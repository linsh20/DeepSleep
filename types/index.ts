export type MustFlag = 0 | 1

export type ProductNameCondition = {
  value: string
  /** English aliases generated upstream for the en_HK Watsons snapshot. */
  aliases?: string[]
  must: MustFlag
}

export type RangeField = "priceMinor" | "volumeMl"

export type RangeCondition = {
  field: RangeField
  min: number | null
  max: number | null
  must: MustFlag
}

export type KeywordScope = "all" | "ingredients"

export type KeywordCondition = {
  keywords: string[]
  /** Defaults to all searchable product text. */
  scope?: KeywordScope
  must: MustFlag
}

export type StructuredSearchInput = {
  taskId: string
  requirementVersion: number
  /** Defaults to true. False explicitly selects deterministic scoring for this request. */
  useLlm?: boolean
  product_name: ProductNameCondition
  range_conditions: RangeCondition[]
  include_keywords: KeywordCondition[]
  exclude_keywords: KeywordCondition[]
}

export type FactStatus = "verified" | "unverified" | "mock"

export type Fact<T> = {
  validUntil?: string
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
  aliases?: string[]
  field?: RangeField
  min?: number | null
  max?: number | null
  keywords?: string[]
  scope?: KeywordScope
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
  /** Arithmetic mean of the raw LLM condition scores; null when the LLM was not used or failed. */
  llmAverageScore: number | null
  popularityScore: number | null
  conditionScores: ConditionScore[]
  needsVerification: string[]
}

export type SearchStatus = "complete" | "partial" | "failed"
export type SearchOutcome = "ranked" | "no_match" | "failed"

export type LlmDebugEvent = {
  productId: string
  direction: "request" | "response" | "error"
  payload: unknown
}

