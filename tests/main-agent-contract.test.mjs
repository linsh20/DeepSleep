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
const { ModelRequirementInterpreter, parseModelInterpretation } = requireTS("../services/main-agent/model-interpreter.ts")
const { ShoppingStub } = requireTS("../services/main-agent/shopping-port.ts")
import { initialMessage, initialWire, volume, moisture, pack, edit, wire } from "./fixtures/contract.mjs"
const { draftValue } = requireTS("../services/main-agent/requirement-interpreter.ts")
let seq = 0
const rid = () => `contract_request_${++seq}`
function setup(outputs) {
  const requests = [], stub = new ShoppingStub()
  const model = new ModelRequirementInterpreter(async () => outputs.shift())
  const agent = new MainTaskOrchestrator(new MemoryTaskRepository(), new DevelopmentRequirementInterpreter(), {
    search: (input, signal) => { requests.push(structuredClone(input)); return stub.search(input, signal) },
  }, { modelInterpreter: model })
  return { agent, requests }
}
const say = (agent, task, message, requestId = rid()) => agent.message(task.taskId, "owner", { requestId, expectedVersion: task.requirementVersion, message })
const last = task => task.messages.at(-1)

test("A–E: actual ShoppingPort payload, targeted edits/removal/promotion and request reuse", async () => {
  const outputs = [initialWire(),
    wire({ hardConstraints: [edit("attributes.volumeMl", volume(200, 300))] }, { hardConstraints: "容量改成200到300ml" }),
    wire({ hardConstraints: [edit("attributes.volumeMl", [])], budget: { amountHKD: "180" } }, { hardConstraints: "容量不限", "budget.amountHKD": "预算改成180" }),
    wire({ hardConstraints: [edit("text.searchable", [moisture])] }, { hardConstraints: "保湿必须满足" }),
    wire({ hardConstraints: [edit("attributes.brand", [])] }, { hardConstraints: "不要限定品牌" }), wire()]
  const { agent, requests } = setup(outputs)
  let t = await agent.create("owner", rid())
  t = await say(agent, t, initialMessage)
  assert.equal(t.status, "result_ready")
  assert.equal(t.intent, "compare")
  assert.equal(requests.length, 1)
  const a = requests[0]
  assert.deepEqual(Object.keys(a).sort(), ["quantity", "requirement"])
  assert.equal(a.quantity, 1)
  assert.equal(a.requirement.query, "乳液")
  assert.equal(a.requirement.budget.maxMinor, 20000)
  assert.equal(a.requirement.hardConstraints.length, 3)
  for (const c of [...volume(100, 300), pack]) assert.ok(a.requirement.hardConstraints.some(x => JSON.stringify(x) === JSON.stringify(c)))
  assert.deepEqual(a.requirement.preferences[0].conditions, [moisture])
  assert.deepEqual(t.shoppingRequest, a)
  const v = t.requirementVersion
  t = await say(agent, t, "容量改成200到300ml，其他不变。")
  assert.equal(t.requirementVersion, v + 1)
  const b = requests.at(-1).requirement
  assert.equal(b.hardConstraints.length, 3)
  assert.ok(b.hardConstraints.some(c => c.op === "gte" && c.value === 200))
  assert.deepEqual(b.preferences, a.requirement.preferences)
  t = await say(agent, t, "容量不限，预算改成180。")
  const c = requests.at(-1).requirement
  assert.deepEqual(c.hardConstraints, [pack])
  assert.equal(c.budget.maxMinor, 18000)
  assert.deepEqual(c.preferences, b.preferences)
  t = await say(agent, t, "保湿必须满足。")
  assert.deepEqual(requests.at(-1).requirement.preferences, [])
  assert.ok(requests.at(-1).requirement.hardConstraints.some(c => c.field === "text.searchable"))
  const count = requests.length, version = t.requirementVersion
  t = await say(agent, t, "不要限定品牌。")
  assert.equal(t.requirementVersion, version)
  assert.equal(requests.length, count)
  const requestId = rid()
  const [one, two] = await Promise.all([say(agent, t, "查看当前方案", requestId), say(agent, t, "查看当前方案", requestId)])
  assert.deepEqual(one, two)
  assert.equal(requests.length, count)
  assert.equal(one.messages.length, 12)
})
test("F: conflicts, unsupported operators/paths and malformed structures preserve prior valid request", async () => {
  for (const [change, expected] of [
    [edit("attributes.volumeMl", volume(300, 100)), "CONDITION_CONFLICT"],
    [edit("attributes.volumeMl", [{ field: "attributes.volumeMl", op: "regex", value: 2 }]), "MODEL_INVALID_OUTPUT"],
    [edit("__proto__.status", []), "MODEL_INVALID_OUTPUT"],
    [edit("attributes.shade", [{ field: "attributes.shade", op: "eq", value: 2 }]), "MODEL_INVALID_OUTPUT"],
  ]) {
    const { agent, requests } = setup([initialWire(), wire({ hardConstraints: [change] }, { hardConstraints: "修改条件" })])
    let t = await agent.create("owner", rid()); t = await say(agent, t, initialMessage)
    const old = t
    t = await say(agent, t, "修改条件")
    assert.equal(last(t).errorCode, expected)
    assert.deepEqual(t.requirement, old.requirement)
    assert.deepEqual(t.shoppingRequest, old.shoppingRequest)
    assert.deepEqual(t.shoppingResult, old.shoppingResult)
    assert.equal(requests.length, 1)
  }
})
test("optional facts never become required; material ambiguity stops tools; shade/exclusions/alternatives survive", async () => {
  const { agent, requests } = setup([initialWire(), wire({}, {}, null, { ambiguities: [{ field: "attributes.volumeMl", question: "你给出的容量单位是毫升还是克？", evidence: "容量200" }] })])
  let t = await agent.create("owner", rid()); t = await say(agent, t, initialMessage)
  assert.deepEqual(t.missingFields, [])
  const old = t
  t = await say(agent, t, "容量200")
  assert.equal(last(t).errorCode, "NEEDS_CLARIFICATION")
  assert.deepEqual(t.requirement, old.requirement)
  assert.equal(requests.length, 1)
  const draft = draftValue({ ...t.requirementDraft, hardConstraints: [{ field: "attributes.shade", op: "eq", value: "02" }], excludedProductIds: ["p1"], allowAlternativeProducts: false })
  t = await agent.save(t.taskId, "owner", { requestId: rid(), expectedVersion: t.requirementVersion, intent: "compare", requirementDraft: draft })
  t = await agent.search(t.taskId, "owner", rid(), t.requirementVersion)
  assert.equal(requests.at(-1).requirement.hardConstraints[0].value, "02")
  assert.deepEqual(requests.at(-1).requirement.excludedProductIds, ["p1"])
  assert.equal(requests.at(-1).requirement.allowAlternativeProducts, false)
})
test("E: remove existing brand without touching other fields or independent text targets", () => {
  const currentDraft = { hardConstraints: [{ field: "attributes.brand", op: "eq", value: "用户品牌" }, pack, { id: "avoid", field: "text.searchable", op: "notContainsAny", value: ["香精"] }], preferences: [{ field: "attributes.brand", weight: 2, source: "explicit", conditions: [{ field: "attributes.brand", op: "eq", value: "用户品牌" }] }] }
  const parsed = parseModelInterpretation(wire({ hardConstraints: [edit("attributes.brand", [])], preferences: [edit("attributes.brand", [])] }, { hardConstraints: "不要限定品牌", preferences: "不要限定品牌" }), { userMessage: "不要限定品牌", currentIntent: "compare", currentDraft, context: [] })
  assert.equal(parsed.requirementDraft.hardConstraints.length, 2)
  assert.deepEqual(parsed.requirementDraft.preferences, [])
})
test("request validators reject unknowns, contradictory inclusion sets and legacy preferences without targets", () => {
  for (const value of [
    { hardConstraints: [{ field: "attributes.weightGrams", op: "gte", value: 100 }] },
    { hardConstraints: [{ field: "attributes.brand", op: "eq", value: "A" }, { field: "attributes.brand", op: "notIn", value: ["A"] }] },
    { preferences: [{ field: "attributes.volumeMl", weight: 1, source: "explicit" }] },
    { allowAlternativeProducts: "yes" },
  ]) assert.throws(() => draftValue(value))
})
test("G: late model interpretation cannot overwrite a newer condition edit or cause another search", async () => {
  let release, began
  const started = new Promise(resolve => { began = resolve })
  let calls = 0
  const requests = [], stub = new ShoppingStub()
  const model = new ModelRequirementInterpreter(async () => {
    calls++
    if (calls === 1) return initialWire()
    if (calls === 2) { began(); return new Promise(resolve => { release = resolve }) }
    return wire({ hardConstraints: [edit("attributes.volumeMl", [])] }, { hardConstraints: "容量不限" })
  })
  const agent = new MainTaskOrchestrator(new MemoryTaskRepository(), new DevelopmentRequirementInterpreter(), {
    search: (input, signal) => { requests.push(structuredClone(input)); return stub.search(input, signal) },
  }, { modelInterpreter: model })
  let t = await agent.create("owner", rid()); t = await say(agent, t, initialMessage)
  const old = say(agent, t, "容量改成200到300ml")
  await started
  const next = await say(agent, t, "容量不限")
  release(wire({ hardConstraints: [edit("attributes.volumeMl", volume(200, 300))] }, { hardConstraints: "容量改成200到300ml" }))
  const result = await old
  assert.equal(last(result).errorCode, "MODEL_SUPERSEDED")
  assert.deepEqual(result.shoppingRequest, next.shoppingRequest)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].requirement.hardConstraints, [pack])
})
test("G: late Shopping result for an old condition version is discarded", async () => {
  let release, began
  const started = new Promise(resolve => { began = resolve })
  const stub = new ShoppingStub(), requests = []
  const outputs = [initialWire(), wire({ hardConstraints: [edit("attributes.volumeMl", [])] }, { hardConstraints: "容量不限" })]
  const agent = new MainTaskOrchestrator(new MemoryTaskRepository(), new DevelopmentRequirementInterpreter(), {
    search: async (input, signal) => {
      requests.push(structuredClone(input))
      const result = await stub.search(input, signal)
      if (requests.length === 1) { began(); return new Promise(resolve => { release = () => resolve(result) }) }
      return result
    },
  }, { modelInterpreter: new ModelRequirementInterpreter(async () => outputs.shift()) })
  const t = await agent.create("owner", rid())
  const old = say(agent, t, initialMessage)
  await started
  const next = await say(agent, agent.get(t.taskId, "owner"), "容量不限")
  release()
  const result = await old
  assert.deepEqual(result.shoppingResult, next.shoppingResult)
  assert.deepEqual(result.shoppingRequest, requests[1])
  assert.equal(requests.length, 2)
  assert.ok(result.events.some(e => e.type === "stale_result_discarded"))
})
test("grams are not silently converted to volume", () => {
  assert.throws(() => parseModelInterpretation(wire({ hardConstraints: [edit("attributes.volumeMl", volume(100, 200))] }, { hardConstraints: "100到200克" }), { userMessage: "100到200克", currentIntent: "compare", currentDraft: {}, context: [] }), e => e.code === "NEEDS_CLARIFICATION")
})
test("removing an absent optional group is a semantic no-op, generated query follows category edits", () => {
  const input = { currentIntent: "compare", currentDraft: { category: "乳液", query: "乳液" }, context: [], userMessage: "不要限定品牌" }
  const parsed = parseModelInterpretation(wire({ hardConstraints: [edit("attributes.brand", [])], preferences: [edit("attributes.brand", [])] }, { hardConstraints: input.userMessage, preferences: input.userMessage }), input)
  assert.deepEqual(parsed.requirementDraft, input.currentDraft)
  const changed = parseModelInterpretation(wire({ category: "面霜" }, { category: "面霜" }), { ...input, userMessage: "改成面霜" })
  assert.deepEqual(changed.requirementDraft, { category: "面霜", query: "面霜" })
})
