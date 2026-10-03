export type Requirement = {
  taskId: string
  requirementVersion: number
  category: string
  query: string
  currency: string
  budget: { maxMinor: number; scope: "item" | "delivered" }
  hardConstraints: {
    field: string
    op: "lte" | "gte" | "eq" | "in" | "notIn"
    value: number | string | boolean | string[]
  }[]
  preferences: { field: string; weight: number; source: "explicit" | "inferred" }[]
  excludedProductIds: string[]
  destination?: string
}

export type Fact<T> = {
  value: T | null
  source: string
  fetchedAt: string
  status: "verified" | "unverified" | "mock"
}

export type AttributeValue = number | string | boolean
export type ProductIdentity = {
  productId: string
  skuId: string | null
  offerId: string | null
}

export type Candidate = ProductIdentity & {
  title: string
  url: string
  attributes: Record<string, Fact<AttributeValue>>
  offer: {
    currency: string
    itemPriceMinor: Fact<number>
    shippingMinor: Fact<number>
    discountMinor: Fact<number>
    stock: Fact<"available" | "unavailable">
    deliverable: Fact<boolean>
  } | null
  missingFields: string[]
}

export type SearchResult = {
  taskId: string
  requirementVersion: number
  candidates: Candidate[]
  status: "complete" | "partial" | "failed"
  warnings: string[]
}

export type VerificationRequest = ProductIdentity & {
  fields: string[]
  reason: string
}

export type SearchErrorCode =
  | "INVALID_INPUT"
  | "SOURCE_UNAVAILABLE"
  | "TIMEOUT"
  | "UNSUPPORTED_CATEGORY"

/** Retrieval filters, not recommendation weights or purchase authorization. */
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
