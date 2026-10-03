// Opt-in live acceptance: node scripts/check-contract-model.mjs (up to five provider calls).
import assert from "node:assert/strict"
import { parseEnv } from "node:util"
import { writeFileSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import ts from "typescript"
const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename)
const { MainTaskOrchestrator } = requireTS("../services/main-agent/orchestrator.ts")
const { MemoryTaskRepository } = requireTS("../services/main-agent/task-repository.ts")
const { DevelopmentRequirementInterpreter } = requireTS("../services/main-agent/requirement-interpreter.ts")
const { ModelRequirementInterpreter, createBigBigTransport, MODEL_ENDPOINT, MODEL_ID } = requireTS("../services/main-agent/model-interpreter.ts")
const { ShoppingStub } = requireTS("../services/main-agent/shopping-port.ts")

const key = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")).LLM_API_KEY?.trim() : undefined
if (!key) { console.log("MODEL_NOT_CONFIGURED: .env.local LLM_API_KEY required"); process.exit(2) }
const transport = createBigBigTransport(() => key)
const requests = [], stub = new ShoppingStub()
const agent = new MainTaskOrchestrator(new MemoryTaskRepository(), new DevelopmentRequirementInterpreter(), {
  search: (input, signal) => { requests.push(structuredClone(input)); return stub.search(input, signal) },
}, { modelInterpreter: new ModelRequirementInterpreter(async (...args) => {
    const raw = await transport.complete(...args)
    if (process.argv.includes("--diagnostic")) {
      // Synthetic acceptance input only. Inspect schema shape, never raw text or provider envelopes.
      try {
        const parsed = JSON.parse(raw)
        const shape = value => Array.isArray(value) ? value.map(shape) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value
        console.log(JSON.stringify({ schemaShape: shape(parsed) }))
      } catch { console.log("DIAGNOSTIC: not JSON") }
    }
    return raw
  }), modelTimeoutMs: 60000 })
let task = await agent.create("live-acceptance", randomUUID())
const turns = []
for (const message of [
  "比较乳液，1件，100到300ml正装，总预算200港币含运费，配送香港，希望保湿。",
  "容量改成200到300ml，其他不变。",
  "容量不限，预算改成180。",
  "保湿必须满足。",
  "不要限定品牌。",
]) {
  task = await agent.message(task.taskId, "live-acceptance", { requestId: randomUUID(), expectedVersion: task.requirementVersion, message })
  const reply = task.messages.at(-1)
  const turn = { message, reply: reply.content, errorCode: reply.errorCode, version: task.requirementVersion, status: task.status, intent: task.intent, shoppingRequest: task.shoppingRequest ?? null, searches: requests.length }
  turns.push(turn)
  console.log(JSON.stringify(turn))
  if (reply.errorCode) { process.exitCode = 1; break }
}
writeFileSync("docs/main-agent-contract-live.json", JSON.stringify({ checkedAt: new Date().toISOString(), endpoint: MODEL_ENDPOINT, model: MODEL_ID, dataEnvironment: "development_mock", turns }, null, 2) + "\n")

if (!process.exitCode) {
  try {
    assert.equal(turns.length, 5)
    assert.deepEqual(turns.map(t => t.version), [1, 2, 3, 4, 4])
    assert.deepEqual(turns.map(t => t.searches), [1, 2, 3, 4, 4])
    assert.ok(turns.every(t => t.intent === "compare" && t.status === "result_ready" && t.shoppingRequest.quantity === 1))
    const reqs = turns.map(t => t.shoppingRequest.requirement)
    assert.equal(reqs[0].budget.maxMinor, 20000)
    assert.equal(reqs[0].hardConstraints.filter(c => c.field === "attributes.volumeMl").length, 2)
    assert.ok(reqs[0].hardConstraints.some(c => c.field === "attributes.volumeMl" && c.op === "gte" && c.value === 100))
    assert.ok(reqs[1].hardConstraints.some(c => c.field === "attributes.volumeMl" && c.op === "gte" && c.value === 200))
    assert.equal(reqs[1].hardConstraints.length, 3)
    assert.equal(reqs[2].budget.maxMinor, 18000)
    assert.equal(reqs[2].hardConstraints.length, 1)
    assert.ok(reqs.slice(0, 3).every(r => r.preferences.some(p => p.conditions.some(c => c.field === "text.searchable" && c.value.includes("保湿")))))
    assert.deepEqual(reqs[3].preferences, [])
    assert.ok(reqs[3].hardConstraints.some(c => c.field === "text.searchable" && c.op === "containsAny" && c.value.includes("保湿")))
    assert.deepEqual(reqs[3], reqs[4])
    console.log("LIVE_ACCEPTANCE_PASS: A-E requests, versions and search counts verified")
  } catch { console.log("LIVE_ACCEPTANCE_FAILED: inspect sanitized recorded requests"); process.exitCode = 1 }
}
