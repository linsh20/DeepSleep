import type {
  OrderPricingInput, PaymentRiskAuthorization, PaymentRiskFlowResult, PaymentRiskRequest, PaymentRiskResult,
  ProductHandoff,
} from "../types"
import { mockOrderPricing } from "./mock-order-pricing"
import { preparePaymentHandoff } from "./order-amount"

export type PaymentRiskOptions = {
  /** Demo only: accept level-1 amounts computed from Mock pricing. Real orders must keep this off. */
  allowMock?: boolean
  now?: () => Date
}

/** HKD dollars -> cents, so limits are compared as integers. null means not a valid amount. */
function cents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  const scaled = Math.round(value * 100)
  return Number.isSafeInteger(scaled) && Math.abs(scaled - value * 100) < 1e-6 ? scaled : null
}

/**
 * Level 2: deterministic payment risk check on one priced product. No HTTP, LLM, database or payment.
 * `approved` lets the UI simulate an order; it is not a real payment authorization.
 */
export async function checkPaymentRisk(
  input: PaymentRiskRequest,
  options: PaymentRiskOptions = {},
): Promise<PaymentRiskResult> {
  const selection = input?.selection
  const auth = input?.userAuthorization
  const result: PaymentRiskResult = {
    taskId: typeof selection?.taskId === "string" ? selection.taskId : "",
    requirementVersion: Number.isSafeInteger(selection?.requirementVersion) ? selection.requirementVersion : 0,
    status: "blocked", offerId: selection?.candidate?.offerId ?? null,
    totalHkd: typeof selection?.orderAmount?.totalHkd === "number" ? selection.orderAmount.totalHkd : null,
    currency: "HKD", reasons: [],
  }
  const amount = selection?.orderAmount
  const grant = auth?.authorization
  if (!selection?.candidate || !amount || !grant || !Array.isArray(auth.allowedPaymentMethodIds)) {
    result.reasons.push("INVALID_INPUT: 需要一级计价后的商品（含 orderAmount）和用户授权。")
    return result
  }
  const now = (options.now ?? (() => new Date()))().getTime()
  const blocked: string[] = [], verify: string[] = []

  // Stale or foreign results are rejected before any amount check.
  if (auth.taskId !== selection.taskId || auth.requirementVersion !== selection.requirementVersion) {
    blocked.push("授权与商品的任务或需求版本不一致，请使用当前版本重新选品。")
  }
  if (selection.productCheck?.status !== "passed") blocked.push("商品未通过一级条件检查。")

  const expiresAt = Date.parse(grant.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) blocked.push("用户授权已过期或到期时间无效。")
  if (grant.currency !== "HKD" || amount.currency !== "HKD") blocked.push("只支持 HKD 授权和订单金额。")
  if (!selection.candidate.offerId || grant.allowedOfferId !== selection.candidate.offerId) {
    blocked.push("授权绑定的商品报价（offerId）与选中商品不一致。")
  }
  if (!Number.isSafeInteger(grant.maxQuantity) || selection.quantity > grant.maxQuantity) {
    blocked.push(`购买数量 ${selection.quantity} 超过授权上限 ${grant.maxQuantity}。`)
  }
  if (auth.allowedPaymentMethodIds.length > 0 && !auth.allowedPaymentMethodIds.includes(amount.paymentMethodId)) {
    blocked.push(`支付方式 ${amount.paymentMethodId} 不在用户允许的范围内。`)
  }

  // Limits use totalHkd, which includes shipping, card offers, FX and fees.
  const total = cents(amount.totalHkd), limit = cents(grant.maxTotalHkd)
  if (total === null || limit === null) blocked.push("INVALID_INPUT: 整单金额或授权上限不是有效的 HKD 元数。")
  else if (total > limit) blocked.push(`整单金额 HKD ${amount.totalHkd} 超过授权上限 HKD ${grant.maxTotalHkd}。`)

  const validUntil = Date.parse(amount.validUntil)
  if (!Number.isFinite(validUntil) || validUntil <= now) verify.push("一级报价已过期，请重新计算整单金额。")
  if (amount.evidenceStatus === "mock" && !options.allowMock) {
    verify.push("整单金额来自 Mock 报价，真实下单前需要可信报价。")
  }

  if (blocked.length) return { ...result, status: "blocked", reasons: [...blocked, ...verify] }
  if (verify.length) return { ...result, status: "needs_verification", reasons: verify }
  const notes = [`整单 HKD ${amount.totalHkd} 在授权上限 HKD ${grant.maxTotalHkd} 内。`]
  if (amount.evidenceStatus === "mock") notes.push("金额来自 Mock 报价，只能用于模拟下单。")
  return { ...result, status: "approved", reasons: notes }
}

/** Level 1 (order pricing) -> level 2 (payment risk), as plain function calls. */
export async function runPaymentRisk(
  input: { selection: ProductHandoff; pricingInput: OrderPricingInput; userAuthorization: PaymentRiskAuthorization },
  options: PaymentRiskOptions = {},
): Promise<PaymentRiskFlowResult> {
  const pricing = preparePaymentHandoff(input.selection, input.pricingInput, options)
  const base = { taskId: pricing.taskId, requirementVersion: pricing.requirementVersion, pricing }
  if (pricing.status !== "ready" || !pricing.selection) {
    const status = pricing.status === "no_available_method" ? "blocked"
      : pricing.status === "failed" ? "failed" : "needs_verification"
    return { ...base, status, stage: "pricing", order: null, risk: null }
  }
  const risk = await checkPaymentRisk({ selection: pricing.selection, userAuthorization: input.userAuthorization }, options)
  return { ...base, status: risk.status, stage: "payment_risk",
    order: risk.status === "approved" ? pricing.selection : null, risk }
}

/**
 * Hackathon shortcut: Watsons selection -> level-1 product-price calculation -> level-2 amount risk.
 * Fulfillment and merchant facts are intentionally excluded; no real order or payment is created.
 */
export async function runWatsonsDemoPaymentRisk(
  input: { selection: ProductHandoff; userAuthorization: PaymentRiskAuthorization },
  options: Omit<PaymentRiskOptions, "allowMock"> = {},
): Promise<PaymentRiskFlowResult> {
  const now = (options.now ?? (() => new Date()))()
  return runPaymentRisk({
    selection: input.selection,
    pricingInput: mockOrderPricing(input.selection, now),
    userAuthorization: input.userAuthorization,
  }, { ...options, allowMock: true })
}
