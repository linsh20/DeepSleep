import dataset from "../data/products.mock.json"
import type {
  AttributeValue,
  FactStatus,
  ProductIdentity,
  ProviderSearchResult,
  SearchErrorCode,
  StockStatus,
  StructuredSearchInput,
} from "../types"

export type RawProduct = ProductIdentity & {
  title: string
  url: string
  category: string
  source: string
  fetchedAt: string
  status: FactStatus
  merchant?: {
    id: string
    name: string
    platformId: string
  }
  searchableText: Record<string, string | null>
  attributes: Record<string, AttributeValue | null>
  offer: {
    currency: string
    itemPriceMinor: number | null
    shippingMinor: number | null
    discountMinor: number | null
    stock: StockStatus | null
    deliverable: boolean | null
  } | null
}

export type ProviderContext = {
  signal: AbortSignal
  input: StructuredSearchInput
}

export interface ProductProvider {
  /** Recall broadly. The local pipeline remains authoritative for every condition. */
  recall(
    productNameHint: string,
    limit: number,
    context: ProviderContext,
  ): Promise<ProviderSearchResult<RawProduct>>
}

export class ProductProviderError extends Error {
  readonly code: SearchErrorCode

  constructor(code: SearchErrorCode, message: string) {
    super(message)
    this.name = "ProductProviderError"
    this.code = code
  }
}

export function identityKey(identity: ProductIdentity): string {
  return JSON.stringify([identity.productId, identity.skuId, identity.offerId])
}

type MockRow = Omit<RawProduct, "source" | "fetchedAt" | "status">

export class MockProductProvider implements ProductProvider {
  private readonly rows: MockRow[] = dataset as MockRow[]

  async recall(
    _productNameHint: string,
    limit: number,
    context: ProviderContext,
  ): Promise<ProviderSearchResult<RawProduct>> {
    context.signal.throwIfAborted()
    const fetchedAt = new Date().toISOString()
    return {
      products: this.rows.slice(0, limit).map((row) => ({
        ...structuredClone(row),
        source: "mock-dataset",
        fetchedAt,
        status: "mock",
      })),
      status: "complete",
    }
  }
}
