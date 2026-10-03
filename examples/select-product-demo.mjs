// Run after npm run dev: node examples/select-product-demo.mjs [base-url] [--llm]
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const baseUrl = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "http://localhost:3000"
const input = JSON.parse(readFileSync(new URL("./select-product.request.json", import.meta.url), "utf8"))
input.searchInput.useLlm = process.argv.includes("--llm")
const response = await fetch(new URL("/api/products/select", baseUrl), {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  signal: AbortSignal.timeout(300_000),
})
const result = await response.json()
assert.equal(response.status, 200, JSON.stringify(result))
assert.equal(result.status, "ready", JSON.stringify(result))
assert.equal(result.taskId, input.searchInput.taskId)
assert.equal(result.requirementVersion, input.searchInput.requirementVersion)
// This object is interface 2's complete payload. No payment or order is sent by this demo.
console.log(JSON.stringify(result.selection, null, 2))
