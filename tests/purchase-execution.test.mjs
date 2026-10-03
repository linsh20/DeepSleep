import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import ts from "typescript"
import Stripe from "stripe"
const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename)
const { SqlitePurchaseRepository } = requireTS("../services/purchase-execution/repository.ts")
const { DemoMerchantAdapter } = requireTS("../services/purchase-execution/demo-merchant.ts")
const { SandboxExecutionGate } = requireTS("../services/purchase-execution/gate.ts")
const { PurchaseExecutionService } = requireTS("../services/purchase-execution/service.ts")
const { StripeSandboxPaymentAdapter } = requireTS("../services/purchase-execution/stripe-sandbox.ts")
const { createPurchaseHttp } = requireTS("../services/purchase-execution/http.ts")
class ControlledPayment {
  snapshots = new Map(); creates = []; confirms = []; retrieves = []; state = "succeeded"; enabled = true
  configured() { return this.enabled }
  configurationId() { return "controlled-fixture-account" }
  async create(op) {
    this.creates.push(structuredClone(op))
    const id = `pi_${op.operationId.replaceAll("-", "")}`
    if (!this.snapshots.has(id)) this.snapshots.set(id, { id, livemode: false, amount: op.quote.totalMinor, currency: "hkd", status: "requires_confirmation", operationId: op.operationId, orderId: op.orderId, planId: op.planId })
    if (this.onCreate) await this.onCreate(op)
    return structuredClone(this.snapshots.get(id))
  }
  async confirm(op) {
    this.confirms.push(structuredClone(op))
    this.snapshots.get(op.paymentId).status = this.state
    if (this.onConfirm) await this.onConfirm(op)
    return structuredClone(this.snapshots.get(op.paymentId))
  }
  async retrieve(id) { this.retrieves.push(id); return structuredClone(this.snapshots.get(id)) }
  verifyWebhook(raw) { return JSON.parse(raw) }
}
function setup(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deepsleep-purchase-test-")), path = join(dir, "test.sqlite")
  const repo = new SqlitePurchaseRepository(path), payment = opts.payment ?? new ControlledPayment()
  const merchant = new DemoMerchantAdapter(repo, opts.now)
  const agent = new PurchaseExecutionService(repo, merchant, new SandboxExecutionGate(), payment, opts)
  t.after(() => { try { repo.close() } catch {} rmSync(dir, { recursive: true, force: true }) })
  return { repo, payment, merchant, agent, path }
}
const fixture = agent => agent.createFixture("owner", randomUUID())
const execute = (agent, v, more = {}) => agent.execute("owner", { planId: v.plan.planId, expectedVersion: v.task.requirementVersion, requestId: randomUUID(), testPermission: true, ...more })
function updateTask(repo, task, patch) {
  const next = { ...task, ...patch }
  repo.db.prepare("UPDATE sandbox_tasks SET data=? WHERE id=?").run(JSON.stringify(next), task.taskId)
}

