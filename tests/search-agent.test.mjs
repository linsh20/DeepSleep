import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import ts from "typescript"

// Test local TypeScript without adding a test framework or emitting build files.
// Type checking is performed separately by tsc / next build.
const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  module._compile(outputText, filename)
}
const { searchCandidates, verifyFacts, createSearchAgent, buildSearchPlan } = requireTS("../services/search-agent.ts")
const { MockProductProvider, ProductProviderError, identityKey } = requireTS("../services/product-provider.ts")

function requirement(overrides = {}) {
  return {
    taskId: "task-a", requirementVersion: 7, category: "Electronics",
    query: "wireless headphones", currency: "HKD", budget: { maxMinor: 50000, scope: "delivered" },
    hardConstraints: [], preferences: [], excludedProductIds: [], destination: "HK", ...overrides,
  }
}
const find = (result, id) => result.candidates.find((candidate) => candidate.productId === `product-${id}`)
const requestFor = (candidate, fields) => ({
  productId: candidate.productId, skuId: candidate.skuId, offerId: candidate.offerId,
  fields, reason: "Decision module needs these facts.",
})
const provider = (overrides) => Object.assign(new MockProductProvider(), overrides)

test("structured recall preserves versions, mock provenance, minor units, and input", async () => {
  const req = requirement()
  const before = structuredClone(req)
  const result = await searchCandidates({ requirement: req, limit: 20 })
  assert.equal(result.status, "complete")
  assert.equal(result.taskId, req.taskId)
  assert.equal(result.requirementVersion, 7)
  assert.deepEqual(req, before)
  assert.equal(find(result, "audiomax").offer.itemPriceMinor.value, 45900)
  for (const candidate of result.candidates) {
    assert.notEqual(candidate.productId, candidate.skuId)
    assert.notEqual(candidate.productId, candidate.offerId)
    const facts = [...Object.values(candidate.attributes),
      ...Object.entries(candidate.offer ?? {}).filter(([key]) => key !== "currency").map(([, value]) => value)]
    for (const fact of facts) {
      assert.equal(fact.status, "mock")
      assert.equal(fact.source, "mock-dataset")
      assert.ok(Number.isFinite(Date.parse(fact.fetchedAt)))
    }
  }
})

test("deduplicates exact identities, retains distinct SKUs/offers, and applies limit after dedup", async () => {
  const full = await searchCandidates({ requirement: requirement(), limit: 20 })
  assert.equal(new Set(full.candidates.map(identityKey)).size, full.candidates.length)
  assert.equal(full.candidates.filter((candidate) => candidate.productId === "product-soundpro").length, 3)
  const limited = await searchCandidates({ requirement: requirement(), limit: 2 })
  assert.equal(limited.candidates.length, 2)
})

test("excluded product removes every SKU and offer", async () => {
  const result = await searchCandidates({ requirement: requirement({ excludedProductIds: ["product-soundpro"] }), limit: 20 })
  assert.ok(result.candidates.length)
  assert.equal(find(result, "soundpro"), undefined)
})

test("retrieval distinguishes item and delivered budgets; unknown totals stay unknown", async () => {
  const delivered = await searchCandidates({ requirement: requirement(), limit: 20 })
  assert.equal(find(delivered, "premium"), undefined)
  assert.equal(find(delivered, "studio"), undefined)
  assert.ok(find(delivered, "discount"))
  assert.equal(find(delivered, "unknown").offer.shippingMinor.value, null)
  assert.ok(find(delivered, "unknown").missingFields.includes("offer.shippingMinor"))
  const item = await searchCandidates({ requirement: requirement({ budget: { maxMinor: 50000, scope: "item" } }), limit: 20 })
  assert.ok(find(item, "premium"))
})

test("stock is a fact, not an implicit purchase or recommendation decision", async () => {
  const all = await searchCandidates({ requirement: requirement(), limit: 20 })
  assert.equal(find(all, "soldout").offer.stock.value, "unavailable")
  const filtered = await searchCandidates({ requirement: requirement({
    hardConstraints: [{ field: "offer.stock", op: "eq", value: "available" }],
  }), limit: 20 })
  assert.equal(find(filtered, "soldout"), undefined)
  assert.deepEqual(Object.keys(all).sort(), ["candidates", "requirementVersion", "status", "taskId", "warnings"])
})

