import { CheckoutCoordinator } from "../checkout/coordinator"
import { LimitedExecutionGate } from "../risk-control/gate"
import { randomUUID } from "node:crypto"
import type { SqliteTaskRepository } from "../main-agent/sqlite-repository"
import type { MainTask } from "../main-agent/types"
import type { SqlitePurchaseRepository } from "../purchase-execution/repository"
import { PurchaseExecutionService } from "../purchase-execution/service"
import { SandboxExecutionGate } from "../purchase-execution/gate"
import { ensure, type MerchantOrderPort, type PaymentPort, type SandboxPlan, type SandboxTask, type Quote } from "../purchase-execution/types"

// Only an exact, explicit virtual-product request is currently provable by this source.
// No ShoppingStub result is consumed. Replace this source with saved Shopping plans later.
export function sandboxSource(task: MainTask): SandboxTask {
  ensure(task.intent === "purchase", "COMPARE_NOT_EXECUTABLE", "仅购买任务可准备或执行沙盒方案", 403)
  const r = task.requirement
  ensure(r, "REQUIREMENT_INCOMPLETE", "请先补全需求", 409)
  ensure(r.category === "沙盒测试乳液" && r.query === "测试乳液 200ml" && task.requirementDraft.quantity === 1 && r.currency === "HKD" && ["香港", "香港（模拟配送，不采集地址）"].includes(r.destination ?? ""), "NEEDS_VERIFICATION", "仅支持明确的虚拟测试需求：类别「沙盒测试乳液」、商品「测试乳液 200ml」、1件、HKD、香港；其他商品事实未核验", 409)
  ensure(r.hardConstraints.length === 0 && r.preferences.length === 0, "NEEDS_VERIFICATION", "测试商品未验证额外硬条件或偏好，不能忽略；请使用无附加条件的独立测试需求", 409)
  ensure(!r.excludedProductIds.includes("sandbox-lotion"), "NO_MATCH", "测试商品已被排除", 409)
  return { taskId: task.taskId, userId: task.userId, intent: task.intent, requirementVersion: task.requirementVersion, requirement: r, quantity: 1 }
}
// Persisted links distinguish authoritative main tasks from historical CLI fixtures.
export function currentTaskResolver(main: SqliteTaskRepository) {
  return (snapshot: SandboxTask): SandboxTask => {
    const linked = main.db.prepare("SELECT 1 FROM main_purchase_links WHERE task_id=?").get(snapshot.taskId)
    if(!linked)return snapshot
    const task=main.get(snapshot.taskId,snapshot.userId)
    const row=main.db.prepare("SELECT data FROM sandbox_plans WHERE task_id=? AND version=?").get(snapshot.taskId,snapshot.requirementVersion)
    const plan=row?JSON.parse(String(row.data)) as SandboxPlan:undefined
    if(!plan?.checkout)return sandboxSource(task)
    ensure(task.requirement,"REQUIREMENT_INCOMPLETE","当前任务缺少完整需求",409)
    return {taskId:task.taskId,userId:task.userId,intent:task.intent,requirementVersion:task.requirementVersion,requirement:task.requirement,quantity:task.requirementDraft.quantity!}
  }
}
export class PurchaseBridge {
  readonly execution: PurchaseExecutionService
  readonly checkout: CheckoutCoordinator
  constructor(private main: SqliteTaskRepository, private repo: SqlitePurchaseRepository, private merchant: MerchantOrderPort, payment: PaymentPort) {
    this.checkout = new CheckoutCoordinator(main,repo,merchant)
    this.execution = new PurchaseExecutionService(repo, merchant, new LimitedExecutionGate(repo), payment, { currentTask: currentTaskResolver(main) })
  }
  private version(taskId: string, owner: string, version: number) {
    const task = this.main.get(taskId, owner)
    ensure(Number.isSafeInteger(version) && task.requirementVersion === version, "STALE_VERSION", "需求版本已变化", 409)
    return task
  }
  private noUnresolvedOtherVersion(taskId: string, version: number) {
    const unsettled = this.repo.db.prepare("SELECT 1 FROM sandbox_operations WHERE task_id=? AND version<>? AND json_extract(data,'$.createStartedAt') IS NOT NULL AND json_extract(data,'$.paymentStatus') NOT IN ('succeeded','failed','canceled')").get(taskId, version)
    ensure(!unsettled, "PRIOR_PAYMENT_UNRESOLVED", "旧版本支付尚未确定，请先核对原操作，不准备替代付款", 409)
  }
  private link(taskId: string, owner: string, planId: string) {
    this.main.get(taskId, owner)
    ensure(this.main.db.prepare("SELECT 1 FROM main_purchase_links WHERE task_id=? AND owner=? AND plan_id=?").get(taskId, owner, planId), "NOT_FOUND", "任务下没有该方案", 404)
  }
  state(taskId: string, owner: string) {
    const task = this.main.get(taskId, owner)
    const purchases = this.main.db.prepare("SELECT plan_id FROM main_purchase_links WHERE task_id=? AND owner=? ORDER BY version DESC").all(taskId, owner).map(row => {
      const view = this.execution.get(String(row.plan_id), owner)
      return { ...view, task: undefined, stale: task.requirementVersion !== view.plan.requirementVersion || task.intent !== "purchase", quoteExpired: view.quote.expiresAt <= Date.now() }
    })
    return { taskId, requirementVersion: task.requirementVersion, intent: task.intent, purchases }
  }
  async prepare(taskId: string, owner: string, input: { expectedVersion: number; requestId: string; candidateId?: string }) {
    if(input.candidateId!==undefined){
      const checkoutPreparation=await this.checkout.prepare(taskId,owner,{...input,candidateId:input.candidateId})
      return {...this.state(taskId,owner),checkoutPreparation}
    }
    ensure(/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId), "INVALID_REQUEST_ID", "requestId 无效")
    ensure(!this.repo.db.prepare("SELECT 1 FROM main_checkout_attempts WHERE owner=? AND request_id=?").get(owner,input.requestId),"REQUEST_CONFLICT","请求已用于候选结算准备",409)
    const prior = this.main.db.prepare("SELECT * FROM main_purchase_requests WHERE owner=? AND request_id=?").get(owner, input.requestId)
    if (prior) { ensure(prior.task_id === taskId && prior.version === input.expectedVersion, "REQUEST_CONFLICT", "requestId 已用于其他准备请求", 409); return this.state(taskId, owner) }
    const task = sandboxSource(this.version(taskId, owner, input.expectedVersion))
    // Do not offer a replacement while a previous version could still settle.
    this.noUnresolvedOtherVersion(taskId, input.expectedVersion)
    const existing = this.main.db.prepare("SELECT plan_id FROM main_purchase_links WHERE task_id=? AND version=?").get(taskId, input.expectedVersion)
    let plan: SandboxPlan, quote: Quote | undefined
    if (!existing) {
      plan = { planId: randomUUID(), taskId, requirementVersion: task.requirementVersion, environment: "sandbox_fixture", productId: "sandbox-lotion", skuId: "sandbox-lotion-200ml", merchantId: "demo-merchant", title: "测试乳液 200ml（虚拟商品，无真实购买）", quantity: 1 }
      quote = await this.merchant.quote(plan)
    }
    this.repo.transaction(() => {
      ensure(!this.repo.db.prepare("SELECT 1 FROM main_checkout_attempts WHERE owner=? AND request_id=?").get(owner,input.requestId),"REQUEST_CONFLICT","请求已用于候选结算准备",409)
      const current = sandboxSource(this.version(taskId, owner, input.expectedVersion))
      this.noUnresolvedOtherVersion(taskId, input.expectedVersion)
      const repeated = this.main.db.prepare("SELECT * FROM main_purchase_requests WHERE owner=? AND request_id=?").get(owner, input.requestId)
      if (repeated) { ensure(repeated.task_id === taskId && repeated.version === input.expectedVersion, "REQUEST_CONFLICT", "requestId 冲突", 409); return }
      const old = this.main.db.prepare("SELECT plan_id FROM main_purchase_links WHERE task_id=? AND version=?").get(taskId, input.expectedVersion)
      let id = old?.plan_id
      if (!id) {
        new SandboxExecutionGate().check({ mode: "sandbox", task: current, plan, quote: quote!, userId: owner, expectedVersion: input.expectedVersion, permitted: true, now: Date.now() })
        // Historical projection/FK anchor only. All pre-payment checks use currentTaskResolver.
        this.repo.db.prepare("INSERT OR IGNORE INTO sandbox_tasks VALUES (?,?,?)").run(taskId, owner, JSON.stringify(current))
        this.repo.db.prepare("INSERT INTO sandbox_plans VALUES (?,?,?,?,?)").run(plan.planId, taskId, input.expectedVersion, JSON.stringify(plan), JSON.stringify(quote))
        this.repo.db.prepare("INSERT INTO main_purchase_links VALUES (?,?,?,?)").run(plan.planId, taskId, owner, input.expectedVersion)
        id = plan.planId
      }
      this.repo.db.prepare("INSERT INTO main_purchase_requests VALUES (?,?,?,?,?)").run(owner, input.requestId, taskId, input.expectedVersion, id!)
    })
    return this.state(taskId, owner)
  }
  async execute(taskId: string, owner: string, input: { planId: string; expectedVersion: number; requestId: string; testPermission: boolean }) {
    this.link(taskId, owner, input.planId)
    await this.execution.execute(owner, input)
    return this.state(taskId, owner)
  }
  async recover(taskId: string, owner: string, planId: string) {
    this.link(taskId, owner, planId)
    await this.execution.reconcile(planId, owner)
    return this.state(taskId, owner)
  }
}
