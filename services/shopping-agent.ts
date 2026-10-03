import { assertStructuredSearchInput, searchProducts } from "./product-search"
import { createContractShoppingAgent } from "../lib/agent-b/workflow"
import { AgentBValidationError, assertCandidate } from "../lib/agent-b/index"
import type {
  Candidate, ContractBPolicy, ContractSearchPort, ContractWorkflowResult, Fact,
  PaymentContext, RankedSearchResult, Requirement, ShoppingCandidate, StructuredSearchInput,
} from "../types"

export type ShoppingAgentRequest = {
  requirement: Requirement
  quantity: number
  /** Main Agent's normalized A conditions; optional broad recall when absent. */
  searchInput?: StructuredSearchInput
  paymentContext?: PaymentContext
}
export type ShoppingAgentResult = ContractWorkflowResult & { search: RankedSearchResult | null }
export type ShoppingDependencies = {
  searchProducts: (input: StructuredSearchInput, context?: { signal: AbortSignal }) => Promise<RankedSearchResult>
  /** Trusted server adapter for live merchant/quote facts. Never model-generated facts. */
  verifyFacts?: ContractSearchPort["verifyFacts"]
}

/** A shape -> B shape. No fabricated quote, delivery, merchant or provenance. */
export function adaptSearchCandidate(candidate: Candidate): ShoppingCandidate {
  assertCandidate(candidate)
  if (typeof candidate.category !== "string" || !candidate.searchableText ||
      typeof candidate.searchableText !== "object" || Array.isArray(candidate.searchableText)) {
    throw new AgentBValidationError("A 候选格式无效", ["需要 category 和 searchableText"])
  }
  const copy = structuredClone(candidate)
  const facts = Object.values(copy.searchableText)
  const valid = facts.length > 0 && facts.every(f => f && typeof f === "object" &&
    (typeof f.value === "string" || f.value === null) && typeof f.source === "string" &&
    Number.isFinite(Date.parse(f.fetchedAt)) && ["verified", "unverified", "mock"].includes(f.status))
  let searchable: Fact<string> = { value: null, source: "", fetchedAt: "", status: "unverified" }
  if (valid) {
    searchable = {
      value: facts.every(f => f.value !== null) ? facts.map(f => f.value).join(" ") : null,
      source: [...new Set(facts.map(f => f.source))].join(";"),
      fetchedAt: new Date(Math.min(...facts.map(f => Date.parse(f.fetchedAt)))).toISOString(),
      status: facts.some(f => f.status === "mock") ? "mock" : facts.some(f => f.status === "unverified") ? "unverified" : "verified",
    }
    const expiries = facts.flatMap(f => f.validUntil ? [Date.parse(f.validUntil)] : [])
    if (expiries.length && expiries.every(Number.isFinite)) searchable.validUntil = new Date(Math.min(...expiries)).toISOString()
  }
  return { ...copy, text: { searchable }, missingFields: [...new Set([
    ...copy.missingFields, "merchant", "quote", ...(searchable.value === null ? ["text.searchable"] : []),
  ])] }
}

/** Server composition: latest A -> B -> optional trusted verification -> B again. */
export function createShoppingAgent(
  dependencies: ShoppingDependencies,
  policy: ContractBPolicy,
  limits: Parameters<typeof createContractShoppingAgent>[2] = {},
) {
  return {
    async runShoppingTask(raw: ShoppingAgentRequest, context?: { signal: AbortSignal }): Promise<ShoppingAgentResult> {
      const request = structuredClone(raw)
      if (!request?.requirement) throw new AgentBValidationError("缺少需求", ["requirement 必填"])
      const r = request.requirement
      const searchInput = request.searchInput ?? {
        taskId: r.taskId, requirementVersion: r.requirementVersion,
        product_name: { value: r.query || r.category, must: 0 },
        range_conditions: [], include_keywords: [], exclude_keywords: [],
      }
      try { assertStructuredSearchInput(searchInput) }
      catch { throw new AgentBValidationError("搜索输入无效", ["按 StructuredSearchInput 提供条件"] ) }
      if (searchInput.taskId !== r.taskId || searchInput.requirementVersion !== r.requirementVersion) {
        throw new AgentBValidationError("搜索需求版本不匹配", ["不能拼接不同任务或版本"])
      }
      let search: RankedSearchResult | null = null
      const port: ContractSearchPort = {
        async searchCandidates({ signal }) {
          const result = await dependencies.searchProducts(structuredClone(searchInput), { signal })
          signal.throwIfAborted()
          if (!result || !Array.isArray(result.candidates) || !Array.isArray(result.warnings) ||
              !result.warnings.every(w => typeof w === "string") || !["complete", "partial", "failed"].includes(result.status) ||
              !["ranked", "no_match", "failed"].includes(result.outcome) ||
              (result.status === "failed") !== (result.outcome === "failed") ||
              (result.outcome !== "ranked" && result.candidates.length > 0)) {
            throw new AgentBValidationError("A 结果格式无效", ["RankedSearchResult 格式/状态不一致"])
          }
          search = structuredClone(result)
          return { taskId: result.taskId, requirementVersion: result.requirementVersion,
            status: result.status, candidates: result.candidates.map(row => adaptSearchCandidate(row.candidate)),
            warnings: [...result.warnings, "B 仅审核 A 返回的候选池；A 的评分不是已核验事实，也不证明全市场最优。"] }
        },
        verifyFacts: dependencies.verifyFacts ?? (async ({ requirement, candidates }) => ({
          taskId: requirement.taskId, requirementVersion: requirement.requirementVersion,
          candidates, status: "partial", warnings: ["SOURCE_UNAVAILABLE: 未接入商户报价/配送补查服务；保留未知字段。"],
        })),
      }
      const result = await createContractShoppingAgent(port, policy, limits).run({
        requirement: r, quantity: request.quantity, paymentContext: request.paymentContext, sourceSearchInput: searchInput,
      }, context)
      return { ...result, search }
    },
  }
}

/** Policy (environment, allowlist, TTL) is server-owned, not accepted from a browser body. */
export function runShoppingTask(request: ShoppingAgentRequest, policy: ContractBPolicy, dependencies: ShoppingDependencies = { searchProducts }) {
  return createShoppingAgent(dependencies, policy).runShoppingTask(request)
}
