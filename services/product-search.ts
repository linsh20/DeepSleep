import type {
  AttributeValue,
  Candidate,
  ConditionScore,
  Fact,
  RankedCandidate,
  RankedSearchResult,
  ScoringCondition,
  StockStatus,
  StructuredSearchInput,
} from "../types"
import {
  createConfiguredConditionScorer,
  DeterministicConditionScorer,
} from "./condition-scorer"
import type { ConditionScorer } from "./condition-scorer"
import {
  identityKey,
  MockProductProvider,
  ProductProviderError,
} from "./product-provider"
import type { ProductProvider, RawProduct } from "./product-provider"
import { selectByPopularity } from "./popularity-ranker"
import {
  applyStructuredFilters,
  assessCondition,
  buildScoringConditions,
} from "./search-filter"

export type ProductSearchOptions = {
  recallLimit?: number
  providerTimeoutMs?: number
  scorerTimeoutMs?: number
  scorerConcurrency?: number
}

class SearchValidationError extends Error {}

export function createProductSearch(
  provider: ProductProvider,
  scorer: ConditionScorer = createConfiguredConditionScorer(),
  options: ProductSearchOptions = {},
) {
  const recallLimit = options.recallLimit ?? 100
  const providerTimeoutMs = options.providerTimeoutMs ?? 5000
  const scorerTimeoutMs = options.scorerTimeoutMs ?? 8000
  const scorerConcurrency = options.scorerConcurrency ?? 3
  validateOptions({ recallLimit, providerTimeoutMs, scorerTimeoutMs, scorerConcurrency })

  async function searchProducts(unsafeInput: StructuredSearchInput): Promise<RankedSearchResult> {
    const identity = resultIdentity(unsafeInput)
    let input: StructuredSearchInput
    try {
      assertStructuredSearchInput(unsafeInput)
      input = structuredClone(unsafeInput)
    } catch {
      return failed(identity, "INVALID_INPUT: 搜索条件格式无效。")
    }

    const warnings: string[] = []
    let partial = false
    let rawProducts: RawProduct[]
    try {
      const response = await timed(
        (signal) => provider.recall(input.product_name.value, recallLimit, { signal, input }),
        providerTimeoutMs,
      )
      if (!response || !Array.isArray(response.products) ||
          (response.status !== "complete" && response.status !== "partial") ||
          (response.warnings !== undefined &&
            (!Array.isArray(response.warnings) || !response.warnings.every((item) => typeof item === "string")))) {
        throw new ProductProviderError("SOURCE_UNAVAILABLE", "Malformed provider response")
      }
      rawProducts = response.products
      if (response.status === "partial") {
        partial = true
        warnings.push("SOURCE_UNAVAILABLE: 商品数据源只返回了部分结果。")
      }
      if (response.warnings?.length) {
        partial = true
        warnings.push("SOURCE_UNAVAILABLE: 商品数据源报告了部分结果。")
      }
    } catch (error) {
      return failed(identity, providerWarning(error))
    }

    const normalized = new Map<string, Candidate>()
    const warningsBeforeNormalization = warnings.length
    let rejectedRecords = 0
    for (const raw of rawProducts) {
      try {
        const candidate = normalizeProduct(raw, warnings)
        const key = identityKey(candidate)
        if (!normalized.has(key)) normalized.set(key, candidate)
      } catch {
        rejectedRecords++
      }
    }
    if (rejectedRecords > 0) {
      partial = true
      warnings.push(`SOURCE_UNAVAILABLE: ${rejectedRecords} 条商品记录格式无效，已跳过。`)
    }
    if (warnings.length > warningsBeforeNormalization) partial = true
    if (rawProducts.length > 0 && normalized.size === 0) {
      return failed(identity, "SOURCE_UNAVAILABLE: 商品数据源没有返回可用记录。")
    }

    const conditions = buildScoringConditions(input)
    const filtered = applyStructuredFilters([...normalized.values()], conditions)
    if (filtered.candidates.length === 0) {
      return {
        ...identity,
        status: partial ? "partial" : "complete",
        outcome: "no_match",
        candidates: [],
        filterLogs: filtered.logs,
        warnings: unique(warnings),
        message: "没有符合当前条件的商品。",
      }
    }

    const popularity = selectByPopularity(filtered.candidates, 10)
    if (popularity.applied) {
      warnings.push(`候选超过 10 种，已按评分和销量从 ${filtered.candidates.length} 种预选到 10 种。`)
    }
    if (scorer.kind === "deterministic") {
      partial = true
      warnings.push("SOURCE_UNAVAILABLE: 未配置 LLM，已使用确定性评分降级。")
    }

    const fallback = new DeterministicConditionScorer()
    const scoreWarnings: string[] = []
    const scored = await mapWithConcurrency(
      popularity.candidates,
      scorerConcurrency,
      async (candidate): Promise<Omit<RankedCandidate, "rank">> => {
        let conditionScores: ConditionScore[]
        try {
          conditionScores = await timed(
            (signal) => scorer.scoreCandidate({ candidate, conditions }, { signal }),
            scorerTimeoutMs,
          )
          assertConditionScores(conditionScores, conditions)
          conditionScores = enforceUnknownScores(conditionScores, candidate, conditions)
        } catch {
          partial = true
          scoreWarnings.push(`SOURCE_UNAVAILABLE: ${candidate.productId} 的 LLM 评分失败，已使用确定性评分降级。`)
          conditionScores = await fallback.scoreCandidate({ candidate, conditions })
        }
        return {
          candidate,
          finalScore: harmonicScore(conditionScores, conditions),
          popularityScore: popularity.scores.get(identityKey(candidate)) ?? null,
          conditionScores,
          needsVerification: conditions
            .filter((condition) => assessCondition(candidate, condition).state === "unknown")
            .map((condition) => condition.id),
        }
      },
    )

    scored.sort((left, right) =>
      right.finalScore - left.finalScore ||
      comparePopularity(right.popularityScore, left.popularityScore) ||
      identityKey(left.candidate).localeCompare(identityKey(right.candidate)))

    const candidates = scored.slice(0, 10).map((candidate, index) => ({ ...candidate, rank: index + 1 }))
    return {
      ...identity,
      status: partial ? "partial" : "complete",
      outcome: "ranked",
      candidates,
      filterLogs: filtered.logs,
      warnings: unique([...warnings, ...scoreWarnings]),
      message: `已按条件满足度排序并输出 ${candidates.length} 种商品。`,
    }
  }

  return { searchProducts }
}

