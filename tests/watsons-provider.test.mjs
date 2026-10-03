import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import ts from "typescript"

const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  module._compile(outputText, filename)
}

const { WatsonsSqliteProductProvider } = requireTS("../services/watsons-product-provider.ts")
const { assessCondition } = requireTS("../services/search-filter.ts")

const input = {
  taskId: "watsons-provider-test",
  requirementVersion: 1,
  product_name: { value: "lotion", must: 1 },
  range_conditions: [],
  include_keywords: [],
  exclude_keywords: [],
}

test("Watsons SQLite provider maps the confirmed en_HK snapshot with provenance", async () => {
  const provider = new WatsonsSqliteProductProvider()
  const result = await provider.recall("lotion", 500, {
    input,
    signal: new AbortController().signal,
  })

  assert.equal(result.status, "complete")
  assert.equal(result.products.length, 349)
  assert.ok(result.products.every((product) => product.productId.startsWith("watsons-product:")))
  assert.ok(result.products.every((product) => product.skuId.startsWith("watsons-sku:")))
  assert.ok(result.products.every((product) => product.offerId.startsWith("watsons-offer-hk:")))
  assert.ok(result.products.every((product) => product.source === "watsons-hk-api-snapshot"))
  assert.ok(result.products.every((product) => product.status === "verified"))
  assert.ok(result.products.every((product) => product.url.startsWith("https://www.watsons.com.hk/")))
  assert.ok(result.products.every((product) => Number.isSafeInteger(product.offer.itemPriceMinor)))
  assert.ok(result.products.every((product) => product.offer.shippingMinor === null))
  assert.ok(result.products.every((product) => product.offer.deliverable === null))
})

test("capacity conflicts and missing facts remain unknown instead of being invented", async () => {
  const result = await new WatsonsSqliteProductProvider().recall("", 500, {
    input,
    signal: new AbortController().signal,
  })
  const byId = new Map(result.products.map((product) => [product.productId, product]))

  assert.equal(byId.get("watsons-product:BP_823759").attributes.volumeMl, null)
  assert.equal(byId.get("watsons-product:BP_816967").attributes.volumeMl, 500)
  assert.equal(byId.get("watsons-product:BP_819058").searchableText.ingredients, null)
  assert.ok(result.products.some((product) => product.attributes.rating === null))
  assert.ok(result.products.every((product) => !String(product.searchableText.description).includes("<img")))
})

test("ingredient-scoped exclusions distinguish volatile alcohol, fatty alcohol, and unknown", () => {
  const alcoholCondition = {
    id: "exclude:0",
    kind: "exclude",
    must: 1,
    label: "no volatile alcohol",
    keywords: ["alcohol"],
    scope: "ingredients",
  }
  assert.equal(assessCondition(candidate("AQUA, CETEARYL ALCOHOL, GLYCERIN"), alcoholCondition).state, "pass")
  assert.equal(assessCondition(candidate("AQUA, ALCOHOL DENAT., GLYCERIN"), alcoholCondition).state, "fail")
  assert.equal(assessCondition(candidate("AQUA, ETHANOL, GLYCERIN"), alcoholCondition).state, "fail")
  assert.equal(assessCondition(candidate("AQUA, PHENOXYETHANOL, GLYCERIN"), {
    ...alcoholCondition,
    keywords: ["ethanol"],
  }).state, "pass")
  assert.equal(assessCondition(candidate(null), alcoholCondition).state, "unknown")

  const fragranceCondition = { ...alcoholCondition, id: "exclude:1", keywords: ["fragrance"] }
  assert.equal(assessCondition(candidate("AQUA, PARFUM, GLYCERIN"), fragranceCondition).state, "fail")
  assert.equal(assessCondition(candidate("AQUA, GLYCERIN"), fragranceCondition).state, "pass")
})

test("product-name aliases are deterministic and language normalization is Unicode-safe", () => {
  const condition = {
    id: "product_name",
    kind: "product_name",
    must: 1,
    label: "lotion",
    productName: "lotion",
    aliases: ["emulsion"],
  }
  assert.equal(assessCondition(candidate("WATER", "Barrier Emulsion"), condition).state, "pass")
  assert.equal(assessCondition(candidate("WATER", "Barrier Cream"), condition).state, "fail")
})

test("a missing Watsons database is a bounded source error", async () => {
  const provider = new WatsonsSqliteProductProvider({ databasePath: "data/watson/data/missing.db" })
  await assert.rejects(
    provider.recall("", 10, { input, signal: new AbortController().signal }),
    (error) => error?.code === "SOURCE_UNAVAILABLE" && !error.message.includes("E:\\"),
  )
})

function candidate(ingredients, title = "Test Lotion") {
  const fact = (value) => ({ value, source: "test", fetchedAt: "2026-10-03T00:00:00.000Z", status: "verified" })
  return {
    productId: "test-product",
    skuId: "test-sku",
    offerId: "test-offer",
    title,
    url: "https://example.test/product",
    category: "test",
    searchableText: { description: fact("test"), ingredients: fact(ingredients) },
    attributes: {},
    offer: null,
    missingFields: ingredients === null ? ["searchableText.ingredients"] : [],
  }
}
