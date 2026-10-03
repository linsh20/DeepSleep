import assert from "node:assert/strict"
import test from "node:test"

import { checkPurchase, evaluateCandidates } from "./index.ts"
import type {
  Authorization,
  Candidate,
  Fact,
  Requirement,
} from "../../types/index.ts"

const NOW = new Date("2026-10-03T04:00:00.000Z")

function fact<T>(value: T, minutesOld = 0): Fact<T> {
  return {
    value,
    source: "test-fixture",
    fetchedAt: new Date(NOW.getTime() - minutesOld * 60_000).toISOString(),
    status: "verified",
  }
}

function candidate(
  productId: string,
  options: {
    price: number
    weightGrams: number
    performanceScore: number
    discount?: number
    priceMinutesOld?: number
    stock?: "available" | "unavailable"
  },
): Candidate {
  return {
    productId,
    skuId: `sku-${productId}`,
    offerId: `offer-${productId}`,
    title: `候选 ${productId}`,
    url: `https://example.test/${productId}`,
    attributes: {
      weightGrams: fact(options.weightGrams),
      performanceScore: fact(options.performanceScore),
      ramGB: fact(16),
    },
    offer: {
      currency: "CNY",
      itemPriceMinor: fact(options.price, options.priceMinutesOld),
      shippingMinor: fact(0, options.priceMinutesOld),
      discountMinor: fact(options.discount ?? 0, options.priceMinutesOld),
      stock: fact(options.stock ?? "available", options.priceMinutesOld),
      deliverable: fact(true, options.priceMinutesOld),
    },
    missingFields: [],
  }
}

function requirement(): Requirement {
  return {
    taskId: "task-1",
    requirementVersion: 1,
    category: "laptop",
    query: "适合开发且便携的笔记本",
    currency: "CNY",
    budget: { maxMinor: 600_000, scope: "delivered" },
    hardConstraints: [{ field: "ramGB", op: "gte", value: 16 }],
    preferences: [
      { field: "performanceScore", weight: 0.7, source: "explicit" },
      { field: "weightGrams", weight: 0.3, source: "explicit" },
    ],
    excludedProductIds: [],
    destination: "上海",
  }
}

test("evaluateCandidates filters hard constraints and keeps diverse recommendations", async () => {
  const result = await evaluateCandidates(
    {
      requirement: requirement(),
      candidates: [
        candidate("balanced", { price: 500_000, weightGrams: 1400, performanceScore: 85 }),
        candidate("performance", { price: 590_000, weightGrams: 2000, performanceScore: 100 }),
        candidate("portable", { price: 480_000, weightGrams: 1000, performanceScore: 70 }),
        candidate("over-budget", { price: 700_000, weightGrams: 1200, performanceScore: 95 }),
      ],
    },
    { now: () => NOW },
  )

  assert.equal(result.status, "ready")
  assert.equal(result.recommendations[0].label, "综合最优")
  assert.ok(result.recommendations.some((item) => item.label === "性能优先"))
  assert.ok(result.recommendations.some((item) => item.label === "便携优先"))
  assert.deepEqual(result.rejected.map((item) => item.productId), ["over-budget"])
  assert.ok(result.recommendations.every((item) => item.score >= 0 && item.score <= 1))
})

test("gram-based weight constraints and preferences accept A's canonical field path", async () => {
  for (const field of ["weightGrams", "attributes.weightGrams"]) {
    const req = requirement()
    req.hardConstraints = [{ field, op: "lte", value: 1500 }]
    req.preferences = [{ field, weight: 1, source: "explicit" }]
    const candidates = [
      candidate("light", { price: 500_000, weightGrams: 1300, performanceScore: 90 }),
      candidate("boundary", { price: 500_000, weightGrams: 1500, performanceScore: 90 }),
      candidate("heavy", { price: 500_000, weightGrams: 1501, performanceScore: 90 }),
      candidate("unknown", { price: 500_000, weightGrams: 1400, performanceScore: 90 }),
    ]
    candidates[3].attributes.weightGrams.value = null

    const result = await evaluateCandidates(
      { requirement: req, candidates },
      { now: () => NOW },
    )

    assert.equal(result.status, "needsVerification")
    assert.deepEqual(
      result.recommendations.map(({ productId, score }) => ({ productId, score })),
      [{ productId: "light", score: 1 }, { productId: "boundary", score: 0 }],
    )
    assert.deepEqual(result.rejected.map(({ productId }) => productId), ["heavy"])
    assert.ok(result.recommendations.every((item) =>
      item.evidenceFields.includes("attributes.weightGrams"),
    ))
    assert.equal(result.verificationRequests[0].productId, "unknown")
    assert.deepEqual(result.verificationRequests[0].fields, ["attributes.weightGrams"])
  }
})

test("unknown hard constraint triggers verification and is not recommended", async () => {
  const unknownRam = candidate("unknown-ram", {
    price: 500_000,
    weightGrams: 1300,
    performanceScore: 90,
  })
  unknownRam.attributes.ramGB = {
    value: null,
    source: "test-fixture",
    fetchedAt: NOW.toISOString(),
    status: "unverified",
  }

  const result = await evaluateCandidates(
    { requirement: requirement(), candidates: [unknownRam] },
    { now: () => NOW },
  )

  assert.equal(result.status, "needsVerification")
  assert.equal(result.recommendations.length, 0)
  assert.deepEqual(result.verificationRequests[0].fields, ["attributes.ramGB"])
})