const defaultSearch = createProductSearch(new MockProductProvider())
export const searchProducts = defaultSearch.searchProducts

export function assertStructuredSearchInput(value: unknown): asserts value is StructuredSearchInput {
  if (!isRecord(value) || !nonempty(value.taskId) || value.taskId.length > 200 ||
      !Number.isSafeInteger(value.requirementVersion) || Number(value.requirementVersion) < 0 ||
      !isRecord(value.product_name) || !nonempty(value.product_name.value) ||
      value.product_name.value.length > 200 || !mustFlag(value.product_name.must) ||
      !Array.isArray(value.range_conditions) || value.range_conditions.length > 50 ||
      !Array.isArray(value.include_keywords) || value.include_keywords.length > 50 ||
      !Array.isArray(value.exclude_keywords) || value.exclude_keywords.length > 50) {
    throw new SearchValidationError("Invalid search input")
  }
  for (const condition of value.range_conditions) {
    if (!isRecord(condition) || !["priceMinor", "volumeMl"].includes(String(condition.field)) ||
        !mustFlag(condition.must) || !validBound(condition.min) || !validBound(condition.max) ||
        (condition.min === null && condition.max === null) ||
        (typeof condition.min === "number" && typeof condition.max === "number" && condition.min > condition.max)) {
      throw new SearchValidationError("Invalid range condition")
    }
  }
  for (const group of [...value.include_keywords, ...value.exclude_keywords]) {
    if (!isRecord(group) || !mustFlag(group.must) || !Array.isArray(group.keywords) ||
        group.keywords.length < 1 || group.keywords.length > 20 ||
        !group.keywords.every((keyword) => nonempty(keyword) && keyword.length <= 100)) {
      throw new SearchValidationError("Invalid keyword condition")
    }
  }
}