test("success: independent final quote, durable test permit, separate order/payment status, read-only GET", async t => {
  const { agent, payment, repo } = setup(t)
  const v = await fixture(agent)
  assert.equal(v.quote.totalMinor, 18000)
  assert.equal(v.plan.environment, "sandbox_fixture")
  assert.equal(v.operation, null)
  const done = await execute(agent, v)
  assert.equal(done.operation.paymentStatus, "succeeded")
  assert.equal(done.order.status, "confirmed")
  assert.equal(done.operation.testPermission.kind, "one_sandbox_test")
  assert.equal(payment.creates.length, 1); assert.equal(payment.confirms.length, 1)
  assert.equal(payment.creates[0].orderId, done.order.orderId)
  assert.equal(repo.operation(done.operation.operationId).paymentId, done.operation.paymentId)
  assert.ok(!JSON.stringify(done).includes("client_secret"))
  const before = [payment.creates.length, payment.confirms.length, payment.retrieves.length]
  for (let i = 0; i < 3; i++) agent.get(v.plan.planId, "owner")
  assert.deepEqual([payment.creates.length, payment.confirms.length, payment.retrieves.length], before)
})
for (const state of ["failed", "requires_action", "processing", "canceled"]) test(`${state}: explicit paused state, merchant remains unpaid; repeated execution does not reconfirm`, async t => {
  const { agent, payment } = setup(t); payment.state = state
  const v = await fixture(agent), result = await execute(agent, v)
  assert.equal(result.operation.paymentStatus, state)
  assert.equal(result.order.status, "pending_payment")
  const again = await execute(agent, v)
  assert.equal(again.operation.operationId, result.operation.operationId)
  assert.equal(payment.creates.length, 1); assert.equal(payment.confirms.length, 1)
})
test("creation timeout: persist unknown, replay identical operation/key/amount even with another requestId", async t => {
  const { agent, payment } = setup(t, { timeoutMs: 5 })
  payment.onCreate = async () => new Promise(() => {})
  const v = await fixture(agent), unknown = await execute(agent, v)
  assert.equal(unknown.operation.paymentStatus, "unknown")
  assert.equal(unknown.operation.errorCode, "PAYMENT_RESULT_UNKNOWN")
  assert.equal(unknown.order.status, "pending_payment")
  assert.equal(unknown.operation.paymentId, null)
  payment.onCreate = undefined
  const done = await execute(agent, v)
  assert.equal(done.operation.operationId, unknown.operation.operationId)
  assert.equal(done.operation.paymentStatus, "succeeded")
  assert.equal(payment.creates.length, 2)
  for (const key of ["createKey", "confirmKey", "operationId", "orderId", "quote", "createStartedAt"]) assert.deepEqual(payment.creates[0][key], payment.creates[1][key])
  assert.equal(payment.snapshots.size, 1); assert.equal(payment.confirms.length, 1)
})
test("confirmation timeout: read existing PI, never create or confirm a second payment", async t => {
  const { agent, payment } = setup(t, { timeoutMs: 5 })
  payment.onConfirm = async () => new Promise(() => {})
  const v = await fixture(agent), unknown = await execute(agent, v)
  assert.equal(unknown.operation.paymentStatus, "unknown")
  assert.ok(unknown.operation.paymentId)
  const done = await agent.reconcile(v.plan.planId, "owner")
  assert.equal(done.operation.paymentStatus, "succeeded")
  assert.equal(done.order.status, "confirmed")
  assert.equal(payment.creates.length, 1); assert.equal(payment.confirms.length, 1)
})
test("cross-connection concurrent execution and changed requestId use one durable operation", async t => {
  const { agent, payment, path } = setup(t)
  const repo2 = new SqlitePurchaseRepository(path)
  t.after(() => repo2.close())
  const agent2 = new PurchaseExecutionService(repo2, new DemoMerchantAdapter(repo2), new SandboxExecutionGate(), payment)
  let entered, release
  const started = new Promise(r => { entered = r })
  payment.onCreate = () => { entered(); return new Promise(r => { release = r }) }
  const v = await fixture(agent), first = execute(agent, v)
  await started
  const concurrent = await execute(agent2, v)
  assert.equal(concurrent.operation.busy, true)
  release(); const done = await first
  const again = await execute(agent2, v)
  assert.equal(again.operation.operationId, done.operation.operationId)
  assert.equal(payment.creates.length, 1); assert.equal(payment.confirms.length, 1)
})
test("database restart preserves operation, orders, sessions and fixture request deduplication", async t => {
  const { repo, agent, payment, path } = setup(t)
  const session = repo.newSession(), requestId = randomUUID()
  const v = await agent.createFixture(session.owner, requestId)
  const done = await agent.execute(session.owner, { planId: v.plan.planId, expectedVersion: 1, requestId: randomUUID(), testPermission: true })
  repo.close()
  const restored = new SqlitePurchaseRepository(path)
  t.after(() => restored.close())
  const restarted = new PurchaseExecutionService(restored, new DemoMerchantAdapter(restored), new SandboxExecutionGate(), payment)
  assert.equal(restored.session(session.token).owner, session.owner)
  const same = await restarted.createFixture(session.owner, requestId)
  assert.equal(same.plan.planId, v.plan.planId)
  assert.equal(same.operation.operationId, done.operation.operationId)
  await restarted.execute(session.owner, { planId: same.plan.planId, expectedVersion: 1, requestId: randomUUID(), testPermission: true })
  assert.equal(payment.creates.length, 1); assert.equal(payment.confirms.length, 1)
})
for (const [name, change, code] of [
  ["compare", () => ({ intent: "compare" }), "COMPARE_NOT_EXECUTABLE"],
  ["old version", () => ({ requirementVersion: 2 }), "STALE_VERSION"],
  ["over budget", v => ({ requirement: { ...v.task.requirement, budget: { maxMinor: 10000, scope: "delivered" } } }), "OVER_BUDGET"],
  ["currency", v => ({ requirement: { ...v.task.requirement, currency: "USD" } }), "CURRENCY_MISMATCH"],
  ["quantity", () => ({ quantity: 2 }), "QUOTE_MISMATCH"],
]) test(`gate rejects ${name} before creating order/payment`, async t => {
  const { agent, repo, payment } = setup(t), v = await fixture(agent)
  updateTask(repo, v.task, change(v))
  await assert.rejects(execute(agent, v), e => e.code === code)
  assert.equal(payment.creates.length, 0)
  assert.equal(repo.forPlan(v.plan.planId), undefined)
})
test("expired quote, wrong owner, missing permission and production mode fail closed", async t => {
  let now = Date.now()
  const { agent, payment, repo, merchant } = setup(t, { now: () => now }), v = await fixture(agent)
  assert.throws(() => agent.get(v.plan.planId, "other"), e => e.code === "NOT_FOUND")
  await assert.rejects(agent.execute("other", { planId: v.plan.planId, expectedVersion: 1, requestId: randomUUID(), testPermission: true }), e => e.code === "NOT_FOUND")
  await assert.rejects(execute(agent, v, { testPermission: false }), e => e.code === "TEST_PERMISSION_REQUIRED")
  const prod = new PurchaseExecutionService(repo, merchant, new SandboxExecutionGate(), payment, { mode: "production" })
  await assert.rejects(execute(prod, v), e => e.code === "POLICY_NOT_CONFIGURED")
  now += 16 * 60 * 1000
  await assert.rejects(execute(agent, v), e => e.code === "QUOTE_EXPIRED")
  assert.equal(payment.creates.length, 0)
})
test("task changes while create is in flight: persist PI but refuse confirmation", async t => {
  const { repo, agent, payment } = setup(t), v = await fixture(agent)
  payment.onCreate = async () => updateTask(repo, v.task, { intent: "compare" })
  const result = await execute(agent, v)
  assert.equal(result.operation.errorCode, "COMPARE_NOT_EXECUTABLE")
  assert.equal(result.operation.paymentStatus, "requires_confirmation")
  assert.ok(result.operation.paymentId)
  assert.equal(payment.confirms.length, 0)
})
test("success with merchant failure preserves payment success; reconciliation only retries merchant", async t => {
  const { agent, merchant, payment } = setup(t)
  const original = merchant.confirm.bind(merchant)
  merchant.confirm = async () => { throw new Error("simulated merchant outage") }
  const v = await fixture(agent), result = await execute(agent, v)
  assert.equal(result.operation.paymentStatus, "succeeded")
  assert.equal(result.order.status, "confirmation_failed")
  assert.equal(result.operation.errorCode, "MERCHANT_CONFIRMATION_FAILED")
  merchant.confirm = original
  const recovered = await agent.reconcile(v.plan.planId, "owner")
  assert.equal(recovered.order.status, "confirmed")
  assert.equal(payment.creates.length, 1); assert.equal(payment.confirms.length, 1)
})
test("webhook duplicate/out-of-order delivery fetches current state and never regresses success", async t => {
  const { agent, payment, repo } = setup(t); payment.state = "processing"
  const v = await fixture(agent), pending = await execute(agent, v), id = pending.operation.paymentId
  payment.snapshots.get(id).status = "succeeded"
  const event = JSON.stringify({ id: "evt_success", paymentId: id })
  await agent.webhook(event, "controlled-test")
  const reads = payment.retrieves.length
  assert.equal((await agent.webhook(event, "controlled-test")).duplicate, true)
  assert.equal(payment.retrieves.length, reads)
  // Stale event snapshot is not trusted; even a stale retrieve cannot undo terminal success.
  payment.snapshots.get(id).status = "failed"
  await agent.webhook(JSON.stringify({ id: "evt_old_failure", paymentId: id }), "controlled-test")
  const final = agent.get(v.plan.planId, "owner")
  assert.equal(final.operation.paymentStatus, "succeeded")
  assert.equal(final.order.status, "confirmed")
  assert.equal(repo.db.prepare("SELECT count(*) n FROM sandbox_webhooks WHERE processed=1").get().n, 2)
})
test("webhook discovers a timed-out create by operation metadata without creating or confirming payment", async t => {
  const { agent, payment } = setup(t, { timeoutMs: 5 })
  payment.onCreate = () => new Promise(() => {})
  const v = await fixture(agent), pending = await execute(agent, v), pi = [...payment.snapshots.values()][0]
  pi.status = "processing"
  await agent.webhook(JSON.stringify({ id: "evt_discovery", paymentId: pi.id, operationId: pending.operation.operationId }), "controlled-test")
  const result = agent.get(v.plan.planId, "owner")
  assert.equal(result.operation.paymentId, pi.id)
  assert.equal(result.operation.paymentStatus, "processing")
  assert.equal(payment.creates.length, 1); assert.equal(payment.confirms.length, 0)
})
test("mismatched or live Stripe object never advances to merchant confirmation", async t => {
  for (const patch of [{ livemode: true }, { amount: 1 }, { currency: "usd" }, { orderId: "foreign" }]) {
    const { agent, payment } = setup(t)
    const original = payment.create.bind(payment)
    payment.create = async op => ({ ...await original(op), ...patch })
    const result = await execute(agent, await fixture(agent))
    assert.equal(result.operation.paymentStatus, "unknown")
    assert.ok(["LIVE_OBJECT_REJECTED", "PAYMENT_MISMATCH"].includes(result.operation.errorCode))
    assert.equal(result.order.status, "pending_payment"); assert.equal(payment.confirms.length, 0)
  }
})
test("missing Stripe configuration is explicit; not represented as a fake payment success", async t => {
  const { agent, payment } = setup(t); payment.enabled = false
  const result = await execute(agent, await fixture(agent))
  assert.equal(result.operation.errorCode, "STRIPE_NOT_CONFIGURED")
  assert.equal(result.operation.paymentStatus, "not_started")
  assert.equal(payment.creates.length, 0)
})
test("expired Stripe idempotency replay window never posts again", async t => {
  let now = Date.now()
  const { agent, repo, payment } = setup(t, { now: () => now, timeoutMs: 5 })
  payment.onCreate = () => new Promise(() => {})
  const v = await fixture(agent)
  // Server-test quote can have a long lifetime to isolate the independent replay-window guard.
  const quote = { ...v.quote, expiresAt: now + 48 * 3600000 }
  repo.db.prepare("UPDATE sandbox_plans SET quote=? WHERE id=?").run(JSON.stringify(quote), v.plan.planId)
  await execute(agent, v)
  now += 24 * 3600000
  const result = await execute(agent, v)
  assert.equal(result.operation.errorCode, "IDEMPOTENCY_WINDOW_EXPIRED")
  assert.equal(result.operation.paymentStatus, "unknown")
  assert.equal(payment.creates.length, 1)
})
test("expired lease fencing rejects an old worker's writes", async t => {
  const { agent, repo, payment } = setup(t); payment.enabled = false
  const v = await execute(agent, await fixture(agent)), id = v.operation.operationId
  const old = repo.acquire(id, 0), newer = repo.acquire(id, 60001)
  assert.ok(old && newer && old !== newer)
  assert.throws(() => repo.mutate(id, old, op => { op.paymentStatus = "succeeded" }, 60002), e => e.code === "OPERATION_BUSY")
  repo.release(id, old)
  assert.equal(repo.operation(id).leaseToken, newer)
})

