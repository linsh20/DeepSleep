// One live model call. Exercises Main Agent -> ShoppingPort as direct function calls.
// Reads only LLM_API_KEY from .env.local and never prints credentials or provider payloads.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { parseEnv } from "node:util"
import ts from "typescript"

const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename)

const { MainTaskOrchestrator } = requireTS("../services/main-agent/orchestrator.ts")
const { MemoryTaskRepository } = requireTS("../services/main-agent/task-repository.ts")
const { DevelopmentRequirementInterpreter } = requireTS("../services/main-agent/requirement-interpreter.ts")
const { ModelRequirementInterpreter, createBigBigTransport, MODEL_ID } = requireTS("../services/main-agent/model-interpreter.ts")
const { deriveSearchInput, toShoppingRequirement } = requireTS("../services/main-agent/shopping-adapter.ts")
const { ShoppingStub } = requireTS("../services/main-agent/shopping-port.ts")

const key = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")).LLM_API_KEY?.trim() : undefined
if (!key) {
  console.log("MODEL_NOT_CONFIGURED: .env.local 需要 LLM_API_KEY；未发送请求。")
  process.exit(2)
}

const userMessage = process.argv.slice(2).join(" ").trim()
  || "我想购买1件乳液，容量200ml，总预算200港币含运费，配送香港，希望保湿。"
const transport = createBigBigTransport(() => key)
const stub = new ShoppingStub()
let handedToSearch = null

const shoppingPort = {
  async search(input, signal) {
    const derived = deriveSearchInput(input.requirement, false)
    handedToSearch = {
      requirement: structuredClone(input.requirement),
    downstreamRequirement: toShoppingRequirement(input.requirement),
      quantity: input.quantity,
      searchInput: structuredClone(derived.searchInput),
      translation: structuredClone(derived.translation),
    }
    return stub.search(input, signal)
  },
}

const agent = new MainTaskOrchestrator(
  new MemoryTaskRepository(),
  new DevelopmentRequirementInterpreter(),
  shoppingPort,
  {
    modelInterpreter: new ModelRequirementInterpreter(transport.complete),
    modelTimeoutMs: 60000,
    timeoutMs: 5000,
    retries: 0,
  },
)

let task = await agent.create("direct-live-model", randomUUID())
task = await agent.message(task.taskId, "direct-live-model", {
  requestId: randomUUID(),
  expectedVersion: task.requirementVersion,
  message: userMessage,
})

const reply = task.messages.at(-1)
if (reply?.errorCode) {
  console.log(JSON.stringify({
    ok: false,
    model: MODEL_ID,
    errorCode: reply.errorCode,
    reply: reply.content,
    taskStatus: task.status,
  }, null, 2))
  process.exit(1)
}

assert.ok(task.requirement, "主 Agent 未生成完整 Requirement")
assert.ok(handedToSearch, "主 Agent 未调用搜索 Agent 接口")
assert.equal(handedToSearch.searchInput.taskId, task.taskId)
assert.equal(handedToSearch.searchInput.requirementVersion, task.requirementVersion)
assert.ok(handedToSearch.searchInput.product_name.value.trim(), "未生成商品搜索词")
assert.ok(Number.isFinite(handedToSearch.requirement.budget.maxHKD), "主 Agent 预算不是 HKD 数值")
assert.equal(handedToSearch.downstreamRequirement.budget.maxMinor / 100, handedToSearch.requirement.budget.maxHKD, "下游整数金额转换错误")
assert.equal("budget" in handedToSearch.searchInput, false, "搜索 Agent 输入不应包含未声明的预算字段")

console.log(JSON.stringify({
  ok: true,
  model: MODEL_ID,
  userMessage,
  mainAgent: {
    intent: task.intent,
    status: task.status,
    requirementVersion: task.requirementVersion,
    requirement: handedToSearch.requirement,
  },
  sentToSearchAgent: {
    quantity: handedToSearch.quantity,
    searchInput: handedToSearch.searchInput,
    translation: handedToSearch.translation,
  },
  sentToShoppingRisk: {
    budget: handedToSearch.downstreamRequirement.budget,
  },
}, null, 2))
