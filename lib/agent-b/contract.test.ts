import test from "node:test"
import assert from "node:assert/strict"
import { evaluateShoppingCandidates, checkShoppingPurchase, explainDecision } from "./contract.ts"
import { createContractShoppingAgent } from "./workflow.ts"
import { evaluateCandidates, checkPurchase } from "./index.ts"
import type { ShoppingCandidate, ContractBPolicy, ContractEvaluationInput, Fact } from "../../types/index.ts"

const now = new Date("2026-10-03T08:00:00.000Z")
const fact = <T>(value: T): Fact<T> => ({ value, source: "merchant-api", fetchedAt: now.toISOString(), status: "verified" })
function setup(): { input: ContractEvaluationInput; policy: ContractBPolicy } {
  const candidate: ShoppingCandidate = {
    productId: "p", skuId: "s", offerId: "o", title: "乳液", url: "https://example.com/product",
    attributes: { category: fact("乳液"), volumeMl: fact(200), packageType: fact("regular") },
    text: { searchable: fact("MOISTURIZING 乳液") }, merchant: {id: "m", name: fact("商户"), platformId: fact("platform")},
    offer: { currency: "HKD", itemPriceMinor: fact(10000), discountMinor: fact(1000), shippingMinor: fact(1000), stock: fact("available"), deliverable: fact(true) },
    quote: {quantity: 2, destination: "香港", otherFeesMinor: fact(500), totalMinor: fact(20500), estimatedDeliveryAtMs: { ...fact(0), value: null }, canFulfillQuantity: fact(true)}, missingFields: [],
  }
  return {
    input: {requirement: {taskId: "task", requirementVersion: 1, category: "乳液", query: "乳液", currency: "HKD", destination: "香港",
      budget: {maxMinor: 21000, scope: "delivered"}, hardConstraints: [{id: "min", field: "attributes.volumeMl", op: "gte", value: 100}],
      preferences: [{id: "moist", field: "text.searchable", weight: 2, source: "explicit", conditions: [{field: "text.searchable", op: "containsAny", value: ["moisturizing"]}]}], excludedProductIds: []},
      quantity: 2, candidates: [candidate], searchStatus: "complete", sourceTaskId: "task", sourceRequirementVersion: 1},
    policy: {policyVersion: "test-v1", dataEnvironment: "verified_sources", merchantAllowlist: [{id: "m", platformId: "platform"}], priceBenchmarks: [], now: () => now},
  }
}
test("matches contract conditions, relative weights, single selection and immutable trace", async () => {
  const {input,policy} = setup()
  const out = await evaluateShoppingCandidates(input,policy)
  assert.equal(out.status,"result_ready")
  assert.equal(out.recommendations.length,1)
  assert.equal(out.recommendations[0].scoreLowerBound,100)
  input.candidates[0].title = "changed"
  assert.equal(out.decisionRecord.candidateSnapshots[0].title,"乳液")
  assert.match(explainDecision(out.decisionRecord), /20500/)
})
test("whole order discount is only subtracted once, including other fees", async () => {
  const {input,policy} = setup()
  input.requirement.budget.maxMinor = 20000
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"no_match")
  input.candidates[0].quote!.totalMinor = fact(19500) // old, incorrect discount multiplication
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"needs_verification")
})
test("unknown shipping, expired facts, context mismatch and quantity require verification", async () => {
  for (const mutate of [
    (c: ShoppingCandidate) => { c.offer!.shippingMinor.value = null },
    (c: ShoppingCandidate) => { c.offer!.stock.fetchedAt = "2026-10-02T08:00:00Z" },
    (c: ShoppingCandidate) => { c.quote!.quantity = 1 },
    (c: ShoppingCandidate) => { delete c.quote!.canFulfillQuantity },
  ]) {
    const {input,policy} = setup(); mutate(input.candidates[0])
    assert.equal((await evaluateShoppingCandidates(input,policy)).status,"needs_verification")
  }
})
test("known failures reject: category, currency, stock, delivery, whitelist, exclusion", async () => {
  for (const mutate of [
    (c: ShoppingCandidate) => { c.attributes.category = fact("口红") },
    (c: ShoppingCandidate) => { c.offer!.currency = "USD" },
    (c: ShoppingCandidate) => { c.offer!.stock = fact("unavailable") },
    (c: ShoppingCandidate) => { c.offer!.deliverable = fact(false) },
    (c: ShoppingCandidate) => { c.merchant!.id = "untrusted" },
  ]) {
    const {input,policy} = setup(); mutate(input.candidates[0])
    assert.equal((await evaluateShoppingCandidates(input,policy)).status,"no_match")
  }
  const {input,policy} = setup(); input.requirement.excludedProductIds = ["p"]
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"no_match")
})
test("unknown preferences yield an interval, not a fabricated complete score", async () => {
  const {input,policy} = setup()
  input.requirement.preferences.push({id:"unknown", field:"attributes.brand", weight:1, source:"explicit", conditions:[{field:"attributes.brand",op:"eq",value:"brand"}]})
  const out = await evaluateShoppingCandidates(input,policy)
  assert.equal(out.status,"result_ready")
  assert.ok(Math.abs(out.recommendations[0].scoreLowerBound! - 200/3) < 1e-10)
  assert.equal(out.recommendations[0].scoreUpperBound,100)
})
test("missing negative text is unknown; NFKC keywords match", async () => {
  const {input,policy} = setup()
  input.requirement.hardConstraints = [{field:"text.searchable",op:"notContainsAny",value:["refill"]}]
  delete input.candidates[0].text
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"needs_verification")
  input.candidates[0].text = {searchable:fact("ＲＥＦＩＬＬ")}
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"no_match")
})
test("no match, source failure, partial result and missing config stay distinct", async () => {
  const {input,policy} = setup()
  input.searchStatus = "partial"
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"result_ready")
  input.candidates = []
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"no_match")
  input.searchStatus = "failed"
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"failed")
  policy.merchantAllowlist = []
  assert.equal((await evaluateShoppingCandidates(input,policy)).diagnostics.nextAction,"resolve_configuration")
})
test("an eligible offer is not blocked by another unresolved offer", async () => {
  const {input,policy} = setup()
  const second = structuredClone(input.candidates[0]); second.offerId = "other"; second.offer!.shippingMinor.value = null
  input.candidates.push(second)
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"result_ready")
})
test("extreme low price triggers verification using independent recent benchmark", async () => {
  const {input,policy} = setup()
  policy.priceBenchmarks = [{productId:"p",skuId:"s",currency:"HKD",destination:"香港",medianUnitPriceMinor:30000,offerCount:5,sellerCount:3,fetchedAt:now.toISOString(),source:"benchmark",excludedOfferIds:["o"]}]
  const out = await evaluateShoppingCandidates(input,policy)
  assert.equal(out.status,"needs_verification")
  assert.equal(out.diagnostics.candidateChecks[0].checks.find(c=>c.conditionId === "system:low-price-risk")!.outcome,"unknown")
})
test("reject unsupported fields, weights, missing condition groups and stale versions", async () => {
  for (const mutate of [
    (i: ContractEvaluationInput) => { i.requirement.hardConstraints[0].field = "attributes.typo" },
    (i: ContractEvaluationInput) => { i.requirement.preferences[0].weight = 0 },
    (i: ContractEvaluationInput) => { delete i.requirement.preferences[0].conditions },
    (i: ContractEvaluationInput) => { i.sourceRequirementVersion = 0 },
  ]) {
    const {input,policy} = setup(); mutate(input)
    await assert.rejects(evaluateShoppingCandidates(input,policy), {name:"AgentBValidationError"})
  }
})
test("mock is preserved for simulation, never accepted for real evaluation or purchase", async () => {
  const {input,policy} = setup()
  input.candidates[0].offer!.stock.status = "mock"
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"needs_verification")
  policy.dataEnvironment = "development_mock"
  assert.equal((await evaluateShoppingCandidates(input,policy)).recommendations[0].evidenceStatus,"mock")
  assert.equal((await checkShoppingPurchase({...input,authorizationId:null},policy,{getAuthorizationById:async()=>null})).status,"blocked")
})
test("purchase uses backend authorization and rechecks all hard rules", async () => {
  const {input,policy} = setup()
  const auth = {authorizationId:"auth",allowedOfferId:"o",maxQuantity:2,maxTotalMinor:21000,currency:"HKD",expiresAt:"2026-10-03T08:10:00Z"}
  const context = {getAuthorizationById:async()=>auth}
  assert.equal((await checkShoppingPurchase({...input,authorizationId:"auth"},policy,context)).status,"approved")
  auth.maxTotalMinor = 20000
  assert.equal((await checkShoppingPurchase({...input,authorizationId:"auth"},policy,context)).status,"blocked")
  auth.maxTotalMinor = 21000
  input.candidates[0].attributes.volumeMl = fact(50)
  assert.equal((await checkShoppingPurchase({...input,authorizationId:"auth"},policy,context)).status,"blocked")
})

