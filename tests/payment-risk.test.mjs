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
const { checkPaymentRisk, runPaymentRisk, runWatsonsDemoPaymentRisk } = requireTS("../services/payment-risk.ts")
const { DEMO_VIRTUAL_CREDIT_CARD_ID, mockOrderPricing } = requireTS("../services/mock-order-pricing.ts")
const { preparePaymentHandoff } = requireTS("../services/order-amount.ts")
const { createProductSelection, selectProduct } = requireTS("../services/product-selection.ts")
const { createProductSearch } = requireTS("../services/product-search.ts")
const { MockProductProvider } = requireTS("../services/product-provider.ts")
const now = new Date("2026-10-04T02:00:00Z")
const options = { allowMock: true, now: () => now }

// Risk 1 uses product price only. The virtual HKD credit card has no fee or discount: total HKD 100.
async function fixture() {
  const request = JSON.parse(readFileSync(new URL("../examples/select-product.request.json", import.meta.url), "utf8"))
  const { selection } = await createProductSelection(createProductSearch(new MockProductProvider()).searchProducts)(request)
  selection.candidate.offer.priceHkd.value = 100
  const pricingInput = mockOrderPricing(selection, now)
  const userAuthorization = {
    taskId: selection.taskId, requirementVersion: selection.requirementVersion, userId: "demo-user",
    authorization: { authorizationId: "auth-1", allowedOfferId: selection.candidate.offerId, maxTotalHkd: 100,
      maxQuantity: 1, currency: "HKD", expiresAt: "2026-10-04T03:00:00Z" },
    allowedPaymentMethodIds: [DEMO_VIRTUAL_CREDIT_CARD_ID], preferredPaymentMethodId: DEMO_VIRTUAL_CREDIT_CARD_ID,
  }
  const priced = preparePaymentHandoff(selection, pricingInput, options).selection
  return { selection, pricingInput, userAuthorization, priced }
}

test("level 1 hands one priced product to level 2; approval at exactly the limit yields a mock order", async () => {
  const { selection, pricingInput, userAuthorization } = await fixture()
  const original = structuredClone({ selection, pricingInput, userAuthorization })
  const flow = await runPaymentRisk({ selection, pricingInput, userAuthorization }, options)
  assert.equal(flow.status, "approved")
  assert.equal(flow.stage, "payment_risk")
  assert.equal(flow.risk.totalHkd, 100)
  assert.equal(flow.risk.offerId, selection.candidate.offerId)
  assert.equal(flow.order.orderAmount.totalHkd, 100)
  assert.equal(flow.order.orderAmount.shippingHkd, 0)
  assert.equal(flow.order.orderAmount.cardDiscountHkd, 0)
  assert.equal(flow.order.orderAmount.billingFee, 0)
  assert.equal(flow.order.orderAmount.billingTotal, 100)
  assert.equal(flow.order.orderAmount.paymentMethodId, DEMO_VIRTUAL_CREDIT_CARD_ID)
  assert.equal(flow.order.candidate.productId, selection.candidate.productId)
  assert.equal(flow.taskId, selection.taskId)
  assert.equal(flow.requirementVersion, selection.requirementVersion)
  assert.ok(flow.risk.reasons.some(reason => reason.includes("Mock")))
  assert.deepEqual({ selection, pricingInput, userAuthorization }, original)
})

test("risk 2 alone blocks a product-price total over the authorized limit", async () => {
  const { selection, pricingInput, userAuthorization } = await fixture()
  userAuthorization.authorization.maxTotalHkd = 99.99
  const flow = await runPaymentRisk({ selection, pricingInput, userAuthorization }, options)
  assert.equal(flow.status, "blocked")
  assert.equal(flow.order, null)
  assert.match(flow.risk.reasons[0], /超过授权上限/)
})

test("stale version, foreign offer, quantity, expired grant and disallowed card are each blocked", async () => {
  const { priced, userAuthorization } = await fixture()
  const cases = {
    version: a => { a.requirementVersion += 1 },
    task: a => { a.taskId = "other-task" },
    offer: a => { a.authorization.allowedOfferId = "other-offer" },
    quantity: a => { a.authorization.maxQuantity = 0 },
    expired: a => { a.authorization.expiresAt = "2026-10-04T01:59:59Z" },
    badExpiry: a => { a.authorization.expiresAt = "not-a-date" },
    card: a => { a.allowedPaymentMethodIds = ["card-ref-2"] },
    currency: a => { a.authorization.currency = "USD" },
    badLimit: a => { a.authorization.maxTotalHkd = 100.001 },
  }
  for (const [name, patch] of Object.entries(cases)) {
    const changed = structuredClone(userAuthorization)
    patch(changed)
    const result = await checkPaymentRisk({ selection: priced, userAuthorization: changed }, options)
    assert.equal(result.status, "blocked", name)
  }
  userAuthorization.allowedPaymentMethodIds = []
  assert.equal((await checkPaymentRisk({ selection: priced, userAuthorization }, options)).status, "approved")
})

