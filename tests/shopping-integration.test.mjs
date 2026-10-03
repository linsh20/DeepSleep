import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import ts from "typescript"

const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  module._compile(outputText, filename)
}
const { createProductSearch } = requireTS("../services/product-search.ts")
const { DeterministicConditionScorer } = requireTS("../services/condition-scorer.ts")
const { WatsonsSqliteProductProvider } = requireTS("../services/watsons-product-provider.ts")
const { createShoppingAgent } = requireTS("../services/shopping-agent.ts")
const now = new Date("2026-10-03T08:00:00.000Z")
const f = value => ({ value, source: "mock-dataset", fetchedAt: now.toISOString(), status: "mock" })
const policy = { policyVersion: "integration-test", dataEnvironment: "development_mock",
  merchantAllowlist: [{ id: "merchant", platformId: "platform" }], priceBenchmarks: [], now: () => now }
const request = () => ({ quantity: 1, requirement: { taskId: "task", requirementVersion: 1, category: "乳液", query: "lotion",
  currency: "HKD", destination: "香港", budget: { maxMinor: 20000, scope: "delivered" },
  hardConstraints: [{ id: "volume", field: "attributes.volumeMl", op: "gte", value: 100 }],
  preferences: [], excludedProductIds: [] },
  searchInput: { taskId: "task", requirementVersion: 1, product_name: { value: "lotion", must: 1 },
    range_conditions: [{ field: "priceMinor", min: null, max: 20000, must: 1 }], include_keywords: [], exclude_keywords: [] } })
const raw = () => ({ productId: "p", skuId: "s", offerId: "o", title: "Lotion 200ml", url: "https://example.com/mock", category: "乳液",
  source: "mock-dataset", fetchedAt: now.toISOString(), status: "mock",
  searchableText: { description: "moisturizing", ingredients: "water" }, attributes: { volumeMl: 200 },
  offer: { currency: "HKD", itemPriceMinor: 17500, shippingMinor: null, discountMinor: null, stock: "available", deliverable: null } })
function search(row = raw()) {
  return createProductSearch({ recall: async () => ({ products: [structuredClone(row)], status: "complete" }) },
    new DeterministicConditionScorer()).searchProducts
}
async function verify({ requirement, quantity, candidates }) {
  return { taskId: requirement.taskId, requirementVersion: requirement.requirementVersion, status: "complete", warnings: [],
    candidates: candidates.map(c => ({ ...c, merchant: { id: "merchant", name: f("模拟商户"), platformId: f("platform") },
      offer: { ...c.offer, shippingMinor: f(1500), discountMinor: f(0), deliverable: f(true) },
      quote: { quantity, destination: requirement.destination, totalMinor: f(17500 * quantity + 1500), otherFeesMinor: f(0),
        estimatedDeliveryAtMs: f(null), canFulfillQuantity: f(true) }, missingFields: [] })) }
}
function payment() {
  const method = (optionId, discount) => ({ optionId, cardId: optionId, label: optionId, paymentChannel: "credit_card", billingCurrency: "HKD",
    eligible: f(true), settlementRate: null, feeBps: f(0), fixedFeeMinor: f(0),
    instantOffer: f({ minSpendMinor: 0, rateBps: 0, amountMinor: discount, capMinor: null }) })
  return { taskId: "task", requirementVersion: 1, quote: { productId: "p", skuId: "s", offerId: "o", quantity: 1,
    destination: "香港", currency: "HKD", totalMinor: 19000 }, methods: [method("card-a", 0), method("card-b", 1000)], comparisonRates: [] }
}

test("real A pipeline -> B -> mock quote verification -> one product and lowest-debit card", async () => {
  const input = { ...request(), paymentContext: payment() }
  const before = structuredClone(input)
  const a = search()
  const agent = createShoppingAgent({ searchProducts: async value => {
    assert.equal("paymentContext" in value, false)
    return a(value)
  }, verifyFacts: verify }, policy)
  const result = await agent.runShoppingTask(input)
  assert.equal(result.status, "result_ready")
  assert.equal(result.recommendations.length, 1)
  assert.equal(result.recommendations[0].offerId, "o")
  assert.equal(result.plan.priceMinor.value, 19000)
  assert.equal(result.paymentOptimization.recommended.cardId, "card-b")
  assert.equal(result.paymentOptimization.recommended.costs.chargeMinor, 18000)
  assert.equal(result.decisionRecord.paymentOptimization.recommended.cardId, "card-b")
  assert.equal(result.verificationRounds, 1)
  assert.equal(result.search.status, "partial") // A's deterministic scoring fallback does not invent verification.
  assert.equal(result.recommendations[0].evidenceStatus, "mock")
  assert.deepEqual(input, before)
})

