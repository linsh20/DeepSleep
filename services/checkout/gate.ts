import { CHECKOUT_PRODUCT } from "./catalog"
import { ensure, type ExecutionGate } from "../purchase-execution/types"
export function checkCheckoutEvidence({task,plan,quote:q,now}:Parameters<ExecutionGate["check"]>[0]) {
  if(plan.productId==="sandbox-lotion"&&!plan.checkout)return
  const e=plan.checkout,c=CHECKOUT_PRODUCT
  ensure(plan.productId===c.productId&&plan.skuId===c.skuId&&e?.kind==="demo_catalog_checkout_v1"&&e.catalogVersion===c.catalogVersion,"NOT_TEST_PRODUCT","需要服务端登记商品及完整 B 复核方案",403)
  ensure(e.expiresAt>now&&q.expiresAt>=e.expiresAt,"QUOTE_EXPIRED","复核事实或支付上下文已过期",409)
  ensure(JSON.stringify(e.requirement)===JSON.stringify(task.requirement)&&JSON.stringify(e.review.decisionRecord.requestSnapshot.requirement)===JSON.stringify(task.requirement)&&e.quantity===task.quantity,"STALE_VERSION","方案审核需求与当前任务不一致",409)
  ensure(e.sourceCandidate.productId===c.productId&&e.sourceCandidate.skuId===c.skuId&&e.sourceCandidate.offerId===c.referenceOfferId&&e.sourceDecisionId.length>0,"INVALID_CHECKOUT_EVIDENCE","来源身份不一致")
  ensure(q.offerId===e.offerId&&q.quoteId===e.quoteId&&q.source==="mock-dataset"&&q.destination===task.requirement.destination&&e.paymentOptionId==="stripe_test_card","QUOTE_MISMATCH","报价来源、配送或支付选项不一致")
  const r=e.review,reviewed=e.reviewedCandidate,p=r.paymentOptimization?.recommended
  ensure(r.taskId===task.taskId&&r.requirementVersion===task.requirementVersion&&r.status==="result_ready"&&r.dataEnvironment==="development_mock"&&r.recommendations.length===1&&r.recommendations[0].offerId===q.offerId&&r.recommendations[0].checks.every(x=>x.outcome==="match"),"NEEDS_VERIFICATION","B 未完整通过当前方案",409)
  ensure(reviewed.productId===q.productId&&reviewed.skuId===q.skuId&&reviewed.offerId===q.offerId&&reviewed.merchant?.id===q.merchantId&&reviewed.quote?.totalMinor.value===q.totalMinor&&JSON.stringify(r.candidates)==JSON.stringify([reviewed]),"QUOTE_MISMATCH","已审核候选与报价不一致")
  ensure(r.paymentOptimization?.status==="ready"&&p?.optionId==="stripe_test_card"&&p.costs.chargeMinor===q.totalMinor&&Date.parse(p.validUntil)>now&&e.paymentContext.quote.offerId===q.offerId&&e.paymentContext.quote.totalMinor===q.totalMinor,"PAYMENT_MISMATCH","支付上下文不一致或已过期",409)
}
