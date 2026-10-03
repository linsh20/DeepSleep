import { ensure } from "./types"
import type { ExecutionGate } from "./types"
export class SandboxExecutionGate implements ExecutionGate {
  check({ mode, task, plan, quote: q, userId, expectedVersion, permitted, now }: Parameters<ExecutionGate["check"]>[0]) {
    ensure(mode === "sandbox", "POLICY_NOT_CONFIGURED", "正式授权和风控策略尚未接入，拒绝执行", 403)
    ensure(permitted, "TEST_PERMISSION_REQUIRED", "请明确许可本次沙盒测试", 403)
    ensure(task.userId === userId, "NOT_FOUND", "没有可访问的测试任务", 404)
    ensure(task.intent === "purchase", "COMPARE_NOT_EXECUTABLE", "比较任务禁止执行购买", 403)
    ensure(task.taskId === plan.taskId && task.requirement.taskId === task.taskId && task.requirementVersion === expectedVersion && plan.requirementVersion === expectedVersion && task.requirement.requirementVersion === expectedVersion, "STALE_VERSION", "任务版本已变化，拒绝旧方案", 409)
    ensure(plan.environment === "sandbox_fixture" && q.environment === "sandbox_fixture" && plan.merchantId === "demo-merchant" && q.merchantId === plan.merchantId, "NOT_TEST_MERCHANT", "只允许服务端测试商户和独立测试报价", 403)
    ensure(q.planId === plan.planId && q.productId === plan.productId && q.skuId === plan.skuId && q.quantity === plan.quantity && q.quantity === task.quantity && Number.isSafeInteger(q.quantity) && q.quantity > 0, "QUOTE_MISMATCH", "报价商品或数量与任务不一致")
    ensure(q.currency === "HKD" && task.requirement.currency === q.currency, "CURRENCY_MISMATCH", "报价币种不一致")
    ensure(Number.isSafeInteger(q.expiresAt) && q.expiresAt > now, "QUOTE_EXPIRED", "报价已过期，未开始新的支付", 409)
    ensure([q.itemSubtotalMinor, q.shippingMinor, q.totalMinor].every(v => Number.isSafeInteger(v) && v >= 0) && q.totalMinor > 0 && q.itemSubtotalMinor + q.shippingMinor === q.totalMinor, "INVALID_QUOTE", "报价金额必须为已知整数港仙")
    const b = task.requirement.budget
    ensure(b && ["item", "delivered"].includes(b.scope) && Number.isSafeInteger(b.maxMinor) && b.maxMinor > 0, "INVALID_BUDGET", "任务预算无效")
    ensure((b.scope === "delivered" ? q.totalMinor : q.itemSubtotalMinor) <= b.maxMinor, "OVER_BUDGET", "报价超过任务预算", 403)
    ensure(q.totalMinor <= 20000, "SANDBOX_LIMIT", "本轮单次测试上限为200 HKD", 403)
    return { decision: "sandbox_test_only" as const }
  }
}
