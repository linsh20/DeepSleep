import type {
  Fact, PaymentContext, PaymentInstantOffer, PaymentOrder,
  PaymentOptimizationPolicy, PaymentOptimizationResult, PaymentOptionEvaluation,
  PaymentQuoteBinding,
} from "../../types/index.ts"

/** Standalone boundary: this module has no dependency on A, order creation or payment execution. */
export class PaymentInputError extends Error {
  readonly code = "INVALID_INPUT"
  constructor(message: string) { super(message); this.name = "PaymentInputError" }
}

const defaults: Record<string, number> = { HKD: 2, CNY: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0 }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 512
const money = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const bps = (v: unknown): v is number => money(v) && v <= 10000
const timestamp = (v: unknown): v is string => typeof v === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
const decimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,11})(\.\d{1,12})?$/.test(v) && Number(v) > 0

function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new PaymentInputError(message)
}
function shape(value: unknown, keys: string[], path: string): asserts value is Record<string, unknown> {
  ensure(isObject(value), `${path} 必须为对象`)
  ensure(Object.keys(value).every(k => keys.includes(k)), `${path} 包含未支持字段；仅传卡片引用和标准条款`)
}
function fact<T>(value: unknown, accepts: (v: unknown) => boolean, path: string): asserts value is Fact<T> {
  shape(value, ["value", "source", "fetchedAt", "status", "validUntil"], path)
  ensure(value.value === null || accepts(value.value), `${path}.value 无效`)
  ensure(["verified", "unverified", "mock"].includes(String(value.status)), `${path}.status 无效`)
  const missing = value.value === null && value.status === "unverified" && value.source === "" && value.fetchedAt === ""
  ensure(missing || text(value.source) && timestamp(value.fetchedAt), `${path} 缺少来源/获取时间`)
  ensure(value.validUntil === undefined || timestamp(value.validUntil), `${path}.validUntil 无效`)
  ensure(value.source !== "mock-dataset" || value.status === "mock", `${path} 的模拟来源不能标记为 verified`)
  if (value.validUntil && timestamp(value.fetchedAt)) ensure(Date.parse(String(value.validUntil)) > Date.parse(value.fetchedAt), `${path} 有效期必须晚于获取时间`)
}
function offer(value: unknown): value is PaymentInstantOffer {
  shape(value, ["minSpendMinor", "rateBps", "amountMinor", "capMinor"], "instantOffer")
  return money(value.minSpendMinor) && bps(value.rateBps) && money(value.amountMinor) && (value.capMinor === null || money(value.capMinor))
}
function binding(value: unknown, units: Record<string, number>, path: string): asserts value is PaymentQuoteBinding {
  shape(value, ["productId", "skuId", "offerId", "quantity", "destination", "currency", "totalMinor"], path)
  ensure([value.productId, value.skuId, value.offerId, value.destination].every(text), `${path} 需要明确商品、SKU、Offer 和配送地`)
  ensure(money(value.quantity) && value.quantity > 0 && money(value.totalMinor), `${path} 数量或总价无效`)
  ensure(typeof value.currency === "string" && Object.hasOwn(units, value.currency), `${path} 币种未配置最小单位`)
}
function validate(order: PaymentOrder | null, context: PaymentContext, policy: PaymentOptimizationPolicy) {
  ensure(isObject(policy) && text(policy.policyVersion), "payment policyVersion 必填")
  ensure(["development_mock", "verified_sources"].includes(policy.dataEnvironment), "payment dataEnvironment 无效")
  const ttl = policy.factTtlMs ?? 300000
  ensure(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 86400000, "支付事实 TTL 必须在 1ms..24h 内")
  ensure(policy.currencyMinorUnits === undefined || isObject(policy.currencyMinorUnits), "currencyMinorUnits 无效")
  const units = { ...defaults, ...policy.currencyMinorUnits }
  ensure(Object.entries(units).every(([k, v]) => /^[A-Z]{3}$/.test(k) && Number.isInteger(v) && v >= 0 && v <= 6), "币种及最小单位位数无效")
  shape(context, ["taskId", "requirementVersion", "quote", "methods", "comparisonRates"], "paymentContext")
  ensure(text(context.taskId) && money(context.requirementVersion), "支付任务/版本无效")
  binding(context.quote, units, "paymentContext.quote")
  ensure(Array.isArray(context.methods) && context.methods.length <= 50, "methods 必须为数组，最多 50 个方案")
  const ids = new Set<string>()
  for (const m of context.methods) {
    shape(m, ["optionId", "cardId", "label", "paymentChannel", "billingCurrency", "eligible", "settlementRate", "feeBps", "fixedFeeMinor", "instantOffer", "futureCashbackMinor"], "payment method")
    ensure([m.optionId, m.cardId, m.label, m.paymentChannel].every(text), "支付方案需要 ID、卡片引用、名称和渠道")
    ensure(typeof m.billingCurrency === "string" && Object.hasOwn(units, m.billingCurrency), "卡片账单币种未配置")
    ensure(!ids.has(m.optionId as string), "重复 optionId")
    ids.add(m.optionId as string)
    fact(m.eligible, v => typeof v === "boolean", "eligible")
    fact(m.feeBps, bps, "feeBps")
    fact(m.fixedFeeMinor, money, "fixedFeeMinor")
    fact(m.instantOffer, offer, "instantOffer")
    if (m.settlementRate !== null) fact(m.settlementRate, decimal, "settlementRate")
    if (m.billingCurrency === context.quote.currency && isObject(m.settlementRate) && m.settlementRate.value !== null) {
      ensure(Number(m.settlementRate.value) === 1, "同币种结算汇率必须为 1")
    }
    if (m.futureCashbackMinor !== undefined && m.futureCashbackMinor !== null) fact(m.futureCashbackMinor, money, "futureCashbackMinor")
  }
  ensure(Array.isArray(context.comparisonRates) && context.comparisonRates.length <= 50, "comparisonRates 无效")
  const pairs = new Set<string>()
  for (const rate of context.comparisonRates) {
    shape(rate, ["fromCurrency", "toCurrency", "rate"], "comparisonRate")
    ensure(typeof rate.fromCurrency === "string" && Object.hasOwn(units, rate.fromCurrency) && rate.toCurrency === context.quote.currency, "比较汇率方向必须为账单币种 → 订单币种")
    ensure(rate.fromCurrency !== rate.toCurrency && !pairs.has(rate.fromCurrency), "重复或同币种比较汇率")
    pairs.add(rate.fromCurrency)
    fact(rate.rate, decimal, "comparisonRate.rate")
  }
  if (order !== null) {
    shape(order, ["taskId", "requirementVersion", "quote", "total", "maxUpfrontMinor"], "paymentOrder")
    ensure(order.taskId === context.taskId && order.requirementVersion === context.requirementVersion, "支付上下文任务或需求版本已过期")
    binding(order.quote, units, "paymentOrder.quote")
    fact(order.total, money, "paymentOrder.total")
    ensure(order.maxUpfrontMinor === null || money(order.maxUpfrontMinor), "maxUpfrontMinor 无效")
  }
  return { units, ttl }
}

