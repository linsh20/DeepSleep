import { randomUUID } from "node:crypto"
import type { MerchantOrderPort, Quote, SandboxPlan } from "./types"
import { ensure } from "./types"
import type { SqlitePurchaseRepository } from "./repository"
export class DemoMerchantAdapter implements MerchantOrderPort {
  constructor(private repo: SqlitePurchaseRepository, private now = Date.now) {}
  async quote(plan: SandboxPlan): Promise<Quote> {
    ensure(plan.environment === "sandbox_fixture" && plan.productId === "sandbox-lotion" && plan.skuId === "sandbox-lotion-200ml" && plan.merchantId === "demo-merchant" && plan.quantity === 1, "NOT_TEST_PRODUCT", "仅支持服务端独立测试商品")
    return { quoteId: randomUUID(), planId: plan.planId, merchantId: plan.merchantId, productId: plan.productId, skuId: plan.skuId, quantity: plan.quantity, currency: "HKD", itemSubtotalMinor: 17000, shippingMinor: 1000, totalMinor: 18000, expiresAt: this.now() + 15 * 60 * 1000, environment: "sandbox_fixture" }
  }
  async createPending(operationId: string, quote: Quote) {
    return this.repo.transaction(() => {
      const existing = this.repo.orderForOperation(operationId)
      if (existing) { ensure(JSON.stringify(existing.quote) === JSON.stringify(quote), "ORDER_CONFLICT", "订单报价不能替换"); return existing }
      const order = { orderId: `demo_${randomUUID()}`, operationId, quote, status: "pending_payment" as const }
      this.repo.saveOrder(order)
      return order
    })
  }
  async get(orderId: string) { return this.repo.order(orderId) }
  async confirm(orderId: string, paymentId: string) {
    return this.repo.transaction(() => {
      const order = this.repo.order(orderId), op = this.repo.operation(order.operationId)
      ensure(op.paymentStatus === "succeeded" && op.paymentId === paymentId, "PAYMENT_NOT_SUCCEEDED", "未取得支付成功事实，不能确认商户订单")
      order.status = "confirmed"; this.repo.saveOrder(order); return order
    })
  }
}
