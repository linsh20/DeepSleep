import { CHECKOUT_PRODUCT } from "../checkout/catalog"
import { randomUUID } from "node:crypto"
import type { MerchantOrderPort, Quote, SandboxPlan } from "./types"
import { ensure } from "./types"
import type { SqlitePurchaseRepository } from "./repository"
export class DemoMerchantAdapter implements MerchantOrderPort {
  constructor(private repo: SqlitePurchaseRepository, private now = Date.now) {}
  async quote(plan: SandboxPlan): Promise<Quote> {
    if(plan.productId === CHECKOUT_PRODUCT.productId){
      const c=CHECKOUT_PRODUCT, now=this.now()
      ensure(plan.environment==="sandbox_fixture" && plan.skuId===c.skuId && plan.merchantId===c.merchantId && plan.quantity===1,"NOT_TEST_PRODUCT","不支持的目录商品或数量")
      return {quoteId:randomUUID(),planId:plan.planId,merchantId:c.merchantId,productId:c.productId,skuId:c.skuId,quantity:1,currency:"HKD",itemSubtotalMinor:c.unitMinor,shippingMinor:c.shippingMinor,discountMinor:c.discountMinor,otherFeesMinor:c.otherFeesMinor,totalMinor:c.unitMinor+c.shippingMinor-c.discountMinor+c.otherFeesMinor,expiresAt:now+60000,environment:"sandbox_fixture",offerId:`demo-offer:${plan.planId}`,destination:"香港",source:"mock-dataset",fetchedAt:new Date(now).toISOString()}
    }
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
