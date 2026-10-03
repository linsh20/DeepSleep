import { evaluateShoppingCandidates } from "./contract.ts"
import { AgentBValidationError } from "./index.ts"
import type { ContractBPolicy, ContractSearchPort, ContractWorkflowResult, Requirement, SearchResult, PaymentContext, StructuredSearchInput } from "../../types/index.ts"

/** Injection boundary for A. Existing mock A is not silently treated as proposal-v1 compliant. */
export function createContractShoppingAgent(
  port: ContractSearchPort,
  policy: ContractBPolicy,
  limits: { timeoutMs?: number; candidatePoolSize?: number; verificationBatchSize?: number; maxVerificationRounds?: number } = {},
) {
  const timeout = limits.timeoutMs ?? 5000
  const pool = limits.candidatePoolSize ?? 30
  const batch = limits.verificationBatchSize ?? 5
  const rounds = limits.maxVerificationRounds ?? 2
  if (![timeout,pool,batch].every(x => Number.isSafeInteger(x) && x > 0) || !Number.isSafeInteger(rounds) || rounds < 0 || rounds > 2) {
    throw new AgentBValidationError("编排配置无效", ["超时、候选池和批量大小必须为正整数，补查轮数为 0..2"])
  }
  return {
    async run(input: {requirement: Requirement; quantity: number; paymentContext?: PaymentContext; sourceSearchInput?: StructuredSearchInput}): Promise<ContractWorkflowResult> {
      const { paymentContext, sourceSearchInput, ...request } = structuredClone(input)
      const warnings: string[] = []
      const execute = async (call: (signal: AbortSignal) => Promise<SearchResult>): Promise<SearchResult> => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await Promise.race([Promise.resolve().then(() => call(controller.signal)), new Promise<never>((_,reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("TIMEOUT")) },timeout)
          })])
          if (result.taskId !== request.requirement.taskId || result.requirementVersion !== request.requirement.requirementVersion) throw new AgentBValidationError("A 返回了旧任务结果", ["taskId/requirementVersion 不匹配"])
          warnings.push(...result.warnings)
          return structuredClone(result)
        } finally { if (timer) clearTimeout(timer) }
      }
      // Validate request before invoking A, without inventing candidate facts.
      const preflight = await evaluateShoppingCandidates({...request, paymentContext, sourceSearchInput, candidates:[], searchStatus:"complete", sourceTaskId:request.requirement.taskId, sourceRequirementVersion:request.requirement.requirementVersion}, policy)
      if (["clarify", "resolve_configuration"].includes(preflight.diagnostics.nextAction)) return {...preflight,verificationRounds:0,stopReason:"completed"}
      let search: SearchResult
      try { search = await execute(signal => port.searchCandidates({...structuredClone(request), limit:pool, signal})) }
      catch (error) {
        if (error instanceof AgentBValidationError) throw error
        const result = await evaluateShoppingCandidates({...request,paymentContext,candidates:[],searchStatus:"failed",sourceTaskId:request.requirement.taskId,sourceRequirementVersion:request.requirement.requirementVersion}, policy)
        result.error = {code:error instanceof Error && error.message === "TIMEOUT" ? "TIMEOUT" : "SOURCE_UNAVAILABLE",message:"搜索未能完成",retryable:true}
        return {...result,verificationRounds:0,stopReason:"source_failed"}
      }
      if (search.candidates.length > pool) throw new AgentBValidationError("A 超过候选池上限", ["请遵守服务端 limit"])
      const evaluate = () => evaluateShoppingCandidates({...request,paymentContext,sourceSearchInput,candidates:search.candidates,searchStatus:search.status,sourceTaskId:search.taskId,sourceRequirementVersion:search.requirementVersion},policy)
      let result = await evaluate()
      let verificationRounds = 0
      let stopReason: ContractWorkflowResult["stopReason"] = "completed"
      // Ignore timestamps for no-progress; preserve outcomes so expiry refresh can still matter.
      const progress = () => JSON.stringify({candidates:search.candidates,checks:result.diagnostics.candidateChecks},
        (key,value) => ["fetchedAt","validUntil"].includes(key) ? undefined : value)
      while (result.status === "needs_verification" && verificationRounds < rounds) {
        const requests = result.diagnostics.verificationRequests.slice(0,batch)
        if (!requests.length) { stopReason = "no_verifiable_fields"; break }
        const before = progress()
        try {
          const updated = await execute(signal => port.verifyFacts({...structuredClone(request),candidates:structuredClone(search.candidates),requests:structuredClone(requests),signal}))
          if (updated.status === "failed") { warnings.push("补查来源失败，保留原候选和待核验状态"); stopReason="source_failed"; break }
          // Preserve candidates omitted by a partial verification response; reject identity injection.
          const id = (c: {productId:string;skuId:string|null;offerId:string|null}) => JSON.stringify([c.productId,c.skuId,c.offerId])
          const known = new Set(search.candidates.map(id))
          if (updated.candidates.some(c => !known.has(id(c)))) throw new AgentBValidationError("补查返回未知商品身份", ["不能用其他 Offer 替换待核验候选"])
          const replacements = new Map(updated.candidates.map(c => [id(c),c]))
          const requestedIds = new Set(requests.map(id))
          // Only requested identities may change; omitted/failed facts must not erase evidence.
          search = {...search,status:search.status === "partial" || updated.status === "partial" ? "partial" : "complete",candidates:search.candidates.map(c => {
            const replacement = replacements.get(id(c))
            if (!replacement || !requestedIds.has(id(c))) return c
            const merged = structuredClone(replacement)
            for (const section of ["attributes", "offer", "text", "merchant", "quote", "searchableText"] as const) {
              const oldFields = c[section]
              if (!oldFields) continue
              if (!merged[section]) {
                Object.assign(merged, { [section]: structuredClone(oldFields) })
                continue
              }
              const nextFields = merged[section] as unknown as Record<string, unknown>
              for (const [field, oldFact] of Object.entries(oldFields)) {
                const nextFact = nextFields[field]
                if (nextFact === undefined || (oldFact && typeof oldFact === "object" && "value" in oldFact && oldFact.value !== null &&
                  nextFact && typeof nextFact === "object" && "value" in nextFact && nextFact.value === null)) {
                  nextFields[field] = structuredClone(oldFact)
                }
              }
            }
            return merged
          })}
          verificationRounds++
          result = await evaluate()
          if (result.status === "needs_verification" && before === progress()) {stopReason="no_progress";break}
        } catch (error) {
          if (error instanceof AgentBValidationError) throw error
          warnings.push("补查超时或来源不可用，保留原候选")
          stopReason="source_failed";break
        }
      }
      if (result.status === "needs_verification" && verificationRounds >= rounds && stopReason === "completed") stopReason="verification_limit"
      result.diagnostics.warnings = [...new Set([...result.diagnostics.warnings,...warnings])]
      return {...result,verificationRounds,stopReason}
    },
  }
}
