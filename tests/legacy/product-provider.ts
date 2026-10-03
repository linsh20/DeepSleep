// Test-only frozen compatibility fixture for retained pre-integration regressions.
import dataset from "./products.mock.json"
import type {
  AttributeValue, Fact, ProductIdentity, Requirement, SearchErrorCode, SearchPlan,
} from "../../types/shopping"

/** Providers use integer minor currency units and explicit provenance. */
export type RawProduct = ProductIdentity & {
  title: string
  url: string
  category: string
  source: string
  fetchedAt: string
  status: Fact<unknown>["status"]
  attributes: Record<string, AttributeValue | null>
  offer: {
    currency: string
    itemPriceMinor?: number | null
    shippingMinor?: number | null
    discountMinor?: number | null
    stock?: "available" | "unavailable" | null
    deliverable?: boolean | null
  } | null
}

export type ProviderSearchResult = {
  products: RawProduct[]
  status: "complete" | "partial"
  warnings?: string[]
}

export type ProviderContext = {
  signal: AbortSignal
  requirement: Requirement
}

export interface ProductProvider {
  search(plan: SearchPlan, limit: number, context: ProviderContext): Promise<ProviderSearchResult>
  /** Return only facts for this exact product/SKU/offer, never another variant. */
  getProductDetails(
    identity: ProductIdentity, fields: string[], context: ProviderContext,
  ): Promise<RawProduct | null>
}

export class ProductProviderError extends Error {
  readonly code: SearchErrorCode
  constructor(code: SearchErrorCode, message: string) {
    super(message)
    this.name = "ProductProviderError"
    this.code = code
  }
}

export const offerFields = [
  "itemPriceMinor", "shippingMinor", "discountMinor", "stock", "deliverable",
] as const

export function identityKey(identity: ProductIdentity): string {
  return JSON.stringify([identity.productId, identity.skuId, identity.offerId])
}

/** Bare attribute names are accepted; returned paths are always canonical. */
export function canonicalField(field: string): string | null {
  if (["totalPrice", "deliveredTotalMinor", "netItemPriceMinor"].includes(field)) return field
  if (offerFields.some((key) => key === field)) return `offer.${field}`
  if (field.startsWith("offer.")) {
    return offerFields.some((key) => field === `offer.${key}`) ? field : null
  }
  const name = field.startsWith("attributes.") ? field.slice(11) : field
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) &&
    !["constructor", "prototype", "__proto__"].includes(name)
    ? `attributes.${name}` : null
}

function rawValue(product: RawProduct, field: string): AttributeValue | null {
  if (["totalPrice", "deliveredTotalMinor", "netItemPriceMinor"].includes(field)) {
    const offer = product.offer
    if (!offer || offer.itemPriceMinor == null || offer.discountMinor == null ||
        offer.discountMinor > offer.itemPriceMinor) return null
    const shipping = field === "netItemPriceMinor" ? 0 : offer.shippingMinor
    if (shipping == null) return null
    return offer.itemPriceMinor - offer.discountMinor + shipping
  }
  if (field.startsWith("attributes.")) return product.attributes[field.slice(11)] ?? null
  const key = field.slice(6) as typeof offerFields[number]
  return product.offer?.[key] ?? null
}

/** Unknown facts stay in recall so downstream modules can request verification. */
export function matchesSearchPlan(product: RawProduct, plan: SearchPlan): boolean {
  if (product.category.trim().toLowerCase() !== plan.category ||
      plan.excludedProductIds.includes(product.productId)) return false
  const haystack = `${product.title} ${Object.values(product.attributes).join(" ")}`.toLowerCase()
  if (!plan.terms.every((term) => haystack.includes(term))) return false
  if (product.offer) {
    const offer = product.offer
    if (offer.currency.toUpperCase() !== plan.currency) return false
    const price = offer.itemPriceMinor
    const discount = offer.discountMinor
    const shipping = plan.budget.scope === "delivered" ? offer.shippingMinor : 0
    if (price != null && discount != null && shipping != null &&
        price + shipping - discount > plan.budget.maxMinor) return false
  }
  return plan.constraints.every(({ field, op, value }) => {
    const actual = rawValue(product, field)
    if (actual === null) return true
    switch (op) {
      case "lte": return typeof actual !== "number" || actual <= (value as number)
      case "gte": return typeof actual !== "number" || actual >= (value as number)
      case "eq": return actual === value
      case "in": return (value as string[]).includes(String(actual))
      case "notIn": return !(value as string[]).includes(String(actual))
    }
  })
}

type MockRow = Omit<RawProduct, "source" | "fetchedAt" | "status"> & {
  details?: {
    attributes?: Record<string, AttributeValue | null>
    offer?: Partial<NonNullable<RawProduct["offer"]>>
  }
}

export class MockProductProvider implements ProductProvider {
  private readonly rows: MockRow[] = dataset as MockRow[]

  private materialize(row: MockRow, destination?: string): RawProduct {
    const product: RawProduct = {
      productId: row.productId, skuId: row.skuId, offerId: row.offerId,
      title: row.title, url: row.url, category: row.category,
      attributes: { ...row.attributes }, offer: row.offer ? { ...row.offer } : null,
      source: "mock-dataset", status: "mock", fetchedAt: new Date().toISOString(),
    }
    // Demo delivery facts are for HK only. Other destinations are unknown.
    if (destination && !["hk", "hong kong", "香港"].includes(destination.trim().toLowerCase()) && product.offer) {
      product.offer.shippingMinor = null
      product.offer.deliverable = null
    }
    return product
  }

  async search(plan: SearchPlan, limit: number, context: ProviderContext): Promise<ProviderSearchResult> {
    context.signal.throwIfAborted()
    if (plan.category !== "electronics") {
      throw new ProductProviderError("UNSUPPORTED_CATEGORY", "Mock source supports Electronics only.")
    }
    const seen = new Set<string>()
    const products: RawProduct[] = []
    for (const row of this.rows) {
      const product = this.materialize(row, plan.destination)
      if (!matchesSearchPlan(product, plan)) continue
      const key = identityKey(product)
      if (!seen.has(key) && seen.size >= limit) continue
      seen.add(key)
      products.push(product)
    }
    return { products, status: "complete" }
  }

  async getProductDetails(identity: ProductIdentity, fields: string[], context: ProviderContext): Promise<RawProduct | null> {
    context.signal.throwIfAborted()
    const row = this.rows.find((entry) => identityKey(entry) === identityKey(identity))
    if (!row) return null
    const product = this.materialize(row, context.requirement.destination)
    for (const field of fields) {
      if (field.startsWith("attributes.")) {
        const key = field.slice(11)
        product.attributes[key] = row.details?.attributes?.[key] ?? product.attributes[key] ?? null
      } else if (product.offer && field.startsWith("offer.")) {
        const key = field.slice(6) as typeof offerFields[number]
        const extra = row.details?.offer
        if (extra && Object.hasOwn(extra, key)) Object.assign(product.offer, { [key]: extra[key] })
      }
    }
    // A details lookup must not turn HK facts into facts for another destination.
    if (context.requirement.destination &&
        !["hk", "hong kong", "香港"].includes(context.requirement.destination.trim().toLowerCase()) && product.offer) {
      product.offer.shippingMinor = null
      product.offer.deliverable = null
    }
    return product
  }
}