function normalizeProduct(raw: RawProduct, warnings: string[]): Candidate {
  if (!isRecord(raw) || !nonempty(raw.productId) ||
      !(raw.skuId === null || nonempty(raw.skuId)) ||
      !(raw.offerId === null || nonempty(raw.offerId)) ||
      !nonempty(raw.title) || !nonempty(raw.url) || !/^https?:\/\//.test(raw.url) ||
      !nonempty(raw.category) || !nonempty(raw.source) || !nonempty(raw.fetchedAt) ||
      !Number.isFinite(Date.parse(raw.fetchedAt)) ||
      !["verified", "unverified", "mock"].includes(raw.status) ||
      !isRecord(raw.searchableText) || !isRecord(raw.attributes)) {
    throw new ProductProviderError("SOURCE_UNAVAILABLE", "Malformed product")
  }
  const ids = [raw.productId, raw.skuId, raw.offerId].filter((value): value is string => value !== null)
  if (new Set(ids).size !== ids.length) {
    throw new ProductProviderError("SOURCE_UNAVAILABLE", "Product identity fields must be distinct")
  }
  const fact = <T>(value: T | null): Fact<T> => ({
    value,
    source: raw.source,
    fetchedAt: raw.fetchedAt,
    status: raw.status,
  })
  const searchableText: Candidate["searchableText"] = {}
  for (const [field, value] of Object.entries(raw.searchableText)) {
    if (typeof value === "string" || value === null) searchableText[field] = fact(value)
    else {
      searchableText[field] = fact<string>(null)
      warnings.push(`SOURCE_UNAVAILABLE: ${raw.productId} 的文本字段 ${field} 无效。`)
    }
  }
  const attributes: Candidate["attributes"] = {}
  for (const [field, value] of Object.entries(raw.attributes)) {
    const valid = value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    attributes[field] = fact(valid ? value as AttributeValue | null : null)
    if (!valid) warnings.push(`SOURCE_UNAVAILABLE: ${raw.productId} 的属性 ${field} 无效。`)
  }
  validateCanonicalNumber(attributes, "volumeMl", (value) => Number.isSafeInteger(value) && value >= 0, raw.productId, warnings)
  validateCanonicalNumber(attributes, "rating", (value) => value >= 0 && value <= 5, raw.productId, warnings)
  validateCanonicalNumber(attributes, "salesCount", (value) => Number.isSafeInteger(value) && value >= 0, raw.productId, warnings)

  let offer: Candidate["offer"] = null
  if (raw.offer !== null) {
    if (!isRecord(raw.offer) || raw.offer.currency.toUpperCase() !== "HKD") {
      throw new ProductProviderError("SOURCE_UNAVAILABLE", "Unsupported currency")
    }
    offer = {
      currency: "HKD",
      itemPriceMinor: fact(normalizeMoney(raw.offer.itemPriceMinor, raw.productId, "itemPriceMinor", warnings)),
      shippingMinor: fact(normalizeMoney(raw.offer.shippingMinor, raw.productId, "shippingMinor", warnings)),
      discountMinor: fact(normalizeMoney(raw.offer.discountMinor, raw.productId, "discountMinor", warnings)),
      stock: fact(normalizeStock(raw.offer.stock, raw.productId, warnings)),
      deliverable: fact(normalizeBoolean(raw.offer.deliverable, raw.productId, "deliverable", warnings)),
    }
  }
  const missingFields = [
    ...Object.entries(searchableText).filter(([, value]) => value.value === null).map(([field]) => `searchableText.${field}`),
    ...Object.entries(attributes).filter(([, value]) => value.value === null).map(([field]) => `attributes.${field}`),
    ...(offer === null ? ["offer"] : Object.entries(offer)
      .filter(([field, value]) => field !== "currency" && (value as Fact<unknown>).value === null)
      .map(([field]) => `offer.${field}`)),
  ].sort()
  return {
    productId: raw.productId,
    skuId: raw.skuId,
    offerId: raw.offerId,
    title: raw.title,
    url: raw.url,
    category: raw.category,
    searchableText,
    attributes,
    offer,
    missingFields,
  }
}

function validateCanonicalNumber(
  attributes: Candidate["attributes"],
  field: string,
  valid: (value: number) => boolean,
  productId: string,
  warnings: string[],
): void {
  const fact = attributes[field]
  if (!fact || fact.value === null) return
  if (typeof fact.value !== "number" || !valid(fact.value)) {
    attributes[field] = { ...fact, value: null }
    warnings.push(`SOURCE_UNAVAILABLE: ${productId} 的属性 ${field} 无效。`)
  }
}