test("risk 2 does not re-check stock, delivery or merchant facts", async () => {
  const { priced, userAuthorization } = await fixture()
  const selection = structuredClone(priced)
  selection.candidate.offer.stock.value = null
  selection.candidate.offer.deliverable.value = null
  assert.equal((await checkPaymentRisk({ selection, userAuthorization }, options)).status, "approved")
})

test("expired quote or Mock amounts without opt-in need verification, never approval", async () => {
  const { priced, userAuthorization } = await fixture()
  const later = { allowMock: true, now: () => new Date("2026-10-04T02:05:00Z") }
  assert.equal((await checkPaymentRisk({ selection: priced, userAuthorization }, later)).status, "needs_verification")
  const strict = await checkPaymentRisk({ selection: priced, userAuthorization }, { now: () => now })
  assert.equal(strict.status, "needs_verification")
  assert.match(strict.reasons[0], /Mock/)
})

test("a blocking rule wins over verification gaps and keeps both reasons", async () => {
  const { priced, userAuthorization } = await fixture()
  priced.orderAmount.validUntil = "2026-10-04T01:59:59Z"
  userAuthorization.authorization.maxTotalHkd = 50
  const result = await checkPaymentRisk({ selection: priced, userAuthorization }, options)
  assert.equal(result.status, "blocked")
  assert.equal(result.reasons.length, 2)
})

test("real Watsons candidate reaches risk 1 and risk 2 with item price only", async () => {
  const request = JSON.parse(readFileSync(new URL("../examples/select-product.request.json", import.meta.url), "utf8"))
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { assert.fail("Watsons demo flow must not use HTTP") }
  try {
    const selected = await selectProduct(request)
    assert.equal(selected.status, "ready")
    const itemPrice = selected.selection.candidate.offer.priceHkd.value
    const userAuthorization = {
      taskId: selected.taskId, requirementVersion: selected.requirementVersion, userId: "demo-user",
      authorization: { authorizationId: "auth-watsons", allowedOfferId: selected.selection.candidate.offerId,
        maxTotalHkd: itemPrice, maxQuantity: 1, currency: "HKD", expiresAt: "2026-10-04T03:00:00Z" },
      allowedPaymentMethodIds: [DEMO_VIRTUAL_CREDIT_CARD_ID], preferredPaymentMethodId: DEMO_VIRTUAL_CREDIT_CARD_ID,
    }
    const flow = await runWatsonsDemoPaymentRisk({ selection: selected.selection, userAuthorization }, { now: () => now })
    assert.equal(flow.status, "approved")
    assert.equal(flow.stage, "payment_risk")
    assert.equal(flow.order.orderAmount.unitPriceHkd, itemPrice)
    assert.equal(flow.order.orderAmount.totalHkd, itemPrice)
    assert.equal(flow.order.orderAmount.billingTotal, itemPrice)
    assert.equal(flow.order.orderAmount.shippingHkd, 0)
    assert.equal(flow.order.orderAmount.paymentMethodId, DEMO_VIRTUAL_CREDIT_CARD_ID)
  } finally { globalThis.fetch = originalFetch }
})

test("malformed level-2 input is blocked without throwing", async () => {
  const { priced, userAuthorization } = await fixture()
  for (const input of [null, {}, { selection: priced }, { userAuthorization },
    { selection: { ...priced, orderAmount: undefined }, userAuthorization }]) {
    const result = await checkPaymentRisk(input, options)
    assert.equal(result.status, "blocked")
    assert.match(result.reasons[0], /^INVALID_INPUT:/)
  }
})

test("pricing problems stop at level 1 and never reach level 2", async () => {
  const { selection, pricingInput, userAuthorization } = await fixture()
  const missing = structuredClone(pricingInput)
  missing.pricing.value.shippingHkd = null
  const unknown = await runPaymentRisk({ selection, pricingInput: missing, userAuthorization }, options)
  assert.deepEqual([unknown.status, unknown.stage, unknown.risk, unknown.order], ["needs_verification", "pricing", null, null])

  const ineligible = structuredClone(pricingInput)
  ineligible.pricing.value.eligible = false
  assert.equal((await runPaymentRisk({ selection, pricingInput: ineligible, userAuthorization }, options)).status, "blocked")

  const foreign = await runPaymentRisk({ selection, pricingInput: { ...pricingInput, offerId: "other" }, userAuthorization }, options)
  assert.deepEqual([foreign.status, foreign.stage], ["failed", "pricing"])
})
