export type MustFlag = 0 | 1

export type ProductNameCondition = {
  value: string
  must: MustFlag
}

export type RangeField = "priceMinor" | "volumeMl"

export type RangeCondition = {
  field: RangeField
  min: number | null
  max: number | null
  must: MustFlag
}

export type KeywordCondition = {
  keywords: string[]
  must: MustFlag
}

export type StructuredSearchInput = {
  taskId: string
  requirementVersion: number
  product_name: ProductNameCondition
  range_conditions: RangeCondition[]
  include_keywords: KeywordCondition[]
  exclude_keywords: KeywordCondition[]
}

export type FactStatus = "verified" | "unverified" | "mock"

export type Fact<T> = {
  value: T | null
  source: string
  fetchedAt: string
  status: FactStatus
}

export type AttributeValue = number | string | boolean
export type StockStatus = "available" | "unavailable"

export type Candidate = {
  productId: string
  skuId: string | null
  offerId: string | null
  title: string
  url: string
  category: string
  searchableText: Record<string, Fact<string>>
  attributes: Record<string, Fact<AttributeValue>>
  offer: {
    currency: "HKD"
    itemPriceMinor: Fact<number>
    shippingMinor: Fact<number>
    discountMinor: Fact<number>
    stock: Fact<StockStatus>
    deliverable: Fact<boolean>
  } | null
  missingFields: string[]
}

export type ProductIdentity = Pick<Candidate, "productId" | "skuId" | "offerId">

export type FilterStage = "product_name" | "range" | "include" | "exclude"

export type FilterLog = {
  stage: FilterStage
  conditionId: string
  mode: "must" | "prefer"
  beforeCount: number
  afterCount: number
  removedCount: number
  unknownCount: number
  message: string
}

export type ScoringCondition = {
  id: string
  kind: FilterStage
  must: MustFlag
  label: string
  productName?: string
  field?: RangeField
  min?: number | null
  max?: number | null
  keywords?: string[]
}

export type ConditionScore = {
  conditionId: string
  score: 1 | 2 | 3 | 4 | 5
  reason: string
  evidenceFields: string[]
  source: "llm" | "rule" | "deterministic-fallback"
}

export type RankedCandidate = {
  rank: number
  candidate: Candidate
  finalScore: number
  popularityScore: number | null
  conditionScores: ConditionScore[]
  needsVerification: string[]
}

export type SearchStatus = "complete" | "partial" | "failed"
export type SearchOutcome = "ranked" | "no_match" | "failed"

export type RankedSearchResult = {
  taskId: string
  requirementVersion: number
  status: SearchStatus
  outcome: SearchOutcome
  candidates: RankedCandidate[]
  filterLogs: FilterLog[]
  warnings: string[]
  message: string
}

export type SearchErrorCode =
  | "INVALID_INPUT"
  | "SOURCE_UNAVAILABLE"
  | "TIMEOUT"
  | "UNSUPPORTED_CATEGORY"

export type ProviderStatus = "complete" | "partial"

export type ProviderSearchResult<T> = {
  products: T[]
  status: ProviderStatus
  warnings?: string[]
}
