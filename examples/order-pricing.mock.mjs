// Deliberately fabricated payment terms for local wiring tests, NOT real card offers or FX.
export function mockOrderPricing(selection, now = new Date()) {
  return {
    taskId: selection.taskId, requirementVersion: selection.requirementVersion,
    productId: selection.candidate.productId, skuId: selection.candidate.skuId, offerId: selection.candidate.offerId,
    quantity: selection.quantity, destination: selection.destination,
    pricing: {
      source: "mock-dataset", status: "mock", fetchedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 300000).toISOString(),
      value: {
        unitPriceHkd: selection.candidate.offer?.priceHkd.value ?? null,
        shippingHkd: 20, orderDiscountHkd: 0,
        paymentMethodId: "card-ref-1", eligible: true, billingCurrency: "HKD",
        settlementRate: null, referenceRateToHkd: null,
        feePercent: 0, fixedFeeBillingAmount: 0,
        cardOffer: { minSpendHkd: 0, discountPercent: 10, discountHkd: 0, capHkd: 50 },
        futureCashbackHkd: null,
      },
    },
  }
}
