import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import ts from "typescript"

const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  module._compile(outputText, filename)
}
const { createProductSelection, selectProduct } = requireTS("../services/product-selection.ts")
const { createProductSearch } = requireTS("../services/product-search.ts")
const { MockProductProvider } = requireTS("../services/product-provider.ts")
const request = () => JSON.parse(readFileSync(new URL("../examples/select-product.request.json", import.meta.url), "utf8"))
const fact = value => ({ value, source: "mock-dataset", status: "mock", fetchedAt: "2026-10-03T08:00:00Z" })
function ranked(id, rank, ingredients, volume = 200) {
  return { rank, finalScore: 5, llmAverageScore: 5, popularityScore: 1, needsVerification: [], conditionScores: [],
    candidate: { productId: id, skuId: `${id}-sku`, offerId: `${id}-offer`, title: "Sensitive Skin Lotion",
      category: "skincare", url: `https://example.invalid/${id}`,
      searchableText: { description: fact("sensitive skin moisturizing"), ingredients: fact(ingredients) },
      attributes: { volumeMl: fact(volume) },
      offer: { currency: "HKD", itemPriceMinor: fact(15000), shippingMinor: fact(null), discountMinor: fact(null),
        stock: fact(null), deliverable: fact(null) }, missingFields: ["offer.shippingMinor"] } }
}
const source = candidates => async input => ({ taskId: input.taskId, requirementVersion: input.requirementVersion,
  candidates, status: "complete", outcome: candidates.length ? "ranked" : "no_match", filterLogs: [], warnings: [], message: "test",
  debug: { llmEvents: [{ direction: "response", payload: "private debug data" }] } })

test("level 1 skips hard failures and unknowns despite score 5, preserving facts for level 2", async () => {
  const input = request()
  input.quantity = 2
  const before = structuredClone(input)
  const result = await createProductSelection(source([
    ranked("too-small", 1, "water", 20), ranked("unknown", 2, null), ranked("pass", 3, "water"),
  ]))(input)
  assert.equal(result.status, "ready")
  assert.equal(result.selection.candidate.productId, "pass")
  assert.equal(result.selection.quantity, 2)
  assert.equal(result.selection.candidate.offer.shippingHkd.value, null)
  assert.equal(result.selection.candidate.offer.priceHkd.value, 150)
  assert.equal(result.selection.candidate.offer.priceHkd.status, "mock")
  assert.equal(result.selection.candidate.databaseCode, null)
  assert.equal("url" in result.selection.candidate, false)
  assert.deepEqual(result.reviews.map(r => r.status), ["rejected", "needs_verification", "passed"])
  assert.ok(!JSON.stringify(result).includes("private debug data"))
  assert.deepEqual(input, before)
})

test("unknown hard requirements do not yield a handoff; unknown preferences may", async () => {
  const select = createProductSelection(source([ranked("unknown", 1, null)]))
  const input = request()
  const blocked = await select(input)
  assert.equal(blocked.status, "needs_verification")
  assert.equal(blocked.selection, null)
  input.searchInput.exclude_keywords.forEach(c => { c.must = 0 })
  const allowed = await select(input)
  assert.equal(allowed.status, "ready")
  assert.ok(allowed.selection.productCheck.checks.some(c => c.outcome === "unknown" && c.must === 0))
})

test("exact identity exclusion selects the next candidate, not all offers of a product", async () => {
  const first = ranked("same", 1, "water")
  const second = ranked("same", 2, "water")
  second.candidate.offerId = "different-offer"
  const input = request()
  input.excludedCandidates = [{ productId: "same", skuId: "same-sku", offerId: "same-offer" }]
  const result = await createProductSelection(source([first, second]))(input)
  assert.equal(result.selection.candidate.offerId, "different-offer")
  input.excludedCandidates.push({ productId: "same", skuId: "same-sku", offerId: "different-offer" })
  assert.equal((await createProductSelection(source([first, second]))(input)).status, "no_match")
})

test("no match, partial usable search, failed source and stale versions remain distinct", async () => {
  assert.equal((await createProductSelection(source([]))(request())).status, "no_match")
  const partial = await createProductSelection(async input => ({ ...await source([ranked("pass", 1, "water")])(input),
    status: "partial", warnings: ["LLM fallback"] }))(request())
  assert.equal(partial.status, "ready")
  assert.equal(partial.searchStatus, "partial")
  for (const search of [
    async input => ({ ...await source([])(input), status: "failed", warnings: ["TIMEOUT: source"] }),
    async input => ({ ...await source([])(input), requirementVersion: input.requirementVersion + 1 }),
    async () => { throw new Error("private upstream error") },
  ]) {
    const result = await createProductSelection(search)(request())
    assert.equal(result.status, "failed")
    assert.equal(result.selection, null)
    assert.ok(!JSON.stringify(result).includes("private upstream error"))
  }
})

