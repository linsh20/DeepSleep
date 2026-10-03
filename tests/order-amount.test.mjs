import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import ts from "typescript"
import { mockOrderPricing } from "../examples/order-pricing.mock.mjs"

const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  module._compile(outputText, filename)
}
const { preparePaymentHandoff } = requireTS("../services/order-amount.ts")
const { createProductSelection } = requireTS("../services/product-selection.ts")
const { createProductSearch } = requireTS("../services/product-search.ts")
const { MockProductProvider } = requireTS("../services/product-provider.ts")
const now = new Date("2026-10-04T02:00:00Z")
const options = { allowMock: true, now: () => now }
async function fixture() {
  const request = JSON.parse(readFileSync(new URL("../examples/select-product.request.json", import.meta.url), "utf8"))
  const { searchProducts } = createProductSearch(new MockProductProvider())
  const { selection } = await createProductSelection(searchProducts)(request)
  selection.quantity = 2
  selection.candidate.offer.priceHkd.value = 100
  return { selection, input: mockOrderPricing(selection, now) }
}

test("level 1 calculates quantity, shipping, order discount and immediate card benefit in HKD", async () => {
  const { selection, input } = await fixture()
  input.pricing.value.orderDiscountHkd = 10
  const original = structuredClone({ selection, input })
  const result = preparePaymentHandoff(selection, input, options)
  assert.equal(result.status, "ready")
  const amount = result.selection.orderAmount
  assert.equal(amount.itemsSubtotalHkd, 200)
  assert.equal(amount.beforeCardDiscountHkd, 210)
  assert.equal(amount.cardDiscountHkd, 21)
  assert.equal(amount.merchantPayableHkd, 189)
  assert.equal(amount.totalHkd, 189)
  assert.equal(amount.billingTotal, 189)
  assert.equal(amount.paymentMethodId, "card-ref-1")
  assert.equal(amount.evidenceStatus, "mock")
  assert.equal(amount.evidence.source, "mock-dataset")
  assert.equal(amount.validUntil, "2026-10-04T02:05:00.000Z")
  assert.ok(!JSON.stringify(result).includes("Minor"))
  assert.equal("url" in result.selection.candidate, false)
  assert.deepEqual({ selection, input }, original)
})

test("FX spread and fees count toward HKD total; future cashback does not", async () => {
  const { selection, input } = await fixture()
  Object.assign(input.pricing.value, { billingCurrency: "USD", settlementRate: "0.13", referenceRateToHkd: "7.8",
    feePercent: 2, fixedFeeBillingAmount: 1, futureCashbackHkd: 80 })
  const result = preparePaymentHandoff(selection, input, options)
  assert.equal(result.status, "ready")
  const amount = result.selection.orderAmount
  assert.equal(amount.merchantPayableHkd, 198)
  assert.equal(amount.billingPrincipal, 25.74)
  assert.equal(amount.billingFee, 1.52)
  assert.equal(amount.billingTotal, 27.26)
  assert.equal(amount.totalHkd, 212.63)
  assert.equal(amount.futureCashbackHkd, 80)
})

test("immediate benefit respects minimum spend, cap, and the payable amount", async () => {
  const { selection, input } = await fixture()
  input.pricing.value.cardOffer.minSpendHkd = 300
  assert.equal(preparePaymentHandoff(selection, input, options).selection.orderAmount.totalHkd, 220)
  input.pricing.value.cardOffer = { minSpendHkd: 0, discountPercent: 50, discountHkd: 10, capHkd: 30 }
  assert.equal(preparePaymentHandoff(selection, input, options).selection.orderAmount.totalHkd, 190)
  input.pricing.value.cardOffer = { minSpendHkd: 0, discountPercent: 100, discountHkd: 10, capHkd: null }
  assert.equal(preparePaymentHandoff(selection, input, options).selection.orderAmount.totalHkd, 0)
})

