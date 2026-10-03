import { createHash, randomUUID } from "node:crypto"
import { SandboxExecutionGate } from "../purchase-execution/gate"
import { PurchaseError, ensure, type PurchaseOperation } from "../purchase-execution/types"
import type { RiskRepository } from "./repository"
import { RISK_CONFIG, type Confirmation, type RiskConfig, type RiskDecision, type RiskInput, type RuleHit } from "./types"
export function hongKongMonth(at: number) { return new Date(at+8*3600000).toISOString().slice(0,7) }
// Every method that assesses/reserves runs inside the caller's BEGIN IMMEDIATE transaction.
export class RiskPolicyEngine {
  constructor(readonly repo: RiskRepository, readonly config: RiskConfig = RISK_CONFIG) {}
  evaluate(input: RiskInput, reserve = true): RiskDecision {
    const {userId:owner,now,plan,quote,operationId}=input
    ensure(operationId,"OPERATION_REQUIRED","需要已保存的操作")
    const op=this.repo.purchase.operation(operationId)
    ensure(op.userId===owner && op.planId===plan.planId,"NOT_FOUND","操作不存在",404)
    const auth=this.repo.current(owner), hits:RuleHit[]=[]
    const hit=(rule:string,severity:"hold"|"block",reason:string,exit="请查看当前任务、报价及授权；更正后重新检查，不能用确认跳过拦截")=>hits.push({rule,severity,reason,exit})
    if (![this.config.frequencyWindowMs,this.config.duplicateWindowMs,this.config.confirmationMs,this.config.maxTransactions].every(v=>Number.isSafeInteger(v)&&v>0)) hit("R12","block","规则配置不完整或相互矛盾","需服务端修正规则；用户确认不能覆盖配置错误")
    if (auth && (![auth.singleSoftMinor,auth.singleHardMinor,auth.monthlySoftMinor,auth.monthlyHardMinor,auth.startsAt,auth.expiresAt].every(v=>Number.isSafeInteger(v)&&v>=0) || auth.singleSoftMinor>auth.singleHardMinor || auth.monthlySoftMinor>auth.monthlyHardMinor || auth.startsAt>=auth.expiresAt)) hit("R12","block","授权规则数据不一致","请重新明确填写有效授权，不能通过本次确认跳过")
    let errorCode: string | undefined
    try { new SandboxExecutionGate().check(input) } catch(error) {
      if(!(error instanceof PurchaseError))throw error
      errorCode=error.code
      hit(error.code,"block",error.message)
    }
    if(!auth) hit("AUTH_REQUIRED","block","没有有效的有限授权","请明确创建仅限沙盒的有限授权；搜索无需授权")
    else {
      if(auth.status!=="active")hit("R10","block","授权已撤销","需要重新明确授权；旧交易仍继续核实，不代表退款")
      if(now<auth.startsAt || now>=auth.expiresAt)hit("R9","block","授权尚未生效或已过期","请明确更新授权有效期")
      if(!auth.productIds.includes(plan.productId)||!auth.merchantIds.includes(plan.merchantId)||!auth.paymentMethods.includes("stripe_test_card"))hit("AUTH_SCOPE","block","商品、商户或支付方法不在有限授权范围")
    }
    // Existing legacy records remain unmodified and are counted only for their original owner.
    const rows=this.repo.db.prepare(`SELECT o.data,r.state,r.amount,r.at,r.settled_at FROM sandbox_operations o LEFT JOIN risk_reservations r ON r.operation_id=o.id WHERE o.owner=? AND o.id<>?`).all(owner,operationId)
    let spentMinor=0,reservedMinor=0,recent=0,duplicate=false
    for(const row of rows){
      const other=JSON.parse(String(row.data)) as PurchaseOperation
      const state=row.state ?? (other.paymentStatus==="succeeded"?"spent":other.createStartedAt!==null && !["failed","canceled"].includes(other.paymentStatus)?"reserved":"released")
      if(state==="released")continue
      if(state==="reserved" && other.createStartedAt===null && other.quote.expiresAt<=now){
        this.repo.db.prepare("UPDATE risk_reservations SET state='released',settled_at=? WHERE operation_id=?").run(now,other.operationId)
        this.repo.audit(owner,now,"unsubmitted_reservation_expired",{operationId:other.operationId})
        continue
      }
      const at=Number(row.at??other.createStartedAt??0), settled=Number(row.settled_at??other.confirmStartedAt??at),amount=Number(row.amount??other.quote.totalMinor)
      if(state==="spent" && hongKongMonth(settled)===hongKongMonth(now))spentMinor+=amount
      if(state==="reserved")reservedMinor+=amount // also retain unresolved reservations across month rollover
      if(at>now-this.config.frequencyWindowMs && at<=now)recent++
      if(at>now-this.config.duplicateWindowMs && at<=now && other.quote.productId===quote.productId && other.quote.merchantId===quote.merchantId && other.quote.totalMinor===quote.totalMinor)duplicate=true
    }
    if(recent+1>this.config.maxTransactions)hit("R7","block","近十分钟含本次的交易次数超过配置上限","等待窗口结束或人工核查；软限额确认不能解除速度拦截")
    if(duplicate)hit("R8","block","近十分钟已有同商品、商户及金额的其他交易","查看并恢复原交易，勿重复付款；同 operation 重试不计为另一笔")
    if(this.config.injectionSignals.some(word=>plan.title.toLowerCase().includes(word.toLowerCase())))hit("R13","block","服务端商品文本命中可疑指令辅助信号","请人工核查商品内容；关键词检查不是完整提示注入检测")
    const projectedMinor=spentMinor+reservedMinor+quote.totalMinor
    if(!Number.isSafeInteger(projectedMinor))hit("INVALID_TOTAL","block","累计金额超出安全整数范围")
    if(auth){
      if(projectedMinor>auth.monthlyHardMinor)hit("R1-hard","block","预计月度占用超过硬上限")
      else if(projectedMinor>auth.monthlySoftMinor)hit("R1-soft","hold","预计月度占用超过软上限","仅可确认本次明确金额的软限额例外")
      if(quote.totalMinor>auth.singleHardMinor)hit("R2-hard","block","本次总额超过单笔硬上限")
      else if(quote.totalMinor>auth.singleSoftMinor)hit("R2-soft","hold","本次总额超过单笔软上限","仅可确认本次明确金额的软限额例外")
    }
    let decision:RiskDecision["decision"]=hits.some(h=>h.severity==="block")?"block":hits.length?"hold":"approve"
    let confirmationId:string|null=null
    if(decision==="hold"&&auth){
      const rules=hits.map(h=>h.rule).sort()
      const binding=createHash("sha256").update(JSON.stringify({owner,operationId,task:input.task,plan,quote,authorizationId:auth.authorizationId,authorizationVersion:auth.version,rules})).digest("hex")
      const row=this.repo.db.prepare("SELECT data FROM risk_confirmations WHERE operation_id=? AND binding=?").get(operationId,binding)
      let c:Confirmation
      if(row)c=JSON.parse(String(row.data))
      else {c={confirmationId:randomUUID(),userId:owner,operationId,taskId:input.task.taskId,requirementVersion:input.expectedVersion,authorizationId:auth.authorizationId,authorizationVersion:auth.version,planId:plan.planId,quoteId:quote.quoteId,amountMinor:quote.totalMinor,rules,expiresAt:Math.min(now+this.config.confirmationMs,quote.expiresAt,auth.expiresAt),status:"pending",binding};this.repo.saveConfirmation(c)}
      confirmationId=c.confirmationId
      if(c.expiresAt<=now||c.status==="rejected"){hit("CONFIRMATION_CLOSED","block","本次确认已拒绝或超时","本次例外不再有效；不得重发同一确认延长有效期");decision="block"}
      else if(c.status==="accepted")decision="approve"
    }
    const result:RiskDecision={policyVersion:this.config.policyVersion,decisionId:randomUUID(),operationId,decision,hits,at:now,authorizationId:auth?.authorizationId??null,authorizationVersion:auth?.version??null,projectedMinor,spentMinor,reservedMinor,confirmationId,...(errorCode?{errorCode}:{})}
    this.repo.saveDecision(owner,result)
    if(decision==="approve" && reserve){
      const old=this.repo.db.prepare("SELECT * FROM risk_reservations WHERE operation_id=?").get(operationId)
      ensure(!old || old.amount===quote.totalMinor,"RESERVATION_MISMATCH","预占金额不一致",409)
      if(!old || old.state==="released")this.repo.audit(owner,now,"budget_reserved",{operationId,amountMinor:quote.totalMinor,authorizationId:auth?.authorizationId,authorizationVersion:auth?.version})
      if(!old)this.repo.db.prepare("INSERT INTO risk_reservations VALUES (?,?,?,?,?,?,NULL)").run(operationId,owner,quote.totalMinor,hongKongMonth(now),"reserved",now)
      else if(old.state==="released")this.repo.db.prepare("UPDATE risk_reservations SET state='reserved',month=?,at=?,settled_at=NULL WHERE operation_id=?").run(hongKongMonth(now),now,operationId)
    }
    return result
  }
  settle(op:PurchaseOperation,now:number){
    if(op.errorCode === "PAYMENT_MISMATCH")this.repo.audit(op.userId,now,"R16_payment_integrity_block",{operationId:op.operationId,reason:"支付对象金额或关联不一致，不能用软限额确认放行"})
    const row=this.repo.db.prepare("SELECT state FROM risk_reservations WHERE operation_id=?").get(op.operationId)
    if(!row || row.state==="spent")return // legacy records gain no invented authorization/reservation
    if(op.paymentStatus==="succeeded"){this.repo.db.prepare("UPDATE risk_reservations SET state='spent',month=?,settled_at=? WHERE operation_id=?").run(hongKongMonth(now),now,op.operationId);this.repo.audit(op.userId,now,"budget_spent",{operationId:op.operationId,amountMinor:op.quote.totalMinor})}
    else if(row.state!=="released" && (["failed","canceled"].includes(op.paymentStatus) || op.createStartedAt===null || (op.paymentStatus==="requires_confirmation"&&op.confirmStartedAt===null&&op.errorCode))){this.repo.db.prepare("UPDATE risk_reservations SET state='released',settled_at=? WHERE operation_id=?").run(now,op.operationId);this.repo.audit(op.userId,now,"budget_released",{operationId:op.operationId,paymentStatus:op.paymentStatus,errorCode:op.errorCode})}
    // Unknown / processing / requires_action can still settle: never release here.
  }
}
