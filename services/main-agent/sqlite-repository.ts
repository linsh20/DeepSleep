import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { TaskRepository } from "./task-repository"
import { TaskError, type MainTask } from "./types"

// Shares the local sandbox database, but exclusively owns main_* tables.
export class SqliteTaskRepository implements TaskRepository {
  private inflight = new Map<string, { fingerprint: string; promise: Promise<MainTask> }>()
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS main_tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS main_sessions (token_hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS main_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS main_purchase_links (plan_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES main_tasks(id), owner TEXT NOT NULL, version INTEGER NOT NULL, UNIQUE(task_id,version));
      CREATE TABLE IF NOT EXISTS main_purchase_requests (owner TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL, plan_id TEXT NOT NULL, PRIMARY KEY(owner,request_id));`)
  }
  readonly sessions = {
    has: (token: string) => !!this.db.prepare("SELECT 1 FROM main_sessions WHERE token_hash=?").get(this.owner(token)),
    add: (token: string) => { this.db.prepare("INSERT OR IGNORE INTO main_sessions VALUES (?)").run(this.owner(token)) },
    owner: (token: string) => this.owner(token),
  }
  owner(token: string) { return createHash("sha256").update(token).digest("hex") }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try { const result = work(); this.db.exec("COMMIT"); return result } catch (e) { this.db.exec("ROLLBACK"); throw e }
  }
  get(taskId: string, userId: string): MainTask {
    const row = this.db.prepare("SELECT data FROM main_tasks WHERE id=? AND owner=?").get(taskId, userId)
    if (!row) throw new TaskError("NOT_FOUND", "任务不存在或不属于当前会话", 404)
    return JSON.parse(String(row.data))
  }
  list(userId: string): MainTask[] { return this.db.prepare("SELECT data FROM main_tasks WHERE owner=? ORDER BY rowid DESC LIMIT 30").all(userId).map(r => JSON.parse(String(r.data))) }
  insert(task: MainTask) { this.db.prepare("INSERT INTO main_tasks VALUES (?,?,?)").run(task.taskId, task.userId, JSON.stringify(task)) }
  update(taskId: string, userId: string, mutate: (task: MainTask) => void) {
    return this.transaction(() => { const task = this.get(taskId, userId); mutate(task); this.db.prepare("UPDATE main_tasks SET data=? WHERE id=? AND owner=?").run(JSON.stringify(task), taskId, userId); return task })
  }
  async once(key: string, fingerprint: string, operation: () => Promise<MainTask>) {
    const running = this.inflight.get(key)
    if (running) { if (running.fingerprint !== fingerprint) throw new TaskError("REQUEST_CONFLICT", "requestId 已用于不同请求", 409); return structuredClone(await running.promise) }
    const old = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM main_requests WHERE id=?").get(key)
      if (!row) this.db.prepare("INSERT INTO main_requests(id,fingerprint) VALUES (?,?)").run(key, fingerprint)
      return row
    })
    if (old) {
      if (old.fingerprint !== fingerprint) throw new TaskError("REQUEST_CONFLICT", "requestId 已用于不同请求", 409)
      if (old.result) return JSON.parse(String(old.result)) as MainTask
      if (old.error) { const e = JSON.parse(String(old.error)); throw new TaskError(e.code, e.message, e.httpStatus) }
      // A crashed or another-process request is never replayed silently.
      throw new TaskError("REQUEST_PENDING", "请求已受理但尚无持久化结果；请读取当前任务，不重复追加消息或调用工具", 409)
    }
    const promise = Promise.resolve().then(operation).then(result => {
      this.db.prepare("UPDATE main_requests SET result=? WHERE id=?").run(JSON.stringify(result), key); return result
    }, error => {
      const safe = error instanceof TaskError ? error : new TaskError("INTERNAL_ERROR", "请求未完成，请查询当前任务", 500)
      this.db.prepare("UPDATE main_requests SET error=? WHERE id=?").run(JSON.stringify({ code: safe.code, message: safe.message, httpStatus: safe.httpStatus }), key); throw safe
    }).finally(() => this.inflight.delete(key))
    this.inflight.set(key, { fingerprint, promise })
    return structuredClone(await promise)
  }
}
