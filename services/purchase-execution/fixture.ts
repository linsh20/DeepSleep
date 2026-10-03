import { randomUUID } from "node:crypto"
import type { SandboxPlan, SandboxTask } from "./types"
// Deliberately independent of ShoppingStub and all recommendation/fact objects.
export class SandboxPurchaseFixture {
  create(userId: string): { task: SandboxTask; plan: SandboxPlan } {
    const taskId = randomUUID(), planId = randomUUID()
    return {
      task: { taskId, userId, intent: "purchase", requirementVersion: 1, quantity: 1,
        requirement: { taskId, requirementVersion: 1, category: "沙盒测试乳液", query: "仅供支付集成测试的虚拟乳液", currency: "HKD", budget: { maxMinor: 20000, scope: "delivered" }, destination: "香港（模拟配送，不采集地址）", hardConstraints: [], preferences: [], excludedProductIds: [] } },
      plan: { planId, taskId, requirementVersion: 1, environment: "sandbox_fixture", productId: "sandbox-lotion", skuId: "sandbox-lotion-200ml", merchantId: "demo-merchant", title: "测试乳液 200ml（虚拟商品，无真实购买）", quantity: 1 },
    }
  }
}
