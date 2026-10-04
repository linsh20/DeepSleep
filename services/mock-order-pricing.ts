import type { OrderPricingInput, ProductHandoff } from "../types"

export const DEMO_VIRTUAL_CREDIT_CARD_ID = "demo-virtual-credit-card"

/**
 * Hackathon-only Watsons pricing boundary. Search supplies the item price; fulfillment and merchant
 * facts are deliberately out of scope. A virtual HKD credit card adds no fee or discount, so the
 * calculated total is exactly item price x quantity. Requires `{ allowMock: true }` downstream.
 */
export function mockOrderPricing(selection: ProductHandoff, now = new Date()): OrderPricingInput {
  return {
    taskId: selection.taskId, requirementVersion: selection.requirementVersion,
    productId: selection.candidate.productId, skuId: selection.candidate.skuId, offerId: selection.candidate.offerId,
    quantity: selection.quantity, destination: selection.destination,
    pricing: {
      source: "mock-dataset", status: "mock", fetchedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 300000).toISOString(),
      value: {
        unitPriceHkd: selection.candidate.offer?.priceHkd.value ?? null,
        shippingHkd: 0, orderDiscountHkd: 0,
        paymentMethodId: DEMO_VIRTUAL_CREDIT_CARD_ID, eligible: true, billingCurrency: "HKD",
        settlementRate: null, referenceRateToHkd: null,
        feePercent: 0, fixedFeeBillingAmount: 0,
        cardOffer: { minSpendHkd: 0, discountPercent: 0, discountHkd: 0, capHkd: 0 },
        futureCashbackHkd: null,
      },
    },
  }
}
