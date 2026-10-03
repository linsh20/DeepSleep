"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { AgentPurchaseDebug } from "@/components/agent-purchase-debug"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { hkdToMinor, minorToHKD } from "@/services/main-agent/money"
import type { ModelConnection } from "@/services/main-agent/model-interpreter"
import type { MainTask } from "@/services/main-agent/types"

type Command = { path: string; body: Record<string, unknown> }
async function request(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`/api/agent/${path}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : { cache: "no-store" })
  let data
  try { data = await response.json() } catch { throw new Error("服务暂时未返回有效 JSON，请刷新任务后重试") }
  if (!response.ok) throw new Error(`${data.error?.code}: ${data.error?.message}`)
  return data as { task?: MainTask; model?: ModelConnection }
}
export function AgentDebug() {
  const [task, setTask] = useState<MainTask | null>(null)
  const [model, setModel] = useState<ModelConnection | null>(null)
  const [chatBusy, setChatBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [lastCommand, setLastCommand] = useState<Command | null>(null)
  const currentId = useRef<string | null>(null)
  const accept = useCallback((next?: MainTask) => {
    if (!next || currentId.current !== next.taskId) return
    currentId.current = next.taskId
    localStorage.setItem("deepsleep-main-task", next.taskId)
    setTask(old => old && old.events.length > next.events.length ? old : next)
  }, [])
  const refresh = useCallback(async (id: string) => {
    accept((await request(`tasks/${id}`)).task)
    const info = await request("model"); if (info.model) setModel(info.model)
  }, [accept])
  useEffect(() => {
    const id = localStorage.getItem("deepsleep-main-task")
    if (!id) return
    currentId.current = id
    void request("session", {}).then(() => refresh(id)).catch(e => setError(String(e)))
  }, [refresh])
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
      const info = await request("model"); if (info.model) setModel(info.model)
      const command = { path: "tasks", body: { requestId: crypto.randomUUID() } }
      setLastCommand(command)
      const result = await request(command.path, command.body)
      if (result.task) { currentId.current = result.task.taskId; localStorage.setItem("deepsleep-main-task",result.task.taskId); setTask(result.task) }
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
        requirementDraft: { ...task.requirementDraft, category: val("category"), query: val("query"), currency: val("currency"), destination: val("destination"),
          quantity: num("quantity"), budget: { maxMinor: val("maxHKD") === "" ? undefined : hkdToMinor(val("maxHKD")), scope: val("scope") } },
      } })
    } catch (e) { setError(String(e)); void refresh(task.taskId).catch(() => {}) } finally { setBusy(false) }
  }
  async function chat() {
    if (!task || !message.trim()) return
    setChatBusy(true); setError("")
    const outgoing = message
    try {
      await send({ path: "messages", body: { requestId: crypto.randomUUID(), taskId: task.taskId, expectedVersion: task.requirementVersion, message: outgoing } })
      setMessage(current => current === outgoing ? "" : current)
      await refresh(task.taskId)
    } catch (e) { setError(String(e)); void refresh(task.taskId).catch(() => {}) }
    finally { setChatBusy(false) }
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
    <p>自然语言对话使用真实模型理解需求；结构化表单可单独调试和修正。ShoppingStub 仍为 development_mock，未核验真实商品。</p>
    <p>仅供本地开发；任务和会话保存于 SQLite。沙盒购买需单独准备方案并明确许可；正式授权和真实购买未接入。</p>
    <Button onClick={start} disabled={busy}>开始新任务</Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {model && <p>模型 {model.model}：{({ missing_config: "未配置：请在服务端 .env.local 填写 LLM_API_KEY 并重启", untested: "已配置，尚未验证连接", connected: "最近一次真实模型请求连接成功", error: "最近一次真实模型请求失败" })[model.state]}{model.checkedAt ? `（${model.checkedAt}）` : ""}{model.code ? ` · ${model.code}` : ""}</p>}
    {task && <>
      <Card><CardHeader><CardTitle>自然语言对话模式</CardTitle></CardHeader><CardContent className="space-y-3">
        <p>模型仅理解需求；澄清和结果回复由服务端根据任务事实生成。请勿输入密钥或支付信息。</p>
        <ol aria-label="对话消息" className="space-y-3">{(task.messages ?? []).map(m => <li key={`${m.requestId}-${m.role}`} className="whitespace-pre-wrap rounded border p-3">
          <strong>{m.role === "user" ? "你" : "助手"}：</strong>{m.content}{m.errorCode && <p role="alert" className="text-destructive">{m.errorCode}</p>}
        </li>)}</ol>
        <form onSubmit={event => { event.preventDefault(); void chat() }} className="space-y-2">
          <label>消息<Input value={message} onChange={e => setMessage(e.target.value)} maxLength={2000} placeholder="例如：帮我看看粉底，或预算改成 180，其他不变" /></label>
          <Button type="submit" disabled={busy || chatBusy || !message.trim()}>{chatBusy ? "正在理解需求…" : "发送消息"}</Button>
        </form>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>结构化表单模式（调试与修正）</CardTitle></CardHeader><CardContent>
        <form onSubmit={event => { event.preventDefault(); void save(new FormData(event.currentTarget)) }} className="grid gap-4 sm:grid-cols-2" key={`${task.taskId}-${task.requirementVersion}`}>
          <label>意图<select name="intent" className="block w-full rounded border p-2" defaultValue={task.intent}><option value="unclear">尚未明确</option><option value="compare">比较方案</option><option value="purchase">购买任务（沙盒需单独许可）</option></select></label>
          <label>类别<Input name="category" defaultValue={task.requirementDraft.category ?? ""} placeholder="例如：化妆品" /></label>
          <label className="sm:col-span-2">商品与规格<Input name="query" defaultValue={task.requirementDraft.query ?? ""} placeholder="商品名称或类别；其他条件按需补充" /></label>
          <label>币种<select name="currency" defaultValue={task.requirementDraft.currency ?? ""} className="block w-full rounded border p-2"><option value="">请选择</option><option value="HKD">HKD</option></select></label>
          <label>预算上限（HKD 元）<Input name="maxHKD" type="number" min="0.01" step="0.01" defaultValue={task.requirementDraft.budget?.maxMinor ? minorToHKD(task.requirementDraft.budget.maxMinor) : ""} /></label>
          <label>预算口径<select name="scope" defaultValue={task.requirementDraft.budget?.scope ?? ""} className="block w-full rounded border p-2"><option value="">请选择</option><option value="item">商品金额</option><option value="delivered">含运费总额</option></select></label>
          <label>数量<Input name="quantity" defaultValue={task.requirementDraft.quantity ?? ""} type="number" min="1" max="100" step="1" /></label>
          <label>配送地区<Input name="destination" defaultValue={task.requirementDraft.destination ?? ""} placeholder="例如：香港" /></label>
          <Button type="submit" disabled={busy}>保存需求并校验</Button>
        </form>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>任务状态：{task.status}</CardTitle></CardHeader><CardContent className="space-y-3">
        <p>任务 {task.taskId} · 需求版本 v{task.requirementVersion} · 意图 {task.intent}</p>
        <p>{task.intent === "purchase" ? "返回搜索方案不代表已下单；沙盒购买状态在独立面板中展示。" : "当前任务仅展示方案，不创建购买或支付。"}</p>
        <Button onClick={run} disabled={busy || !["ready_to_search", "failed"].includes(task.status)}>运行 ShoppingStub</Button>
        {lastCommand && <Button variant="outline" className="ml-2" disabled={busy} onClick={() => {
          setError(""); void send(lastCommand).catch(e => setError(String(e)))
        }}>重发上次请求（相同 requestId）</Button>}
        <h2 className="font-semibold">缺失字段与澄清问题</h2>
        <p>{task.missingFields.join("、") || "无缺失字段"}</p>
        <ul>{task.clarificationQuestions.map(q => <li key={q}>{q}</li>)}</ul>
        <h2 className="font-semibold">当前需求草稿</h2><pre className="overflow-auto text-sm">{JSON.stringify({ ...task.requirementDraft, budget: task.requirementDraft.budget ? { maxHKD: task.requirementDraft.budget.maxMinor ? minorToHKD(task.requirementDraft.budget.maxMinor) : null, scope: task.requirementDraft.budget.scope } : undefined }, null, 2)}</pre>
        <h2 className="font-semibold">硬条件（只读）</h2>
        <pre className="overflow-auto text-sm">{JSON.stringify(task.requirementDraft.hardConstraints ?? [], null, 2)}</pre>
        <h2 className="font-semibold">偏好及相对权重（只读）</h2>
        <pre className="overflow-auto text-sm">{JSON.stringify(task.requirementDraft.preferences ?? [], null, 2)}</pre>
        <p>预算 {task.requirementDraft.budget?.maxMinor ? `${minorToHKD(task.requirementDraft.budget.maxMinor)} HKD` : "未指定"} · {task.requirementDraft.budget?.scope === "delivered" ? "含运费总额" : "商品金额"} · 数量 {task.requirementDraft.quantity ?? "未指定"} · 配送 {task.requirementDraft.destination ?? "未指定"}</p>
        <p>条件可通过聊天修改；此表单保存其他字段时保留条件。Stub 不判断真实商品是否满足条件，文本匹配不证明功效。</p>
        <h2 className="font-semibold">实际传给 ShoppingPort 的请求（港仙；无对话或凭据）</h2>
        <pre className="overflow-auto text-sm">{task.shoppingRequest ? JSON.stringify(task.shoppingRequest, null, 2) : "当前版本尚未发送请求"}</pre>
        <h2 className="font-semibold">ShoppingStub 结果（开发模拟 / 未核验）</h2>
        <pre className="overflow-auto whitespace-pre-wrap text-sm">{task.shoppingResult ? JSON.stringify(task.shoppingResult, null, 2) : "尚无当前版本结果"}</pre>
      </CardContent></Card>
      <AgentPurchaseDebug key={`${task.taskId}-${task.requirementVersion}`} task={task}/>
      <Card><CardHeader><CardTitle>事件时间线</CardTitle></CardHeader><CardContent><ol className="space-y-2 text-sm">{task.events.map(e => <li key={e.sequence}>{e.at} · v{e.requirementVersion} · {e.type} · {e.detail}</li>)}</ol></CardContent></Card>
    </>}
  </main>
}
