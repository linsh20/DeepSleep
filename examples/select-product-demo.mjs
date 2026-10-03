// Direct function call; no server needed. node examples/select-product-demo.mjs [--llm]
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import ts from "typescript"

// The application compiles TS; this small loader does the same for the standalone demo.
const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  module._compile(outputText, filename)
}
requireTS("@next/env").loadEnvConfig(process.cwd())
const { selectProduct } = requireTS("../services/product-selection.ts")
const input = JSON.parse(readFileSync(new URL("./select-product.request.json", import.meta.url), "utf8"))
input.searchInput.useLlm = process.argv.includes("--llm")
const result = await selectProduct(input)
assert.equal(result.status, "ready", JSON.stringify(result))
assert.equal(result.taskId, input.searchInput.taskId)
assert.equal(result.requirementVersion, input.searchInput.requirementVersion)
assert.equal("url" in result.selection.candidate, false)
// Pass this database object to level 2's function. This demo does not perform payment or place an order.
console.log(JSON.stringify(result.selection, null, 2))
