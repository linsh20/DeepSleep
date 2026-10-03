"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { MainTask } from "@/services/main-agent/types"
import type { PurchaseBridge } from "@/services/purchase-bridge/service"
type State = ReturnType<PurchaseBridge["state"]>
export function AgentPurchaseDebug({task}: {task:MainTask}) {
  const [state,setState] = useState<State | null>(null)
  const [preparation,setPreparation]=useState<unknown>(null)
  const shopping=task.shoppingResult && "kind" in task.shoppingResult ? task.shoppingResult : null
  const [permission,setPermission] = useState(false)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState("")
  const current = state?.purchases.find(p => p.plan.requirementVersion === task.requirementVersion)
  async function call(action:string,planId?:string,candidateId?:string) {
    setBusy(true);setError("")
    try {
      const response = await fetch(`/api/agent/purchases/${action}${action === "state" ? `?taskId=${encodeURIComponent(task.taskId)}` : ""}`,action === "state" ? {cache:"no-store"} : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({taskId:task.taskId,requestId:crypto.randomUUID(),...(action === "recover" ? {} : {expectedVersion:task.requirementVersion}),...(planId ? {planId}:{}),...(candidateId ? {candidateId}:{}),...(action === "execute" ? {testPermission:permission}:{})})})
      const data = await response.json()
      if (!response.ok) throw new Error(`${data.error?.code}: ${data.error?.message}`)
      setState(data);setPreparation(data.checkoutPreparation??null)
    } catch(e) {setError(String(e))} finally {setBusy(false);setPermission(false)}
  }
  return <Card><CardHeader><CardTitle>当前任务的沙盒购买（独立于搜索状态）</CardTitle></CardHeader><CardContent className="space-y-3">
    <p>商户为模拟，Stripe 仅运行沙盒，无真实扣款。测试商品必须明确填写：类别「沙盒测试乳液」、商品「测试乳液 200ml」、1件、HKD、香港，无附加条件。报价为170 HKD + 运费10 HKD。</p>
    <Button disabled={busy || task.intent !== "purchase" || !task.requirement} onClick={()=>void call("prepare")}>准备当前任务的沙盒方案（不付款）</Button>
    <p>Shopping 目录案例：类别「沙盒目录乳液」、商品「DEEPSLEEP DEMO LOTION 200ML」、1件、香港。先运行搜索，再准备下面的候选。商品和商户均为模拟，不代表 Watsons 结账。<a href="/agent-risk" className="underline">查看 / 修改有限授权与软限额确认</a></p>
    {shopping?.candidates.map(c=><Button key={JSON.stringify([c.productId,c.skuId,c.offerId])} disabled={busy||task.intent!=="purchase"} onClick={()=>void call("prepare",undefined,JSON.stringify([c.productId,c.skuId,c.offerId]))}>补查并准备：{c.title}</Button>)}
    {preparation!==null&&<pre className="overflow-auto text-xs">{JSON.stringify(preparation,null,2)}</pre>}
    <Button variant="outline" disabled={busy} onClick={()=>void call("state")}>查询该任务购买记录（只读）</Button>
    {error && <p role="alert">{error}</p>}
    {current && <div className="space-y-2">
      <p>方案 {current.plan.planId} · 报价 {current.quote.totalMinor/100} HKD · 有效至 {new Date(current.quote.expiresAt).toLocaleString()}</p>
      <label><input type="checkbox" checked={permission} onChange={e=>setPermission(e.target.checked)}/>我许可本次 Stripe 沙盒测试，无真实扣款；不代表持续授权</label>
      <Button disabled={busy || !permission || current.stale || current.quoteExpired || task.intent !== "purchase"} onClick={()=>void call("execute",current.plan.planId)}>运行沙盒购买</Button>
    </div>}
    {state?.purchases.map(p=><section className="rounded border p-3" key={p.plan.planId}>
      <p>方案 v{p.plan.requirementVersion} · {p.stale ? "旧需求方案：不可发起付款；交易历史保留" : "当前版本"}</p>
      <p>支付状态：{p.operation?.paymentStatus ?? "not_started"} · 商户状态：{p.order?.status ?? "尚无订单"}</p>
      <p>Stripe ID：{p.operation?.paymentId ?? "尚未创建"}</p>
      {p.operation && <Button variant="outline" disabled={busy} onClick={()=>void call("recover",p.plan.planId)}>主动核对 Stripe / 恢复商户确认</Button>}
      <pre className="overflow-auto text-xs">{JSON.stringify(p,null,2)}</pre>
    </section>)}
  </CardContent></Card>
}