test("conflicting numeric requirements ask main Agent to clarify", async () => {
  const {input,policy} = setup()
  input.requirement.hardConstraints.push({field:"attributes.volumeMl",op:"lte",value:50})
  const out = await evaluateShoppingCandidates(input,policy)
  assert.equal(out.status,"failed")
  assert.equal(out.diagnostics.nextAction,"clarify")
})
test("template condition IDs can coexist with automatic rules", async () => {
  const {input,policy} = setup()
  input.requirement.hardConstraints.push({id:"stock",field:"offer.stock",op:"eq",value:"available"})
  assert.equal((await evaluateShoppingCandidates(input,policy)).status,"result_ready")
})
test("contract workflow calls A with quantity and stops unchanged verification", async () => {
  const {input,policy} = setup()
  input.candidates[0].quote!.totalMinor.value = null
  let calls = 0
  const envelope = {taskId:"task",requirementVersion:1,status:"partial" as const,candidates:input.candidates,warnings:[]}
  const agent = createContractShoppingAgent({searchCandidates:async req => { assert.equal(req.quantity,2);return envelope },verifyFacts:async()=>{calls++;return envelope}},policy)
  const out = await agent.run({requirement:input.requirement,quantity:2})
  assert.equal(out.stopReason,"no_progress")
  assert.equal(calls,1)
})
test("contract workflow enforces timeout and rejects stale A envelope", async () => {
  const {input,policy} = setup()
  const port = {searchCandidates:async()=>new Promise<never>(()=>{}), verifyFacts:async()=>new Promise<never>(()=>{})}
  const out = await createContractShoppingAgent(port,policy,{timeoutMs:10}).run({requirement:input.requirement,quantity:2})
  assert.equal(out.status,"failed")
  assert.equal(out.error!.code,"TIMEOUT")
  await assert.rejects(createContractShoppingAgent({...port,searchCandidates:async()=>({taskId:"task",requirementVersion:0,status:"complete",candidates:[],warnings:[]})},policy).run({requirement:input.requirement,quantity:2}),{name:"AgentBValidationError"})
})
test("legacy entries reject new semantics rather than silently using old totals", async () => {
  const {input} = setup()
  await assert.rejects(evaluateCandidates({requirement:input.requirement,candidates:input.candidates}),{name:"AgentBValidationError"})
  input.requirement.preferences = []
  await assert.rejects(checkPurchase({requirement:input.requirement,candidate:input.candidates[0],quantity:2,authorization:null}),{name:"AgentBValidationError"})
})
test("authorization is checked at query completion, with a bounded timeout", async () => {
  const {input,policy} = setup()
  let clock = now
  policy.now = () => clock
  const auth = {authorizationId:"a",allowedOfferId:"o",maxQuantity:2,maxTotalMinor:21000,currency:"HKD",expiresAt:"2026-10-03T08:01:00Z"}
  const out = await checkShoppingPurchase({...input,authorizationId:"a"},policy,{getAuthorizationById:async()=>{clock = new Date("2026-10-03T08:02:00Z");return auth}})
  assert.equal(out.status,"blocked")
  const timed = await checkShoppingPurchase({...input,authorizationId:"a"},policy,{timeoutMs:10,getAuthorizationById:async()=>new Promise<never>(()=>{})})
  assert.equal(timed.status,"blocked")
})
test("partial verification preserves known facts and caller requirement snapshot", async () => {
  const {input,policy} = setup()
  input.candidates[0].offer!.stock.value = null
  const original = structuredClone(input.candidates)
  const port = {
    searchCandidates:async (req: {requirement: ContractEvaluationInput["requirement"]}) => {
      req.requirement.budget.maxMinor = 0
      return {taskId:"task",requirementVersion:1,status:"partial" as const,candidates:original,warnings:[]}
    },
    verifyFacts:async () => {
      const candidates = structuredClone(original)
      candidates[0].offer!.stock = fact("available")
      candidates[0].attributes.volumeMl.value = null
      return {taskId:"task",requirementVersion:1,status:"complete" as const,candidates,warnings:[]}
    },
  }
  const out = await createContractShoppingAgent(port,policy).run({requirement:input.requirement,quantity:2})
  assert.equal(out.status,"result_ready")
  assert.equal(out.candidates[0].attributes.volumeMl.value,200)
  assert.equal(out.diagnostics.searchStatus,"partial")
  assert.equal(input.requirement.budget.maxMinor,21000)
})
