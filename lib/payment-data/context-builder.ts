import type { Fact, FactStatus, PaymentContext, PaymentInstantOffer, PaymentQuoteBinding } from "../../types/index.ts"
import { PaymentRepository, type PaymentRuleRow } from "./repository.ts"

export type BuildPaymentContextInput = {
  userId: string
  taskId: string
  requirementVersion: number
  quote: PaymentQuoteBinding
  category: string | null
  merchantId: string | null
  acceptedPaymentChannels: string[] | null
  acceptedNetworks: string[] | null
  now?: Date
}

const unknown = <T>(): Fact<T> => ({ value: null, source: "", fetchedAt: "", status: "unverified" })
const fact = <T>(row: PaymentRuleRow | null | undefined, value: T | null): Fact<T> => row &&
  !(row.source === "mock-dataset" && row.evidence_status !== "mock") ? {
  value,
  source: String(row.source),
  fetchedAt: String(row.fetched_at),
  status: row.evidence_status as FactStatus,
  ...(row.valid_until ? { validUntil: String(row.valid_until) } : {}),
} : unknown<T>()
const applies = (row: PaymentRuleRow, input: BuildPaymentContextInput) =>
  (!row.eligible_category || input.category === row.eligible_category) &&
  (!row.eligible_merchant_id || input.merchantId === row.eligible_merchant_id)
const discount = (amount: number, row: PaymentRuleRow) => Math.min(amount,
  Math.floor(amount * Number(row.rate_bps) / 10000) + Number(row.amount_minor))

/** Builds the exact existing Agent B contract; it does not rank cards or authorize payment. */
export function buildPaymentContext(repository: PaymentRepository, input: BuildPaymentContextInput): PaymentContext {
  if (!input?.userId || !input.taskId || !input.quote) throw new TypeError("userId、taskId 和 quote 必填")
  if (!Number.isSafeInteger(input.requirementVersion) || input.requirementVersion < 0) throw new TypeError("requirementVersion 无效")
  const period = (input.now ?? new Date()).toISOString().slice(0,7)
  const methods = repository.cards(input.userId).map(card => {
    const cardId = String(card.card_id), billingCurrency = String(card.billing_currency)
    const fee = repository.fee(cardId)
    const instantRows = repository.benefits(cardId,"instant_discount")
    const usableInstant = instantRows.filter(row => applies(row,input))
    const instantCandidate = usableInstant.length === 1 ? usableInstant[0] : undefined
    const instant = instantCandidate?.cap_verified === 1 ? instantCandidate : undefined
    const futureRows = repository.benefits(cardId,"future_cashback").filter(row => applies(row,input))
    const future = futureRows.length === 1 ? futureRows[0] : undefined
    const supported = card.status === "active" && input.acceptedPaymentChannels !== null && input.acceptedNetworks !== null
      ? input.acceptedPaymentChannels.includes(String(card.payment_channel)) && input.acceptedNetworks.includes(String(card.network))
      : card.status === "inactive" ? false : null
    let offer: PaymentInstantOffer | null = null
    if (instant) {
      let cap = instant.per_tx_cap_minor as number | null
      if (instant.monthly_cap_minor !== null) {
        const remaining = Math.max(0, Number(instant.monthly_cap_minor) - repository.usage(input.userId,String(instant.benefit_id),period))
        cap = cap === null ? remaining : Math.min(Number(cap),remaining)
      }
      offer = { minSpendMinor:Number(instant.min_spend_minor), rateBps:Number(instant.rate_bps),
        amountMinor:Number(instant.amount_minor), capMinor:cap }
    }
    const settlement = billingCurrency === input.quote.currency ? null : repository.settlementRate(cardId,input.quote.currency,billingCurrency)
    const cashback = future ? discount(input.quote.totalMinor,future) : null
    return {
      optionId: instant ? `${cardId}:${String(instant.benefit_id)}` : cardId,
      cardId, label:String(card.label), paymentChannel:String(card.payment_channel), billingCurrency,
      eligible: supported === null ? unknown<boolean>() : {
        value:supported, source:"merchant-payment-acceptance", fetchedAt:(input.now ?? new Date()).toISOString(), status:"mock" as const,
      },
      settlementRate: billingCurrency === input.quote.currency ? null : fact(settlement, settlement ? String(settlement.rate_text) : null),
      feeBps: fact(fee, fee?.fee_bps === null || !fee ? null : Number(fee.fee_bps)),
      fixedFeeMinor: fact(fee, fee?.fixed_fee_minor === null || !fee ? null : Number(fee.fixed_fee_minor)),
      instantOffer: fact(instant,offer),
      futureCashbackMinor: future ? fact(future,cashback) : unknown<number>(),
    }
  })
  const billingCurrencies = [...new Set(methods.map(method => method.billingCurrency).filter(currency => currency !== input.quote.currency))]
  return {
    taskId:input.taskId, requirementVersion:input.requirementVersion, quote:structuredClone(input.quote), methods,
    comparisonRates: billingCurrencies.map(currency => {
      const row = repository.referenceRate(currency,input.quote.currency)
      return { fromCurrency:currency, toCurrency:input.quote.currency, rate:fact(row,row ? String(row.rate_text) : null) }
    }),
  }
}
