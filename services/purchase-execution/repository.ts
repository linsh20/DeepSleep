import { DatabaseSync } from "node:sqlite"
import { randomUUID, createHash } from "node:crypto"
import type { MerchantOrder, PurchaseOperation, Quote, SandboxPlan, SandboxTask } from "./types"
import { ensure } from "./types"

// Dedicated sandbox schema; not a migration of the main-agent or Shopping database.
export class SqlitePurchaseRepository {
  readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sandbox_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sandbox_tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sandbox_plans (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES sandbox_tasks(id), version INTEGER NOT NULL, data TEXT NOT NULL, quote TEXT NOT NULL, UNIQUE(task_id,version));
      CREATE TABLE IF NOT EXISTS sandbox_fixture_requests (owner TEXT NOT NULL, request_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES sandbox_plans(id), PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS sandbox_operations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL, plan_id TEXT NOT NULL UNIQUE REFERENCES sandbox_plans(id), payment_id TEXT UNIQUE, data TEXT NOT NULL, UNIQUE(task_id,version));
      CREATE TABLE IF NOT EXISTS sandbox_orders (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES sandbox_operations(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sandbox_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES sandbox_operations(id), at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sandbox_webhooks (event_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, operation_id TEXT, processed INTEGER NOT NULL DEFAULT 0);
    `)
  }
  close() { this.db.close() }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try { const result = work(); this.db.exec("COMMIT"); return result } catch (e) { this.db.exec("ROLLBACK"); throw e }
  }
  session(token?: string) {
    const hash = (s: string) => createHash("sha256").update(s).digest("hex")
    if (token && this.db.prepare("SELECT 1 FROM sandbox_sessions WHERE token_hash=?").get(hash(token))) return { token, owner: hash(token) }
    return undefined
  }
  newSession() {
    const token = randomUUID() + randomUUID(), owner = createHash("sha256").update(token).digest("hex")
    this.db.prepare("INSERT INTO sandbox_sessions VALUES (?,?)").run(owner, Date.now())
    return { token, owner }
  }
  private read<T>(table: string, id: string): T {
    // table is exclusively a source-code constant, never user/model input.
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)
    ensure(row, "NOT_FOUND", "测试记录不存在", 404)
    return JSON.parse(String(row.data)) as T
  }
  task(id: string) { return this.read<SandboxTask>("sandbox_tasks", id) }
  plan(id: string) { return this.read<SandboxPlan>("sandbox_plans", id) }
  quote(id: string): Quote {
    const row = this.db.prepare("SELECT quote FROM sandbox_plans WHERE id=?").get(id)
    ensure(row, "NOT_FOUND", "测试方案不存在", 404)
    return JSON.parse(String(row.quote))
  }
  fixtureRequest(owner: string, requestId: string): string | undefined {
    return this.db.prepare("SELECT plan_id FROM sandbox_fixture_requests WHERE owner=? AND request_id=?").get(owner, requestId)?.plan_id as string | undefined
  }
  saveFixture(task: SandboxTask, plan: SandboxPlan, quote: Quote, requestId: string) {
    return this.transaction(() => {
      const old = this.fixtureRequest(task.userId, requestId)
      if (old) return old
      this.db.prepare("INSERT INTO sandbox_tasks VALUES (?,?,?)").run(task.taskId, task.userId, JSON.stringify(task))
      this.db.prepare("INSERT INTO sandbox_plans VALUES (?,?,?,?,?)").run(plan.planId, task.taskId, plan.requirementVersion, JSON.stringify(plan), JSON.stringify(quote))
      this.db.prepare("INSERT INTO sandbox_fixture_requests VALUES (?,?,?)").run(task.userId, requestId, plan.planId)
      return plan.planId
    })
  }
  operation(id: string) { return this.read<PurchaseOperation>("sandbox_operations", id) }
  forPlan(planId: string): PurchaseOperation | undefined {
    const row = this.db.prepare("SELECT data FROM sandbox_operations WHERE plan_id=?").get(planId)
    return row ? JSON.parse(String(row.data)) : undefined
  }
  forPayment(id: string): PurchaseOperation | undefined {
    const row = this.db.prepare("SELECT data FROM sandbox_operations WHERE payment_id=?").get(id)
    return row ? JSON.parse(String(row.data)) : undefined
  }
  insertOperation(op: PurchaseOperation) {
    this.db.prepare("INSERT INTO sandbox_operations VALUES (?,?,?,?,?,?,?)").run(op.operationId, op.userId, op.taskId, op.requirementVersion, op.planId, op.paymentId, JSON.stringify(op))
    this.event(op.operationId, "test_permission", "一次沙盒测试许可；不代表正式授权或风控通过")
  }
  writeOperation(op: PurchaseOperation) {
    this.db.prepare("UPDATE sandbox_operations SET payment_id=?, data=? WHERE id=?").run(op.paymentId, JSON.stringify(op), op.operationId)
  }
  mutate(id: string, token: string, fn: (op: PurchaseOperation) => void, now = Date.now()) {
    return this.transaction(() => {
      const op = this.operation(id)
      ensure(op.leaseToken === token && op.leaseUntil > now, "OPERATION_BUSY", "操作已由其他执行者接管；请刷新", 409)
      fn(op); this.writeOperation(op); return op
    })
  }
  acquire(id: string, now = Date.now()) {
    return this.transaction(() => {
      const op = this.operation(id)
      if (op.leaseToken && op.leaseUntil > now) return null
      const token = randomUUID(); op.leaseToken = token; op.leaseUntil = now + 60000; this.writeOperation(op); return token
    })
  }
  release(id: string, token: string) {
    this.transaction(() => { const op = this.operation(id); if (op.leaseToken === token) { op.leaseToken = null; op.leaseUntil = 0; this.writeOperation(op) } })
  }
  event(id: string, kind: string, detail: string) { this.db.prepare("INSERT INTO sandbox_events(operation_id,at,kind,detail) VALUES (?,?,?,?)").run(id, Date.now(), kind, detail) }
  events(id: string) { return this.db.prepare("SELECT sequence,at,kind,detail FROM sandbox_events WHERE operation_id=? ORDER BY sequence").all(id) }
  order(id: string) { return this.read<MerchantOrder>("sandbox_orders", id) }
  orderForOperation(id: string): MerchantOrder | undefined {
    const row = this.db.prepare("SELECT data FROM sandbox_orders WHERE operation_id=?").get(id)
    return row ? JSON.parse(String(row.data)) : undefined
  }
  saveOrder(order: MerchantOrder) { this.db.prepare("INSERT INTO sandbox_orders VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(order.orderId, order.operationId, JSON.stringify(order)) }
  webhook(eventId: string, paymentId: string, operationId?: string) {
    this.db.prepare("INSERT OR IGNORE INTO sandbox_webhooks(event_id,payment_id,operation_id) VALUES (?,?,?)").run(eventId, paymentId, operationId ?? null)
    const row = this.db.prepare("SELECT * FROM sandbox_webhooks WHERE event_id=?").get(eventId)!
    ensure(row.payment_id === paymentId, "INVALID_WEBHOOK", "事件身份冲突")
    return Boolean(row.processed)
  }
  finishWebhook(id: string) { this.db.prepare("UPDATE sandbox_webhooks SET processed=1 WHERE event_id=?").run(id) }
  list(owner: string) { return this.db.prepare("SELECT p.id FROM sandbox_plans p JOIN sandbox_tasks t ON p.task_id=t.id WHERE t.owner=? ORDER BY p.rowid DESC LIMIT 30").all(owner).map(r => String(r.id)) }
}
