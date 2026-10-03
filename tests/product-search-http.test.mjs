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
const { productSearchResponse } = requireTS("../lib/product-search-http.ts")

const input = () => ({
  taskId: "http-test",
  requirementVersion: 3,
  product_name: { value: "乳液", must: 1 },
  range_conditions: [
    { field: "volumeMl", min: 100, max: 300, must: 1 },
    { field: "priceMinor", min: 10000, max: 30000, must: 0 },
  ],
  include_keywords: [{ keywords: ["敏感肌", "sensitive skin"], must: 1 }],
  exclude_keywords: [{ keywords: ["酒精", "alcohol"], must: 1 }],
})

const request = (body) => new Request("http://localhost/api/products/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

test("search route returns ranked results, logs, identity, and no-store", async () => {
  const response = await search(request(input()))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Cache-Control"), "no-store")
  const result = await response.json()
  assert.equal(result.taskId, "http-test")
  assert.equal(result.requirementVersion, 3)
  assert.equal(result.outcome, "ranked")
  assert.ok(result.candidates.length > 0 && result.candidates.length <= 10)
  assert.deepEqual(result.filterLogs.map((log) => log.stage), ["product_name", "range", "range", "include", "exclude"])
})

test("malformed JSON and invalid structured input return 400", async () => {
  const invalidInputs = [
    null,
    { ...input(), taskId: "" },
    { ...input(), product_name: { value: "", must: 1 } },
    { ...input(), range_conditions: [{ field: "price", min: 1, max: 2, must: 1 }] },
    { ...input(), include_keywords: [{ keywords: [], must: 1 }] },
  ]
  const requests = [new Request("http://localhost", { method: "POST", body: "{" }), ...invalidInputs.map(request)]
  for (const item of requests) {
    const response = await search(item)
    assert.equal(response.status, 400)
    const result = await response.json()
    assert.equal(result.status, "failed")
    assert.match(result.warnings[0], /^INVALID_INPUT:/)
  }
})

test("oversized declared request bodies are rejected before parsing", async () => {
  const response = await search(new Request("http://localhost/api/products/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "100001" },
    body: JSON.stringify(input()),
  }))
  assert.equal(response.status, 400)
  assert.match((await response.json()).warnings[0], /^INVALID_INPUT:/)
})

test("transport hides unexpected server errors", async () => {
  const response = await productSearchResponse(request(input()), async () => {
    throw new Error("private upstream response")
  })
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(body.taskId, "http-test")
  assert.equal(body.requirementVersion, 3)
  assert.ok(!JSON.stringify(body).includes("private upstream response"))
})
