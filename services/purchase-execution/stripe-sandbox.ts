import Stripe from "stripe"
import { createHash } from "node:crypto"
import { ensure, PurchaseError } from "./types"
import type { PaymentPort, PaymentSnapshot, PurchaseOperation } from "./types"

// Only this official test PaymentMethod is available. Never accept one from the browser/model.
export const SANDBOX_PAYMENT_METHOD = "pm_card_visa"
export class StripeSandboxPaymentAdapter implements PaymentPort {
  constructor(private secrets: () => { key?: string; webhookSecret?: string }, private makeClient = (key: string) => new Stripe(key, { apiVersion: "2026-09-30.endive", maxNetworkRetries: 0, timeout: 10000 })) {}
  configured() { return /^sk_test_/.test(this.secrets().key?.trim() ?? "") }
  configurationId() { return createHash("sha256").update(`${this.secrets().key?.trim() ?? ""}:2026-09-30.endive:${SANDBOX_PAYMENT_METHOD}`).digest("hex") }
  private client() {
    const key = this.secrets().key?.trim()
    ensure(key, "STRIPE_NOT_CONFIGURED", "请在服务端 .env.local 配置 Stripe 沙盒密钥", 503)
    ensure(/^sk_test_/.test(key), "STRIPE_TEST_KEY_REQUIRED", "拒绝非测试密钥；本模块不能执行真实支付", 403)
    return this.makeClient(key)
  }
  private snapshot(pi: Stripe.PaymentIntent): PaymentSnapshot {
    ensure(pi.livemode === false, "LIVE_OBJECT_REJECTED", "拒绝非沙盒 Stripe 对象", 403)
    ensure(/^pi_[A-Za-z0-9_]+$/.test(pi.id) && Number.isSafeInteger(pi.amount) && typeof pi.currency === "string", "INVALID_STRIPE_OBJECT", "Stripe 对象格式无效", 502)
    const status = pi.status === "requires_payment_method" ? "failed" : pi.status
    ensure(["requires_confirmation", "requires_action", "processing", "succeeded", "canceled", "failed"].includes(status), "UNSUPPORTED_PAYMENT_STATUS", "支付状态不受本轮支持，已暂停", 409)
    return { id: pi.id, livemode: false, amount: pi.amount, currency: pi.currency, status: status as PaymentSnapshot["status"], operationId: pi.metadata?.operationId, orderId: pi.metadata?.orderId, planId: pi.metadata?.planId }
  }
  private async call(fn: (client: Stripe) => Promise<Stripe.PaymentIntent>) {
    const client = this.client()
    try { return this.snapshot(await fn(client)) }
    catch (e) {
      if (e instanceof PurchaseError) throw e
      // Card errors can carry the current PI. Project only whitelisted non-sensitive fields.
      // SDK ESM/CJS or Next bundles can have distinct class identities.
      const card = e && typeof e === "object" ? e as { type?: unknown; rawType?: unknown; payment_intent?: unknown } : undefined
      if (card?.type === "StripeCardError" && card.rawType === "card_error" && card.payment_intent && typeof card.payment_intent === "object") return this.snapshot(card.payment_intent as Stripe.PaymentIntent)
      throw new PurchaseError("PAYMENT_RESULT_UNKNOWN", "Stripe 请求未取得可确认结果；保留原操作，不能创建新尝试掩盖未知状态", 502)
    }
  }
  async create(op: PurchaseOperation) {
    ensure(op.orderId, "ORDER_REQUIRED", "需要已保存的待付款订单")
    return this.call(client => client.paymentIntents.create({ amount: op.quote.totalMinor, currency: op.quote.currency.toLowerCase(), allowed_payment_method_types: ["card"], payment_method: SANDBOX_PAYMENT_METHOD, confirm: false, confirmation_method: "automatic", capture_method: "automatic", metadata: { operationId: op.operationId, orderId: op.orderId!, planId: op.planId }, description: "DeepSleep sandbox fixture — simulated merchant only" }, { idempotencyKey: op.createKey }))
  }
  async confirm(op: PurchaseOperation) {
    ensure(op.paymentId && /^pi_[A-Za-z0-9_]+$/.test(op.paymentId), "PAYMENT_ID_REQUIRED", "缺少 Stripe 对象 ID")
    return this.call(client => client.paymentIntents.confirm(op.paymentId!, {}, { idempotencyKey: op.confirmKey }))
  }
  async retrieve(id: string) {
    ensure(/^pi_[A-Za-z0-9_]+$/.test(id), "INVALID_PAYMENT_ID", "无效 Stripe 对象 ID")
    return this.call(client => client.paymentIntents.retrieve(id))
  }
  verifyWebhook(raw: string, signature: string) {
    const secret = this.secrets().webhookSecret
    ensure(secret, "WEBHOOK_NOT_CONFIGURED", "未配置 Stripe Webhook 签名密钥", 503)
    let event: Stripe.Event
    try { event = this.client().webhooks.constructEvent(raw, signature, secret, 300) }
    catch (e) { if (e instanceof PurchaseError) throw e; throw new PurchaseError("INVALID_WEBHOOK_SIGNATURE", "Webhook 签名无效", 400) }
    ensure(event.livemode === false, "LIVE_OBJECT_REJECTED", "拒绝正式环境事件", 403)
    if (!["payment_intent.created", "payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.processing", "payment_intent.requires_action", "payment_intent.canceled"].includes(event.type)) return null
    const pi = event.data.object as Stripe.PaymentIntent
    ensure(pi.object === "payment_intent" && pi.livemode === false && /^pi_[A-Za-z0-9_]+$/.test(pi.id), "INVALID_WEBHOOK", "Webhook 对象无效")
    return { id: event.id, paymentId: pi.id, operationId: pi.metadata?.operationId }
  }
}