test("all definitively rejected candidates produce needsSearch", async () => {
  const result = await evaluateCandidates(
    {
      requirement: requirement(),
      candidates: [
        candidate("too-expensive", {
          price: 800_000,
          weightGrams: 1100,
          performanceScore: 100,
        }),
      ],
    },
    { now: () => NOW },
  )

  assert.equal(result.status, "needsSearch")
  assert.equal(result.recommendations.length, 0)
  assert.equal(result.rejected[0].productId, "too-expensive")
  assert.ok(result.searchHints.length > 0)
})

test("item budget uses the verified net item price after discount", async () => {
  const itemBudgetRequirement = requirement()
  itemBudgetRequirement.budget.scope = "item"
  const discounted = candidate("discounted", {
    price: 650_000,
    discount: 100_000,
    weightGrams: 1300,
    performanceScore: 90,
  })

  const result = await evaluateCandidates(
    { requirement: itemBudgetRequirement, candidates: [discounted] },
    { now: () => NOW },
  )

  assert.equal(result.status, "ready")
  assert.equal(result.recommendations[0].productId, "discounted")
  assert.ok(result.recommendations[0].evidenceFields.includes("offer.discountMinor"))
})

test("checkPurchase approves only against the matching backend authorization", async () => {
  const selected = candidate("approved", {
    price: 500_000,
    weightGrams: 1300,
    performanceScore: 90,
  })
  const authorization: Authorization = {
    authorizationId: "auth-1",
    allowedOfferId: "offer-approved",
    maxTotalMinor: 520_000,
    maxQuantity: 1,
    currency: "CNY",
    expiresAt: "2026-10-03T05:00:00.000Z",
  }

  const result = await checkPurchase(
    {
      requirement: requirement(),
      candidate: selected,
      quantity: 1,
      authorization,
    },
    {
      now: () => NOW,
      getAuthorizationById: async () => authorization,
    },
  )

  assert.equal(result.status, "approved")
  assert.equal(result.totalMinor, 500_000)
})

test("checkPurchase blocks an authorization that differs from the backend record", async () => {
  const selected = candidate("tampered", {
    price: 500_000,
    weightGrams: 1300,
    performanceScore: 90,
  })
  const supplied: Authorization = {
    authorizationId: "auth-2",
    allowedOfferId: "offer-tampered",
    maxTotalMinor: 999_999,
    maxQuantity: 1,
    currency: "CNY",
    expiresAt: "2026-10-03T05:00:00.000Z",
  }
  const persisted = { ...supplied, maxTotalMinor: 500_000 }

  const result = await checkPurchase(
    {
      requirement: requirement(),
      candidate: selected,
      quantity: 1,
      authorization: supplied,
    },
    {
      now: () => NOW,
      getAuthorizationById: async () => persisted,
    },
  )

  assert.equal(result.status, "blocked")
  assert.match(result.reasons[0], /后端记录不一致/)
})

test("checkPurchase requests fresh dynamic facts before purchase", async () => {
  const selected = candidate("stale", {
    price: 500_000,
    weightGrams: 1300,
    performanceScore: 90,
    priceMinutesOld: 2,
  })
  const authorization: Authorization = {
    authorizationId: "auth-3",
    allowedOfferId: "offer-stale",
    maxTotalMinor: 520_000,
    maxQuantity: 1,
    currency: "CNY",
    expiresAt: "2026-10-03T05:00:00.000Z",
  }

  const result = await checkPurchase(
    {
      requirement: requirement(),
      candidate: selected,
      quantity: 1,
      authorization,
    },
    {
      now: () => NOW,
      getAuthorizationById: async () => authorization,
    },
  )

  assert.equal(result.status, "needsVerification")
  assert.ok(result.verificationRequests[0].fields.includes("offer.itemPriceMinor"))
})

test("checkPurchase safely blocks when no backend authorization lookup is supplied", async () => {
  const selected = candidate("no-backend", {
    price: 500_000,
    weightGrams: 1300,
    performanceScore: 90,
  })
  const authorization: Authorization = {
    authorizationId: "auth-4",
    allowedOfferId: "offer-no-backend",
    maxTotalMinor: 520_000,
    maxQuantity: 1,
    currency: "CNY",
    expiresAt: "2026-10-03T05:00:00.000Z",
  }

  const result = await checkPurchase({
    requirement: requirement(),
    candidate: selected,
    quantity: 1,
    authorization,
  })

  assert.equal(result.status, "blocked")
  assert.match(result.reasons[0], /后端授权记录查询/)
})

test("runtime validation rejects preference weights that do not add up to one", async () => {
  const invalidRequirement = requirement()
  invalidRequirement.preferences[0].weight = 0.5

  await assert.rejects(
    evaluateCandidates(
      {
        requirement: invalidRequirement,
        candidates: [
          candidate("invalid", {
            price: 500_000,
            weightGrams: 1300,
            performanceScore: 90,
          }),
        ],
      },
      { now: () => NOW },
    ),
    /购物需求输入无效/,
  )
})
