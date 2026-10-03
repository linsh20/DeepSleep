import type {
  ProductConditionCheck, ProductReview, RankedSearchResult, SelectProductRequest,
  SelectProductResult, StructuredSearchInput,
} from "../types"
import { assertStructuredSearchInput, searchProducts } from "./product-search"
import { assessCondition, buildScoringConditions } from "./search-filter"
import { identityKey } from "./product-provider"

/** Product suitability only. Shipping, payment authorization and live quotes belong to level 2. */
export function createProductSelection(
  search: (input: StructuredSearchInput) => Promise<RankedSearchResult> = searchProducts,
) {
  return async function selectProduct(raw: SelectProductRequest): Promise<SelectProductResult> {
    const result: SelectProductResult = {
      taskId: typeof raw?.searchInput?.taskId === "string" ? raw.searchInput.taskId : "",
      requirementVersion: Number.isSafeInteger(raw?.searchInput?.requirementVersion)
        ? raw.searchInput.requirementVersion : 0,
      status: "failed", selection: null, searchStatus: "failed", reviews: [], warnings: [],
    }
    try {
      assertStructuredSearchInput(raw?.searchInput)
      if (raw.searchInput.product_name.must !== 1 ||
          (raw.quantity !== undefined && (!Number.isSafeInteger(raw.quantity) || raw.quantity < 1)) ||
          (raw.destination != null && (typeof raw.destination !== "string" || !raw.destination.trim())) ||
          (raw.excludedCandidates !== undefined && (!Array.isArray(raw.excludedCandidates) ||
            raw.excludedCandidates.length > 100 || raw.excludedCandidates.some(id =>
              !id || typeof id.productId !== "string" || !id.productId.trim() ||
              !(id.skuId === null || typeof id.skuId === "string" && !!id.skuId.trim()) ||
              !(id.offerId === null || typeof id.offerId === "string" && !!id.offerId.trim()))))) {
        throw new Error("Invalid selection request")
      }
    } catch {
      result.error = { code: "INVALID_INPUT", message: "需要有效 searchInput（品名 must=1）、正整数 quantity 和精确的 excludedCandidates。" }
      return result
    }

    const request = structuredClone(raw)
    try {
      const searchResult = await search(structuredClone(request.searchInput))
      if (searchResult.taskId !== result.taskId || searchResult.requirementVersion !== result.requirementVersion) {
        result.error = { code: "SOURCE_UNAVAILABLE", message: "搜索结果的任务或需求版本不匹配。" }
        return result
      }
      result.searchStatus = searchResult.status
      result.warnings = [...searchResult.warnings]
      if (searchResult.status === "failed") {
        result.error = { code: searchResult.warnings.some(w => w.startsWith("TIMEOUT:")) ? "TIMEOUT" : "SOURCE_UNAVAILABLE",
          message: "商品搜索失败，请重试或检查数据源。" }
        return result
      }

      const excluded = new Set((request.excludedCandidates ?? []).map(identityKey))
      const conditions = buildScoringConditions(request.searchInput)
      // Reuse deterministic rules; a high LLM score is not evidence of a hard-condition match.
      for (const item of [...searchResult.candidates].sort((a, b) => a.rank - b.rank).slice(0, 10)) {
        const candidate = item.candidate
        if (excluded.has(identityKey(candidate))) continue
        const checks: ProductConditionCheck[] = conditions.map(condition => {
          const assessment = assessCondition(candidate, condition)
          return {
            conditionId: condition.id, must: condition.must,
            outcome: assessment.state === "pass" ? "match" : assessment.state === "fail" ? "mismatch" : "unknown",
            evidenceFields: assessment.evidenceFields, reason: assessment.reason,
          }
        })
        const hard = checks.filter(check => check.must === 1)
        const review: ProductReview = {
          productId: candidate.productId, skuId: candidate.skuId, offerId: candidate.offerId,
          status: hard.some(check => check.outcome === "mismatch") ? "rejected"
            : hard.some(check => check.outcome === "unknown") ? "needs_verification" : "passed",
          checks,
        }
        result.reviews.push(review)
        if (review.status !== "passed") continue
        result.status = "ready"
        result.selection = {
          taskId: result.taskId, requirementVersion: result.requirementVersion,
          quantity: request.quantity ?? 1, destination: request.destination ?? null,
          searchInput: request.searchInput, candidate: structuredClone(candidate),
          productCheck: { status: "passed", checkedAt: new Date().toISOString(), checks },
        }
        return result
      }
      result.status = result.reviews.some(review => review.status === "needs_verification")
        ? "needs_verification" : "no_match"
      return result
    } catch {
      return { ...result, status: "failed", selection: null, searchStatus: "failed",
        error: { code: "SOURCE_UNAVAILABLE", message: "无法完成商品搜索和条件检查。" } }
    }
  }
}

export const selectProduct = createProductSelection()
