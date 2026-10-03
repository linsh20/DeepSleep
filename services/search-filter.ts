import type {
  Candidate,
  FilterLog,
  KeywordScope,
  RangeField,
  ScoringCondition,
  StructuredSearchInput,
} from "../types"

export type ConditionAssessment = {
  state: "pass" | "fail" | "unknown"
  evidenceFields: string[]
  reason: string
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function buildScoringConditions(input: StructuredSearchInput): ScoringCondition[] {
  return [
    {
      id: "product_name",
      kind: "product_name",
      must: input.product_name.must,
      label: `品名包含“${input.product_name.value}”`,
      productName: input.product_name.value,
      aliases: [...(input.product_name.aliases ?? [])],
    },
    ...input.range_conditions.map((condition, index): ScoringCondition => ({
      id: `range:${index}:${condition.field}`,
      kind: "range",
      must: condition.must,
      label: `${rangeLabel(condition.field)} ${renderRange(condition.min, condition.max)}`,
      field: condition.field,
      min: condition.min,
      max: condition.max,
    })),
    ...input.include_keywords.map((condition, index): ScoringCondition => ({
      id: `include:${index}`,
      kind: "include",
      must: condition.must,
      label: `包含任一关键词：${condition.keywords.join(" / ")}`,
      keywords: [...condition.keywords],
      scope: condition.scope ?? "all",
    })),
    ...input.exclude_keywords.map((condition, index): ScoringCondition => ({
      id: `exclude:${index}`,
      kind: "exclude",
      must: condition.must,
      label: `不包含任一关键词：${condition.keywords.join(" / ")}`,
      keywords: [...condition.keywords],
      scope: condition.scope ?? "all",
    })),
  ]
}

export function assessCondition(
  candidate: Candidate,
  condition: ScoringCondition,
): ConditionAssessment {
  if (condition.kind === "product_name") {
    const expected = [condition.productName ?? "", ...(condition.aliases ?? [])]
      .map(normalizeText)
      .filter(Boolean)
    const title = normalizeText(candidate.title)
    const matched = expected.some((term) => title.includes(term))
    return {
      state: matched ? "pass" : "fail",
      evidenceFields: ["title"],
      reason: matched ? "商品标题匹配品名或别名" : "商品标题不匹配品名或别名",
    }
  }

  if (condition.kind === "range") {
    const field = condition.field as RangeField
    const value = numericValue(candidate, field)
    const evidenceField = field === "priceMinor" ? "offer.itemPriceMinor" : "attributes.volumeMl"
    if (value === null) {
      return { state: "unknown", evidenceFields: [evidenceField], reason: `${evidenceField} 缺失` }
    }
    const matched = (condition.min === null || condition.min === undefined || value >= condition.min) &&
      (condition.max === null || condition.max === undefined || value <= condition.max)
    return {
      state: matched ? "pass" : "fail",
      evidenceFields: [evidenceField],
      reason: matched ? `${value} 在要求范围内` : `${value} 超出要求范围`,
    }
  }

  const keywords = condition.keywords ?? []
  const scope = condition.scope ?? "all"
  const corpus = searchableCorpus(candidate, scope)
  const matchedKeywords = keywords.filter((keyword) => keywordMatches(corpus.rawText, keyword, scope))
  const evidenceFields = corpus.evidenceFields
  if (condition.kind === "include") {
    if (matchedKeywords.length > 0) {
      return { state: "pass", evidenceFields, reason: `匹配关键词：${matchedKeywords.join("、")}` }
    }
    return corpus.complete
      ? { state: "fail", evidenceFields, reason: "商品文本未匹配包含关键词" }
      : { state: "unknown", evidenceFields, reason: "商品文本不完整，无法确认包含关键词" }
  }

  if (matchedKeywords.length > 0) {
    return { state: "fail", evidenceFields, reason: `匹配到排除关键词：${matchedKeywords.join("、")}` }
  }
  return corpus.complete
    ? { state: "pass", evidenceFields, reason: "商品文本未匹配排除关键词" }
    : { state: "unknown", evidenceFields, reason: "商品文本不完整，无法确认未包含排除关键词" }
}

export function applyStructuredFilters(
  candidates: Candidate[],
  conditions: ScoringCondition[],
): { candidates: Candidate[]; logs: FilterLog[] } {
  let remaining = [...candidates]
  const logs: FilterLog[] = []

  for (const condition of conditions) {
    const beforeCount = remaining.length
    const assessments = remaining.map((candidate) => ({
      candidate,
      assessment: assessCondition(candidate, condition),
    }))
    const unknownCount = assessments.filter(({ assessment }) => assessment.state === "unknown").length
    if (condition.must === 1) {
      remaining = assessments
        .filter(({ assessment }) => assessment.state !== "fail")
        .map(({ candidate }) => candidate)
    }
    const afterCount = remaining.length
    const mode = condition.must === 1 ? "must" : "prefer"
    logs.push({
      stage: condition.kind,
      conditionId: condition.id,
      mode,
      beforeCount,
      afterCount,
      removedCount: beforeCount - afterCount,
      unknownCount,
      message: condition.must === 1
        ? `按${condition.label}筛选后，由 ${beforeCount} 种缩小到 ${afterCount} 种`
        : `偏好条件“${condition.label}”不执行淘汰，仍为 ${afterCount} 种`,
    })
    if (remaining.length === 0) break
  }

  return { candidates: remaining, logs }
}

function numericValue(candidate: Candidate, field: RangeField): number | null {
  if (field === "priceMinor") return candidate.offer?.itemPriceMinor.value ?? null
  const value = candidate.attributes.volumeMl?.value
  return typeof value === "number" ? value : null
}

function searchableCorpus(
  candidate: Candidate,
  scope: KeywordScope,
): { rawText: string; complete: boolean; evidenceFields: string[] } {
  if (scope === "ingredients") {
    const ingredients = candidate.searchableText.ingredients
    return {
      rawText: ingredients?.value ?? "",
      complete: ingredients?.value !== null && ingredients?.value !== undefined,
      evidenceFields: ["searchableText.ingredients"],
    }
  }

  const entries = Object.entries(candidate.searchableText)
  const facts = entries.map(([, fact]) => fact)
  return {
    rawText: [
      candidate.title,
      ...facts.flatMap((fact) => fact.value === null ? [] : [fact.value]),
    ].join(" "),
    complete: facts.length > 0 && facts.every((fact) => fact.value !== null),
    evidenceFields: ["title", ...entries.map(([key]) => `searchableText.${key}`)],
  }
}

function keywordMatches(text: string, keyword: string, scope: KeywordScope): boolean {
  const normalizedKeyword = normalizeText(keyword)
  if (!normalizedKeyword) return false
  if (scope === "ingredients" && isVolatileAlcoholKeyword(normalizedKeyword)) {
    return containsVolatileAlcohol(text)
  }
  if (scope === "ingredients" && ["fragrance", "parfum", "perfume", "香精", "香料"].includes(normalizedKeyword)) {
    return ingredientSegments(text).some((segment) =>
      !/^(?:fragrance|parfum|perfume) free$/.test(segment) &&
      /(?:\b(?:fragrance|parfum|perfume)\b|香精|香料)/.test(segment))
  }
  return normalizeText(text).includes(normalizedKeyword)
}

function isVolatileAlcoholKeyword(value: string): boolean {
  return [
    "alcohol", "alcohol denat", "alcohol denatured", "denatured alcohol",
    "ethanol", "ethyl alcohol", "isopropyl alcohol", "isopropanol",
    "sd alcohol", "酒精", "变性酒精", "乙醇",
  ].includes(value) || value.startsWith("sd alcohol ")
}

function containsVolatileAlcohol(value: string): boolean {
  return ingredientSegments(value).some((segment) =>
    /^(?:alcohol(?: denat(?:ured)?)?|denatured alcohol|ethanol|ethyl alcohol|isopropyl alcohol|isopropanol|sd alcohol(?: \d+[a-z]?)?|酒精|变性酒精|乙醇)$/.test(segment))
}

function ingredientSegments(value: string): string[] {
  return value.split(/[,;\n]/).map(normalizeText).filter(Boolean)
}

function rangeLabel(field: RangeField): string {
  return field === "priceMinor" ? "价格（HKD 最小货币单位）" : "容量（ml）"
}

function renderRange(min: number | null | undefined, max: number | null | undefined): string {
  if (min !== null && min !== undefined && max !== null && max !== undefined) return `${min}–${max}`
  if (min !== null && min !== undefined) return `不低于 ${min}`
  return `不高于 ${max}`
}
