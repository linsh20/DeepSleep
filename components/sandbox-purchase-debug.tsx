"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import type { PurchaseExecutionService } from "@/services/purchase-execution/service"
type View = ReturnType<PurchaseExecutionService["get"]>
async function api(action: string, body?: object): Promise<{ view?: View; views?: View[] }> {
  const response = await fetch(`/api/sandbox-purchase/${action}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" })
  const result = await response.json()
  if (!response.ok) throw new Error(`${result.error?.code}: ${result.error?.message}`)
  return result
}
export function SandboxPurchaseDebug() {
  const [view, setView] = useState<View | null>(null), [views, setViews] = useState<View[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [permission, setPermission] = useState(false)
  async function work(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : "请求失败，请查询已有操作") } finally { setBusy(false) } }
  function accept(next?: View) { if (next) { setView(next); setViews(old => [next, ...old.filter(v => v.plan.planId !== next.plan.planId)]) } }
  const state = view?.operation?.paymentStatus
  return <main className="mx-auto max-w-4xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">模拟商户订单 + Stripe 沙盒支付</h1>
    <p>商户订单为模拟；支付仅运行在 Stripe 沙盒，无真实扣款或真实商品购买。正式授权和风控尚未接入，正式模式拒绝执行。</p>
    <p>独立服务端测试方案，不使用 ShoppingStub 的未知价格。SQLite 保存订单、支付关联和一次测试许可。</p>
    <Button disabled={busy} onClick={() => void work(async () => { await api("session", {}); const r = await api("state"); setViews(r.views ?? []); if (r.views?.[0]) accept(r.views[0]) })}>打开沙盒会话 / 恢复记录</Button>
    <Button className="ml-2" disabled={busy} onClick={() => void work(async () => { await api("session", {}); accept((await api("fixture", { requestId: crypto.randomUUID() })).view); setPermission(false) })}>创建独立测试方案</Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {views.length > 0 && <label className="block">已有测试方案<select className="ml-2 rounded border p-2" value={view?.plan.planId ?? ""} onChange={e => { setView(views.find(v => v.plan.planId === e.target.value) ?? null); setPermission(false) }}>{views.map(v => <option key={v.plan.planId} value={v.plan.planId}>{v.plan.planId}</option>)}</select></label>}
    {view && <>
      <Card><CardHeader><CardTitle>测试方案与服务端报价</CardTitle></CardHeader><CardContent className="space-y-3">
        <p>{view.plan.title} · {view.plan.quantity}件 · {view.quote.currency} {(view.quote.totalMinor / 100).toFixed(2)}（含运费）</p>
        <p>总预算 {(view.task.requirement.budget.maxMinor / 100).toFixed(2)} HKD · 报价有效至 {new Date(view.quote.expiresAt).toLocaleString()} · v{view.task.requirementVersion}</p>
        <pre className="overflow-auto text-sm">{JSON.stringify({ plan: view.plan, quote: view.quote }, null, 2)}</pre>
        <p>{view.stripeConfigured ? "已配置测试密钥；配置存在不代表 Stripe 实测成功。" : "Stripe 沙盒未配置：请在服务端 .env.local 填写 STRIPE_SECRET_KEY、STRIPE_WEBHOOK_SECRET 并重启。"}</p>
        <label className="block"><input type="checkbox" checked={permission} onChange={e => setPermission(e.target.checked)} /> 我许可对这个已保存方案运行一次沙盒测试；不代表持续授权。</label>
        <Button disabled={busy || !permission} onClick={() => void work(async () => { accept((await api("execute", { planId: view.plan.planId, expectedVersion: view.task.requirementVersion, requestId: crypto.randomUUID(), testPermission: true })).view) })}>运行沙盒购买 / 恢复同一操作</Button>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>支付与订单状态</CardTitle></CardHeader><CardContent className="space-y-3">
        <p>支付：{state ?? "尚未执行"} · 模拟订单：{view.order?.status ?? "尚未创建"}</p>
        <p>Stripe 测试对象 ID：{view.operation?.paymentId ?? "尚未取得；不能据此断言未创建"}</p>
        {view.operation?.errorCode && <p role="alert" className="text-destructive">{view.operation.errorCode}</p>}
        {state === "requires_action" && <p>需要额外验证，本轮未实现验证界面；已暂停，未完成支付。</p>}
        {state === "processing" && <p>Stripe 仍在处理，不能宣称支付完成。</p>}
        {state === "unknown" && <p>支付结果未知。保留原订单和幂等键，请恢复同一操作，不创建新方案来重付。</p>}
        {state === "failed" && <p>支付失败或被拒绝，本轮不更换支付方式再次尝试。</p>}
        {state === "succeeded" && <p>Stripe 沙盒支付已成功。{view.order?.status === "confirmed" ? "模拟订单已确认。" : "模拟商户订单尚未确认，请恢复订单确认；不可重新付款。"} 无真实扣款。</p>}
        <p>本次测试许可：{view.operation ? new Date(view.operation.testPermission.grantedAt).toLocaleString() : "尚未记录"} · 检查仅限沙盒，不是正式风控通过。</p>
        <Button disabled={busy} variant="outline" onClick={() => void work(async () => accept((await api(`state?planId=${encodeURIComponent(view.plan.planId)}`)).view))}>只读刷新</Button>
        <Button className="ml-2" disabled={busy || !view.operation} variant="outline" onClick={() => void work(async () => accept((await api("reconcile", { planId: view.plan.planId })).view))}>核对 Stripe / 恢复商户确认（不创建支付）</Button>
        <pre className="overflow-auto text-sm">{JSON.stringify({ operation: view.operation, order: view.order, events: view.events }, null, 2)}</pre>
      </CardContent></Card>
    </>}
  </main>
}
