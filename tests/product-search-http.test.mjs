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
const { POST: search } = requireTS("../app/api/products/search/route.ts")
const { POST: verify } = requireTS("../app/api/products/verify/route.ts")
const { productSearchResponse } = requireTS("../lib/product-search-http.ts")
const requirement = {
  taskId: "homepage-test", requirementVersion: 3, category: "Electronics",
  query: "wireless headphones", currency: "HKD", budget: { maxMinor: 50000, scope: "delivered" },
  hardConstraints: [], preferences: [], excludedProductIds: [], destination: "HK",
}
const request = (body) => new Request("http://localhost/api/products/search", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
})

test("homepage search and verification routes return real agent results", async () => {
  const response = await search(request({ requirement, limit: 20 }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Cache-Control"), "no-store")
  const result = await response.json()
  const light = result.candidates.find((candidate) => candidate.productId === "product-light")
  assert.equal(light.attributes.weightGrams.value, null)
  const updatedResponse = await verify(request({ requirement, candidates: result.candidates, requests: [{
    productId: light.productId, skuId: light.skuId, offerId: light.offerId,
    fields: ["attributes.weightGrams"], reason: "Homepage lookup",
  }] }))
  assert.equal(updatedResponse.status, 200)
  const updated = await updatedResponse.json()
  assert.equal(updated.taskId, requirement.taskId)
  assert.equal(updated.requirementVersion, requirement.requirementVersion)
  assert.equal(updated.candidates.find((candidate) => candidate.productId === "product-light").attributes.weightGrams.value, 180)
})

test("malformed JSON and invalid search input produce structured 400 errors", async () => {
  for (const req of [
    new Request("http://localhost", { method: "POST", body: "{" }), request(null),
    request({ requirement, limit: 0 }), request({ requirement: { ...requirement, query: "" }, limit: 10 }),
    request({ requirement: null }),
  ]) {
    const response = await search(req)
    assert.equal(response.status, 400)
    const result = await response.json()
    assert.equal(result.status, "failed")
    assert.match(result.warnings[0], /^INVALID_INPUT:/)
  }
})

test("unsupported categories and oversized verification batches have explicit errors", async () => {
  const unsupported = await search(request({ requirement: { ...requirement, category: "Clothing" }, limit: 10 }))
  assert.equal(unsupported.status, 422)
  const oversized = await verify(request({ requirement, candidates: Array(101).fill(null), requests: [] }))
  assert.equal(oversized.status, 400)
  assert.equal((await oversized.json()).taskId, requirement.taskId)
})

test("unexpected source exceptions do not expose backend details", async () => {
  const response = await productSearchResponse(request({ requirement }), async () => { throw new Error("secret details") })
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(body.requirementVersion, 3)
  assert.match(body.warnings[0], /^SOURCE_UNAVAILABLE:/)
  assert.ok(!JSON.stringify(body).includes("secret details"))
})
