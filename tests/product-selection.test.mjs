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
const { createProductSelection } = requireTS("../services/product-selection.ts")
const { createProductSearch } = requireTS("../services/product-search.ts")
const { MockProductProvider } = requireTS("../services/product-provider.ts")
const { POST } = requireTS("../app/api/products/select/route.ts")
const { productSelectionResponse } = requireTS("../lib/product-selection-http.ts")
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
  assert.equal(result.selection.candidate.offer.shippingMinor.value, null)
  assert.equal(result.selection.candidate.offer.itemPriceMinor.status, "mock")
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

test("invalid requests are 400 and never reach the source", async () => {
  const select = createProductSelection(async () => { assert.fail("must not search") })
  for (const input of [null, {}, { ...request(), quantity: 0 }, { ...request(), quantity: 1.5 },
    { ...request(), destination: 12 }, { ...request(), excludedCandidates: [{}] },
    { ...request(), searchInput: { ...request().searchInput, product_name: { value: "lotion", must: 0 } } }]) {
    const response = await productSelectionResponse(new Request("http://localhost", {
      method: "POST", body: JSON.stringify(input),
    }), select)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).selection, null)
  }
  assert.equal((await POST(new Request("http://localhost", { method: "POST", body: "{" }))).status, 400)
})

test("documented request runs through real mock search and HTTP handler", async () => {
  const { searchProducts } = createProductSearch(new MockProductProvider())
  const select = createProductSelection(searchProducts)
  const response = await productSelectionResponse(new Request("http://localhost", {
    method: "POST", body: JSON.stringify(request()),
  }), select)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Cache-Control"), "no-store")
  const result = await response.json()
  assert.equal(result.status, "ready")
  assert.equal(result.selection.searchInput.taskId, result.taskId)
  assert.equal(result.selection.candidate.offer.itemPriceMinor.source, "mock-dataset")
  assert.equal(result.selection.candidate.offer.itemPriceMinor.status, "mock")
})

test("documented request also runs through the real Watsons route without LLM credentials", async () => {
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(request()) }))
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.status, "ready")
  assert.ok(result.selection.candidate.productId.startsWith("watsons-product:"))
  assert.equal(result.selection.candidate.offer.shippingMinor.value, null)
})
