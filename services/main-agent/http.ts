import { randomUUID } from "node:crypto"
import { TaskError } from "./types"
import { draftValue, intentValue, keys, object } from "./requirement-interpreter"
import type { ModelConnection } from "./model-interpreter"
import type { MainTaskOrchestrator } from "./orchestrator"

export function createAgentHttp(agent: MainTaskOrchestrator, enabled: boolean, sessions: { has(id: string): boolean; add(id: string): unknown; owner?(id: string): string } = new Set<string>(), modelStatus?: () => ModelConnection) {
  // Opaque server-issued demo sessions; not authentication for a deployed product.
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } })
  async function body(request: Request) {
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new TaskError("INVALID_INPUT", "需要 application/json", 415)
    const reader = request.body?.getReader()
    if (!reader) throw new TaskError("INVALID_INPUT", "缺少请求体")
    let size = 0, raw = ""
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 16384) { await reader.cancel(); throw new TaskError("INVALID_INPUT", "请求体过大", 413) }
        raw += decoder.decode(value, { stream: true })
      }
      raw += decoder.decode()
      return object(JSON.parse(raw))
    } catch (error) {
      if (error instanceof TaskError) throw error
      throw new TaskError("INVALID_INPUT", "JSON 格式无效")
    } finally { reader.releaseLock() }
  }
  return async function handle(request: Request, action: "session" | "create" | "get" | "save" | "search" | "message" | "model", taskId?: string) {
    try {
      if (!enabled) return json({ error: { code: "DEVELOPMENT_ONLY", message: "主 Agent 调试接口仅在开发环境开放" } }, 404)
      if (request.method !== ((action === "get" || action === "model") ? "GET" : "POST")) throw new TaskError("METHOD_NOT_ALLOWED", "请求方法不支持", 405)
      if (request.method === "POST" && request.headers.get("origin") !== `${new URL(request.url).protocol}//${request.headers.get("host") ?? new URL(request.url).host}`) throw new TaskError("FORBIDDEN", "需要同源请求", 403)
      const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)deepsleep_demo=([a-f0-9-]+)/)?.[1]
      const sessionId = cookie && sessions.has(cookie) ? cookie : undefined
      const userId = sessionId ? (sessions.owner?.(sessionId) ?? sessionId) : undefined
      if (action === "session") {
        keys(await body(request), [])
        const id = sessionId ?? randomUUID()
        sessions.add(id)
        return json({ mode: "model_with_development_form", storage: sessions.owner ? "sqlite" : "memory", purchaseExecution: "explicit_sandbox_only" }, 200, {
          "Set-Cookie": `deepsleep_demo=${id}; Path=/api/agent; HttpOnly; SameSite=Strict; Max-Age=2592000${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
        })
      }
      if (!userId) throw new TaskError("SESSION_REQUIRED", "请先建立演示会话", 401)
      if (action === "model") return json({ model: modelStatus?.() ?? { state: "missing_config", model: "gpt-6.1-sol-plus" } })
      if (action === "get") return json({ task: agent.get(taskId!, userId) })
      const input = await body(request)
      if (typeof input.requestId !== "string") throw new TaskError("INVALID_INPUT", "缺少 requestId")
      if (action === "message") {
        keys(input, ["requestId", "taskId", "expectedVersion", "message"])
        if (typeof input.taskId !== "string") throw new TaskError("INVALID_INPUT", "缺少 taskId")
        return json({ task: await agent.message(input.taskId, userId, { requestId: input.requestId, expectedVersion: input.expectedVersion as number, message: input.message as string }) })
      }
      if (action === "create") {
        keys(input, ["requestId"])
        return json({ task: await agent.create(userId, input.requestId) })
      }
      if (action === "search") {
        keys(input, ["requestId", "expectedVersion"])
        return json({ task: await agent.search(taskId!, userId, input.requestId, input.expectedVersion as number) })
      }
      keys(input, ["requestId", "expectedVersion", "intent", "requirementDraft", "userMessage"])
      return json({ task: await agent.save(taskId!, userId, {
        requestId: input.requestId, expectedVersion: input.expectedVersion as number,
        intent: intentValue(input.intent), requirementDraft: draftValue(input.requirementDraft), userMessage: input.userMessage as string | undefined,
      }) })
    } catch (error) {
      if (error instanceof TaskError) return json({ error: { code: error.code, message: error.message } }, error.httpStatus)
      return json({ error: { code: "INTERNAL_ERROR", message: "任务处理失败，请刷新当前任务" } }, 500)
    }
  }
}
