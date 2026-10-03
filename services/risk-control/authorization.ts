import { randomUUID } from "node:crypto"
import { ensure } from "../purchase-execution/types"
import type { RiskRepository } from "./repository"
import { RISK_CONFIG, type Authorization, type AuthorizationTerms, type RiskConfig } from "./types"
export class AuthorizationService {
  constructor(private repo: RiskRepository, private config: RiskConfig = RISK_CONFIG, private now = Date.now) {}
  current(owner: string) { return this.repo.current(owner) }
  save(owner: string, terms: AuthorizationTerms, expectedVersion: number, requestId: string, explicitlyConfirmed: boolean) {
    ensure(explicitlyConfirmed === true, "AUTH_CONFIRMATION_REQUIRED", "必须明确确认有限测试授权",403)
    const allowed = ["startsAt","expiresAt","singleSoftMinor","singleHardMinor","monthlySoftMinor","monthlyHardMinor","productIds","merchantIds","paymentMethods"]
    ensure(terms && typeof terms === "object" && Object.keys(terms).length === allowed.length && Object.keys(terms).every(k=>allowed.includes(k)),"INVALID_AUTHORIZATION","授权字段不完整或不支持")
    for(const value of [terms.startsAt,terms.expiresAt,terms.singleSoftMinor,terms.singleHardMinor,terms.monthlySoftMinor,terms.monthlyHardMinor]) ensure(Number.isSafeInteger(value) && value>=0,"INVALID_AUTHORIZATION","金额和时间须为非负安全整数")
    ensure(terms.expiresAt>terms.startsAt && terms.expiresAt>this.now() && terms.expiresAt<=8640000000000000,"INVALID_AUTHORIZATION","有效期无效")
    ensure(terms.singleHardMinor>0 && terms.singleHardMinor<=20000 && terms.singleSoftMinor<=terms.singleHardMinor && terms.monthlyHardMinor>0 && terms.monthlySoftMinor<=terms.monthlyHardMinor,"INVALID_AUTHORIZATION","软上限不能高于硬上限，单笔硬上限不得超过200 HKD")
    for(const key of ["productIds","merchantIds","paymentMethods"] as const) ensure(Array.isArray(terms[key]) && terms[key].length>0 && terms[key].every(v=>this.config[key].includes(v)) && new Set(terms[key]).size===terms[key].length,"UNSUPPORTED_AUTH_SCOPE","仅支持已配置的模拟商品、商户和 Stripe 测试卡范围")
    return this.change(owner,expectedVersion,requestId,{terms,explicitlyConfirmed},old=>({...structuredClone(terms),authorizationId:old?.authorizationId??randomUUID(),userId:owner,version:(old?.version??0)+1,status:"active",createdAt:this.now()}))
  }
  revoke(owner: string, expectedVersion: number, requestId: string) {
    return this.change(owner,expectedVersion,requestId,{revoke:true},old=>{ensure(old,"AUTH_REQUIRED","尚无授权",409);return {...old,version:old.version+1,status:"revoked",createdAt:this.now()}})
  }
  private change(owner:string, version:number, requestId:string, input:unknown, update:(old:Authorization|null)=>Authorization) {
    ensure(Number.isSafeInteger(version)&&version>=0&&typeof requestId === "string"&&/^[A-Za-z0-9_-]{8,100}$/.test(requestId),"INVALID_INPUT","版本或 requestId 无效")
    return this.repo.purchase.transaction(()=>{
      const fingerprint=JSON.stringify({version,input}), db=this.repo.db
      const prior=db.prepare("SELECT * FROM risk_requests WHERE owner=? AND request_id=?").get(owner,requestId)
      if(prior){ensure(prior.fingerprint===fingerprint,"REQUEST_CONFLICT","requestId 已用于不同授权操作",409);return JSON.parse(String(prior.data)) as Authorization}
      const old=this.repo.current(owner);ensure((old?.version??0)===version,"STALE_AUTHORIZATION","授权版本已变化，请重新查看",409)
      const next=update(old)
      db.prepare("INSERT INTO risk_authorizations VALUES (?,?,?)").run(owner,next.version,JSON.stringify(next))
      db.prepare("INSERT INTO risk_requests VALUES (?,?,?,?)").run(owner,requestId,fingerprint,JSON.stringify(next))
      this.repo.audit(owner,this.now(),next.status === "revoked"?"authorization_revoked":old?"authorization_modified":"authorization_created",next)
      return next
    })
  }
}
