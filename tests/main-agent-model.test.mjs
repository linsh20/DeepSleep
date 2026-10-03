import assert from "node:assert/strict"
import test from "node:test"
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
const { ModelRequirementInterpreter, parseModelInterpretation, createBigBigTransport, boundedContext, MODEL_ENDPOINT, MODEL_ID } = requireTS("../services/main-agent/model-interpreter.ts")
const { ShoppingStub } = requireTS("../services/main-agent/shopping-port.ts")
const { createAgentHttp } = requireTS("../services/main-agent/http.ts")
const { hkdToMinor } = requireTS("../services/main-agent/money.ts")
let sequence = 0
const rid = () => `model_req_${++sequence}`
const fullDraft = () => ({ category: "化妆品", query: "测试牌粉底02色30ml正装", currency: "HKD", quantity: 1, destination: "香港", budget: { maxMinor: 20000, scope: "delivered" } })
const fullMessage = "帮我买测试牌粉底02色30ml正装，一件，预算200港币含运费，配送香港"
const wire = (patch = {}, evidence = {}, intent = "compare", intentEvidence = null) => JSON.stringify({ intent, intentEvidence, requirementDraft: patch, evidence, missingFields: [], clarificationQuestions: [] })
const fullWire = () => wire({ category: "化妆品", query: "测试牌粉底02色30ml正装", currency: "HKD", quantity: 1, destination: "香港", budget: { amountHKD: "200", scope: "delivered" } }, {
  category: "粉底", query: "测试牌粉底02色30ml正装", currency: "港币", quantity: "一件", destination: "香港", "budget.amountHKD": "预算200港币", "budget.scope": "含运费",
}, "purchase", "帮我买")
function setup(transport, options = {}) {
  let calls = 0, modelCalls = 0
  const model = new ModelRequirementInterpreter(async (...args) => { modelCalls++; return transport(...args) })
  const stub = new ShoppingStub()
  const agent = new MainTaskOrchestrator(new MemoryTaskRepository(), new DevelopmentRequirementInterpreter(), { search: (...args) => { calls++; return stub.search(...args) } }, { modelInterpreter: model, ...options })
  return { agent, calls: () => calls, modelCalls: () => modelCalls }
}
const say = (agent, task, message, requestId = rid()) => agent.message(task.taskId, "owner", { requestId, expectedVersion: task.requirementVersion, message })
const last = task => task.messages.at(-1)

