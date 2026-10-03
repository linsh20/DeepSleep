import test from "node:test"
import assert from "node:assert/strict"
import { optimizePaymentMethods, PaymentInputError } from "./payment.ts"
import { evaluateShoppingCandidates, explainDecision, checkShoppingPurchase } from "./contract.ts"
import { createContractShoppingAgent } from "./workflow.ts"
import type { Fact, PaymentMethodOption, PaymentOrder, PaymentContext, PaymentOptimizationPolicy, ContractEvaluationInput, ContractBPolicy } from "../../types/index.ts"

const now = new Date("2026-10-03T08:00:00.000Z")
const f = <T>(value: T): Fact<T> => ({ value, source: "issuer-terms", fetchedAt: now.toISOString(), status: "verified" })
const method = (id: string): PaymentMethodOption => ({
  optionId: id, cardId: `card-${id}`, label: `卡片 ${id}`, paymentChannel: "credit_card", billingCurrency: "HKD",
  eligible: f(true), settlementRate: null, feeBps: f(0), fixedFeeMinor: f(0),
  instantOffer: f({ minSpendMinor: 0, rateBps: 0, amountMinor: 0, capMinor: null }),
})
function setup(): { order: PaymentOrder; context: PaymentContext; policy: PaymentOptimizationPolicy } {
  const quote = { productId: "p", skuId: "s", offerId: "o", quantity: 1, destination: "香港", currency: "HKD", totalMinor: 20000 }
  return {
    order: { taskId: "task", requirementVersion: 1, quote: { ...quote }, total: f(20000), maxUpfrontMinor: 22000 },
    context: { taskId: "task", requirementVersion: 1, quote, methods: [method("hkd")], comparisonRates: [] },
    policy: { policyVersion: "test", dataEnvironment: "verified_sources", now: () => now },
  }
}
function integrationSetup() {
  const { context, policy } = setup()
  const input: ContractEvaluationInput = {
    requirement: { taskId: "task", requirementVersion: 1, category: "乳液", query: "乳液", currency: "HKD",
      budget: { maxMinor: 22000, scope: "delivered" }, destination: "香港", hardConstraints: [], preferences: [], excludedProductIds: [] },
    quantity: 1, sourceTaskId: "task", sourceRequirementVersion: 1, searchStatus: "complete", paymentContext: context,
    candidates: [{ productId: "p", skuId: "s", offerId: "o", title: "乳液", url: "https://example.com/p",
      attributes: { category: f("乳液") }, merchant: { id: "seller", name: f("店铺"), platformId: f("platform") },
      offer: { currency: "HKD", itemPriceMinor: f(19000), shippingMinor: f(1000), discountMinor: f(0), stock: f("available"), deliverable: f(true) },
      quote: { quantity: 1, destination: "香港", totalMinor: f(20000), otherFeesMinor: f(0), estimatedDeliveryAtMs: { ...f(0), value: null } }, missingFields: [] }],
  }
  const bPolicy: ContractBPolicy = { ...policy, merchantAllowlist: [{ id: "seller", platformId: "platform" }], priceBenchmarks: [] }
  return { input, policy: bPolicy }
}

