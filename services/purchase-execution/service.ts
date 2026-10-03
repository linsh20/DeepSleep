import { randomUUID } from "node:crypto"
import { PurchaseError, ensure } from "./types"
import type { ExecutionGate, MerchantOrderPort, PaymentPort, PaymentSnapshot, PurchaseOperation } from "./types"
import { SandboxPurchaseFixture } from "./fixture"
import type { SqlitePurchaseRepository } from "./repository"

export class PurchaseExecutionService {
  constructor(private repo: SqlitePurchaseRepository, private merchant: MerchantOrderPort, private gate: ExecutionGate, private payment: PaymentPort, private options: { now?: () => number; timeoutMs?: number; mode?: "sandbox" | "production" } = {}) {}
  private now() { return (this.options.now ?? Date.now)() }
  private async bounded<T>(fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PurchaseError("PAYMENT_RESULT_UNKNOWN", "调用超时，保留原操作以恢复", 504)), this.options.timeoutMs ?? 12000) })]) }
    finally { clearTimeout(timer) }
  }
  private requestId(id: string) { ensure(typeof id === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(id), "INVALID_REQUEST_ID", "requestId 格式无效") }
  private owned(planId: string, userId: string) {
    const plan = this.repo.plan(planId), task = this.repo.task(plan.taskId)
    ensure(task.userId === userId, "NOT_FOUND", "测试方案不存在", 404)
    return { plan, task }
  }
  private check(op: PurchaseOperation) {
    const { task, plan } = this.owned(op.planId, op.userId)
    return this.gate.check({ mode: this.options.mode ?? "sandbox", task, plan, quote: op.quote, userId: op.userId, expectedVersion: op.requirementVersion, permitted: op.permit.kind === "one_sandbox_test", now: this.now() })
  }
  async createFixture(userId: string, requestId: string) {
    this.requestId(requestId)
    const existing = this.repo.fixtureRequest(userId, requestId)
    if (existing) return this.get(existing, userId)
    const { task, plan } = new SandboxPurchaseFixture().create(userId)
    const quote = await this.bounded(() => this.merchant.quote(plan))
    const id = this.repo.saveFixture(task, plan, quote, requestId)
    return this.get(id, userId)
  }
  // No provider calls, order creation, confirmation or reconciliation on GET.
  get(planId: string, userId: string) {
    const { task, plan } = this.owned(planId, userId), op = this.repo.forPlan(planId)
    return { mode: "sandbox_only", merchantEnvironment: "simulated", paymentEnvironment: "stripe_sandbox", stripeConfigured: this.payment.configured(), task, plan, quote: this.repo.quote(planId),
      operation: op ? { operationId: op.operationId, requirementVersion: op.requirementVersion, paymentId: op.paymentId, paymentStatus: op.paymentStatus, errorCode: op.errorCode, testPermission: { kind: op.permit.kind, grantedAt: op.permit.grantedAt, planId: op.permit.planId }, busy: !!op.leaseToken && op.leaseUntil > this.now() } : null,
      order: op?.orderId ? this.repo.order(op.orderId) : null, events: op ? this.repo.events(op.operationId) : [] }
  }
  list(userId: string) { return this.repo.list(userId).map(id => this.get(id, userId)) }
  async execute(userId: string, input: { planId: string; expectedVersion: number; requestId: string; testPermission: boolean }) {
    this.requestId(input.requestId)
    ensure(input.testPermission === true, "TEST_PERMISSION_REQUIRED", "请许可本次沙盒测试", 403)
    ensure(this.options.mode !== "production", "POLICY_NOT_CONFIGURED", "正式策略未配置，拒绝执行", 403)
    const op = this.repo.transaction(() => {
      const { plan, task } = this.owned(input.planId, userId)
      ensure(task.intent === "purchase", "COMPARE_NOT_EXECUTABLE", "比较任务禁止执行", 403)
      ensure(task.requirementVersion === input.expectedVersion && plan.requirementVersion === input.expectedVersion, "STALE_VERSION", "需求版本已变化", 409)
      const old = this.repo.forPlan(plan.planId)
      if (old) return old
      const quote = this.repo.quote(plan.planId)
      this.gate.check({ mode: this.options.mode ?? "sandbox", task, plan, quote, userId, expectedVersion: input.expectedVersion, permitted: true, now: this.now() })
      const operationId = randomUUID()
      const created: PurchaseOperation = { operationId, userId, taskId: task.taskId, requirementVersion: task.requirementVersion, planId: plan.planId, quote,
        permit: { kind: "one_sandbox_test", grantedAt: this.now(), requestId: input.requestId, planId: plan.planId, userId },
        orderId: null, paymentId: null, paymentStatus: "not_started", createKey: `sandbox:${operationId}:create`, confirmKey: `sandbox:${operationId}:confirm`, createStartedAt: null, confirmStartedAt: null, providerBinding: null, errorCode: null, leaseToken: null, leaseUntil: 0 }
      this.repo.insertOperation(created); return created
    })
    await this.run(op.operationId, true)
    return this.get(input.planId, userId)
  }
  async reconcile(planId: string, userId: string) {
    ensure(this.options.mode !== "production", "POLICY_NOT_CONFIGURED", "正式策略未配置，拒绝执行", 403)
    this.owned(planId, userId)
    const op = this.repo.forPlan(planId)
    ensure(op, "OPERATION_REQUIRED", "尚未运行沙盒购买")
    await this.run(op.operationId, false)
    return this.get(planId, userId)
  }
  private validate(snapshot: PaymentSnapshot, op: PurchaseOperation) {
    ensure(snapshot.livemode === false, "LIVE_OBJECT_REJECTED", "拒绝正式环境支付对象", 403)
    ensure(/^pi_[A-Za-z0-9_]+$/.test(snapshot.id) && (!op.paymentId || op.paymentId === snapshot.id) && snapshot.amount === op.quote.totalMinor && snapshot.currency.toUpperCase() === op.quote.currency && snapshot.operationId === op.operationId && snapshot.orderId === op.orderId && snapshot.planId === op.planId, "PAYMENT_MISMATCH", "Stripe 对象金额、币种或订单关联不匹配，已暂停", 409)
    ensure(["requires_confirmation", "requires_action", "processing", "failed", "succeeded", "canceled"].includes(snapshot.status), "INVALID_PAYMENT_STATE", "支付状态不支持")
  }
  private apply(id: string, token: string, snapshot: PaymentSnapshot) {
    return this.repo.mutate(id, token, op => {
      this.validate(snapshot, op)
      // Terminal success is absorbing, irrespective of webhook timestamps or old reads.
      op.paymentId = snapshot.id
      if (op.paymentStatus !== "succeeded") op.paymentStatus = snapshot.status
      op.errorCode = null
      this.repo.event(id, "payment_status", op.paymentStatus)
    }, this.now())
  }
  private window(start: number | null) {
    // Stripe may prune idempotency keys after 24h. Never replay a potentially charging
    // POST beyond our conservative 23h window; retain unknown state for manual reconciliation.
    ensure(start === null || this.now() - start < 23 * 60 * 60 * 1000, "IDEMPOTENCY_WINDOW_EXPIRED", "幂等恢复窗口已过；保留原操作，只允许核对既有对象，不创建新支付", 409)
  }
  private async confirmMerchant(id: string, token: string) {
    const op = this.repo.operation(id)
    if (op.paymentStatus !== "succeeded" || !op.orderId || !op.paymentId) return
    if (this.repo.order(op.orderId).status === "confirmed") return
    try {
      const observed = await this.bounded(() => this.merchant.get(op.orderId!))
      const result = observed.status === "confirmed" ? observed : await this.bounded(() => this.merchant.confirm(op.orderId!, op.paymentId!))
      ensure(result.orderId === op.orderId && result.operationId === id && JSON.stringify(result.quote) === JSON.stringify(op.quote) && result.status === "confirmed", "MERCHANT_CONFIRMATION_FAILED", "支付成功，但模拟商户未确认订单")
      this.repo.mutate(id, token, current => { this.repo.saveOrder(result); current.errorCode = null; this.repo.event(id, "merchant_confirmed", "模拟订单已确认；没有真实商户购买") }, this.now())
    } catch {
      this.repo.mutate(id, token, current => {
        current.errorCode = "MERCHANT_CONFIRMATION_FAILED"
        const order = this.repo.order(current.orderId!)
        if (order.status !== "confirmed") { order.status = "confirmation_failed"; this.repo.saveOrder(order) }
        this.repo.event(id, "merchant_confirmation_failed", "支付保持成功，订单待恢复；不可再次扣款")
      }, this.now())
    }
  }
  private async run(id: string, allowPayment: boolean, discoveredPaymentId?: string) {
    const token = this.repo.acquire(id, this.now())
    if (!token) return false
    try {
      let op = this.repo.operation(id)
      if (op.paymentStatus === "succeeded") { await this.confirmMerchant(id, token); return true }
      if (!op.orderId) {
        if (!allowPayment) return true
        this.check(op)
        const order = await this.bounded(() => this.merchant.createPending(id, op.quote))
        ensure(order.operationId === id && order.status === "pending_payment" && JSON.stringify(order.quote) === JSON.stringify(op.quote), "ORDER_MISMATCH", "待付款订单不匹配")
        op = this.repo.mutate(id, token, current => { this.repo.saveOrder(order); current.orderId = order.orderId; this.repo.event(id, "order_created", "模拟商户待付款订单") }, this.now())
      }
      if (op.providerBinding) ensure(op.providerBinding === this.payment.configurationId(), "PAYMENT_CONFIGURATION_CHANGED", "支付配置与原操作不同；禁止重建支付，请恢复原沙盒配置后核对", 409)
      const knownId = op.paymentId ?? discoveredPaymentId
      if (knownId) {
        op = this.apply(id, token, await this.bounded(() => this.payment.retrieve(knownId)))
      } else if (allowPayment) {
        this.check(op); this.window(op.createStartedAt)
        ensure(this.payment.configured(), "STRIPE_NOT_CONFIGURED", "Stripe 沙盒未配置；未调用 Stripe", 503)
        op = this.repo.mutate(id, token, current => { current.providerBinding ??= this.payment.configurationId(); current.createStartedAt ??= this.now(); current.paymentStatus = "creating"; current.errorCode = null; this.repo.event(id, "payment_create", "使用持久化创建幂等键") }, this.now())
        op = this.apply(id, token, await this.bounded(() => this.payment.create(op)))
      } else {
        throw new PurchaseError("PAYMENT_ID_UNKNOWN", "没有已知 Stripe ID；可在有效期内使用原操作恢复，或等待已验签通知")
      }
      if (allowPayment && op.paymentStatus === "requires_confirmation") {
        // Re-read authoritative task and immutable quote after every await, immediately before charging.
        this.check(op); this.window(op.confirmStartedAt)
        op = this.repo.mutate(id, token, current => { current.confirmStartedAt ??= this.now(); current.paymentStatus = "confirming"; this.repo.event(id, "payment_confirm", "仅确认已关联的 Stripe 测试 PaymentIntent") }, this.now())
        op = this.apply(id, token, await this.bounded(() => this.payment.confirm(op)))
      }
      if (op.paymentStatus === "succeeded") await this.confirmMerchant(id, token)
      return true
    } catch (e) {
      if (e instanceof PurchaseError && e.code === "OPERATION_BUSY") return false
      const code = e instanceof PurchaseError ? e.code : "PAYMENT_RESULT_UNKNOWN"
      this.repo.mutate(id, token, op => {
        if (op.paymentStatus !== "succeeded" && ["creating", "confirming"].includes(op.paymentStatus)) op.paymentStatus = "unknown"
        op.errorCode = code; this.repo.event(id, "execution_paused", code)
      }, this.now())
      return false
    } finally { this.repo.release(id, token) }
  }
  async webhook(raw: string, signature: string) {
    ensure(this.options.mode !== "production", "POLICY_NOT_CONFIGURED", "正式策略未配置，拒绝执行", 403)
    const event = this.payment.verifyWebhook(raw, signature)
    if (!event) return { received: true, ignored: true }
    if (this.repo.webhook(event.id, event.paymentId, event.operationId)) return { received: true, duplicate: true }
    let op = this.repo.forPayment(event.paymentId)
    if (!op && event.operationId) {
      try { op = this.repo.operation(event.operationId) } catch { /* Foreign Stripe object: no local operation. */ }
    }
    if (!op) { this.repo.finishWebhook(event.id); return { received: true, ignored: true } }
    // Never apply the event's snapshot/status or rely on created timestamps for ordering.
    const done = await this.run(op.operationId, false, event.paymentId)
    ensure(done, "WEBHOOK_RETRY_REQUIRED", "事件已持久化，等待同一操作恢复或重投", 503)
    this.repo.finishWebhook(event.id)
    return { received: true }
  }
}