test("missing costs or FX never become free shipping or a guessed exchange rate", async () => {
  const { selection, input } = await fixture()
  for (const field of ["unitPriceHkd", "shippingHkd", "orderDiscountHkd", "eligible", "feePercent", "fixedFeeBillingAmount", "cardOffer"]) {
    const changed = structuredClone(input)
    changed.pricing.value[field] = null
    const result = preparePaymentHandoff(selection, changed, options)
    assert.equal(result.status, "needs_verification", field)
    assert.equal(result.selection, null)
  }
  for (const field of ["settlementRate", "referenceRateToHkd"]) {
    const changed = structuredClone(input)
    Object.assign(changed.pricing.value, { billingCurrency: "USD", settlementRate: "0.13", referenceRateToHkd: "7.8", [field]: null })
    assert.equal(preparePaymentHandoff(selection, changed, options).status, "needs_verification")
  }
})

test("Mock needs explicit opt-in; stale, future, and unverified quotes cannot be handed off", async () => {
  const { selection, input } = await fixture()
  assert.equal(preparePaymentHandoff(selection, input, { now: () => now }).status, "needs_verification")
  for (const patch of [
    { status: "unverified", source: "unverified-quote" },
    { fetchedAt: "2026-10-04T01:00:00Z", validUntil: "2026-10-04T01:05:00Z" },
    { fetchedAt: "2026-10-04T02:01:00Z", validUntil: "2026-10-04T02:06:00Z" },
  ]) {
    const changed = structuredClone(input)
    Object.assign(changed.pricing, patch)
    assert.equal(preparePaymentHandoff(selection, changed, options).status, "needs_verification")
  }
  input.pricing.source = "trusted-quote-adapter"
  input.pricing.status = "verified"
  assert.equal(preparePaymentHandoff(selection, input, { now: () => now }).selection.orderAmount.evidenceStatus, "verified")
})

test("quote is bound to exact task/version, candidate identity, quantity and destination", async () => {
  const { selection, input } = await fixture()
  for (const [field, value] of Object.entries({ taskId: "other", requirementVersion: 2, productId: "other",
    skuId: "other", offerId: "other", quantity: 3, destination: "other" })) {
    const result = preparePaymentHandoff(selection, { ...input, [field]: value }, options)
    assert.equal(result.status, "failed", field)
    assert.equal(result.error.code, "INVALID_INPUT")
    assert.equal(result.selection, null)
  }
  input.pricing.value.unitPriceHkd = 101
  assert.equal(preparePaymentHandoff(selection, input, options).status, "needs_verification")
})

test("invalid money and rates are rejected; ineligible card does not yield a payable selection", async () => {
  const { selection, input } = await fixture()
  for (const patch of [{ shippingHkd: -1 }, { shippingHkd: 1.005 }, { shippingHkd: Infinity },
    { orderDiscountHkd: 221 }, { feePercent: 101 }, { settlementRate: "0" }, { referenceRateToHkd: "2" },
    { billingCurrency: "JPY", fixedFeeBillingAmount: 0.5 }, { billingCurrency: "XXX" }]) {
    const changed = structuredClone(input)
    Object.assign(changed.pricing.value, patch)
    assert.equal(preparePaymentHandoff(selection, changed, options).status, "failed", JSON.stringify(patch))
  }
  input.pricing.value.eligible = false
  const result = preparePaymentHandoff(selection, input, options)
  assert.equal(result.status, "no_available_method")
  assert.equal(result.selection, null)
})

test("fractional HKD and zero-digit billing currencies use deterministic conservative rounding", async () => {
  const { selection, input } = await fixture()
  selection.candidate.offer.priceHkd.value = input.pricing.value.unitPriceHkd = 0.1
  Object.assign(input.pricing.value, { shippingHkd: 0.1, billingCurrency: "JPY", settlementRate: "19.5", referenceRateToHkd: "0.05" })
  const amount = preparePaymentHandoff(selection, input, options).selection.orderAmount
  assert.equal(amount.beforeCardDiscountHkd, 0.3)
  assert.equal(amount.cardDiscountHkd, 0.03)
  assert.equal(amount.billingTotal, 6)
  assert.equal(amount.totalHkd, 0.3)
})