test("hard constraints filter known facts but preserve unknowns for verification", async () => {
  const result = await searchCandidates({ requirement: requirement({ hardConstraints: [
    { field: "weightGrams", op: "lte", value: 230 },
    { field: "batteryLifeHours", op: "gte", value: 24 },
    { field: "color", op: "in", value: ["black", "blue"] },
    { field: "brand", op: "notIn", value: ["discount"] },
  ] }), limit: 20 })
  assert.equal(find(result, "soundpro"), undefined)
  assert.equal(find(result, "discount"), undefined)
  assert.ok(find(result, "light"))
  assert.ok(find(result, "travel"))
})

test("missing fields include requested attributes and absent offers, never invented zeroes", async () => {
  const result = await searchCandidates({ requirement: requirement({ preferences: [
    { field: "noiseCancellation", weight: 1, source: "explicit" },
  ] }), limit: 20 })
  assert.equal(find(result, "light").attributes.weightGrams.value, null)
  assert.ok(find(result, "light").missingFields.includes("attributes.weightGrams"))
  assert.ok(find(result, "light").missingFields.includes("attributes.noiseCancellation"))
  assert.equal(find(result, "catalog").offer, null)
  assert.ok(find(result, "catalog").missingFields.includes("offer"))
})

test("verification changes only requested candidate and fields, retaining the caller's input", async () => {
  const req = requirement()
  const initial = await searchCandidates({ requirement: req, limit: 20 })
  const before = structuredClone(initial.candidates)
  const candidate = find(initial, "light")
  const updated = await verifyFacts({ requirement: req, candidates: initial.candidates,
    requests: [requestFor(candidate, ["attributes.weightGrams"])] })
  assert.equal(updated.status, "complete")
  assert.equal(updated.requirementVersion, 7)
  assert.equal(find(updated, "light").attributes.weightGrams.value, 180)
  assert.equal(find(updated, "light").attributes.weightGrams.status, "mock")
  assert.equal(find(updated, "light").attributes.weightGrams.source, "mock-dataset")
  assert.equal(find(updated, "light").missingFields.includes("attributes.weightGrams"), false)
  const expected = structuredClone(before)
  const target = expected.find((entry) => identityKey(entry) === identityKey(candidate))
  target.attributes.weightGrams = find(updated, "light").attributes.weightGrams
  target.missingFields = target.missingFields.filter((field) => field !== "attributes.weightGrams")
  assert.deepEqual(updated.candidates, expected)
  assert.deepEqual(initial.candidates, before)
})

test("verification uses exact SKU/offer identity and sends only requested fields", async () => {
  const req = requirement()
  const initial = await searchCandidates({ requirement: req, limit: 20 })
  const candidate = initial.candidates.find((entry) => entry.offerId === "offer-soundpro-black-store-b")
  const calls = []
  const mock = new MockProductProvider()
  const agent = createSearchAgent(provider({ getProductDetails: async (identity, fields, context) => {
    calls.push({ identity: identityKey(identity), fields })
    const raw = await mock.getProductDetails(identity, fields, context)
    raw.offer.shippingMinor = 1200
    raw.attributes.weightGrams = 999
    return raw
  } }))
  const updated = await agent.verifyFacts({ requirement: req, candidates: initial.candidates,
    requests: [requestFor(candidate, ["offer.shippingMinor"]), requestFor(candidate, ["offer.shippingMinor"])] })
  assert.deepEqual(calls, [{ identity: identityKey(candidate), fields: ["offer.shippingMinor"] }])
  assert.equal(updated.candidates.find((entry) => identityKey(entry) === identityKey(candidate)).offer.shippingMinor.value, 1200)
  assert.equal(updated.candidates.find((entry) => identityKey(entry) === identityKey(candidate)).attributes.weightGrams.value, 240)
  assert.equal(find(updated, "soundpro").offer.shippingMinor.value, 2000)
})

