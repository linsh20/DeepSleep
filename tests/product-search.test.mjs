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

const { createProductSearch } = requireTS("../services/product-search.ts")
const { MockProductProvider, ProductProviderError, identityKey } = requireTS("../services/product-provider.ts")

const baseInput = (overrides = {}) => ({
  taskId: "search-test",
  requirementVersion: 7,
  product_name: { value: "乳液", must: 1 },
  range_conditions: [
    { field: "volumeMl", min: 100, max: 300, must: 1 },
    { field: "priceMinor", min: 10000, max: 30000, must: 0 },
  ],
  include_keywords: [
    { keywords: ["敏感肌", "sensitive skin"], must: 1 },
    { keywords: ["保湿", "补水", "moisturizing"], must: 0 },
  ],
  exclude_keywords: [
    { keywords: ["酒精", "alcohol"], must: 1 },
    { keywords: ["香精", "fragrance"], must: 0 },
  ],
  ...overrides,
})

const fiveScorer = {
  kind: "llm",
  calls: [],
  async scoreCandidate({ candidate, conditions }) {
    this.calls.push(candidate.productId)
    return conditions.map((condition) => ({
      conditionId: condition.id,
      score: 5,
      reason: "测试模型认为条件满足",
      evidenceFields: ["title"],
      source: "llm",
    }))
  },
}

test("runs deterministic stages in order, keeps input immutable, and returns ranked handoff", async () => {
  const input = baseInput()
  const before = structuredClone(input)
  const scorer = { ...fiveScorer, calls: [] }
  const result = await createProductSearch(new MockProductProvider(), scorer).searchProducts(input)
  assert.deepEqual(input, before)
  assert.equal(result.taskId, input.taskId)
  assert.equal(result.requirementVersion, 7)
  assert.equal(result.status, "complete")
  assert.equal(result.outcome, "ranked")
  assert.ok(result.candidates.length > 0 && result.candidates.length <= 10)
  assert.deepEqual(result.filterLogs.map((log) => log.stage), [
    "product_name", "range", "range", "include", "include", "exclude", "exclude",
  ])
  assert.deepEqual(result.candidates.map((item) => item.rank), result.candidates.map((_, index) => index + 1))
  assert.equal(new Set(result.candidates.map((item) => identityKey(item.candidate))).size, result.candidates.length)
  const mockCandidate = result.candidates.find((item) => item.candidate.productId === "lotion-calm-01").candidate
  assert.equal(mockCandidate.offer.itemPriceMinor.value, 23800)
  assert.equal(mockCandidate.offer.itemPriceMinor.source, "mock-dataset")
  assert.equal(mockCandidate.offer.itemPriceMinor.status, "mock")
})

test("prefer conditions log without removing candidates and more than ten are popularity-preselected", async () => {
  const scorer = { ...fiveScorer, calls: [] }
  const input = baseInput({ range_conditions: [], include_keywords: [], exclude_keywords: [] })
  const result = await createProductSearch(new MockProductProvider(), scorer).searchProducts(input)
  assert.equal(result.candidates.length, 10)
  assert.equal(scorer.calls.length, 10)
  assert.ok(result.warnings.some((warning) => warning.includes("预选到 10")))

  const preferOnly = baseInput({
    product_name: { value: "不存在的品名", must: 0 },
    range_conditions: [], include_keywords: [], exclude_keywords: [],
  })
  const preferred = await createProductSearch(new MockProductProvider(), { ...fiveScorer, calls: [] }).searchProducts(preferOnly)
  assert.equal(preferred.filterLogs[0].beforeCount, preferred.filterLogs[0].afterCount)
  assert.equal(preferred.filterLogs[0].mode, "prefer")
})

test("zero matches is complete no_match and does not call the scorer", async () => {
  const scorer = { ...fiveScorer, calls: [] }
  const result = await createProductSearch(new MockProductProvider(), scorer).searchProducts(baseInput({
    product_name: { value: "洗发水", must: 1 },
  }))
  assert.equal(result.status, "complete")
  assert.equal(result.outcome, "no_match")
  assert.deepEqual(result.candidates, [])
  assert.equal(scorer.calls.length, 0)
  assert.equal(result.filterLogs.length, 1)
})

test("known must violations are removed while unknown facts survive with forced score 3", async () => {
  const scorer = { ...fiveScorer, calls: [] }
  const result = await createProductSearch(new MockProductProvider(), scorer).searchProducts(baseInput({
    range_conditions: [{ field: "volumeMl", min: 100, max: 300, must: 1 }],
    include_keywords: [], exclude_keywords: [],
  }))
  assert.equal(result.candidates.some((item) => item.candidate.productId === "lotion-family-09"), false)
  assert.equal(result.candidates.some((item) => item.candidate.productId === "lotion-mini-10"), false)
  const unknown = result.candidates.find((item) => item.candidate.productId === "lotion-unknown-13")
  assert.ok(unknown)
  assert.ok(unknown.needsVerification.includes("range:0:volumeMl"))
  assert.equal(unknown.conditionScores.find((score) => score.conditionId === "range:0:volumeMl").score, 3)
  assert.equal(unknown.conditionScores.find((score) => score.conditionId === "range:0:volumeMl").source, "rule")
})

