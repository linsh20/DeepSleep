import { ensure, type SandboxTask } from "../purchase-execution/types"
import { RiskPolicyEngine } from "./engine"
import type { RiskRepository } from "./repository"
export class ConfirmationService {
  constructor(private repo:RiskRepository,private currentTask:(task:SandboxTask)=>SandboxTask,private now=Date.now){}
  respond(owner:string,id:string,accept:boolean) {
    ensure(typeof accept==="boolean","INVALID_INPUT","需要明确确认或拒绝")
    const outcome=this.repo.purchase.transaction(()=>{
      const c=this.repo.confirmation(id,owner);ensure(c,"NOT_FOUND","确认单不存在",404)
      if(!accept){
        ensure(c.status!=="accepted","CONFIRMATION_CLOSED","已确认的交易不能通过拒绝按钮撤销；请查看支付事实",409)
        c.status="rejected";this.repo.saveConfirmation(c);this.repo.audit(owner,this.now(),"confirmation_rejected",c);return {confirmation:c,accepted:false}
      }
      ensure(c.expiresAt>this.now()&&c.status!=="rejected","CONFIRMATION_CLOSED","确认已拒绝或超时",409)
      const op=this.repo.purchase.operation(c.operationId)
      const task=this.currentTask(this.repo.purchase.task(c.taskId)),plan=this.repo.purchase.plan(c.planId),quote=this.repo.purchase.quote(c.planId)
      ensure(task.userId===owner&&op.userId===owner,"NOT_FOUND","确认单不存在",404)
      ensure(task.requirementVersion===c.requirementVersion&&task.intent==="purchase","STALE_VERSION","当前需求或意图已变化",409)
      const auth=this.repo.current(owner)
      ensure(auth?.authorizationId===c.authorizationId&&auth.version===c.authorizationVersion,"STALE_AUTHORIZATION","授权已变化，请重新查看风控结果",409)
      ensure(JSON.stringify(quote)===JSON.stringify(op.quote),"QUOTE_MISMATCH","报价与操作记录不一致",409)
      const result=new RiskPolicyEngine(this.repo).evaluate({mode:"sandbox",task,plan,quote,userId:owner,expectedVersion:c.requirementVersion,permitted:true,now:this.now(),operationId:op.operationId},false)
      if(result.decision==="block"||result.confirmationId!==id)return {confirmation:c,accepted:false,decision:result}
      if(c.status!=="accepted"){c.status="accepted";this.repo.saveConfirmation(c);this.repo.audit(owner,this.now(),"confirmation_accepted",c)}
      return {confirmation:c,accepted:true,decision:result}
    })
    // This endpoint never calls Stripe or executes an order; execute rechecks everything.
    return outcome
  }
}