test("missing merchant/quote service stops without inventing free shipping or verified recommendation", async () => {
  const result = await createShoppingAgent({ searchProducts: search() }, policy).runShoppingTask(request())
  assert.equal(result.status, "needs_verification")
  assert.equal(result.recommendations.length, 0)
  assert.equal(result.stopReason, "no_progress")
  assert.equal(result.verificationRounds, 1)
  assert.ok(result.missingFacts.includes("offer.shippingMinor"))
  assert.ok(result.missingFacts.includes("merchant.platformId"))
  assert.equal(result.candidates[0].offer.shippingMinor.value, null)
})

test("A unknown hard ingredient exclusion remains unknown in B even with a complete quote", async () => {
  const row = raw(); row.searchableText.ingredients = null
  const input = request()
  input.searchInput.exclude_keywords = [{ keywords: ["alcohol"], scope: "ingredients", must: 1 }]
  const result = await createShoppingAgent({ searchProducts: search(row), verifyFacts: verify }, policy).runShoppingTask(input)
  assert.equal(result.status, "needs_verification")
  assert.equal(result.recommendations.length, 0)
  assert.ok(result.missingFacts.includes("searchableText.ingredients"))
  assert.equal(result.diagnostics.candidateChecks[0].checks.find(c => c.conditionId === "search:exclude:0").outcome, "unknown")
})

test("B enforces delivered budget after A's unit-price filter passed", async () => {
  const input = request(); input.requirement.budget.maxMinor = 18000
  const result = await createShoppingAgent({ searchProducts: search(), verifyFacts: verify }, policy).runShoppingTask(input)
  assert.equal(result.search.candidates.length, 1)
  assert.equal(result.status, "no_match")
  assert.ok(result.reason)
  assert.equal(result.recommendations.length, 0)
})

test("task/version mismatch is rejected; search timeouts are bounded", async () => {
  const a = search()
  await assert.rejects(createShoppingAgent({ searchProducts: async input => ({ ...await a(input), requirementVersion: 0 }) }, policy)
    .runShoppingTask(request()), /旧任务/)
  const input = request(); input.searchInput.requirementVersion = 0
  await assert.rejects(createShoppingAgent({ searchProducts: a }, policy).runShoppingTask(input), /版本不匹配/)
  const result = await createShoppingAgent({ searchProducts: () => new Promise(() => {}) }, policy, { timeoutMs: 10 }).runShoppingTask(request())
  assert.equal(result.status, "failed")
  assert.equal(result.error.code, "TIMEOUT")
})

test("Watsons SQLite data reaches B without repeated sale discount or invented checkout facts", async () => {
  const a = createProductSearch(new WatsonsSqliteProductProvider(), new DeterministicConditionScorer(), { recallLimit: 500 }).searchProducts
  const input = request()
  input.searchInput.product_name = { value: "lotion", must: 0 }
  input.searchInput.range_conditions = []
  const source = await a(input.searchInput)
  assert.ok(source.candidates.length > 0)
  input.requirement.category = source.candidates[0].candidate.category
  input.requirement.hardConstraints = []
  input.requirement.budget.maxMinor = 1000000
  const result = await createShoppingAgent({ searchProducts: a }, { ...policy, dataEnvironment: "verified_sources" }).runShoppingTask(input)
  assert.equal(result.status, "needs_verification")
  assert.equal(result.recommendations.length, 0)
  assert.ok(result.candidates.every(c => c.offer.discountMinor.value === null && c.offer.shippingMinor.value === null))
  assert.ok(result.candidates.every(c => c.attributes.category.source === "watsons-hk-api-snapshot"))
  assert.ok(result.candidates.every(c => c.attributes.listPriceMinor !== undefined))
})