test("natural-language acceptance 1–5: clarify, complete, budget edit, compare-only, duplicate", async () => {
  const outputs = [wire({ category: "化妆品", query: "粉底" }, { category: "粉底", query: "粉底" }, "compare", "看看"), fullWire(),
    wire({ budget: { amountHKD: "180" } }, { "budget.amountHKD": "预算改成 180" }, "purchase"), wire({}, {}, "compare", "只是比较，先不要买"), wire()]
  const seen = []
  const { agent, calls, modelCalls } = setup(async messages => { seen.push(messages); return outputs.shift() })
  let task = await agent.create("owner", rid())
  task = await say(agent, task, "帮我看看粉底")
  assert.equal(task.intent, "compare")
  assert.equal(task.status, "needs_clarification")
  assert.equal(task.requirementDraft.query, "粉底")
  assert.equal(task.requirementDraft.budget, undefined)
  assert.equal(calls(), 0)
  task = await say(agent, task, fullMessage)
  assert.equal(task.status, "result_ready")
  assert.equal(task.intent, "purchase")
  assert.equal(task.requirementDraft.budget.maxMinor, 20000)
  assert.equal(calls(), 1)
  assert.match(last(task).content, /购买执行尚未接入/)
  const before = task
  task = await say(agent, task, "预算改成 180，其他不变")
  assert.equal(task.requirementVersion, before.requirementVersion + 1)
  assert.deepEqual(task.requirementDraft, { ...before.requirementDraft, budget: { maxMinor: 18000, scope: "delivered" } })
  assert.equal(calls(), 2)
  task = await say(agent, task, "只是比较，先不要买")
  assert.equal(task.intent, "compare")
  assert.equal(calls(), 3)
  const requestId = rid(), version = task.requirementVersion
  const [first, second] = await Promise.all([say(agent, task, "看看当前方案", requestId), say(agent, task, "看看当前方案", requestId)])
  assert.deepEqual(first, second)
  assert.equal(first.requirementVersion, version)
  assert.equal(first.messages.length, 10)
  assert.equal(modelCalls(), 5)
  assert.equal(calls(), 3)
  assert.equal(first.shoppingResult.dataEnvironment, "development_mock")
  const sent = JSON.parse(seen[2][1].content)
  assert.equal(sent.currentDraft.query, fullDraft().query)
  assert.equal(sent.currentIntent, "purchase")
  assert.ok(!JSON.stringify(seen).includes(first.taskId))
})
test("omitted fields preserve current values; explicit null deletes, independent completeness checks remain", async () => {
  const input = { userMessage: "删除配送地区", currentIntent: "compare", currentDraft: fullDraft(), context: [] }
  const parsed = parseModelInterpretation(wire({ destination: null }, { destination: "删除配送地区" }), input)
  assert.equal(parsed.requirementDraft.destination, undefined)
  assert.equal(parsed.requirementDraft.query, fullDraft().query)
  const { agent, calls } = setup(async () => wire({ destination: null }, { destination: "删除配送地区" }))
  let task = await agent.create("owner", rid())
  task = await agent.save(task.taskId, "owner", { requestId: rid(), expectedVersion: 0, intent: "compare", requirementDraft: fullDraft() })
  task = await say(agent, task, "删除配送地区")
  assert.equal(task.status, "needs_clarification")
  assert.ok(task.missingFields.includes("destination"))
  assert.equal(calls(), 0)
})
test("6: concurrent messages cannot overwrite newer interpretations, including same-version no-op", async () => {
  let release, started
  const began = new Promise(resolve => { started = resolve })
  let n = 0
  const { agent } = setup(async () => {
    if (++n === 1) { started(); return new Promise(resolve => { release = resolve }) }
    return wire({}, {}, "unclear")
  })
  const task = await agent.create("owner", rid())
  const older = say(agent, task, "购买粉底")
  await began
  const newer = await say(agent, task, "我还没决定")
  assert.equal(newer.requirementVersion, 0)
  release(wire({ query: "粉底" }, { query: "粉底" }, "purchase", "购买"))
  const result = await older
  assert.equal(result.intent, "unclear")
  assert.deepEqual(result.requirementDraft, {})
  assert.equal(last(result).errorCode, "MODEL_SUPERSEDED")
  assert.equal(result.messages.length, 4)
})
test("6: structured form edit while model is pending rejects late response", async () => {
  let release, started
  const began = new Promise(resolve => { started = resolve })
  const { agent, calls } = setup(async () => { started(); return new Promise(resolve => { release = resolve }) })
  const task = await agent.create("owner", rid())
  const pending = say(agent, task, fullMessage)
  await began
  const saved = await agent.save(task.taskId, "owner", { requestId: rid(), expectedVersion: 0, intent: "compare", requirementDraft: { query: "用户新指定唇膏" } })
  release(fullWire())
  const result = await pending
  assert.deepEqual(result.requirementDraft, saved.requirementDraft)
  assert.equal(last(result).errorCode, "MODEL_SUPERSEDED")
  assert.equal(calls(), 0)
})
for (const [name, output] of [["illegal JSON", "not json"], ["invented amount", wire({ budget: { amountHKD: "999" } }, { "budget.amountHKD": "180" })], ["injected status", JSON.stringify({ ...JSON.parse(wire()), status: "completed" })], ["invalid question schema", JSON.stringify({ ...JSON.parse(wire()), clarificationQuestions: [17] })]]) {
  test(`7: ${name} preserves prior requirement/result and does not search`, async () => {
    const { agent, calls } = setup(async () => output)
    let task = await agent.create("owner", rid())
    task = await agent.save(task.taskId, "owner", { requestId: rid(), expectedVersion: 0, intent: "compare", requirementDraft: fullDraft() })
    task = await agent.search(task.taskId, "owner", rid(), task.requirementVersion)
    const response = await say(agent, task, "预算改成180")
    assert.equal(last(response).errorCode, "MODEL_INVALID_OUTPUT")
    assert.deepEqual(response.requirementDraft, task.requirementDraft)
    assert.deepEqual(response.shoppingResult, task.shoppingResult)
    assert.equal(calls(), 1)
  })
}
test("7: model timeout is finite and late output has no side effect", async () => {
  let release, captured
  const { agent, calls } = setup((_, signal) => { captured = signal; return new Promise(resolve => { release = resolve }) }, { modelTimeoutMs: 5 })
  const task = await agent.create("owner", rid())
  const result = await say(agent, task, fullMessage)
  assert.equal(last(result).errorCode, "MODEL_TIMEOUT")
  assert.equal(captured.aborted, true)
  release(fullWire())
  await new Promise(resolve => setTimeout(resolve, 1))
  assert.deepEqual(agent.get(task.taskId, "owner"), result)
  assert.equal(calls(), 0)
})
test("7: missing key makes no request; duplicate failed message adds no messages", async () => {
  let network = 0
  const transport = createBigBigTransport(() => undefined, async () => { network++; throw new Error() })
  const { agent } = setup(transport.complete)
  const task = await agent.create("owner", rid()), requestId = rid()
  const one = await say(agent, task, "帮我看看粉底", requestId)
  const two = await say(agent, task, "帮我看看粉底", requestId)
  assert.deepEqual(one, two)
  assert.equal(one.messages.length, 2)
  assert.equal(last(one).errorCode, "MODEL_NOT_CONFIGURED")
  assert.equal(transport.status().state, "missing_config")
  assert.equal(network, 0)
})
test("transport uses documented path and supplied model, nonstreaming, no tool-calling or retries", async () => {
  let calls = 0
  const transport = createBigBigTransport(() => "fixture-key", async (url, options) => {
    calls++
    assert.equal(url, MODEL_ENDPOINT)
    assert.equal(url, "https://api.bigbigapi.com/chat/completions")
    const data = JSON.parse(options.body)
    assert.equal(data.model, MODEL_ID)
    assert.equal(data.stream, false)
    assert.equal(data.tools, undefined)
    assert.equal(options.redirect, "error")
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] })
  })
  assert.equal(transport.status().state, "untested")
  assert.equal(await transport.complete([{ role: "user", content: "Reply OK" }], new AbortController().signal), "OK")
  assert.equal(transport.status().state, "connected")
  assert.equal(calls, 1)
  assert.ok(!JSON.stringify(transport.status()).includes("fixture-key"))
})
for (const [response, code] of [
  [() => new Response("secret-provider-detail", { status: 401 }), "MODEL_HTTP_ERROR"],
  [() => Response.json({ choices: [{ finish_reason: "stop", message: { refusal: "private refusal" } }] }), "MODEL_REFUSED"],
  [() => Response.json({ choices: [{ finish_reason: "length", message: { content: "incomplete" } }] }), "MODEL_INVALID_RESPONSE"],
  [() => new Response("not json"), "MODEL_INVALID_RESPONSE"],
]) test(`provider ${code} is explicit and sanitized`, async () => {
  let calls = 0
  const transport = createBigBigTransport(() => "fixture-key", async () => { calls++; return response() })
  await assert.rejects(transport.complete([], new AbortController().signal), e => e.code === code && !e.message.includes("private") && !e.message.includes("secret"))
  assert.equal(calls, 1)
  assert.equal(transport.status().state, "error")
})
test("deterministic HKD conversion and context length bounds", () => {
  assert.equal(hkdToMinor("200"), 20000)
  assert.equal(hkdToMinor("180"), 18000)
  assert.equal(hkdToMinor("0.29"), 29)
  assert.equal(hkdToMinor("180.05"), 18005)
  for (const value of ["1.001", "1e3", "-1", "0", "Infinity"]) assert.throws(() => hkdToMinor(value))
  const context = boundedContext(Array.from({ length: 20 }, () => ({ role: "user", content: "x".repeat(2000) })))
  assert.ok(context.length <= 8)
  assert.ok(context.reduce((sum, m) => sum + m.content.length, 0) <= 6000)
})
test("message HTTP checks ownership, optimistic version and message idempotency", async () => {
  const { agent, modelCalls } = setup(async () => wire({}, {}, "unclear"))
  const handle = createAgentHttp(agent, true)
  let cookie = ""
  const request = (action, body, taskId) => handle(new Request("http://localhost/api/agent/messages", { method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), action, taskId)
  cookie = (await request("session", {})).headers.get("set-cookie").split(";")[0]
  const task = (await (await request("create", { requestId: rid() })).json()).task
  const body = { requestId: rid(), taskId: task.taskId, expectedVersion: 0, message: "我还没决定" }
  const one = await (await request("message", body)).json()
  const two = await (await request("message", body)).json()
  assert.deepEqual(one, two)
  assert.equal(modelCalls(), 1)
  assert.equal((await request("message", { ...body, requestId: rid(), expectedVersion: 99 })).status, 409)
  assert.equal((await request("message", { ...body, message: "another" })).status, 409)
  cookie = ""
  cookie = (await request("session", {})).headers.get("set-cookie").split(";")[0]
  assert.equal((await request("message", { ...body, requestId: rid() })).status, 404)
  assert.equal(modelCalls(), 1)
})
test("obvious secrets and payment numbers are rejected before storage or model forwarding", async () => {
  const { agent, modelCalls } = setup(async () => wire())
  const task = await agent.create("owner", rid())
  for (const message of ["LLM_API_KEY=private", "银行卡 4242 4242 4242 4242", "Authorization: Bearer private"]) assert.throws(() => say(agent, task, message), e => e.code === "SENSITIVE_INPUT")
  assert.equal(modelCalls(), 0)
  assert.equal(agent.get(task.taskId, "owner").messages, undefined)
})

test("TaskError identity survives separate Next route module instances", () => {
  const path = requireTS.resolve("../services/main-agent/types.ts")
  const Original = requireTS(path).TaskError
  delete requireTS.cache[path]
  const OtherBundle = requireTS(path).TaskError
  const error = new Original("MODEL_NOT_CONFIGURED", "缺少配置", 503)
  assert.ok(error instanceof OtherBundle)
  assert.equal(error.code, "MODEL_NOT_CONFIGURED")
  assert.equal(({ code: "MODEL_NOT_CONFIGURED" }) instanceof OtherBundle, false)
})