test("weighted harmonic mean penalizes one low condition", async () => {
  const rows = [raw("balanced", "Balanced Lotion"), raw("spiky", "Spiky Lotion")]
  const provider = { recall: async () => ({ products: rows, status: "complete" }) }
  const scorer = {
    kind: "llm",
    async scoreCandidate({ candidate, conditions }) {
      const values = candidate.productId === "balanced" ? [3, 3] : [5, 1]
      return conditions.map((condition, index) => ({
        conditionId: condition.id, score: values[index], reason: "test", evidenceFields: ["title"], source: "llm",
      }))
    },
  }
  const result = await createProductSearch(provider, scorer).searchProducts(baseInput({
    product_name: { value: "Lotion", must: 0 },
    range_conditions: [],
    include_keywords: [{ keywords: ["gentle"], must: 0 }],
    exclude_keywords: [],
  }))
  assert.equal(result.candidates[0].candidate.productId, "balanced")
  assert.ok(result.candidates[0].finalScore > result.candidates[1].finalScore)
})

test("one scorer failure degrades only that product and returns partial usable results", async () => {
  let failed = false
  const scorer = {
    kind: "llm",
    async scoreCandidate({ conditions }) {
      if (!failed) { failed = true; throw new Error("offline") }
      return conditions.map((condition) => ({
        conditionId: condition.id, score: 4, reason: "ok", evidenceFields: ["title"], source: "llm",
      }))
    },
  }
  const result = await createProductSearch(new MockProductProvider(), scorer).searchProducts(baseInput())
  assert.equal(result.status, "partial")
  assert.equal(result.outcome, "ranked")
  assert.ok(result.candidates.length > 1)
  assert.ok(result.warnings.some((warning) => warning.includes("LLM 评分失败")))
})

test("a scorer timeout is bounded and falls back without losing the candidate", async () => {
  let signal
  const scorer = {
    kind: "llm",
    scoreCandidate: async (_input, context) => {
      signal = context.signal
      return new Promise(() => {})
    },
  }
  const provider = { recall: async () => ({ products: [raw("slow", "Slow Lotion")], status: "complete" }) }
  const result = await createProductSearch(provider, scorer, { scorerTimeoutMs: 10 }).searchProducts(baseInput({
    product_name: { value: "Lotion", must: 1 }, range_conditions: [], include_keywords: [], exclude_keywords: [],
  }))
  assert.equal(result.status, "partial")
  assert.equal(result.candidates.length, 1)
  assert.equal(signal.aborted, true)
})

test("invalid provider facts become null and mark the result partial", async () => {
  const malformed = raw("bad-price", "Bad Price Lotion")
  malformed.offer.itemPriceMinor = -1
  const provider = { recall: async () => ({ products: [malformed], status: "complete" }) }
  const result = await createProductSearch(provider, { ...fiveScorer, calls: [] }).searchProducts(baseInput({
    product_name: { value: "Lotion", must: 1 }, range_conditions: [], include_keywords: [], exclude_keywords: [],
  }))
  assert.equal(result.status, "partial")
  assert.equal(result.candidates[0].candidate.offer.itemPriceMinor.value, null)
  assert.ok(result.candidates[0].candidate.missingFields.includes("offer.itemPriceMinor"))
})

test("deterministic fallback is explicit and does not require a model key", async () => {
  const result = await createProductSearch(new MockProductProvider()).searchProducts(baseInput())
  assert.equal(result.status, "partial")
  assert.ok(result.warnings.some((warning) => warning.includes("未配置 LLM")))
  assert.ok(result.candidates.every((item) => item.conditionScores.every((score) => score.source !== "llm")))
})

test("partial source, total failure, timeout, and invalid input remain distinct", async () => {
  const scorer = { ...fiveScorer, calls: [] }
  const partialProvider = { recall: async () => ({ products: [raw("p", "P Lotion")], status: "partial", warnings: ["one source unavailable"] }) }
  const partial = await createProductSearch(partialProvider, scorer).searchProducts(baseInput({
    product_name: { value: "Lotion", must: 1 }, range_conditions: [], include_keywords: [], exclude_keywords: [],
  }))
  assert.equal(partial.status, "partial")
  assert.equal(partial.outcome, "ranked")

  const failedProvider = { recall: async () => { throw new ProductProviderError("SOURCE_UNAVAILABLE", "secret") } }
  const failed = await createProductSearch(failedProvider, scorer).searchProducts(baseInput())
  assert.equal(failed.status, "failed")
  assert.match(failed.warnings[0], /^SOURCE_UNAVAILABLE:/)
  assert.ok(!JSON.stringify(failed).includes("secret"))

  let signal
  const timeoutProvider = { recall: async (_hint, _limit, context) => {
    signal = context.signal
    return new Promise(() => {})
  } }
  const timeout = await createProductSearch(timeoutProvider, scorer, { providerTimeoutMs: 10 }).searchProducts(baseInput())
  assert.equal(timeout.status, "failed")
  assert.match(timeout.warnings[0], /^TIMEOUT:/)
  assert.equal(signal.aborted, true)

  const invalid = await createProductSearch(new MockProductProvider(), scorer).searchProducts({ ...baseInput(), requirementVersion: -1 })
  assert.equal(invalid.status, "failed")
  assert.match(invalid.warnings[0], /^INVALID_INPUT:/)
})

function raw(productId, title) {
  return {
    productId, skuId: `${productId}-sku`, offerId: `${productId}-offer`, title,
    url: `https://example.test/${productId}`, category: "test", source: "test-source",
    fetchedAt: new Date().toISOString(), status: "verified",
    searchableText: { description: "gentle", ingredients: "water", tags: "test" },
    attributes: { volumeMl: 200, rating: 4, salesCount: 100 },
    offer: { currency: "HKD", itemPriceMinor: 20000, shippingMinor: 0, discountMinor: 0,
      stock: "available", deliverable: true },
  }
}
