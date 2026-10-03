export type ConstraintOperator = "lte" | "gte" | "eq" | "in" | "notIn"

export type Constraint = {
  field: string
  op: ConstraintOperator
  value: number | string | boolean | string[]
}

export type Preference = {
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
  destination?: string
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

export type SearchStatus = "complete" | "partial" | "failed"

export type SearchResult = {
  taskId: string
  requirementVersion: number
  candidates: Candidate[]
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
}

export type EvaluateCandidatesInput = {
  requirement: Requirement
  candidates: Candidate[]
}

export type CheckPurchaseInput = {
  requirement: Requirement
  candidate: Candidate
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

export type ProductIdentity = Pick<Candidate, "productId" | "skuId" | "offerId">
export type SearchErrorCode =
  | "INVALID_INPUT" | "SOURCE_UNAVAILABLE" | "TIMEOUT" | "UNSUPPORTED_CATEGORY"
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
  stopReason: "ready" | "needsSearch" | "searchFailed" | "verificationLimit" | "noVerifiableFields"
}