function assertConditionScores(scores: ConditionScore[], conditions: ScoringCondition[]): void {
  if (!Array.isArray(scores) || scores.length !== conditions.length) throw new Error("Invalid scores")
  const ids = new Set<string>()
  for (const score of scores) {
    if (!conditions.some((condition) => condition.id === score.conditionId) || ids.has(score.conditionId) ||
        !Number.isInteger(score.score) || score.score < 1 || score.score > 5 ||
        !nonempty(score.reason) || score.reason.length > 500 || !Array.isArray(score.evidenceFields) ||
        score.evidenceFields.length > 20 ||
        !score.evidenceFields.every((field) => typeof field === "string") ||
        !["llm", "rule", "deterministic-fallback"].includes(score.source)) {
      throw new Error("Invalid scores")
    }
    ids.add(score.conditionId)
  }
}

function harmonicScore(scores: ConditionScore[], conditions: ScoringCondition[]): number {
  const byId = new Map(scores.map((score) => [score.conditionId, score]))
  let totalWeight = 0
  let denominator = 0
  for (const condition of conditions) {
    const weight = condition.must === 1 ? 2 : 1
    totalWeight += weight
    denominator += weight / byId.get(condition.id)!.score
  }
  return Math.round((totalWeight / denominator) * 1_000_000) / 1_000_000
}

function enforceUnknownScores(
  scores: ConditionScore[],
  candidate: Candidate,
  conditions: ScoringCondition[],
): ConditionScore[] {
  const conditionById = new Map(conditions.map((condition) => [condition.id, condition]))
  return scores.map((score) => {
    const condition = conditionById.get(score.conditionId)!
    const assessment = assessCondition(candidate, condition)
    return assessment.state === "unknown"
      ? {
          conditionId: score.conditionId,
          score: 3,
          reason: assessment.reason,
          evidenceFields: assessment.evidenceFields,
          source: "rule",
        }
      : score
  })
}

async function timed<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new ProductProviderError("TIMEOUT", "Operation timed out"))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await action(values[index])
    }
  }))
  return results
}

function validateOptions(options: Required<ProductSearchOptions>): void {
  if (!Number.isSafeInteger(options.recallLimit) || options.recallLimit < 10 || options.recallLimit > 500 ||
      !Number.isSafeInteger(options.providerTimeoutMs) || options.providerTimeoutMs < 1 ||
      !Number.isSafeInteger(options.scorerTimeoutMs) || options.scorerTimeoutMs < 1 ||
      !Number.isSafeInteger(options.scorerConcurrency) || options.scorerConcurrency < 1 || options.scorerConcurrency > 10) {
    throw new SearchValidationError("Invalid product search options")
  }
}

function providerWarning(error: unknown): string {
  if (error instanceof ProductProviderError && error.code === "TIMEOUT") {
    return "TIMEOUT: 商品数据源请求超时。"
  }
  if (error instanceof ProductProviderError && error.code === "UNSUPPORTED_CATEGORY") {
    return "UNSUPPORTED_CATEGORY: 商品数据源不支持该类别。"
  }
  return "SOURCE_UNAVAILABLE: 商品数据源不可用。"
}

function failed(
  identity: Pick<RankedSearchResult, "taskId" | "requirementVersion">,
  warning: string,
): RankedSearchResult {
  return {
    ...identity,
    status: "failed",
    outcome: "failed",
    candidates: [],
    filterLogs: [],
    warnings: [warning],
    message: "商品搜索失败。",
  }
}

function resultIdentity(value: unknown): Pick<RankedSearchResult, "taskId" | "requirementVersion"> {
  return isRecord(value) && typeof value.taskId === "string" && Number.isSafeInteger(value.requirementVersion)
    ? { taskId: value.taskId, requirementVersion: value.requirementVersion as number }
    : { taskId: "", requirementVersion: 0 }
}

function normalizeMoney(
  value: unknown,
  productId: string,
  field: string,
  warnings: string[],
): number | null {
  if (value === null) return null
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value)
  warnings.push(`SOURCE_UNAVAILABLE: ${productId} 的报价字段 ${field} 无效。`)
  return null
}

function normalizeStock(value: unknown, productId: string, warnings: string[]): StockStatus | null {
  if (value === null || value === "available" || value === "unavailable") return value
  warnings.push(`SOURCE_UNAVAILABLE: ${productId} 的报价字段 stock 无效。`)
  return null
}

function normalizeBoolean(
  value: unknown,
  productId: string,
  field: string,
  warnings: string[],
): boolean | null {
  if (value === null || typeof value === "boolean") return value
  warnings.push(`SOURCE_UNAVAILABLE: ${productId} 的报价字段 ${field} 无效。`)
  return null
}

function validBound(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0)
}

function mustFlag(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function comparePopularity(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return -1
  if (right === null) return 1
  return left - right
}
