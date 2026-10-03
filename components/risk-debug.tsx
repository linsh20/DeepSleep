"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { hkdToMinor } from "@/services/main-agent/money"
import type { Authorization, Confirmation, RiskDecision } from "@/services/risk-control/types"
type View = { scope:{productIds:string[]}; authorization: Authorization | null; confirmations: Confirmation[]; decisions: RiskDecision[]; reservations: unknown[] }
export function RiskDebug(){
  const [view,setView]=useState<View|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[observedAt,setObservedAt]=useState(0)
  async function api(path:string,body?:unknown){
    const r=await fetch(`/api/agent/${path}`,body===undefined?{cache:"no-store"}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    const data=await r.json();if(!r.ok)throw Error(`${data.error?.code}: ${data.error?.message}`);return data
  }
  async function refresh(){setView(await api("risk/state"));setObservedAt(Date.now())}
  async function run(work:()=>Promise<void>){setBusy(true);setError("");try{await work()}catch(e){setError(String(e))}finally{setBusy(false)}}
  async function save(form:FormData){await run(async()=>{
    await api("risk/authorization",{expectedVersion:view?.authorization?.version??0,requestId:crypto.randomUUID(),explicitlyConfirmed:form.get("confirmed")==="on",terms:{
      startsAt:Date.now(),expiresAt:Date.parse(String(form.get("expiresAt"))),
      singleSoftMinor:hkdToMinor(String(form.get("singleSoft"))),singleHardMinor:hkdToMinor(String(form.get("singleHard"))),
      monthlySoftMinor:hkdToMinor(String(form.get("monthlySoft"))),monthlyHardMinor:hkdToMinor(String(form.get("monthlyHard"))),
      productIds:form.getAll("products").map(String),merchantIds:["demo-merchant"],paymentMethods:["stripe_test_card"],
    }});await refresh()
  })}
  return <main className="mx-auto max-w-4xl space-y-4 p-6"><h1 className="text-2xl font-semibold">有限授权与风控调试</h1>
    <p>仅支持虚拟测试乳液、模拟商户 demo-merchant、Stripe 测试卡；无真实扣款。演示会话不是正式身份认证。<a className="underline" href="/agent">返回主 Agent</a></p>
    <Button disabled={busy} onClick={()=>run(async()=>{await api("session",{});await refresh()})}>建立或读取当前演示会话</Button>
    {error&&<p role="alert">{error}</p>}
    {view&&<><Card><CardHeader><CardTitle>明确创建 / 修改有限授权</CardTitle></CardHeader><CardContent>
      <p>当前版本 {view.authorization?.version??0}，状态 {view.authorization?.status??"未授权"}。以下金额单位为 HKD 元；提交后创建新版本。撤销不等于退款。</p>
      <form action={save} className="space-y-3" key={view.authorization?.version??0}>
        {([["singleSoft","单笔软上限",100,view.authorization?.singleSoftMinor],["singleHard","单笔硬上限（最多200）",200,view.authorization?.singleHardMinor],["monthlySoft","月度软上限",300,view.authorization?.monthlySoftMinor],["monthlyHard","月度硬上限",400,view.authorization?.monthlyHardMinor]] as const).map(([name,label,fallback,value])=><label className="block" key={name}>{label}<Input name={name} type="number" min="0" step="0.01" defaultValue={value===undefined?fallback:value/100} required/></label>)}
        <fieldset><legend>明确选择允许的演示商品（新增目录不会自动扩展旧授权）</legend>{view.scope.productIds.map(id=><label className="block" key={id}><input type="checkbox" name="products" value={id} defaultChecked={view.authorization?.productIds.includes(id)??false}/>{id}</label>)}</fieldset>
        <label className="block">失效时间（本机时区）<Input type="datetime-local" name="expiresAt" required/></label>
        <label className="block"><input type="checkbox" name="confirmed" required/> 我明确授权上述范围和额度内的沙盒购买；这与每次测试许可分开。</label>
        <Button disabled={busy}>明确确认并保存授权</Button>
      </form>
      <Button disabled={busy||!view.authorization} onClick={()=>run(async()=>{await api("risk/revoke",{expectedVersion:view.authorization!.version,requestId:crypto.randomUUID()});await refresh()})}>撤销当前授权</Button>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>软限额确认单</CardTitle></CardHeader><CardContent><p>仅限列出的本次金额和版本；两分钟内有效，且不晚于授权或报价到期。确认不修改持续授权，也不直接付款。确认后到主 Agent 再执行，服务端会重新检查。</p>
      {view.confirmations.map(c=><div key={c.confirmationId} className="my-4 border p-3"><p>金额 HKD {c.amountMinor/100}；状态 {c.expiresAt<=observedAt?"已过期（不可确认）":c.status}；有效至 {new Date(c.expiresAt).toLocaleString()}</p><pre className="overflow-auto text-xs">{JSON.stringify(c,null,2)}</pre>
      <Button disabled={busy||c.status!=="pending"||c.expiresAt<=observedAt} onClick={()=>run(async()=>{const result=await api("risk/confirmation",{confirmationId:c.confirmationId,accept:true});await refresh();if(!result.accepted)throw Error("当前检查未允许本次例外，请查看最新决策")})}>确认仅本次软限额例外</Button>
      <Button disabled={busy||c.status!=="pending"} onClick={()=>run(async()=>{await api("risk/confirmation",{confirmationId:c.confirmationId,accept:false});await refresh()})}>拒绝本次交易</Button></div>)}
    </CardContent></Card>
    <Button disabled={busy} onClick={()=>run(refresh)}>只读刷新决策与预算记录</Button><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(view,null,2)}</pre></>}
  </main>
}
