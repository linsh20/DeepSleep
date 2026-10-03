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
const { createShoppingAgent, runShoppingTask } = requireTS("../services/shopping-agent.ts")
const { evaluateCandidates, checkPurchase } = requireTS("../lib/agent-b/index.ts")
const { createSearchAgent, buildSearchPlan } = requireTS("../services/search-agent.ts")
const { matchesSearchPlan } = requireTS("../services/product-provider.ts")
const requirement = () => ({
  taskId: "integration", requirementVersion: 0, category: "Electronics",
  query: "headphones", currency: "HKD", budget: { maxMinor: 50000, scope: "delivered" },
  hardConstraints: [{ field: "weightGrams", op: "lte", value: 250 }],
  preferences: [{ field: "batteryLifeHours", weight: 1, source: "explicit" }],
  excludedProductIds: [], destination: "HK",
})
const raw = () => ({
  productId: "p", skuId: "s", offerId: "o", title: "Headphones", url: "https://example.test/product",
  category: "Electronics", source: "integration-test-fixture", fetchedAt: new Date().toISOString(), status: "verified",
  attributes: { weightGrams: null, batteryLifeHours: 30 },
  offer: { currency: "HKD", itemPriceMinor: 40000, shippingMinor: 1000, discountMinor: 0,
    stock: "available", deliverable: true },
})

test("A search -> B requests -> A verifies exact facts -> B ready, without mutating input", async () => {
  const req = requirement()
  const before = structuredClone(req)
  let calls = 0
  const agent = createShoppingAgent({
    search: async () => ({ products: [raw()], status: "complete" }),
    getProductDetails: async (identity, fields) => {
      calls++
      assert.deepEqual(fields, ["attributes.weightGrams"])
      assert.equal(identity.offerId, "o")
      return { ...raw(), attributes: { weightGrams: 200, batteryLifeHours: 30 } }
    },
  })
  const result = await agent.runShoppingTask({ requirement: req, limit: 20 })
  assert.equal(result.stopReason, "ready")
  assert.equal(result.verificationRounds, 1)
  assert.equal(calls, 1)
  assert.equal(result.requirementVersion, 0)
  assert.equal(result.evaluation.recommendations[0].productId, "p")
  assert.ok(result.evaluation.recommendations[0].evidenceFields.includes("attributes.batteryLifeHours"))
  assert.deepEqual(req, before)
})

test("default mock source stays mock and verification stops after two rounds", async () => {
  const result = await runShoppingTask({ requirement: requirement(), limit: 20 })
  assert.equal(result.stopReason, "verificationLimit")
  assert.equal(result.verificationRounds, 2)
  assert.equal(result.evaluation.status, "needsVerification")
  assert.equal(result.evaluation.recommendations.length, 0)
  assert.ok(result.search.candidates.length > 0)
  assert.ok(result.search.candidates.every((candidate) =>
    candidate.offer === null || candidate.offer.stock.status === "mock"))
  const candidate = result.search.candidates.find((item) => item.offerId && item.offer)
  const authorization = { authorizationId: "test", allowedOfferId: candidate.offerId,
    maxTotalMinor: 50000, maxQuantity: 1, currency: "HKD", expiresAt: new Date(Date.now() + 60000).toISOString() }
  const check = await checkPurchase({ requirement: requirement(), candidate, quantity: 1, authorization },
    { getAuthorizationById: async () => authorization })
  assert.notEqual(check.status, "approved")
})

test("A failed lookup placeholders remain unknown in B instead of validation errors", async () => {
  const req = requirement()
  req.hardConstraints = []
  req.preferences = []
  const a = createSearchAgent({
    search: async () => ({ products: [raw()], status: "complete" }),
    getProductDetails: async () => { throw new Error("offline") },
  })
  const initial = await a.searchCandidates({ requirement: req, limit: 10 })
  const updated = await a.verifyFacts({ requirement: req, candidates: initial.candidates,
    requests: [{ productId: "p", skuId: "s", offerId: "o", fields: ["attributes.newFact"], reason: "check" }] })
  req.hardConstraints = [{ field: "newFact", op: "eq", value: true }]
  const result = await evaluateCandidates({ requirement: req, candidates: updated.candidates })
  assert.equal(result.status, "needsVerification")
  assert.ok(result.verificationRequests[0].fields.includes("attributes.newFact"))
})

test("partial search survives and task input is snapshotted across awaits", async () => {
  const req = requirement()
  const agent = createShoppingAgent({
    search: async () => {
      req.requirementVersion = 99
      req.budget.maxMinor = 0
      return { products: [{ ...raw(), attributes: { weightGrams: 200, batteryLifeHours: 30 } }],
        status: "partial", warnings: ["one source unavailable"] }
    },
    getProductDetails: async () => null,
  })
  const result = await agent.runShoppingTask({ requirement: req, limit: 20 })
  assert.equal(result.requirementVersion, 0)
  assert.equal(result.search.status, "partial")
  assert.equal(result.evaluation.status, "ready")
  assert.ok(result.search.warnings.includes("one source unavailable"))
})

test("derived prices use offer facts in A search planning and B scoring", async () => {
  const req = requirement()
  req.hardConstraints = [{ field: "totalPrice", op: "lte", value: 41000 }]
  req.preferences = [{ field: "deliveredTotalMinor", weight: 1, source: "explicit" }]
  const plan = buildSearchPlan(req)
  assert.deepEqual(plan.requiredFields, ["offer.itemPriceMinor", "offer.shippingMinor", "offer.discountMinor"])
  assert.equal(matchesSearchPlan(raw(), plan), true)
  assert.equal(matchesSearchPlan({ ...raw(), offer: { ...raw().offer, shippingMinor: 1001 } }, plan), false)
  const agent = createShoppingAgent({ search: async () => ({ products: [raw()], status: "complete" }),
    getProductDetails: async () => null })
  const result = await agent.runShoppingTask({ requirement: req, limit: 10 })
  assert.equal(result.stopReason, "ready")
  req.preferences = [{ field: "itemPriceMinor", weight: 1, source: "explicit" }]
  assert.ok(buildSearchPlan(req).requiredFields.includes("offer.itemPriceMinor"))
})

test("empty search and source failure return distinct terminal outcomes", async () => {
  for (const fail of [false, true]) {
    const agent = createShoppingAgent({
      search: async () => {
        if (fail) throw new Error("offline")
        return { products: [], status: "complete" }
      },
      getProductDetails: async () => { assert.fail("no lookup expected") },
    })
    const result = await agent.runShoppingTask({ requirement: requirement(), limit: 20 })
    assert.equal(result.stopReason, fail ? "searchFailed" : "needsSearch")
    assert.equal(result.verificationRounds, 0)
  }
})