test("unknown facts remain null, known facts survive an unsuccessful lookup", async () => {
  const req = requirement()
  const initial = await searchCandidates({ requirement: req, limit: 20 })
  const unknown = find(initial, "unknown")
  const missing = await verifyFacts({ requirement: req, candidates: initial.candidates,
    requests: [requestFor(unknown, ["attributes.weightGrams", "offer.shippingMinor"])] })
  assert.equal(missing.status, "partial")
  assert.equal(find(missing, "unknown").attributes.weightGrams.value, null)
  const fail = createSearchAgent(provider({ getProductDetails: async () => { throw new Error("private backend details") } }))
  const failed = await fail.verifyFacts({ requirement: req, candidates: initial.candidates,
    requests: [requestFor(find(initial, "audiomax"), ["offer.itemPriceMinor"])] })
  assert.equal(failed.status, "failed")
  assert.deepEqual(failed.candidates, initial.candidates)
  assert.ok(!failed.warnings.join(" ").includes("private backend"))
})

test("null detail does not replace valid fact; response currency changes cannot corrupt an offer", async () => {
  const req = requirement()
  const initial = await searchCandidates({ requirement: req, limit: 20 })
  const candidate = find(initial, "audiomax")
  const mock = new MockProductProvider()
  for (const change of [
    (raw) => { raw.offer.itemPriceMinor = null },
    (raw) => { raw.offer.currency = "USD"; raw.offer.itemPriceMinor = 100 },
  ]) {
    const agent = createSearchAgent(provider({ getProductDetails: async (...args) => {
      const raw = await mock.getProductDetails(...args)
      change(raw)
      return raw
    } }))
    const result = await agent.verifyFacts({ requirement: req, candidates: initial.candidates,
      requests: [requestFor(candidate, ["offer.itemPriceMinor"])] })
    assert.equal(result.status, "partial")
    assert.deepEqual(find(result, "audiomax").offer, candidate.offer)
  }
})

test("one failed verification does not discard other successful facts", async () => {
  const req = requirement()
  const initial = await searchCandidates({ requirement: req, limit: 20 })
  const mock = new MockProductProvider()
  const agent = createSearchAgent(provider({ getProductDetails: async (identity, ...args) => {
    if (identity.productId === "product-travel") throw new Error("offline")
    return mock.getProductDetails(identity, ...args)
  } }))
  const result = await agent.verifyFacts({ requirement: req, candidates: initial.candidates, requests: [
    requestFor(find(initial, "light"), ["attributes.weightGrams"]),
    requestFor(find(initial, "travel"), ["attributes.batteryLifeHours"]),
  ] })
  assert.equal(result.status, "partial")
  assert.equal(find(result, "light").attributes.weightGrams.value, 180)
  assert.equal(find(result, "travel").attributes.batteryLifeHours.value, null)
})

test("source partial, total failure, malformed records, and zero matches are distinguishable", async () => {
  const req = requirement()
  const mock = new MockProductProvider()
  const raw = await mock.search(buildSearchPlan(req), 20, { signal: new AbortController().signal, requirement: req })
  const partial = await createSearchAgent(provider({ search: async () => ({ ...raw, status: "partial" }) }))
    .searchCandidates({ requirement: req, limit: 20 })
  assert.equal(partial.status, "partial")
  assert.ok(partial.candidates.length)
  const malformed = await createSearchAgent(provider({ search: async () => ({ ...raw, products: [null, ...raw.products] }) }))
    .searchCandidates({ requirement: req, limit: 20 })
  assert.equal(malformed.status, "partial")
  assert.ok(malformed.candidates.length)
  const allMalformed = await createSearchAgent(provider({ search: async () => ({ products: [null], status: "complete" }) }))
    .searchCandidates({ requirement: req, limit: 20 })
  assert.equal(allMalformed.status, "failed")
  const failed = await createSearchAgent(provider({ search: async () => { throw new Error("offline") } }))
    .searchCandidates({ requirement: req, limit: 20 })
  assert.equal(failed.status, "failed")
  assert.match(failed.warnings[0], /^SOURCE_UNAVAILABLE:/)
  assert.equal(failed.requirementVersion, 7)
  const empty = await searchCandidates({ requirement: requirement({ query: "no-such-product" }), limit: 20 })
  assert.equal(empty.status, "complete")
  assert.deepEqual(empty.candidates, [])
})

test("invalid provider facts are null rather than invented values", async () => {
  const req = requirement()
  const mock = new MockProductProvider()
  const agent = createSearchAgent(provider({ search: async (...args) => {
    const result = await mock.search(...args)
    result.products[0].offer.shippingMinor = -1
    return result
  } }))
  const result = await agent.searchCandidates({ requirement: req, limit: 20 })
  assert.equal(result.status, "partial")
  assert.equal(result.candidates[0].offer.shippingMinor.value, null)
})

