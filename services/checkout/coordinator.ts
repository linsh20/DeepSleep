import { SandboxExecutionGate } from "../purchase-execution/gate"
import { randomUUID } from "node:crypto"
import { evaluateShoppingCandidates } from "../../lib/agent-b/contract"
import type { Fact, PaymentContext, ShoppingCandidate } from "../../types"
import type { SqliteTaskRepository } from "../main-agent/sqlite-repository"
import type { SqlitePurchaseRepository } from "../purchase-execution/repository"
import { ensure, type MerchantOrderPort, type SandboxPlan } from "../purchase-execution/types"
import { CHECKOUT_PRODUCT, checkoutPolicy } from "./catalog"
import type { CheckoutEvidence } from "./types"
export const candidateId = (c:Pick<ShoppingCandidate,"productId"|"skuId"|"offerId">) => JSON.stringify([c.productId,c.skuId,c.offerId])
export class CheckoutCoordinator {
  constructor(private main:SqliteTaskRepository,private repo:SqlitePurchaseRepository,private merchant:MerchantOrderPort){
    repo.db.exec("CREATE TABLE IF NOT EXISTS main_checkout_attempts (owner TEXT NOT NULL,request_id TEXT NOT NULL,task_id TEXT NOT NULL,version INTEGER NOT NULL,candidate_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,request_id))")
  }
  async prepare(taskId:string,owner:string,input:{expectedVersion:number;requestId:string;candidateId:string}) {
    ensure(/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId),"INVALID_REQUEST_ID","requestId 无效")
    const task=this.main.get(taskId,owner)
    ensure(task.intent==="purchase","COMPARE_NOT_EXECUTABLE","比较任务不能准备购买",403)
    ensure(task.requirement && task.requirementVersion===input.expectedVersion,"STALE_VERSION","需要当前完整需求",409)
    const prior=this.repo.db.prepare("SELECT * FROM main_checkout_attempts WHERE owner=? AND request_id=?").get(owner,input.requestId)
    if(prior){ensure(prior.task_id===taskId&&prior.version===input.expectedVersion&&prior.candidate_id===input.candidateId,"REQUEST_CONFLICT","请求已用于其他准备",409);return JSON.parse(String(prior.data))}
    ensure(!this.repo.db.prepare("SELECT 1 FROM main_purchase_requests WHERE owner=? AND request_id=?").get(owner,input.requestId),"REQUEST_CONFLICT","请求已用于其他准备",409)
    const unresolved=()=>ensure(!this.repo.db.prepare("SELECT 1 FROM sandbox_operations WHERE task_id=? AND version<>? AND json_extract(data,'$.createStartedAt') IS NOT NULL AND json_extract(data,'$.paymentStatus') NOT IN ('succeeded','failed','canceled')").get(taskId,input.expectedVersion),"PRIOR_PAYMENT_UNRESOLVED","旧交易未确定，先核实原操作",409)
    unresolved()
    const shopping=task.shoppingResult
    ensure(shopping && "kind" in shopping && shopping.kind==="shopping_contract_v1" && shopping.taskId===taskId&&shopping.requirementVersion===input.expectedVersion,"SHOPPING_REQUIRED","需要当前任务已保存的 Shopping 候选",409)
    const source=shopping.candidates.find(c=>candidateId(c)===input.candidateId)
    ensure(source,"NOT_FOUND","当前任务没有该候选",404)
    const existing=this.repo.db.prepare("SELECT p.data FROM main_purchase_links l JOIN sandbox_plans p ON p.id=l.plan_id WHERE l.task_id=? AND l.version=?").get(taskId,input.expectedVersion)
    if(existing){const p=JSON.parse(String(existing.data)) as SandboxPlan;ensure(p.checkout&&candidateId(p.checkout.sourceCandidate)===input.candidateId,"PLAN_CONFLICT","此版本已绑定其他方案",409);return {status:"result_ready",planId:p.planId,quoteExpired:this.repo.quote(p.planId).expiresAt<=Date.now(),reused:true}}
    let outcome:Record<string,unknown>
    let plan:SandboxPlan|undefined, quote:Awaited<ReturnType<MerchantOrderPort["quote"]>>|undefined
    const audit=shopping.diagnostics.candidateChecks.find(c=>candidateId(c)===input.candidateId)
    if(audit?.checks.some(c=>c.outcome==="mismatch"))outcome={status:"no_match",reason:"候选已有明确不满足的硬条件",checks:audit.checks}
    else if(source.productId!==CHECKOUT_PRODUCT.productId||source.skuId!==CHECKOUT_PRODUCT.skuId||source.offerId!==CHECKOUT_PRODUCT.referenceOfferId)outcome={status:"unsupported_product",reason:"候选未登记到模拟商户目录；不会把 Watsons 未知事实变成可付款报价"}
    else if(task.requirementDraft.quantity!==1 || task.requirement.destination!=="香港")outcome={status:"no_match",reason:"演示目录仅支持1件、配送香港"}
    else {
      const c=CHECKOUT_PRODUCT
      plan={planId:randomUUID(),taskId,requirementVersion:input.expectedVersion,environment:"sandbox_fixture",productId:source.productId,skuId:c.skuId,merchantId:c.merchantId,title:source.title,quantity:1}
      quote=await this.merchant.quote(plan)
      ensure(quote.source==="mock-dataset"&&quote.offerId&&quote.destination===task.requirement.destination&&quote.discountMinor!==undefined&&quote.otherFeesMinor!==undefined&&quote.fetchedAt,"INVALID_QUOTE","目录报价事实不完整")
      const f=<T>(value:T|null):Fact<T>=>({value,source:"mock-dataset",status:"mock",fetchedAt:quote!.fetchedAt!,validUntil:new Date(quote!.expiresAt).toISOString()})
      const candidate:ShoppingCandidate={...structuredClone(source),offerId:quote.offerId,
        merchant:{id:c.merchantId,name:f("Demo Merchant（模拟商户）"),platformId:f("deepsleep-demo")},
        offer:{currency:quote.currency,itemPriceMinor:f(quote.itemSubtotalMinor),shippingMinor:f(quote.shippingMinor),discountMinor:f(quote.discountMinor),stock:f("available"),deliverable:f(true)},
        quote:{quantity:quote.quantity,destination:quote.destination,totalMinor:f(quote.totalMinor),otherFeesMinor:f(quote.otherFeesMinor),estimatedDeliveryAtMs:f<number>(null),canFulfillQuantity:f(true)}}
      const paymentContext:PaymentContext={taskId,requirementVersion:input.expectedVersion,quote:{productId:candidate.productId,skuId:candidate.skuId,offerId:candidate.offerId,quantity:quote.quantity,destination:quote.destination,currency:quote.currency,totalMinor:quote.totalMinor},methods:[{optionId:"stripe_test_card",cardId:"server-test-card",label:"Stripe 沙盒测试卡",paymentChannel:"credit_card",billingCurrency:"HKD",eligible:f(true),settlementRate:null,feeBps:f(0),fixedFeeMinor:f(0),instantOffer:f({minSpendMinor:0,rateBps:0,amountMinor:0,capMinor:null})}],comparisonRates:[]}
      const review=await evaluateShoppingCandidates({requirement:task.requirement,quantity:1,candidates:[candidate],searchStatus:"complete",sourceTaskId:taskId,sourceRequirementVersion:input.expectedVersion,sourceSearchInput:shopping.searchInput,paymentContext},checkoutPolicy())
      const ready=review.status==="result_ready"&&review.paymentOptimization?.status==="ready"&&review.paymentOptimization.recommended?.optionId==="stripe_test_card"&&review.paymentOptimization.recommended.costs.chargeMinor===quote.totalMinor
      if(ready){
        const facts=[...Object.values(candidate.attributes),...Object.values(candidate.searchableText??{}),...(candidate.text?[candidate.text.searchable]:[])]
        const expiresAt=Math.min(quote.expiresAt,Date.parse(review.paymentOptimization!.recommended!.validUntil),...facts.filter(f=>f.value!==null&&f.status!=="unverified").map(f=>Math.min(Date.parse(f.fetchedAt)+86400000,f.validUntil?Date.parse(f.validUntil):Infinity)))
        const evidence:CheckoutEvidence={kind:"demo_catalog_checkout_v1",catalogVersion:c.catalogVersion,sourceDecisionId:shopping.decisionRecord.decisionId,sourceCandidate:structuredClone(source),reviewedCandidate:candidate,requirement:structuredClone(task.requirement),quantity:1,offerId:quote.offerId,quoteId:quote.quoteId,paymentOptionId:"stripe_test_card",paymentContext,review,expiresAt}
        plan.checkout=evidence
        outcome={status:"result_ready",planId:plan.planId,review,quote}
      }else outcome={status:review.status==="result_ready"?"needs_verification":review.status,reason:"报价补充后仍须满足 B 的所有硬条件及支付上下文检查",review,quote}
    }
    return this.repo.transaction(()=>{
      const current=this.main.get(taskId,owner)
      ensure(current.requirement && current.requirementVersion===input.expectedVersion && current.intent==="purchase" && JSON.stringify(current.requirement)===JSON.stringify(task.requirement),"STALE_VERSION","准备期间需求变化",409)
      unresolved()
      const repeated=this.repo.db.prepare("SELECT * FROM main_checkout_attempts WHERE owner=? AND request_id=?").get(owner,input.requestId)
      if(repeated){ensure(repeated.task_id===taskId&&repeated.version===input.expectedVersion&&repeated.candidate_id===input.candidateId,"REQUEST_CONFLICT","请求冲突",409);return JSON.parse(String(repeated.data))}
      ensure(!this.repo.db.prepare("SELECT 1 FROM main_purchase_requests WHERE owner=? AND request_id=?").get(owner,input.requestId),"REQUEST_CONFLICT","请求已用于旧准备入口",409)
      const old=this.repo.db.prepare("SELECT plan_id FROM main_purchase_links WHERE task_id=? AND version=?").get(taskId,input.expectedVersion)
      if(old){const p=this.repo.plan(String(old.plan_id));ensure(p.checkout&&candidateId(p.checkout.sourceCandidate)===input.candidateId,"PLAN_CONFLICT","本版本已绑定其他候选",409);outcome={status:"result_ready",planId:p.planId,reused:true}}
      else if(outcome.status==="result_ready"&&plan?.checkout&&quote){
        const snapshot={taskId,userId:owner,intent:current.intent,requirementVersion:input.expectedVersion,requirement:current.requirement,quantity:1}
        new SandboxExecutionGate().check({mode:"sandbox",task:snapshot,plan,quote,userId:owner,expectedVersion:input.expectedVersion,permitted:true,now:Date.now()})
        this.repo.db.prepare("INSERT OR IGNORE INTO sandbox_tasks VALUES (?,?,?)").run(taskId,owner,JSON.stringify(snapshot))
        this.repo.db.prepare("INSERT INTO sandbox_plans VALUES (?,?,?,?,?)").run(plan.planId,taskId,input.expectedVersion,JSON.stringify(plan),JSON.stringify(quote))
        this.repo.db.prepare("INSERT INTO main_purchase_links VALUES (?,?,?,?)").run(plan.planId,taskId,owner,input.expectedVersion)
      }
      this.repo.db.prepare("INSERT INTO main_checkout_attempts VALUES (?,?,?,?,?,?)").run(owner,input.requestId,taskId,input.expectedVersion,input.candidateId,JSON.stringify(outcome))
      return outcome
    })
  }
}
