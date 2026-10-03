import { assertCandidate } from "../../lib/agent-b/index"
import { assertStructuredSearchInput } from "../product-search"
import type { ContractShoppingResult } from "./shopping-port"
import { TaskError } from "./types"
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
function ok(value: unknown): asserts value { if (!value) throw new TaskError("INVALID_INPUT","Shopping 契约结果不合法；拒绝应用") }
const str = (v: unknown) => typeof v === "string" && v.length <= 100000
const texts = (v: unknown) => Array.isArray(v) && v.length <= 2000 && v.every(str)
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v)
const one = (v: unknown, values: string[]) => typeof v === "string" && values.includes(v)
function list(value: unknown, check: (v: unknown) => void) { ok(Array.isArray(value) && value.length <= 1000); value.forEach(check) }
function id(v: unknown): asserts v is Record<string,unknown> { ok(rec(v) && str(v.productId) && (v.skuId === null || str(v.skuId)) && (v.offerId === null || str(v.offerId))) }
function fact(v: unknown) {
  ok(rec(v) && (v.value === null || str(v.value) || num(v.value) || typeof v.value === "boolean") && one(v.status,["mock","verified","unverified"]) && str(v.source) && str(v.fetchedAt))
  ok(v.source !== "mock-dataset" || v.status === "mock")
  ok(v.value === null && v.status === "unverified" && v.source === "" && v.fetchedAt === "" || (String(v.source).length > 0 && Number.isFinite(Date.parse(String(v.fetchedAt)))))
  ok(v.validUntil === undefined || str(v.validUntil) && Number.isFinite(Date.parse(String(v.validUntil))))
}
function candidate(v: unknown) {
  ok(rec(v)); assertCandidate(v)
  ok(rec(v.attributes)); Object.values(v.attributes).forEach(fact)
  if (v.searchableText !== undefined) {ok(rec(v.searchableText)); Object.values(v.searchableText).forEach(fact)}
  if (v.text !== undefined) {ok(rec(v.text));fact(v.text.searchable)}
  if (v.offer !== null) {ok(rec(v.offer)); for (const k of ["itemPriceMinor","shippingMinor","discountMinor","stock","deliverable"] as const) fact(v.offer[k])}
  if (v.merchant !== undefined) {ok(rec(v.merchant) && str(v.merchant.id));fact(v.merchant.name);if(v.merchant.platformId !== undefined)fact(v.merchant.platformId)}
  if (v.quote !== undefined) {ok(rec(v.quote) && Number.isSafeInteger(v.quote.quantity) && Number(v.quote.quantity)>0 && str(v.quote.destination)); for(const k of ["otherFeesMinor","totalMinor","estimatedDeliveryAtMs"] as const)fact(v.quote[k]); if(v.quote.canFulfillQuantity !== undefined)fact(v.quote.canFulfillQuantity)}
}
function check(v: unknown) {ok(rec(v) && str(v.conditionId) && one(v.outcome,["match","mismatch","unknown"]) && texts(v.evidenceFields) && str(v.reason))}
function scores(v: Record<string,unknown>) {for(const k of ["scoreLowerBound","scoreUpperBound"])ok(v[k] === null || num(v[k]) && Number(v[k])>=0 && Number(v[k])<=100)}
function audit(v:unknown) {id(v);ok(one(v.disposition,["eligible","rejected","needs_verification"]));list(v.checks,check);list(v.preferenceChecks,check);scores(v)}
function recommendation(v:unknown) {id(v);ok(v.rank === 1 && one(v.evidenceStatus,["mock","verified"]) && str(v.explanation) && texts(v.tradeoffs));list(v.checks,check);ok((v.checks as Record<string,unknown>[]).every(c=>c.outcome === "match"));list(v.preferenceChecks,check);scores(v)}
function checkedContractResult(value: unknown): ContractShoppingResult {
  ok(rec(value));const v=value
  ok(v.kind === "shopping_contract_v1" && str(v.taskId) && Number.isSafeInteger(v.requirementVersion) && one(v.dataEnvironment,["development_mock","verified_sources"]) && one(v.status,["result_ready","needs_verification","no_match","failed"]))
  ok(Number.isSafeInteger(v.verificationRounds) && Number(v.verificationRounds)>=0 && Number(v.verificationRounds)<=2 && one(v.stopReason,["completed","verification_limit","no_progress","no_verifiable_fields","source_failed"]))
  list(v.candidates,candidate);list(v.recommendations,recommendation)
  ok((v.recommendations as unknown[]).length === (v.status === "result_ready" ? 1 : 0))
  if(v.status === "result_ready") {ok(rec(v.plan) && str(v.plan.title) && str(v.plan.notice));fact(v.plan.priceMinor)}
  if(v.status === "needs_verification")ok(texts(v.missingFacts))
  if(v.status === "no_match")ok(str(v.reason))
  if(v.status === "failed")ok(rec(v.error) && one(v.error.code,["TIMEOUT","SOURCE_UNAVAILABLE","INVALID_INPUT","AUTHORIZATION_UNAVAILABLE","INTERNAL_ERROR"]) && str(v.error.message) && typeof v.error.retryable === "boolean")
  ok(rec(v.diagnostics));const d=v.diagnostics
  ok(one(d.searchStatus,["complete","partial","failed"]) && d.countUnit === "offer" && texts(d.warnings) && one(d.nextAction,["none","verify","search","clarify","resolve_configuration"]))
  list(d.candidateChecks,audit);list(d.verificationRequests,x=>{id(x);ok(texts(x.fields)&&str(x.reason))})
  list(d.filterLogs,x=>{ok(rec(x)&&str(x.conditionId));for(const k of ["inputCount","matchedCount","rejectedCount","unknownCount"])ok(Number.isSafeInteger(x[k])&&Number(x[k])>=0)})
  ok(rec(v.decisionRecord));const r=v.decisionRecord
  ok(r.taskId === v.taskId && r.requirementVersion === v.requirementVersion && r.dataEnvironment === v.dataEnvironment && str(r.decisionId) && str(r.policyVersion) && str(r.checkedAt) && Number.isFinite(Date.parse(String(r.checkedAt))))
  ok(rec(r.requestSnapshot) && rec(r.requestSnapshot.requirement) && r.requestSnapshot.requirement.taskId===v.taskId && r.requestSnapshot.requirement.requirementVersion===v.requirementVersion && Number.isSafeInteger(r.requestSnapshot.quantity) && Number(r.requestSnapshot.quantity)>0)
  list(r.candidateSnapshots,candidate);list(r.audits,audit);if(r.selected !== null)recommendation(r.selected)
  ok(JSON.stringify(r.candidateSnapshots)===JSON.stringify(v.candidates) && JSON.stringify(r.audits)===JSON.stringify(d.candidateChecks) && JSON.stringify(r.selected)===JSON.stringify((v.recommendations as unknown[])[0]??null))
  // This boundary is search/review only: never persist model/payment credentials or optimization contexts.
  ok(v.paymentOptimization === undefined && r.paymentContextSnapshot === undefined && r.paymentOptimization === undefined)
  assertStructuredSearchInput(v.searchInput);ok(v.searchInput.taskId===v.taskId && v.searchInput.requirementVersion===v.requirementVersion)
  ok(rec(v.translation) && v.translation.dictionaryVersion === "en-hk-v1" && str(v.translation.originalQuery) && str(v.translation.originalCategory) && texts(v.translation.retainedForB) && texts(v.translation.warnings))
  list(v.translation.mappings,x=>ok(rec(x)&&str(x.original)&&texts(x.aliases)))
  if(v.search!==null){ok(rec(v.search)&&v.search.taskId===v.taskId&&v.search.requirementVersion===v.requirementVersion&&one(v.search.status,["complete","partial","failed"])&&one(v.search.outcome,["ranked","no_match","failed"])&&texts(v.search.warnings)&&str(v.search.message));list(v.search.candidates,x=>{ok(rec(x)&&num(x.rank)&&num(x.finalScore)&& (x.llmAverageScore===null||num(x.llmAverageScore))&&(x.popularityScore===null||num(x.popularityScore))&&texts(x.needsVerification));candidate(x.candidate);list(x.conditionScores,c=>ok(rec(c)&&str(c.conditionId)&&Number.isInteger(c.score)&&Number(c.score)>=1&&Number(c.score)<=5&&str(c.reason)&&texts(c.evidenceFields)&&one(c.source,["llm","rule","deterministic-fallback"]))) });list(v.search.filterLogs,x=>ok(rec(x)&&str(x.conditionId)&&one(x.stage,["product_name","range","include","exclude"])&&one(x.mode,["must","prefer"])&&num(x.beforeCount)&&num(x.afterCount)&&num(x.removedCount)&&num(x.unknownCount)&&str(x.message)));ok(v.search.debug===undefined)}
  return structuredClone(v) as ContractShoppingResult
}

export function validateContractResult(value: unknown): ContractShoppingResult {
  try { return checkedContractResult(value) } catch (error) {
    if (error instanceof TaskError) throw error
    throw new TaskError("INVALID_INPUT", "Shopping 契约结果结构或事实非法；拒绝应用")
  }
}
