import type {
  Fact, OrderPricingInput, OrderPricingTerms, PreparePaymentHandoffResult, ProductHandoff,
} from "../types"
import { optimizePaymentMethods, PaymentInputError } from "../lib/agent-b/payment"

const digits = { HKD: 2, CNY: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0 }

function minor(value: number, places = 2): number {
  const pattern = places === 0 ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/
  if (typeof value !== "number" || !pattern.test(String(value)) ||
      !Number.isSafeInteger(Math.round(value * 10 ** places))) {
    throw new PaymentInputError("金额必须为非负元数，HKD 最多两位小数，JPY 必须为整数。")
  }
  return Math.round(value * 10 ** places)
}

/** Level 1: pure calculation, no HTTP, authorization, LLM or transaction. */
export function preparePaymentHandoff(
  selection: ProductHandoff,
  input: OrderPricingInput,
  options: { allowMock?: boolean; now?: () => Date } = {},
): PreparePaymentHandoffResult {
  const result: PreparePaymentHandoffResult = {
    taskId: selection?.taskId ?? "", requirementVersion: selection?.requirementVersion ?? 0,
    status: "needs_verification", selection: null, reasons: [],
  }
  try {
    if (!selection || !input || selection.productCheck?.status !== "passed" ||
        input.taskId !== selection.taskId || input.requirementVersion !== selection.requirementVersion ||
        input.quantity !== selection.quantity || input.destination !== selection.destination ||
        ["productId", "skuId", "offerId"].some(key =>
          input[key as keyof OrderPricingInput] !== selection.candidate[key as keyof typeof selection.candidate])) {
      throw new PaymentInputError("报价必须绑定相同任务、需求版本、商品、SKU、Offer、数量和配送地。")
    }
    const p = input.pricing?.value
    if (!p || [p.unitPriceHkd, p.shippingHkd, p.orderDiscountHkd, p.eligible,
      p.feePercent, p.fixedFeeBillingAmount, p.cardOffer].some(value => value == null) ||
      !selection.destination || !selection.candidate.skuId || !selection.candidate.offerId) {
      result.reasons.push("补充单价、运费、额外折扣、支付方式可用性、手续费及信用卡优惠；未知不能按零处理。")
      return result
    }
    if (p.unitPriceHkd !== selection.candidate.offer?.priceHkd.value) {
      result.reasons.push("报价单价与选品时不同，请刷新商品并重新检查商品条件。")
      return result
    }
    if (!Object.hasOwn(digits, p.billingCurrency)) throw new PaymentInputError("不支持的账单币种。")
    if (p.billingCurrency === "HKD" && p.referenceRateToHkd !== null && p.referenceRateToHkd !== "1") {
      throw new PaymentInputError("HKD 参考汇率必须为 1 或 null。")
    }
    const unitPrice = minor(p.unitPriceHkd!)
    if (!Number.isSafeInteger(selection.quantity) || selection.quantity < 1) throw new PaymentInputError("数量必须为正整数。")
    const subtotal = unitPrice * selection.quantity
    const shipping = minor(p.shippingHkd!)
    const discount = minor(p.orderDiscountHkd!)
    const beforeCard = subtotal + shipping - discount
    if (![subtotal, subtotal + shipping, beforeCard].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new PaymentInputError("整单金额溢出，或额外折扣超过商品金额加运费。")
    }
    const fact = <T>(value: T | null): Fact<T> => ({ ...input.pricing, value })
    const quote = {
      productId: input.productId, skuId: input.skuId, offerId: input.offerId,
      quantity: input.quantity, destination: input.destination!, currency: "HKD", totalMinor: beforeCard,
    }
    const offer = p.cardOffer!
    const payment = optimizePaymentMethods({
      taskId: input.taskId, requirementVersion: input.requirementVersion, quote,
      total: fact(beforeCard), maxUpfrontMinor: null, // Authorization/limits belong to level 2.
    }, {
      taskId: input.taskId, requirementVersion: input.requirementVersion, quote,
      methods: [{
        optionId: p.paymentMethodId, cardId: p.paymentMethodId, label: p.paymentMethodId,
        paymentChannel: "card", billingCurrency: p.billingCurrency, eligible: fact(p.eligible),
        settlementRate: p.settlementRate === null ? null : fact(p.settlementRate),
        feeBps: fact(minor(p.feePercent!)), fixedFeeMinor: fact(minor(p.fixedFeeBillingAmount!, digits[p.billingCurrency])),
        instantOffer: fact({ minSpendMinor: minor(offer.minSpendHkd), rateBps: minor(offer.discountPercent),
          amountMinor: minor(offer.discountHkd), capMinor: offer.capHkd === null ? null : minor(offer.capHkd) }),
        futureCashbackMinor: fact(p.futureCashbackHkd === null ? null : minor(p.futureCashbackHkd)),
      }],
      comparisonRates: p.billingCurrency === "HKD" ? [] : [{
        fromCurrency: p.billingCurrency, toCurrency: "HKD", rate: fact(p.referenceRateToHkd),
      }],
    }, {
      policyVersion: "handoff-v1", dataEnvironment: options.allowMock ? "development_mock" : "verified_sources",
      now: options.now,
    })
    const chosen = payment.recommended
    if (!chosen) {
      result.status = payment.status === "no_available_method" ? "no_available_method" : "needs_verification"
      result.reasons = payment.evaluations.flatMap(e => e.reasons)
      if (!result.reasons.length) result.reasons.push("报价/优惠/汇率缺失、过期或来源不满足要求，请补充。")
      return result
    }
    const costs = chosen.costs, scale = 10 ** digits[p.billingCurrency]
    return {
      ...result, status: "ready", reasons: ["金额已计算，不代表支付授权；下单前二级需复核有效期和授权。"],
      selection: {
        ...structuredClone(selection),
        orderAmount: {
          currency: "HKD", unitPriceHkd: unitPrice / 100, itemsSubtotalHkd: subtotal / 100,
          shippingHkd: shipping / 100, orderDiscountHkd: discount / 100, beforeCardDiscountHkd: beforeCard / 100,
          cardDiscountHkd: costs.instantDiscountMinor / 100, merchantPayableHkd: costs.orderPayableMinor / 100,
          totalHkd: costs.comparisonChargeMinor / 100, paymentMethodId: p.paymentMethodId,
          billingCurrency: p.billingCurrency, billingPrincipal: costs.convertedPrincipalMinor / scale,
          billingFee: costs.feeMinor / scale, billingTotal: costs.chargeMinor / scale,
          settlementRate: p.billingCurrency === "HKD" ? "1" : p.settlementRate!,
          referenceRateToHkd: p.billingCurrency === "HKD" ? "1" : p.referenceRateToHkd!,
          futureCashbackHkd: costs.futureCashbackMinor === null ? null : costs.futureCashbackMinor / 100,
          checkedAt: payment.checkedAt, validUntil: chosen.validUntil,
          evidenceStatus: input.pricing.status === "mock" ? "mock" : "verified",
          evidence: structuredClone(input.pricing) as Fact<OrderPricingTerms>,
        },
      },
    }
  } catch (error) {
    return { ...result, status: "failed", error: {
      code: error instanceof PaymentInputError ? "INVALID_INPUT" : "SOURCE_UNAVAILABLE",
      message: error instanceof PaymentInputError ? error.message : "无法计算整单金额，请检查报价输入。",
    } }
  }
}
