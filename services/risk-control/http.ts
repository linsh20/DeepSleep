import type { SqliteTaskRepository } from "../main-agent/sqlite-repository"
import { TaskError } from "../main-agent/types"
import { PurchaseError, ensure } from "../purchase-execution/types"
import { currentTaskResolver } from "../purchase-bridge/service"
import { AuthorizationService } from "./authorization"
import { ConfirmationService } from "./confirmation"
import type { RiskRepository } from "./repository"
import { RISK_CONFIG, type AuthorizationTerms } from "./types"
export function riskHttp(repo:RiskRepository,main:SqliteTaskRepository){
  return async(request:Request,action:string)=>{
    const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{"Cache-Control":"no-store"}})
    try{
      ensure(["state","authorization","revoke","confirmation"].includes(action),"NOT_FOUND","接口不存在",404)
      ensure(request.method===(action==="state"?"GET":"POST"),"METHOD_NOT_ALLOWED","方法不支持",405)
      const token=request.headers.get("cookie")?.match(/(?:^|;\s*)deepsleep_demo=([a-f0-9-]+)(?:;|$)/)?.[1]
      ensure(token&&main.sessions.has(token),"SESSION_REQUIRED","请建立主 Agent 演示会话",401)
      const owner=main.owner(token)
      if(action==="state")return json({...repo.view(owner),scope:{productIds:RISK_CONFIG.productIds,merchantIds:RISK_CONFIG.merchantIds,paymentMethods:RISK_CONFIG.paymentMethods},notice:"仅限模拟商品和 Stripe 沙盒；演示会话不是正式身份认证"})
      const url=new URL(request.url)
      ensure(request.headers.get("origin")===`${url.protocol}//${request.headers.get("host")??url.host}`,"FORBIDDEN","需要同源请求",403)
      ensure(request.headers.get("content-type")?.startsWith("application/json"),"INVALID_INPUT","需要 JSON",415)
      const reader=request.body?.getReader();ensure(reader,"INVALID_INPUT","缺少请求")
      const chunks:Uint8Array[]=[];let size=0
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();throw new PurchaseError("INVALID_INPUT","请求过大",413)}chunks.push(value)}}finally{reader.releaseLock()}
      let body:Record<string,unknown>
      try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"))}catch{throw new PurchaseError("INVALID_INPUT","JSON 无效")}
      const keys=action==="authorization"?["terms","expectedVersion","requestId","explicitlyConfirmed"]:action==="revoke"?["expectedVersion","requestId"]:["confirmationId","accept"]
      ensure(body&&typeof body==="object"&&!Array.isArray(body)&&Object.keys(body).every(k=>keys.includes(k)),"INVALID_INPUT","包含不支持的字段")
      if(action==="confirmation"){
        ensure(typeof body.confirmationId==="string"&&typeof body.accept==="boolean","INVALID_INPUT","需要确认单和明确答复")
        return json(new ConfirmationService(repo,currentTaskResolver(main)).respond(owner,body.confirmationId,body.accept))
      }
      ensure(Number.isSafeInteger(body.expectedVersion)&&typeof body.requestId==="string","INVALID_INPUT","需要版本和 requestId")
      const auth=new AuthorizationService(repo)
      if(action==="revoke")return json({authorization:auth.revoke(owner,body.expectedVersion as number,body.requestId)})
      return json({authorization:auth.save(owner,body.terms as AuthorizationTerms,body.expectedVersion as number,body.requestId,body.explicitlyConfirmed===true)})
    }catch(error){
      if(error instanceof PurchaseError)return json({error:{code:error.code,message:error.message}},error.status)
      if(error instanceof TaskError)return json({error:{code:error.code,message:error.message}},error.httpStatus)
      return json({error:{code:"RISK_UNAVAILABLE",message:"风控请求失败；未因此放行付款"}},500)
    }
  }
}