test("timeouts are bounded and signal cancellation to providers", async () => {
  let signal
  const agent = createSearchAgent(provider({ search: (_plan, _limit, context) => {
    signal = context.signal
    return new Promise(() => {})
  } }), { timeoutMs: 10 })
  const result = await agent.searchCandidates({ requirement: requirement(), limit: 10 })
  assert.equal(result.status, "failed")
  assert.match(result.warnings[0], /^TIMEOUT:/)
  assert.equal(signal.aborted, true)
})

test("invalid input and unsupported categories return typed warnings", async () => {
  for (const input of [
    { requirement: requirement(), limit: 0 },
    { requirement: requirement({ budget: { maxMinor: -1, scope: "item" } }), limit: 10 },
    { requirement: requirement({ hardConstraints: [{ field: "weightGrams", op: "lte", value: "heavy" }] }), limit: 10 },
    { requirement: requirement({ query: " " }), limit: 10 },
    null,
  ]) {
    const result = await searchCandidates(input)
    assert.equal(result.status, "failed")
    assert.match(result.warnings[0], /^INVALID_INPUT:/)
  }
  const unsupported = await searchCandidates({ requirement: requirement({ category: "Clothing" }), limit: 10 })
  assert.match(unsupported.warnings[0], /^UNSUPPORTED_CATEGORY:/)
  assert.throws(() => createSearchAgent(new MockProductProvider(), { timeoutMs: 0 }), ProductProviderError)
})

test("no verification request means no provider call; unmatched and unsafe requests are rejected", async () => {
  const req = requirement()
  const initial = await searchCandidates({ requirement: req, limit: 20 })
  let calls = 0
  const agent = createSearchAgent(provider({ getProductDetails: async () => { calls++; return null } }))
  const unchanged = await agent.verifyFacts({ requirement: req, candidates: initial.candidates, requests: [] })
  assert.deepEqual(unchanged.candidates, initial.candidates)
  const absent = { ...requestFor(find(initial, "light"), ["attributes.weightGrams"]), skuId: "sku-absent" }
  const unmatched = await agent.verifyFacts({ requirement: req, candidates: initial.candidates, requests: [absent] })
  assert.equal(unmatched.status, "failed")
  const invalid = await agent.verifyFacts({ requirement: req, candidates: initial.candidates,
    requests: [requestFor(find(initial, "light"), ["attributes.__proto__"])] })
  assert.match(invalid.warnings[0], /^INVALID_INPUT:/)
  assert.equal(calls, 0)
  const malformed = structuredClone(initial.candidates)
  malformed[0].missingFields = [null]
  const invalidCandidate = await agent.verifyFacts({ requirement: req, candidates: malformed,
    requests: [requestFor(malformed[0], ["attributes.weightGrams"])] })
  assert.equal(invalidCandidate.status, "failed")
  assert.match(invalidCandidate.warnings[0], /^INVALID_INPUT:/)
})

test("other destinations never reuse HK delivery facts", async () => {
  const req = requirement({ destination: "TW" })
  const initial = await searchCandidates({ requirement: req, limit: 20 })
  const candidate = find(initial, "audiomax")
  assert.equal(candidate.offer.shippingMinor.value, null)
  assert.equal(candidate.offer.deliverable.value, null)
  const updated = await verifyFacts({ requirement: req, candidates: initial.candidates,
    requests: [requestFor(candidate, ["offer.shippingMinor", "offer.deliverable"])] })
  assert.equal(find(updated, "audiomax").offer.shippingMinor.value, null)
})

test("mock operation needs no model API key and preferences do not reorder candidates", async () => {
  const previous = process.env.LLM_API_KEY
  delete process.env.LLM_API_KEY
  try {
    const base = await searchCandidates({ requirement: requirement(), limit: 20 })
    const preferred = await searchCandidates({ requirement: requirement({ preferences: [
      { field: "batteryLifeHours", weight: 100, source: "inferred" },
    ] }), limit: 20 })
    assert.equal(base.status, "complete")
    assert.deepEqual(base.candidates.map(identityKey), preferred.candidates.map(identityKey))
  } finally {
    if (previous === undefined) delete process.env.LLM_API_KEY
    else process.env.LLM_API_KEY = previous
  }
})