export type RankedSearchResult = {
  taskId: string
  requirementVersion: number
  status: SearchStatus
  outcome: SearchOutcome
  candidates: RankedCandidate[]
  filterLogs: FilterLog[]
  warnings: string[]
  message: string
  /** Present only when the server-side local development debug switch is enabled. */
  debug?: {
    llmEvents: LlmDebugEvent[]
  }
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

// Hackathon integration: main agent -> search + product check -> payment risk.
/** Public function input. Prices are HKD dollars, e.g. 100 = HKD 100. */
export type ProductSelectionConditions = Omit<StructuredSearchInput, "range_conditions"> & {
  range_conditions: {
    field: "priceHkd" | "volumeMl"
    min: number | null
    max: number | null
    must: MustFlag
  }[]
}

export type SelectProductRequest = {
  searchInput: ProductSelectionConditions
  quantity?: number
  destination?: string | null
  /** Previously rejected exact offers; skip them when selecting from the top ten. */
  excludedCandidates?: ProductIdentity[]
}

export type ProductConditionCheck = ConditionCheck & { must: MustFlag }

export type ProductReview = ProductIdentity & {
  status: "passed" | "rejected" | "needs_verification"
  checks: ProductConditionCheck[]
}

/** Database facts for level 2. No URL; all monetary values use HKD dollars. */
export type HandoffProduct = Omit<Candidate, "url" | "offer"> & {
  /** products.code in the Watsons SQLite database; null for Mock products. */
  databaseCode: string | null
  offer: {
    currency: "HKD"
    priceHkd: Fact<number>
    shippingHkd: Fact<number>
    discountHkd: Fact<number>
    stock: Fact<StockStatus>
    deliverable: Fact<boolean>
  } | null
}

/** Product check output; add orderAmount before handing off to level 2. */
export type ProductHandoff = {
  taskId: string
  requirementVersion: number
  quantity: number
  destination: string | null
  searchInput: ProductSelectionConditions
  candidate: HandoffProduct
  productCheck: {
    status: "passed"
    checkedAt: string
    checks: ProductConditionCheck[]
  }
}

export type SelectProductResult = {
  taskId: string
  requirementVersion: number
  status: "ready" | "no_match" | "needs_verification" | "failed"
  selection: ProductHandoff | null
  searchStatus: SearchStatus
  reviews: ProductReview[]
  warnings: string[]
  error?: { code: SearchErrorCode; message: string }
}

/** Main agent sends this directly to payment risk; search never needs it. */
export type PaymentRiskAuthorization = {
  taskId: string
  requirementVersion: number
  userId: string
  authorization: {
    authorizationId: string
    allowedOfferId: string
    /** HKD dollars, e.g. 300 = HKD 300, at most two decimal places. */
    maxTotalHkd: number
    maxQuantity: number
    currency: "HKD"
    expiresAt: string
  }
  /** Opaque references only. Empty means no restriction within the user's available methods. */
  allowedPaymentMethodIds: string[]
  preferredPaymentMethodId: string | null
}

/** Arguments for the level-2 risk team's function. */
export type PaymentRiskRequest = {
  selection: PricedProductHandoff
  userAuthorization: PaymentRiskAuthorization
}

/** One order, one selected card. Monetary inputs are major units, never cents. */
export type OrderPricingTerms = {
  unitPriceHkd: number | null
  shippingHkd: number | null
  /** Additional order discount, excluding discounts already reflected in unitPriceHkd. */
  orderDiscountHkd: number | null
  paymentMethodId: string
  eligible: boolean | null
  billingCurrency: "HKD" | "CNY" | "USD" | "EUR" | "GBP" | "JPY"
  /** Billing currency units per HKD; null is allowed only for HKD (rate 1). */
  settlementRate: string | null
  /** HKD per billing currency unit, a reference rate independent of card settlement. */
  referenceRateToHkd: string | null
  feePercent: number | null
  /** Major units of billingCurrency, not HKD when using a foreign-currency card. */
  fixedFeeBillingAmount: number | null
  cardOffer: {
    minSpendHkd: number
    discountPercent: number
    discountHkd: number
    capHkd: number | null
  } | null
  /** Delayed cashback is informational; never reduces upfront charge. */
  futureCashbackHkd: number | null
}

export type OrderPricingInput = ProductIdentity & {
  taskId: string
  requirementVersion: number
  quantity: number
  destination: string | null
  /** Trusted quote/terms snapshot, with the oldest fetchedAt and earliest expiry of its inputs. */
  pricing: Fact<OrderPricingTerms>
}

export type OrderAmount = {
  currency: "HKD"
  unitPriceHkd: number
  itemsSubtotalHkd: number
  shippingHkd: number
  orderDiscountHkd: number
  beforeCardDiscountHkd: number
  cardDiscountHkd: number
  merchantPayableHkd: number
  /** Upfront debit including FX and fees, converted to HKD for level-2 limit checks. */
  totalHkd: number
  paymentMethodId: string
  billingCurrency: OrderPricingTerms["billingCurrency"]
  billingPrincipal: number
  billingFee: number
  billingTotal: number
  settlementRate: string
  referenceRateToHkd: string
  futureCashbackHkd: number | null
  checkedAt: string
  validUntil: string
  evidenceStatus: "mock" | "verified"
  evidence: Fact<OrderPricingTerms>
}

export type PricedProductHandoff = ProductHandoff & { orderAmount: OrderAmount }

export type PreparePaymentHandoffResult = {
  taskId: string
  requirementVersion: number
  status: "ready" | "needs_verification" | "no_available_method" | "failed"
  selection: PricedProductHandoff | null
  reasons: string[]
  error?: { code: SearchErrorCode; message: string }
}

export type PaymentRiskResult = {
  taskId: string
  requirementVersion: number
  status: "approved" | "blocked" | "needs_verification"
  offerId: string | null
  totalHkd: number | null
  currency: "HKD"
  reasons: string[]
}

// Agent B contract; Candidate remains the existing Agent A search shape.
export type ConstraintOperator = "lte" | "gte" | "eq" | "in" | "notIn" | "containsAny" | "notContainsAny"

export type Constraint = {
  id?: string
  field: string
  op: ConstraintOperator
  value: number | string | boolean | string[]
}

export type Preference = {
  id?: string
  conditions?: Constraint[]
  field: string
  weight: number
  source: "explicit" | "inferred"
}

export type Requirement = {
  taskId: string
  requirementVersion: number
  category: string
  query: string
  currency: string
  budget: {
    maxMinor: number
    scope: "item" | "delivered"
  }
  hardConstraints: Constraint[]
  preferences: Preference[]
  excludedProductIds: string[]
  allowAlternativeProducts?: boolean
  destination?: string
}

export type ShoppingCandidate = {
  category?: string
  searchableText?: Record<string, Fact<string>>
  text?: { searchable: Fact<string> }
  merchant?: { id: string; name: Fact<string>; platformId?: Fact<string> }
  quote?: {
    quantity: number
    destination: string
    otherFeesMinor: Fact<number>
    totalMinor: Fact<number>
    estimatedDeliveryAtMs: Fact<number>
    canFulfillQuantity?: Fact<boolean>
  }
  productId: string
  skuId: string | null
  offerId: string | null
  title: string
  url: string
  attributes: Record<string, Fact<AttributeValue>>
  offer: {
    currency: string
    itemPriceMinor: Fact<number>
    shippingMinor: Fact<number>
    discountMinor: Fact<number>
    stock: Fact<StockStatus>
    deliverable: Fact<boolean>
  } | null
  missingFields: string[]
}

export type SearchResult = {
  taskId: string
  requirementVersion: number
  candidates: ShoppingCandidate[]
  status: SearchStatus
  warnings: string[]
}

export type VerificationRequest = {
  productId: string
  skuId: string | null
  offerId: string | null
  fields: string[]
  reason: string
}

export type EvaluationRecommendation = {
  productId: string
  skuId: string | null
  offerId: string | null
  score: number
  label: string
  satisfied: string[]
  tradeoffs: string[]
  evidenceFields: string[]
}

export type EvaluationResult = {
  taskId: string
  requirementVersion: number
  status: "ready" | "needsVerification" | "needsSearch"
  recommendations: EvaluationRecommendation[]
  rejected: {
    productId: string
    skuId?: string | null
    offerId?: string | null
    reasons: string[]
  }[]
  verificationRequests: VerificationRequest[]
  searchHints: string[]
}

export type Authorization = {
  authorizationId: string
  allowedOfferId: string
  maxTotalMinor: number
  maxQuantity: number
  currency: string
  expiresAt: string
}

export type PurchaseCheck = {
  taskId: string
  requirementVersion: number
  status: "approved" | "blocked" | "needsVerification"
  offerId: string | null
  totalMinor: number | null
  checkedAt: string
  reasons: string[]
  verificationRequests: VerificationRequest[]
  paymentOptimization?: PaymentOptimizationResult
}

export type EvaluateCandidatesInput = {
  requirement: Requirement
  candidates: ShoppingCandidate[]
}

export type CheckPurchaseInput = {
  requirement: Requirement
  candidate: ShoppingCandidate
  quantity: number
  authorization: Authorization | null
}

export type AgentErrorCode =
  | "TIMEOUT"
  | "SOURCE_UNAVAILABLE"
  | "INVALID_INPUT"
  | "AUTHORIZATION_UNAVAILABLE"
  | "INTERNAL_ERROR"

export type AgentError = {
  code: AgentErrorCode
  message: string
  retryable: boolean
  details?: string[]
}

export type SearchPlan = {
  category: string
  terms: string[]
  currency: string
  budget: Requirement["budget"]
  constraints: Requirement["hardConstraints"]
  excludedProductIds: string[]
  requiredFields: string[]
  destination?: string
}

export type ShoppingWorkflowResult = {
  taskId: string
  requirementVersion: number
  search: SearchResult
  evaluation: EvaluationResult
  verificationRounds: number
  stopReason: "ready" | "needsSearch" | "searchFailed" | "verificationLimit" | "noVerifiableFields" | "noProgress"
}

// proposal-v1: canonical contract for the new B entry. Legacy UI types above remain adapters.
export type ConditionOutcome = "match" | "mismatch" | "unknown"
export type ConditionCheck = {
  conditionId: string
  outcome: ConditionOutcome
  evidenceFields: string[]
  reason: string
}
export type CandidateAudit = ProductIdentity & {
  checks: ConditionCheck[]
  preferenceChecks: ConditionCheck[]
  disposition: "eligible" | "rejected" | "needs_verification"
  scoreLowerBound: number | null
  scoreUpperBound: number | null
}
export type ContractRecommendation = ProductIdentity & {
  rank: number
  evidenceStatus: "verified" | "mock"
  checks: ConditionCheck[]
  preferenceChecks: ConditionCheck[]
  scoreLowerBound: number | null
  scoreUpperBound: number | null
  explanation: string
  tradeoffs: string[]
}
export type DecisionRecord = {
  decisionId: string
  taskId: string
  requirementVersion: number
  checkedAt: string
  policyVersion: string
  dataEnvironment: "development_mock" | "verified_sources"
  requestSnapshot: { requirement: Requirement; quantity: number }
  candidateSnapshots: ShoppingCandidate[]
  audits: CandidateAudit[]
  selected: ContractRecommendation | null
  paymentContextSnapshot?: PaymentContext
  paymentOptimization?: PaymentOptimizationResult
}
export type ContractEvaluationInput = {
  sourceSearchInput?: StructuredSearchInput
  requirement: Requirement
  quantity: number
  candidates: ShoppingCandidate[]
  searchStatus: SearchStatus
  // The orchestration layer supplies A's envelope, so stale data can be rejected.
  sourceTaskId: string
  sourceRequirementVersion: number
  paymentContext?: PaymentContext
}
export type PriceBenchmark = {
  productId: string
  skuId: string
  currency: string
  destination: string
  medianUnitPriceMinor: number
  offerCount: number
  sellerCount: number
  fetchedAt: string
  source: string
  excludedOfferIds: string[]
}
export type ContractBPolicy = {
  /** Search-only integration may inspect candidates without trusted checkout configuration. */
  searchOnly?: boolean
  policyVersion: string
  dataEnvironment: "development_mock" | "verified_sources"
  merchantAllowlist: { id: string; platformId: string }[]
  priceBenchmarks: PriceBenchmark[]
  lowPriceRatio?: number
  offerTtlMs?: number
  staticTtlMs?: number
  now?: () => Date
  categoryAliases?: Record<string, string>
  /** Trusted language aliases for user text, not product facts. */
  textAliases?: Record<string, string[]>
  /** Broad source taxonomy cannot prove a more specific requested category. */
  broadCategories?: string[]
  // Explicit server schema: unknown constraint fields are errors, not ignored.
  attributeSchema?: Record<string, "number" | "string" | "boolean">
  payment?: Pick<PaymentOptimizationPolicy, "factTtlMs" | "currencyMinorUnits">
}
export type ContractBResult = {
  taskId: string
  requirementVersion: number
  dataEnvironment: ContractBPolicy["dataEnvironment"]
  status: "result_ready" | "no_match" | "needs_verification" | "failed"
  plan?: { title: string; notice: string; priceMinor: Fact<number> }
  reason?: string
  missingFacts?: string[]
  candidates: ShoppingCandidate[]
  recommendations: ContractRecommendation[]
  diagnostics: {
    searchStatus: SearchStatus
    countUnit: "offer"
    candidateChecks: CandidateAudit[]
    filterLogs: { conditionId: string; inputCount: number; matchedCount: number; rejectedCount: number; unknownCount: number }[]
    verificationRequests: VerificationRequest[]
    warnings: string[]
    nextAction: "none" | "verify" | "search" | "clarify" | "resolve_configuration"
  }
  decisionRecord: DecisionRecord
  paymentOptimization?: PaymentOptimizationResult
  error?: AgentError
}

export type ContractSearchPort = {
  searchCandidates(input: { requirement: Requirement; quantity: number; limit: number; signal: AbortSignal }): Promise<SearchResult>
  verifyFacts(input: { requirement: Requirement; quantity: number; candidates: ShoppingCandidate[]; requests: VerificationRequest[]; signal: AbortSignal }): Promise<SearchResult>
}
export type ContractWorkflowResult = ContractBResult & {
  verificationRounds: number
  stopReason: "completed" | "verification_limit" | "no_progress" | "no_verifiable_fields" | "source_failed"
}

// Payment optimization uses opaque card references, never card numbers/CVV.
export type PaymentQuoteBinding = ProductIdentity & {
  quantity: number
  destination: string
  currency: string
  totalMinor: number
}
export type PaymentOrder = {
  taskId: string
  requirementVersion: number
  quote: PaymentQuoteBinding
  total: Fact<number>
  // In quote.currency. null means no delivered-payment cap was supplied.
  maxUpfrontMinor: number | null
}
export type PaymentInstantOffer = {
  // All Minor fields are in the order currency, applied once to the whole order.
  minSpendMinor: number
  rateBps: number
  amountMinor: number
  // Effective cap after any per-transaction / remaining campaign quota checks.
  capMinor: number | null
}
export type PaymentMethodOption = {
  optionId: string
  cardId: string
  label: string
  paymentChannel: string
  billingCurrency: string
  // Upstream confirms card availability, merchant acceptance and offer eligibility.
  eligible: Fact<boolean>
  // Billing major units per ONE order major unit; decimal string, not float.
  // Same currency uses 1. null for cross-currency means unknown.
  settlementRate: Fact<string> | null
  feeBps: Fact<number>
  fixedFeeMinor: Fact<number> // billing currency
  // Unknown is value:null. Confirmed no discount is rateBps=amountMinor=0.
  instantOffer: Fact<PaymentInstantOffer>
  // Optional, confirmed expected future cashback in ORDER currency. Never ranked/deducted.
  futureCashbackMinor?: Fact<number> | null
}
export type PaymentComparisonRate = {
  fromCurrency: string
  toCurrency: string
  // Shared reference rate for comparisons; NOT the inverse of each card's own rate.
  rate: Fact<string>
}
export type PaymentContext = {
  taskId: string
  requirementVersion: number
  quote: PaymentQuoteBinding
  methods: PaymentMethodOption[]
  comparisonRates: PaymentComparisonRate[]
}
export type PaymentOptimizationPolicy = {
  policyVersion: string
  dataEnvironment: "development_mock" | "verified_sources"
  factTtlMs?: number
  currencyMinorUnits?: Record<string, number>
  now?: () => Date
}
export type PaymentCostBreakdown = {
  instantDiscountMinor: number // order currency
  orderPayableMinor: number // order currency, before card fees
  convertedPrincipalMinor: number // billing currency
  feeMinor: number // billing currency
  chargeMinor: number // billing currency, actual estimated upfront debit
  comparisonChargeMinor: number // order currency, common reference valuation
  futureCashbackMinor: number | null // order currency; informational only
}
export type PaymentOptionEvaluation = {
  optionId: string
  cardId: string
  label: string
  paymentChannel: string
  billingCurrency: string
  status: "eligible" | "ineligible" | "needs_verification"
  costs: PaymentCostBreakdown | null
  reasons: string[]
  evidenceFields: string[]
  validUntil: string | null
}
export type PaymentRecommendation = PaymentOptionEvaluation & {
  status: "eligible"
  costs: PaymentCostBreakdown
  validUntil: string
  explanation: string
}
export type PaymentOptimizationResult = {
  taskId: string
  requirementVersion: number
  policyVersion: string
  dataEnvironment: PaymentOptimizationPolicy["dataEnvironment"]
  status: "ready" | "needs_verification" | "no_available_method" | "not_evaluated"
  objective: "lowest_upfront_charge"
  comparisonCurrency: string
  orderSnapshot: PaymentOrder | null
  checkedAt: string
  evidenceStatus: "verified" | "mock"
  comparisonComplete: boolean
  recommended: PaymentRecommendation | null
  evaluations: PaymentOptionEvaluation[]
  verificationRequests: { optionId: string | null; fields: string[]; reason: string }[]
  warnings: string[]
}