test("Stripe adapter uses documented pinned API shape, test card, stable keys, and sanitized objects", async () => {
  const seen = []
  const pi = { id: "pi_fixture", object: "payment_intent", livemode: false, amount: 18000, currency: "hkd", status: "requires_confirmation", metadata: { operationId: "op1", orderId: "order1", planId: "plan1" }, client_secret: "must-not-escape" }
  const client = { paymentIntents: { create: async (params, opts) => { seen.push([params, opts]); return pi }, confirm: async (id, params, opts) => { seen.push([id, params, opts]); return { ...pi, status: "succeeded" } }, retrieve: async () => pi } }
  const adapter = new StripeSandboxPaymentAdapter(() => ({ key: "sk_test_fixture" }), () => client)
  const op = { operationId: "op1", planId: "plan1", orderId: "order1", quote: { totalMinor: 18000, currency: "HKD" }, createKey: "stable-create", confirmKey: "stable-confirm", paymentId: "pi_fixture" }
  assert.ok(!JSON.stringify(await adapter.create(op)).includes("client_secret"))
  await adapter.confirm(op)
  assert.equal(seen[0][0].payment_method, "pm_card_visa")
  assert.deepEqual(seen[0][0].allowed_payment_method_types, ["card"])
  assert.equal(seen[0][0].confirm, false)
  assert.equal(seen[0][1].idempotencyKey, "stable-create")
  assert.equal(seen[1][2].idempotencyKey, "stable-confirm")
  pi.livemode = true
  await assert.rejects(adapter.retrieve("pi_fixture"), e => e.code === "LIVE_OBJECT_REJECTED")
  for (const key of [undefined, "sk_live_fixture"]) {
    const blocked = new StripeSandboxPaymentAdapter(() => ({ key }), () => { throw new Error("must not construct client") })
    await assert.rejects(blocked.create(op), e => ["STRIPE_NOT_CONFIGURED", "STRIPE_TEST_KEY_REQUIRED"].includes(e.code))
  }
})
test("official SDK webhook verification rejects tampering, stale signature and live events", () => {
  const secret = "whsec_controlled_test_only", stripe = new Stripe("sk_test_fixture")
  const adapter = new StripeSandboxPaymentAdapter(() => ({ key: "sk_test_fixture", webhookSecret: secret }))
  const payload = JSON.stringify({ id: "evt_signed", type: "payment_intent.succeeded", livemode: false, data: { object: { id: "pi_fixture", object: "payment_intent", livemode: false, metadata: { operationId: "op1" } } } })
  const sign = (raw, timestamp = Math.floor(Date.now() / 1000)) => stripe.webhooks.generateTestHeaderString({ payload: raw, secret, timestamp })
  assert.deepEqual(adapter.verifyWebhook(payload, sign(payload)), { id: "evt_signed", paymentId: "pi_fixture", operationId: "op1" })
  assert.throws(() => adapter.verifyWebhook(payload + " ", sign(payload)), e => e.code === "INVALID_WEBHOOK_SIGNATURE")
  assert.throws(() => adapter.verifyWebhook(payload, sign(payload, Math.floor(Date.now() / 1000) - 400)), e => e.code === "INVALID_WEBHOOK_SIGNATURE")
  const live = payload.replace('"livemode":false', '"livemode":true')
  assert.throws(() => adapter.verifyWebhook(live, sign(live)), e => e.code === "LIVE_OBJECT_REJECTED")
})
test("HTTP ownership, CSRF, field allowlist, GET side effects and production disablement", async t => {
  const { agent, repo, payment } = setup(t), http = createPurchaseHttp(agent, repo, true)
  let cookie = ""
  const post = (action, body, origin = "http://localhost") => http(new Request(`http://localhost/api/sandbox-purchase/${action}`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), action)
  cookie = (await post("session", {})).headers.get("set-cookie").split(";")[0]
  const v = (await (await post("fixture", { requestId: randomUUID() })).json()).view
  const input = { requestId: randomUUID(), planId: v.plan.planId, expectedVersion: 1, testPermission: true }
  assert.equal((await post("execute", { ...input, amount: 1, paymentMethod: "anything" })).status, 400)
  assert.equal((await post("execute", input, "https://evil.example")).status, 403)
  assert.equal((await http(new Request("http://localhost/api/sandbox-purchase/execute", { headers: { cookie } }), "execute")).status, 405)
  assert.equal(payment.creates.length, 0)
  assert.equal((await post("execute", input)).status, 200)
  const before = payment.creates.length
  const read = await http(new Request(`http://localhost/api/sandbox-purchase/state?planId=${v.plan.planId}&success=true`, { headers: { cookie } }), "state")
  assert.equal(read.status, 200); assert.equal(payment.creates.length, before)
  cookie = ""
  cookie = (await post("session", {})).headers.get("set-cookie").split(";")[0]
  assert.equal((await post("execute", { ...input, requestId: randomUUID() })).status, 404)
  const disabled = createPurchaseHttp(agent, repo, false)
  assert.equal((await disabled(new Request("http://localhost"), "state")).status, 404)
})
test("configuration change cannot replay an unknown payment into another Stripe account", async t => {
  const { agent, payment } = setup(t, { timeoutMs: 5 })
  payment.onCreate = () => new Promise(() => {})
  const v = await fixture(agent)
  await execute(agent, v)
  payment.configurationId = () => "different-account"
  const result = await execute(agent, v)
  assert.equal(result.operation.errorCode, "PAYMENT_CONFIGURATION_CHANGED")
  assert.equal(payment.creates.length, 1)
})
test("concurrent duplicate webhook remains pending durably and succeeds on redelivery", async t => {
  const { agent, payment, repo } = setup(t); payment.state = "processing"
  const v = await execute(agent, await fixture(agent)), id = v.operation.paymentId
  let entered, release
  const started = new Promise(r => { entered = r }), original = payment.retrieve.bind(payment)
  payment.retrieve = async id => { entered(); await new Promise(r => { release = r }); return original(id) }
  payment.snapshots.get(id).status = "succeeded"
  const event = JSON.stringify({ id: "evt_concurrent", paymentId: id })
  const first = agent.webhook(event, "controlled-test")
  await started
  await assert.rejects(agent.webhook(event, "controlled-test"), e => e.code === "WEBHOOK_RETRY_REQUIRED")
  assert.equal(repo.db.prepare("SELECT processed FROM sandbox_webhooks WHERE event_id=?").get("evt_concurrent").processed, 0)
  release(); await first
  assert.equal((await agent.webhook(event, "controlled-test")).duplicate, true)
  assert.equal(agent.get(v.plan.planId, "owner").order.status, "confirmed")
})
test("late create response after timeout cannot change recorded unknown state", async t => {
  const { agent, payment } = setup(t, { timeoutMs: 5 })
  let release
  payment.onCreate = () => new Promise(r => { release = r })
  const v = await fixture(agent), unknown = await execute(agent, v)
  release(); await new Promise(r => setImmediate(r))
  assert.equal(agent.get(v.plan.planId, "owner").operation.paymentStatus, "unknown")
  assert.equal(agent.get(v.plan.planId, "owner").operation.operationId, unknown.operation.operationId)
  assert.equal(payment.confirms.length, 0)
})
test("gate rejects non-test merchant, unknown amounts, altered product and missing formal policy", async t => {
  const { agent } = setup(t), v = await fixture(agent), gate = new SandboxExecutionGate()
  const input = { mode: "sandbox", task: v.task, plan: v.plan, quote: v.quote, userId: "owner", expectedVersion: 1, permitted: true, now: Date.now() }
  for (const quote of [
    { ...v.quote, merchantId: "real-merchant" },
    { ...v.quote, totalMinor: null },
    { ...v.quote, skuId: "other-sku" },
    { ...v.quote, shippingMinor: -1 },
    { ...v.quote, totalMinor: 18001 },
  ]) assert.throws(() => gate.check({ ...input, quote }))
  assert.throws(() => gate.check({ ...input, mode: "production" }), e => e.code === "POLICY_NOT_CONFIGURED")
})
test("Stripe declined-card error with PI is a failed payment, not success or unknown", async () => {
  const pi = { id: "pi_declined", object: "payment_intent", livemode: false, amount: 18000, currency: "hkd", status: "requires_payment_method", metadata: { operationId: "op1", orderId: "order1", planId: "plan1" } }
  const adapter = new StripeSandboxPaymentAdapter(() => ({ key: "sk_test_fixture" }), () => ({ paymentIntents: { confirm: async () => { throw new Stripe.errors.StripeCardError({ type: "card_error", message: "private processor detail", payment_intent: pi }) } } }))
  const result = await adapter.confirm({ paymentId: pi.id, confirmKey: "same-confirm" })
  assert.equal(result.status, "failed")
  assert.ok(!JSON.stringify(result).includes("private"))
})