test("ranks upfront costs across currencies including capped instant discount and card fees, not cashback", () => {
  const { order, context, policy } = setup()
  context.methods[0].futureCashbackMinor = f(10000)
  const cny = { ...method("cny"), billingCurrency: "CNY", settlementRate: f("0.92"), feeBps: f(100), fixedFeeMinor: f(100),
    instantOffer: f({ minSpendMinor: 20000, rateBps: 1000, amountMinor: 0, capMinor: 1500 }) }
  context.methods.push(cny)
  context.comparisonRates = [{ fromCurrency: "CNY", toCurrency: "HKD", rate: f("1.08") }]
  const output = optimizePaymentMethods(order, context, policy)
  assert.equal(output.status, "ready")
  assert.equal(output.recommended!.optionId, "cny")
  assert.deepEqual(output.recommended!.costs, { instantDiscountMinor: 1500, orderPayableMinor: 18500,
    convertedPrincipalMinor: 17020, feeMinor: 271, chargeMinor: 17291, comparisonChargeMinor: 18675, futureCashbackMinor: null })
  assert.equal(output.evaluations[0].costs!.futureCashbackMinor, 10000)
  assert.equal(output.objective, "lowest_upfront_charge")
})
test("shared reference FX preserves card exchange spreads instead of cancelling them", () => {
  const { order, context, policy } = setup()
  context.methods = ["0.9", "1.0"].map((rate, i) => ({ ...method(`c${i}`), billingCurrency: "CNY", settlementRate: f(rate) }))
  context.comparisonRates = [{ fromCurrency: "CNY", toCurrency: "HKD", rate: f("1.1") }]
  const result = optimizePaymentMethods(order, context, policy)
  assert.equal(result.recommended!.optionId, "c0")
  assert.deepEqual(result.evaluations.map(e => e.costs!.comparisonChargeMinor), [19800, 22000])
})
test("offer thresholds use pre-card order amount; effective cap, zero discount and flooring are explicit", () => {
  const { order, context, policy } = setup()
  context.methods[0].instantOffer = f({ minSpendMinor: 20001, rateBps: 1000, amountMinor: 500, capMinor: null })
  assert.equal(optimizePaymentMethods(order, context, policy).recommended!.costs.instantDiscountMinor, 0)
  context.methods[0].instantOffer = f({ minSpendMinor: 20000, rateBps: 1000, amountMinor: 500, capMinor: 700 })
  assert.equal(optimizePaymentMethods(order, context, policy).recommended!.costs.instantDiscountMinor, 700)
  order.total.value = order.quote.totalMinor = context.quote.totalMinor = 101
  context.methods[0].instantOffer = f({ minSpendMinor: 0, rateBps: 1000, amountMinor: 0, capMinor: null })
  assert.equal(optimizePaymentMethods(order, context, policy).recommended!.costs.instantDiscountMinor, 10)
})
test("currency minor units handle JPY and explicit three-decimal currency configuration", () => {
  const { order, context, policy } = setup()
  context.methods = [{ ...method("jpy"), billingCurrency: "JPY", settlementRate: f("20") }]
  context.comparisonRates = [{ fromCurrency: "JPY", toCurrency: "HKD", rate: f("0.05") }]
  assert.equal(optimizePaymentMethods(order, context, policy).recommended!.costs.chargeMinor, 4000)
  policy.currencyMinorUnits = { KWD: 3 }
  context.methods = [{ ...method("kwd"), billingCurrency: "KWD", settlementRate: f("0.04") }]
  context.comparisonRates = [{ fromCurrency: "KWD", toCurrency: "HKD", rate: f("25") }]
  const cost = optimizePaymentMethods(order, context, policy).recommended!.costs
  assert.equal(cost.chargeMinor, 8000)
  assert.equal(cost.comparisonChargeMinor, 20000)
})
test("fees cannot cross the delivered budget; cashback and card discounts do not rescue rejected orders", () => {
  const { order, context, policy } = setup()
  order.maxUpfrontMinor = 20000
  context.methods[0].fixedFeeMinor = f(1)
  context.methods[0].futureCashbackMinor = f(20000)
  assert.equal(optimizePaymentMethods(order, context, policy).status, "no_available_method")
  order.maxUpfrontMinor = 19000
  context.methods[0].instantOffer.value!.amountMinor = 5000
  assert.equal(optimizePaymentMethods(order, context, policy).status, "no_available_method")
})
test("unknown or expired terms request verification while retaining known feasible alternatives", () => {
  for (const alter of [
    (m: PaymentMethodOption) => { m.eligible.value = null },
    (m: PaymentMethodOption) => { m.feeBps.value = null },
    (m: PaymentMethodOption) => { m.instantOffer.value = null },
    (m: PaymentMethodOption) => { m.fixedFeeMinor.fetchedAt = "2026-10-03T07:00:00Z" },
    (m: PaymentMethodOption) => { m.instantOffer.validUntil = now.toISOString(); m.instantOffer.fetchedAt = "2026-10-03T07:59:00Z" },
    (m: PaymentMethodOption) => { m.eligible.fetchedAt = "2026-10-03T08:01:00Z" },
  ]) {
    const { order, context, policy } = setup()
    alter(context.methods[0])
    assert.equal(optimizePaymentMethods(order, context, policy).status, "needs_verification")
    context.methods.push(method("known"))
    const result = optimizePaymentMethods(order, context, policy)
    assert.equal(result.status, "ready")
    assert.equal(result.recommended!.optionId, "known")
    assert.equal(result.comparisonComplete, false)
    assert.equal(result.verificationRequests.length, 1)
  }
})
test("cross-currency comparison needs both card settlement rate and common comparison rate", () => {
  const { order, context, policy } = setup()
  context.methods[0].billingCurrency = "USD"
  let result = optimizePaymentMethods(order, context, policy)
  assert.equal(result.status, "needs_verification")
  assert.equal(result.verificationRequests[0].fields.length, 2)
  context.methods[0].settlementRate = f("0.128")
  result = optimizePaymentMethods(order, context, policy)
  assert.equal(result.verificationRequests[0].fields.length, 1)
})
test("quote binding, expiry and task versions prevent reuse after order changes", () => {
  for (const key of ["productId", "skuId", "offerId", "destination", "currency"] as const) {
    const { order, context, policy } = setup()
    order.quote[key] = key === "currency" ? "USD" : "changed"
    assert.equal(optimizePaymentMethods(order, context, policy).status, "needs_verification")
  }
  for (const alter of [
    (o: PaymentOrder) => { o.quote.quantity = 2 },
    (o: PaymentOrder) => { o.quote.totalMinor++ },
    (o: PaymentOrder) => { o.total.fetchedAt = "2026-10-03T07:00:00Z" },
  ]) {
    const { order, context, policy } = setup(); alter(order)
    assert.equal(optimizePaymentMethods(order, context, policy).status, "needs_verification")
  }
  const { order, context, policy } = setup()
  context.requirementVersion++
  assert.throws(() => optimizePaymentMethods(order, context, policy), PaymentInputError)
})
test("no order, no methods and unavailable cards have distinct results", () => {
  const { order, context, policy } = setup()
  assert.equal(optimizePaymentMethods(null, context, policy).status, "not_evaluated")
  context.methods[0].eligible = f(false)
  assert.equal(optimizePaymentMethods(order, context, policy).status, "no_available_method")
  context.methods = []
  assert.equal(optimizePaymentMethods(order, context, policy).status, "no_available_method")
})
test("mock payment facts remain mock; unknown optional cashback never changes the ranking", () => {
  const { order, context, policy } = setup()
  context.methods[0].feeBps.status = "mock"
  assert.equal(optimizePaymentMethods(order, context, policy).status, "needs_verification")
  policy.dataEnvironment = "development_mock"
  context.methods[0].futureCashbackMinor = { ...f(10000), status: "unverified" }
  const result = optimizePaymentMethods(order, context, policy)
  assert.equal(result.status, "ready")
  assert.equal(result.evidenceStatus, "mock")
  assert.equal(result.recommended!.costs.futureCashbackMinor, null)
})
test("rejects ambiguous amounts, rates, duplicate IDs, extra card data and invalid provenance", () => {
  const mutations: ((c: PaymentContext) => void)[] = [
    c => { c.methods[0].feeBps.value = -1 },
    c => { c.methods[0].fixedFeeMinor.value = 1.5 },
    c => { c.methods[0].settlementRate = f("0.9") }, // same currency
    c => { c.methods[0].settlementRate = f("1e-2") },
    c => { c.methods.push(structuredClone(c.methods[0])) },
    c => { c.methods[0].billingCurrency = "ZZZ" },
    c => { Object.assign(c.methods[0], { cardNumber: "not-allowed" }) },
    c => { c.methods[0].eligible.source = "mock-dataset" },
    c => { c.methods[0].eligible.fetchedAt = "yesterday" },
    c => { c.methods[0].instantOffer.value!.rateBps = 10001 },
    c => { c.comparisonRates = [{ fromCurrency: "USD", toCurrency: "CNY", rate: f("7") }] },
  ]
  for (const mutate of mutations) {
    const { order, context, policy } = setup(); mutate(context)
    assert.throws(() => optimizePaymentMethods(order, context, policy), PaymentInputError)
  }
})
test("exact integer math handles free orders and overflow without selecting an unsafe option", () => {
  const { order, context, policy } = setup()
  order.total.value = order.quote.totalMinor = context.quote.totalMinor = Number.MAX_SAFE_INTEGER
  order.maxUpfrontMinor = null
  context.methods[0].fixedFeeMinor = f(1)
  assert.equal(optimizePaymentMethods(order, context, policy).status, "no_available_method")
  context.methods[0].instantOffer = f({ minSpendMinor: 0, rateBps: 10000, amountMinor: Number.MAX_SAFE_INTEGER, capMinor: null })
  context.methods[0].fixedFeeMinor = f(0)
  assert.equal(optimizePaymentMethods(order, context, policy).recommended!.costs.chargeMinor, 0)
})
test("ties are stable and cashback does not win ties; snapshots and conservative expiry are preserved", () => {
  const { order, context, policy } = setup()
  context.methods = [method("b"), method("a")]
  context.methods[0].futureCashbackMinor = f(20000)
  context.methods[1].feeBps.validUntil = "2026-10-03T08:01:00Z"
  const result = optimizePaymentMethods(order, context, policy)
  assert.equal(result.recommended!.optionId, "a")
  assert.equal(result.recommended!.validUntil, "2026-10-03T08:01:00.000Z")
  order.total.value = 1
  context.methods[1].label = "changed"
  assert.equal(result.orderSnapshot!.total.value, 20000)
  assert.notEqual(result.recommended!.label, "changed")
})
test("B returns payment optimization and persists inputs, calculations and explanation in decision record", async () => {
  const { input, policy } = integrationSetup()
  const result = await evaluateShoppingCandidates(input, policy)
  assert.equal(result.status, "result_ready")
  assert.equal(result.paymentOptimization!.status, "ready")
  assert.deepEqual(result.decisionRecord.paymentOptimization, result.paymentOptimization)
  assert.match(explainDecision(result.decisionRecord), /预计当下扣款最低/)
  input.paymentContext!.methods[0].label = "changed"
  assert.notEqual(result.decisionRecord.paymentContextSnapshot!.methods[0].label, "changed")
  delete input.paymentContext
  assert.equal((await evaluateShoppingCandidates(input, policy)).paymentOptimization, undefined)
})
test("B never optimizes a rejected offer or a partial item-only quote; component expiry binds payment output", async () => {
  const { input, policy } = integrationSetup()
  input.requirement.budget.maxMinor = 19000
  assert.equal((await evaluateShoppingCandidates(input, policy)).paymentOptimization!.status, "not_evaluated")
  input.requirement.budget.scope = "item"
  input.candidates[0].offer!.shippingMinor.value = null
  const partial = await evaluateShoppingCandidates(input, policy)
  assert.equal(partial.status, "result_ready")
  assert.equal(partial.paymentOptimization!.status, "not_evaluated")
  input.candidates[0].offer!.shippingMinor = { ...f(1000), validUntil: "2026-10-03T08:00:20Z" }
  assert.equal((await evaluateShoppingCandidates(input, policy)).paymentOptimization!.recommended!.validUntil, "2026-10-03T08:00:20.000Z")
})
test("workflow keeps payment data with B and never forwards card information to A", async () => {
  const { input, policy } = integrationSetup()
  const envelope = { taskId: "task", requirementVersion: 1, status: "complete" as const, candidates: input.candidates, warnings: [] }
  const agent = createContractShoppingAgent({ searchCandidates: async request => {
    assert.equal("paymentContext" in request, false)
    return envelope
  }, verifyFacts: async () => envelope }, policy)
  const result = await agent.run({ requirement: input.requirement, quantity: 1, paymentContext: input.paymentContext })
  assert.equal(result.paymentOptimization!.status, "ready")
})
test("purchase precheck with payment context enforces both requirement and backend authorization caps including fees", async () => {
  const { input, policy } = integrationSetup()
  input.paymentContext!.methods[0].fixedFeeMinor = f(100)
  const auth = { authorizationId: "a", allowedOfferId: "o", maxTotalMinor: 20050, maxQuantity: 1, currency: "HKD", expiresAt: "2026-10-03T08:10:00Z" }
  const context = { getAuthorizationById: async () => auth }
  const check = () => checkShoppingPurchase({ ...input, authorizationId: "a" }, policy, context)
  assert.equal((await check()).status, "blocked")
  auth.maxTotalMinor = 22000
  input.requirement.budget.maxMinor = 20050
  assert.equal((await check()).status, "blocked")
  input.requirement.budget.maxMinor = 22000
  assert.equal((await check()).paymentOptimization!.recommended!.costs.chargeMinor, 20100)
  input.paymentContext!.methods[0].feeBps.value = null
  assert.equal((await check()).status, "needsVerification")
  input.paymentContext!.methods[0].feeBps = { ...f(0), fetchedAt: "2026-10-03T07:58:00Z" }
  assert.equal((await evaluateShoppingCandidates(input, policy)).paymentOptimization!.status, "ready")
  assert.equal((await check()).status, "needsVerification")
})