test("invalid function arguments never reach the source", async () => {
  const select = createProductSelection(async () => { assert.fail("must not search") })
  for (const input of [null, {}, { ...request(), quantity: 0 }, { ...request(), quantity: 1.5 },
    { ...request(), destination: 12 }, { ...request(), excludedCandidates: [{}] },
    { ...request(), searchInput: { ...request().searchInput, product_name: { value: "lotion", must: 0 } } }]) {
    const result = await select(input)
    assert.equal(result.error.code, "INVALID_INPUT")
    assert.equal(result.selection, null)
  }
})

test("documented function call runs through mock search with HKD amounts", async () => {
  const { searchProducts } = createProductSearch(new MockProductProvider())
  const select = createProductSelection(searchProducts)
  const result = await select(request())
  assert.equal(result.status, "ready")
  assert.equal(result.selection.searchInput.taskId, result.taskId)
  assert.equal(result.selection.candidate.offer.priceHkd.source, "mock-dataset")
  assert.equal(result.selection.candidate.offer.priceHkd.status, "mock")
})

test("direct function reads Watsons DB without network, and hands off its database code and HKD price", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { assert.fail("No HTTP needed for this function call") }
  try {
    const result = await selectProduct(request())
    assert.equal(result.status, "ready")
    const product = result.selection.candidate
    assert.ok(product.productId.startsWith("watsons-product:"))
    assert.equal(product.offer.shippingHkd.value, null)
    assert.equal("url" in product, false)
    assert.ok(!JSON.stringify(result).includes("Minor"))
    const db = new DatabaseSync("data/watson/data/products.db", { readOnly: true })
    try {
      const row = db.prepare("SELECT code, price FROM products WHERE code = ?").get(product.databaseCode)
      assert.equal(row.code, product.databaseCode)
      assert.equal(row.price, product.offer.priceHkd.value)
    } finally { db.close() }
  } finally { globalThis.fetch = originalFetch }
})

test("HKD decimal bounds convert exactly; no public amount, evidence path or reason uses cents", async () => {
  const input = request()
  input.searchInput.range_conditions = [{ field: "priceHkd", min: 19.9, max: 20.05, must: 1 }]
  const row = ranked("decimal", 1, "water")
  row.candidate.offer.itemPriceMinor = fact(1990)
  row.candidate.offer.shippingMinor = fact(0)
  row.candidate.offer.discountMinor = fact(105)
  row.candidate.attributes.listPriceMinor = fact(2900)
  const before = structuredClone(input)
  const result = await createProductSelection(async value => {
    assert.deepEqual(value.range_conditions, [{ field: "priceMinor", min: 1990, max: 2005, must: 1 }])
    return source([row])(value)
  })(input)
  assert.equal(result.selection.candidate.offer.priceHkd.value, 19.9)
  assert.equal(result.selection.candidate.offer.shippingHkd.value, 0)
  assert.equal(result.selection.candidate.offer.discountHkd.value, 1.05)
  assert.equal(result.selection.candidate.attributes.listPriceHkd.value, 29)
  assert.ok(!JSON.stringify(result).includes("Minor"))
  assert.match(result.selection.productCheck.checks[1].reason, /HKD 19\.90/)
  assert.deepEqual(input, before)

  row.candidate.offer.itemPriceMinor = fact(2006)
  assert.equal((await createProductSelection(source([row]))(input)).status, "no_match")
  input.searchInput.range_conditions[0].min = null
  assert.equal((await createProductSelection(source([row]))(input)).status, "no_match")
})

test("reject sub-cent, nonfinite, negative and legacy-cent input rather than guessing currency units", async () => {
  const select = createProductSelection(async () => { assert.fail("must not search") })
  for (const value of [1.005, -1, NaN, Infinity, "100", undefined]) {
    const input = request()
    input.searchInput.range_conditions = [{ field: "priceHkd", min: value, max: 300, must: 1 }]
    assert.equal((await select(input)).error.code, "INVALID_INPUT")
  }
  const input = request()
  input.searchInput.range_conditions = [{ field: "priceMinor", min: 10000, max: 30000, must: 1 }]
  assert.equal((await select(input)).error.code, "INVALID_INPUT")
})
