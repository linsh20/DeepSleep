import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { StockStatus } from "../types"
import {
  MockProductProvider,
  ProductProviderError,
  type ProductProvider,
  type ProviderContext,
  type RawProduct,
} from "./product-provider"

const WATSONS_ORIGIN = "https://www.watsons.com.hk"
const SOURCE = "watsons-hk-api-snapshot"
const CONFIRMED_CATEGORY = "confirmed_face_treatment"

type WatsonsProductRow = {
  code: unknown
  name: unknown
  brand: unknown
  price: unknown
  ingredients: unknown
  raw_json: unknown
}

type SnapshotMetadata = {
  status?: unknown
  language?: unknown
  currency?: unknown
  exported_at?: unknown
}

export type WatsonsSqliteProviderOptions = {
  databasePath?: string
}

/** Read-only adapter for the attributable Watsons en_HK crawl snapshot. */
export class WatsonsSqliteProductProvider implements ProductProvider {
  private readonly databasePath: string

  constructor(options: WatsonsSqliteProviderOptions = {}) {
    const configured = options.databasePath ?? process.env.WATSONS_DB_PATH?.trim()
    this.databasePath = configured
      ? isAbsolute(configured) ? configured : resolve(/* turbopackIgnore: true */ process.cwd(), configured)
      : resolve(process.cwd(), "data", "watson", "data", "products.db")
  }

  async recall(
    _productNameHint: string,
    limit: number,
    context: ProviderContext,
  ): Promise<{ products: RawProduct[]; status: "complete" | "partial"; warnings?: string[] }> {
    context.signal.throwIfAborted()
    if (!existsSync(this.databasePath)) {
      throw new ProductProviderError("SOURCE_UNAVAILABLE", "Watsons database is missing")
    }

    let database: DatabaseSync | null = null
    try {
      database = new DatabaseSync(this.databasePath, { readOnly: true })
      const metadata = readSnapshotMetadata(database)
      assertSupportedSnapshot(metadata)
      const fetchedAt = String(metadata.exported_at)
      const rows = database.prepare(`
        SELECT code, name, brand, price, ingredients, raw_json
        FROM products
        WHERE category_status = ?
        ORDER BY code
        LIMIT ?
      `).all(CONFIRMED_CATEGORY, limit) as WatsonsProductRow[]

      const products: RawProduct[] = []
      let rejected = 0
      for (const row of rows) {
        context.signal.throwIfAborted()
        try {
          products.push(mapWatsonsProduct(row, fetchedAt))
        } catch {
          rejected++
        }
      }
      return rejected === 0
        ? { products, status: "complete" }
        : {
            products,
            status: "partial",
            warnings: [`${rejected} Watsons records could not be normalized.`],
          }
    } catch (error) {
      if (error instanceof ProductProviderError || isAbortError(error)) throw error
      throw new ProductProviderError("SOURCE_UNAVAILABLE", "Watsons database could not be read")
    } finally {
      database?.close()
    }
  }
}

export function createDefaultProductProvider(): ProductProvider {
  return process.env.PRODUCT_DATA_MODE?.trim().toLowerCase() === "mock"
    ? new MockProductProvider()
    : new WatsonsSqliteProductProvider()
}

function readSnapshotMetadata(database: DatabaseSync): SnapshotMetadata {
  const row = database.prepare("SELECT metadata_json FROM snapshot LIMIT 1").get()
  if (!row || typeof row.metadata_json !== "string") {
    throw new ProductProviderError("SOURCE_UNAVAILABLE", "Watsons snapshot metadata is missing")
  }
  const parsed: unknown = JSON.parse(row.metadata_json)
  if (!isRecord(parsed)) {
    throw new ProductProviderError("SOURCE_UNAVAILABLE", "Watsons snapshot metadata is invalid")
  }
  return parsed
}

function assertSupportedSnapshot(metadata: SnapshotMetadata): void {
  if (metadata.status !== "complete" || metadata.language !== "en_HK" || metadata.currency !== "HKD" ||
      typeof metadata.exported_at !== "string" || !Number.isFinite(Date.parse(metadata.exported_at))) {
    throw new ProductProviderError("SOURCE_UNAVAILABLE", "Unsupported Watsons snapshot")
  }
}

