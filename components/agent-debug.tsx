"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { MainTask } from "@/services/main-agent/types"

type Command = { path: string; body: Record<string, unknown> }
async function request(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`/api/agent/${path}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : { cache: "no-store" })
  const data = await response.json()
  if (!response.ok) throw new Error(`${data.error?.code}: ${data.error?.message}`)
  return data as { task?: MainTask }
}
export function AgentDebug() {
  const [task, setTask] = useState<MainTask | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [lastCommand, setLastCommand] = useState<Command | null>(null)
  const currentId = useRef<string | null>(null)
  const accept = useCallback((next?: MainTask) => {
    if (!next || currentId.current !== next.taskId) return
    currentId.current = next.taskId
    setTask(old => old && old.events.length > next.events.length ? old : next)
  }, [])
  const refresh = useCallback(async (id: string) => { accept((await request(`tasks/${id}`)).task) }, [accept])
  const taskId = task?.taskId
  useEffect(() => {
    if (!taskId) return
    const timer = setInterval(() => { void refresh(taskId).catch(e => setError(String(e))) }, 750)
    return () => clearInterval(timer)
  }, [taskId, refresh]) // Polling is read-only; never invokes search.
  async function send(command: Command) {
    setLastCommand(command)
    const result = await request(command.path, command.body)
    accept(result.task)
    return result.task
  }
  async function start() {
    setBusy(true); setError("")
    try {
      await request("session", {})
      const command = { path: "tasks", body: { requestId: crypto.randomUUID() } }
      setLastCommand(command)
      const result = await request(command.path, command.body)
      if (result.task) { currentId.current = result.task.taskId; setTask(result.task) }
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  async function save(form: FormData) {
    if (!task) return
    setBusy(true); setError("")
    const val = (name: string) => String(form.get(name) ?? "")
    const num = (name: string) => val(name) === "" ? undefined : Number(val(name))
    try {
      await send({ path: `tasks/${task.taskId}/requirements`, body: {
        requestId: crypto.randomUUID(), expectedVersion: task.requirementVersion, intent: val("intent"),
        requirementDraft: { category: val("category"), query: val("query"), currency: val("currency"), destination: val("destination"),
          quantity: num("quantity"), budget: { maxMinor: num("maxMinor"), scope: val("scope") } },
      } })
    } catch (e) { setError(String(e)); void refresh(task.taskId) } finally { setBusy(false) }
  }
  async function run() {
    if (!task) return
    setError("")
    // Leave the form editable while the awaited server search is in flight.
    try { await send({ path: `tasks/${task.taskId}/search`, body: { requestId: crypto.randomUUID(), expectedVersion: task.requirementVersion } }) }
    catch (e) { setError(String(e)) }
  }
  return <main className="mx-auto w-full max-w-4xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">DeepSleep 主 Agent 调试</h1>
    <p>开发输入模式：模型尚未接入，请通过表单明确填写和修正需求。ShoppingStub 全部为开发模拟，未核验真实商品。</p>
    <p>仅供本地单进程开发；内存数据在进程重启后丢失，不用于授权、预算或支付去重。购买执行尚未接入。</p>
    <Button onClick={start} disabled={busy}>开始新任务</Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {task && <>
      <Card><CardHeader><CardTitle>结构化需求输入</CardTitle></CardHeader><CardContent>
        <form onSubmit={event => { event.preventDefault(); void save(new FormData(event.currentTarget)) }} className="grid gap-4 sm:grid-cols-2" key={task.taskId}>
          <label>意图<select name="intent" className="block w-full rounded border p-2" defaultValue="unclear"><option value="unclear">尚未明确</option><option value="compare">比较方案</option><option value="purchase">购买任务（不执行）</option></select></label>
          <label>类别<Input name="category" placeholder="例如：化妆品" /></label>
          <label className="sm:col-span-2">商品与规格<Input name="query" placeholder="填写品牌、商品、色号、容量及正装/补充装" /></label>
          <label>币种<select name="currency" defaultValue="" className="block w-full rounded border p-2"><option value="">请选择</option><option value="HKD">HKD</option></select></label>
          <label>预算上限（港仙，HKD 180 = 18000）<Input name="maxMinor" type="number" min="1" step="1" /></label>
          <label>预算口径<select name="scope" defaultValue="" className="block w-full rounded border p-2"><option value="">请选择</option><option value="item">商品金额</option><option value="delivered">含运费总额</option></select></label>
          <label>数量<Input name="quantity" type="number" min="1" max="100" step="1" /></label>
          <label>配送地区<Input name="destination" placeholder="例如：香港" /></label>
          <Button type="submit" disabled={busy}>保存需求并校验</Button>
        </form>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>任务状态：{task.status}</CardTitle></CardHeader><CardContent className="space-y-3">
        <p>任务 {task.taskId} · 需求版本 v{task.requirementVersion} · 意图 {task.intent}</p>
        <p>{task.intent === "purchase" ? "购买执行尚未接入；返回方案不代表已下单。" : "当前任务仅展示方案，不创建购买或支付。"}</p>
        <Button onClick={run} disabled={busy || !["ready_to_search", "failed"].includes(task.status)}>运行 ShoppingStub</Button>
        {lastCommand && <Button variant="outline" className="ml-2" disabled={busy} onClick={() => {
          setError(""); void send(lastCommand).catch(e => setError(String(e)))
        }}>重发上次请求（相同 requestId）</Button>}
        <h2 className="font-semibold">缺失字段与澄清问题</h2>
        <p>{task.missingFields.join("、") || "无缺失字段"}</p>
        <ul>{task.clarificationQuestions.map(q => <li key={q}>{q}</li>)}</ul>
        <h2 className="font-semibold">当前需求草稿</h2><pre className="overflow-auto text-sm">{JSON.stringify(task.requirementDraft, null, 2)}</pre>
        <h2 className="font-semibold">ShoppingStub 结果（开发模拟 / 未核验）</h2>
        <pre className="overflow-auto whitespace-pre-wrap text-sm">{task.shoppingResult ? JSON.stringify(task.shoppingResult, null, 2) : "尚无当前版本结果"}</pre>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>事件时间线</CardTitle></CardHeader><CardContent><ol className="space-y-2 text-sm">{task.events.map(e => <li key={e.sequence}>{e.at} · v{e.requirementVersion} · {e.type} · {e.detail}</li>)}</ol></CardContent></Card>
    </>}
  </main>
}