const zero = BigInt(0), one = BigInt(1), ten = BigInt(10), basis = BigInt(10000)
const ceil = (n: bigint, d: bigint) => (n + d - one) / d
function integer(n: bigint): number {
  ensure(n >= zero && n <= BigInt(Number.MAX_SAFE_INTEGER), "支付金额计算超出安全整数范围")
  return Number(n)
}
function convert(minor: number, rate: string, fromDigits: number, toDigits: number): number {
  const [whole, fraction = ""] = rate.split(".")
  return integer(ceil(BigInt(minor) * BigInt(whole + fraction) * ten ** BigInt(toDigits), ten ** BigInt(fraction.length + fromDigits)))
}
function sameQuote(a: PaymentQuoteBinding, b: PaymentQuoteBinding) {
  return (Object.keys(a) as (keyof PaymentQuoteBinding)[]).every(k => a[k] === b[k])
}

/** Rank known feasible plans by upfront debit in a shared currency. No authorization is issued. */
export function optimizePaymentMethods(
  rawOrder: PaymentOrder | null,
  rawContext: PaymentContext,
  policy: PaymentOptimizationPolicy,
): PaymentOptimizationResult {
  const { units, ttl } = validate(rawOrder, rawContext, policy)
  const order = structuredClone(rawOrder), context = structuredClone(rawContext)
  const now = policy.now?.() ?? new Date(), at = now.getTime()
  ensure(Number.isFinite(at), "支付审核时间无效")
  const end = (f: Fact<unknown>) => Math.min(Date.parse(f.fetchedAt) + ttl, f.validUntil ? Date.parse(f.validUntil) : Infinity)
  const usable = <T>(f: Fact<T> | null | undefined): f is Fact<T> & { value: T } => !!f && f.value !== null &&
    (f.status === "verified" || f.status === "mock" && policy.dataEnvironment === "development_mock") &&
    Date.parse(f.fetchedAt) <= at && end(f) > at
  const result: PaymentOptimizationResult = {
    taskId: context.taskId, requirementVersion: context.requirementVersion, policyVersion: policy.policyVersion,
    dataEnvironment: policy.dataEnvironment, status: "not_evaluated", objective: "lowest_upfront_charge",
    comparisonCurrency: context.quote.currency, orderSnapshot: order, checkedAt: now.toISOString(),
    evidenceStatus: policy.dataEnvironment === "development_mock" ? "mock" : "verified",
    comparisonComplete: false, recommended: null, evaluations: [], verificationRequests: [],
    warnings: ["支付方式建议不代表最终风控批准；下单前需复核订单、汇率、优惠和授权。"],
  }
  if (policy.dataEnvironment === "development_mock") result.warnings.push("模拟支付比较，不产生交易。")
  if (!order) {
    result.warnings.push("尚无已通过选品审核且报价完整的商品，不比较支付方式。")
    return finish(result)
  }
  if (!sameQuote(order.quote, context.quote) || !usable(order.total) || order.total.value !== order.quote.totalMinor) {
    result.status = "needs_verification"
    result.verificationRequests.push({ optionId: null, fields: ["paymentContext.quote", "paymentOrder.total"], reason: "重新提供与选中商品、数量、地区、金额绑定且未过期的报价和支付条款" })
    return finish(result)
  }
  if (order.maxUpfrontMinor !== null && order.quote.totalMinor > order.maxUpfrontMinor) {
    result.status = "no_available_method"
    result.warnings.push("原订单已经超预算，不能依靠信用卡优惠绕过选品预算检查。")
    return finish(result)
  }
  for (const [i, m] of context.methods.entries()) {
    const prefix = `paymentContext.methods[${i}]`
    const evaluation: PaymentOptionEvaluation = {
      optionId: m.optionId, cardId: m.cardId, label: m.label, paymentChannel: m.paymentChannel,
      billingCurrency: m.billingCurrency, status: "needs_verification", costs: null,
      reasons: [], evidenceFields: ["paymentOrder.total"], validUntil: null,
    }
    result.evaluations.push(evaluation)
    const missing: string[] = []
    const used: Fact<unknown>[] = [order.total]
    function read<T>(f: Fact<T> | null | undefined, path: string): T | null {
      evaluation.evidenceFields.push(path)
      if (!usable(f)) { missing.push(path); return null }
      used.push(f)
      return f.value
    }
    const eligible = read(m.eligible, `${prefix}.eligible`)
    if (eligible === false) { evaluation.status = "ineligible"; evaluation.reasons.push("此卡片/支付方案不适用于当前用户及订单"); continue }
    const feeRate = read(m.feeBps, `${prefix}.feeBps`)
    const fixedFee = read(m.fixedFeeMinor, `${prefix}.fixedFeeMinor`)
    const promotion = read(m.instantOffer, `${prefix}.instantOffer`)
    const sameCurrency = m.billingCurrency === order.quote.currency
    const settlement = sameCurrency && m.settlementRate === null ? "1" : read(m.settlementRate, `${prefix}.settlementRate`)
    const comparisonIndex = context.comparisonRates.findIndex(r => r.fromCurrency === m.billingCurrency && r.toCurrency === order.quote.currency)
    const comparison = sameCurrency ? "1" : read(context.comparisonRates[comparisonIndex]?.rate, `paymentContext.comparisonRates.${m.billingCurrency}.${order.quote.currency}`)
    if (missing.length) {
      evaluation.reasons.push("可用性、手续费、即时优惠或汇率缺失/过期，尚不能比较")
      result.verificationRequests.push({ optionId: m.optionId, fields: missing, reason: evaluation.reasons[0] })
      continue
    }
    // read() has checked every prerequisite. BigInt avoids floating-point money errors.
    const p = promotion!
    const original = order.quote.totalMinor
    const rawDiscount = original >= p.minSpendMinor ? BigInt(original) * BigInt(p.rateBps) / basis + BigInt(p.amountMinor) : zero
    const discountLimit = BigInt(Math.min(original, p.capMinor ?? original))
    const discount = integer(rawDiscount < discountLimit ? rawDiscount : discountLimit)
    try {
      const payable = original - discount
      const principal = convert(payable, settlement!, units[order.quote.currency], units[m.billingCurrency])
      const fee = integer(ceil(BigInt(principal) * BigInt(feeRate!), basis) + BigInt(fixedFee!))
      const charge = integer(BigInt(principal) + BigInt(fee))
      const compared = convert(charge, comparison!, units[m.billingCurrency], units[order.quote.currency])
      const cashback = usable(m.futureCashbackMinor) ? m.futureCashbackMinor.value : null
      if (m.futureCashbackMinor) {
        evaluation.evidenceFields.push(`${prefix}.futureCashbackMinor`)
        if (cashback === null) result.warnings.push(`${m.optionId}: 返现信息未知或过期，不计入成本、预算或排序`)
      }
      evaluation.costs = { instantDiscountMinor: discount, orderPayableMinor: payable, convertedPrincipalMinor: principal,
        feeMinor: fee, chargeMinor: charge, comparisonChargeMinor: compared, futureCashbackMinor: cashback }
      evaluation.validUntil = new Date(Math.min(...used.map(end))).toISOString()
      evaluation.status = order.maxUpfrontMinor !== null && compared > order.maxUpfrontMinor ? "ineligible" : "eligible"
      evaluation.reasons.push(evaluation.status === "ineligible" ? "含支付费用的预计扣款折算后超出预算" : "可用性和当前优惠已核实，按当下扣款比较")
      if (original < p.minSpendMinor) evaluation.reasons.push("未达到即时优惠门槛，按无优惠扣款计算")
    } catch (error) {
      if (!(error instanceof PaymentInputError)) throw error
      evaluation.status = "ineligible"
      evaluation.reasons.push(error.message)
    }
  }
  const eligible = result.evaluations.filter(e => e.status === "eligible").sort((a, b) =>
    a.costs!.comparisonChargeMinor - b.costs!.comparisonChargeMinor || (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0))
  result.comparisonComplete = !result.evaluations.some(e => e.status === "needs_verification")
  result.status = eligible.length ? "ready" : result.comparisonComplete ? "no_available_method" : "needs_verification"
  if (eligible.length) {
    const selected = eligible[0]
    result.recommended = { ...selected, status: "eligible", costs: selected.costs!, validUntil: selected.validUntil!,
      explanation: `在已核实可用方案中，${selected.label} 的预计当下扣款最低：${selected.costs!.chargeMinor} ${selected.billingCurrency} 最小单位，按统一参考汇率折算为 ${selected.costs!.comparisonChargeMinor} ${order.quote.currency} 最小单位。返现不参与排序；同价按 optionId 稳定排序。` }
  }
  if (!result.comparisonComplete) result.warnings.push("部分方案待核验；推荐只代表已核实方案中的最低扣款，不能断言所有卡片中最优。")
  if (!context.methods.length) result.warnings.push("主 Agent 未提供可用信用卡方案。")
  return finish(result)
}

function finish(result: PaymentOptimizationResult): PaymentOptimizationResult {
  assertOutput(result)
  return structuredClone(result)
}

function assertOutput(result: PaymentOptimizationResult) {
  ensure((result.status === "ready") === (result.recommended !== null), "支付输出状态与推荐不一致")
  for (const e of result.evaluations) {
    if (e.costs) {
      ensure(Object.values(e.costs).every(v => v === null || money(v)), "支付输出金额无效")
      ensure(e.costs.convertedPrincipalMinor + e.costs.feeMinor === e.costs.chargeMinor, "支付费用明细不一致")
    }
    if (e.status === "eligible") ensure(e.costs !== null && timestamp(e.validUntil), "合格支付方案缺少金额或有效期")
  }
}