function mapWatsonsProduct(row: WatsonsProductRow, fetchedAt: string): RawProduct {
  if (typeof row.raw_json !== "string") throw new Error("Missing raw product")
  const parsed: unknown = JSON.parse(row.raw_json)
  if (!isRecord(parsed)) throw new Error("Invalid raw product")

  const code = requiredText(row.code)
  const title = cleanText(row.name) ?? cleanText(parsed.name)
  const brand = cleanText(row.brand)
  const ingredients = cleanText(row.ingredients)
  const variantCode = cleanText(parsed.defaultVariantCode) ?? cleanText(parsed.ean) ?? code
  const price = moneyMinor(readNestedNumber(parsed, "price", "value") ?? finiteNumber(row.price))
  const listPrice = moneyMinor(readNestedNumber(parsed, "elabOldPrice", "value") ?? readNestedNumber(parsed, "elabPrice", "value"))
  const description = cleanHtmlText(parsed.description) ?? cleanText(parsed.shortDescription)
  const categoryPath = cleanText(parsed.gtmCategoryPath)
  const category = deepestCategory(parsed.categoryNameLevels) ?? categoryPath?.split("/").at(-1)?.trim() ?? "Face Treatment"
  const reviewCount = nonnegativeInteger(parsed.productNumberOfReview)
  const rating = reviewCount !== null && reviewCount > 0 ? ratingValue(parsed.averageRating) : null
  const salesCount = nonnegativeInteger(parsed.sellQuantity)
  const stock = stockValue(parsed.stock)
  if (!title || price === null) throw new Error("Required product facts are missing")
  const volumeMl = parseProductVolumeMl(parsed, title)
  return {
    productId: `watsons-product:${code}`,
    skuId: `watsons-sku:${variantCode}`,
    offerId: `watsons-offer-hk:${code}:${variantCode}`,
    title,
    url: watsonsUrl(parsed.url),
    category,
    source: SOURCE,
    fetchedAt,
    status: "verified",
    searchableText: {
      description,
      ingredients: meaningfulIngredients(ingredients),
      brand,
      categoryPath,
    },
    attributes: {
      volumeMl,
      packSize: cleanText(parsed.elabPackSize),
      rating,
      reviewCount,
      salesCount,
      listPriceMinor: listPrice,
    },
    offer: {
      currency: "HKD",
      itemPriceMinor: price,
      shippingMinor: null,
      // itemPriceMinor is already the displayed sale price. Checkout discounts are unknown.
      discountMinor: null,
      stock,
      deliverable: null,
    },
  }
}

function parseProductVolumeMl(product: Record<string, unknown>, title: string): number | null {
  const sources = [product.elabPackSize]
  if (Array.isArray(product.elabVariantProductContentSizeUnits)) {
    sources.push(...product.elabVariantProductContentSizeUnits)
  }
  sources.push(title)

  const values: number[] = []
  for (const source of sources) {
    if (typeof source !== "string") continue
    const parsed = parseSingleVolumeMl(source)
    if (parsed === "ambiguous") return null
    if (typeof parsed === "number") values.push(parsed)
  }
  const unique = [...new Set(values)]
  return unique.length === 1 ? unique[0] : null
}

function parseSingleVolumeMl(value: string): number | "ambiguous" | null {
  const normalized = value.normalize("NFKC")
  if (/\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:ml|毫升)/i.test(normalized) ||
      /\+/.test(normalized) && /\d+(?:\.\d+)?\s*(?:ml|毫升|g|克)\b/i.test(normalized)) {
    return "ambiguous"
  }
  const matches = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*(ml|毫升|l|升)\b/gi)]
  if (matches.length === 0) return null
  const converted = matches.map((match) => Number(match[1]) * (/^(l|升)$/i.test(match[2]) ? 1000 : 1))
  if (converted.some((item) => !Number.isSafeInteger(item) || item <= 0)) return null
  const unique = [...new Set(converted)]
  return unique.length === 1 ? unique[0] : "ambiguous"
}

function cleanHtmlText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const withoutMarkup = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
  return cleanText(withoutMarkup)
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim()
  return cleaned ? cleaned : null
}

function meaningfulIngredients(value: string | null): string | null {
  return value && !/^(?:n\/?a|not available|unknown|-)+$/i.test(value) ? value : null
}

function watsonsUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing product URL")
  const url = new URL(value, WATSONS_ORIGIN)
  if (url.protocol !== "https:" || url.hostname !== "www.watsons.com.hk") throw new Error("Invalid product URL")
  return url.href
}

function deepestCategory(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const names = value.flatMap((item) => isRecord(item) ? [cleanText(item.name)] : []).filter((item): item is string => item !== null)
  return names.at(-1) ?? null
}

function stockValue(value: unknown): StockStatus | null {
  if (!isRecord(value)) return null
  return value.stockLevelStatus === "inStock" ? "available"
    : value.stockLevelStatus === "outOfStock" ? "unavailable"
    : null
}

function ratingValue(value: unknown): number | null {
  const number = finiteNumber(value)
  return number !== null && number >= 0 && number <= 5 ? number : null
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function moneyMinor(value: number | null): number | null {
  if (value === null || value < 0) return null
  const minor = Math.round(value * 100)
  return Number.isSafeInteger(minor) ? minor : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readNestedNumber(value: Record<string, unknown>, objectKey: string, valueKey: string): number | null {
  const nested = value[objectKey]
  return isRecord(nested) ? finiteNumber(nested[valueKey]) : null
}

function requiredText(value: unknown): string {
  const text = cleanText(value)
  if (!text) throw new Error("Required text is missing")
  return text
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
