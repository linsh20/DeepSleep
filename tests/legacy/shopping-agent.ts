// Test-only frozen compatibility fixture for retained pre-integration regressions.
import { createSearchAgent } from "./search-agent"
import { canonicalField, MockProductProvider } from "./product-provider"
import type { ProductProvider } from "./product-provider"
import { AgentBValidationError, assertRequirement, evaluateCandidates } from "../../lib/agent-b/index"
import type { EvaluateOptions } from "../../lib/agent-b/index"
import type { Requirement, SearchResult, ShoppingWorkflowResult } from "../../types"

// Purchase checks stay separate and require a backend authorization lookup.
export { checkPurchase } from "../../lib/agent-b/index"

export function createShoppingAgent(
  provider: ProductProvider,
  options: { timeoutMs?: number; maxVerificationRounds?: number; evaluation?: EvaluateOptions } = {},
) {
  const maxRounds = options.maxVerificationRounds ?? 2
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 0 || maxRounds > 2) {
    throw new AgentBValidationError("补查次数无效", ["maxVerificationRounds 必须为 0、1 或 2"])
  }
  const agentA = createSearchAgent(provider, { timeoutMs: options.timeoutMs })

  async function runShoppingTask(input: { requirement: Requirement; limit: number }): Promise<ShoppingWorkflowResult> {
    assertRequirement(input?.requirement)
    // Own a snapshot: caller edits during an await must not alter this task's version or budget.
    const requirement = structuredClone(input.requirement)
    const accept = (result: SearchResult) => {
      if (result.taskId !== requirement.taskId || result.requirementVersion !== requirement.requirementVersion) {
        throw new AgentBValidationError("结果需求版本不匹配", ["拒绝接收其他任务或版本的数据"])
      }
      return result
    }
    let search = accept(await agentA.searchCandidates({ requirement, limit: input.limit }))
    let evaluation = await evaluateCandidates({ requirement, candidates: search.candidates }, options.evaluation)
    let verificationRounds = 0
    const finish = (stopReason: ShoppingWorkflowResult["stopReason"]): ShoppingWorkflowResult => ({
      taskId: requirement.taskId, requirementVersion: requirement.requirementVersion,
      search, evaluation, verificationRounds, stopReason,
    })
    if (search.status === "failed" && search.candidates.length === 0) return finish("searchFailed")

    while (evaluation.status === "needsVerification" && verificationRounds < maxRounds) {
      const requests = evaluation.verificationRequests.map((request) => ({
        ...request,
        fields: request.fields.filter((field) =>
          /^(attributes|offer)\./.test(canonicalField(field) ?? "")),
      })).filter((request) => request.fields.length > 0)
      if (!requests.length) return finish("noVerifiableFields")
      const refreshed = accept(await agentA.verifyFacts({
        requirement, candidates: search.candidates, requests,
      }))
      search = { ...refreshed, warnings: [...new Set([...search.warnings, ...refreshed.warnings])] }
      verificationRounds++
      evaluation = await evaluateCandidates({ requirement, candidates: search.candidates }, options.evaluation)
    }
    return finish(evaluation.status === "needsVerification" ? "verificationLimit" : evaluation.status)
  }

  return { ...agentA, evaluateCandidates, runShoppingTask }
}

export const runShoppingTask = createShoppingAgent(new MockProductProvider()).runShoppingTask
