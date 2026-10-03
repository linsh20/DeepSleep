import { TaskError } from "../main-agent/types"
import { PurchaseError, ensure } from "../purchase-execution/types"
import type { PurchaseBridge } from "./service"
import type { SqliteTaskRepository } from "../main-agent/sqlite-repository"
export function bridgeHttp(bridge: PurchaseBridge, main: SqliteTaskRepository) {
  return async (request: Request, action: string) => {
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
    try {
      ensure(["prepare", "execute", "state", "recover"].includes(action), "NOT_FOUND", "接口不存在", 404)
      ensure(request.method === (action === "state" ? "GET" : "POST"), "METHOD_NOT_ALLOWED", "请求方法不支持", 405)
      const url = new URL(request.url)
      const token = request.headers.get("cookie")?.match(/(?:^|;\s*)deepsleep_demo=([a-f0-9-]+)(?:;|$)/)?.[1]
      ensure(token && main.sessions.has(token), "SESSION_REQUIRED", "请先建立主 Agent 会话", 401)
      const owner = main.owner(token)
      if (action === "state") {
        const taskId = url.searchParams.get("taskId")
        ensure(taskId, "INVALID_INPUT", "需要任务 ID")
        return json(bridge.state(taskId, owner))
      }
      ensure(request.headers.get("origin") === `${url.protocol}//${request.headers.get("host") ?? url.host}`, "FORBIDDEN", "需要同源请求", 403)
      ensure(request.headers.get("content-type")?.startsWith("application/json"), "INVALID_INPUT", "需要 JSON", 415)
      const reader = request.body?.getReader(); ensure(reader, "INVALID_INPUT", "缺少请求体")
      const chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw new PurchaseError("INVALID_INPUT", "请求过大", 413) }; chunks.push(value) } } finally { reader.releaseLock() }
      let body: Record<string, unknown>
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new PurchaseError("INVALID_INPUT", "JSON 无效") }
      const fields = action === "prepare" ? ["taskId", "expectedVersion", "requestId", "candidateId"] : action === "execute" ? ["taskId", "planId", "expectedVersion", "requestId", "testPermission"] : ["taskId", "planId", "requestId"]
      ensure(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(k => fields.includes(k)), "INVALID_INPUT", "包含不支持的字段")
      ensure(typeof body.taskId === "string" && typeof body.requestId === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(body.requestId), "INVALID_INPUT", "缺少 taskId 或 requestId")
      if (action === "prepare") { ensure(body.candidateId===undefined || typeof body.candidateId==="string" && body.candidateId.length<=600,"INVALID_INPUT","候选身份无效"); ensure(Number.isSafeInteger(body.expectedVersion), "INVALID_INPUT", "版本无效"); return json(await bridge.prepare(body.taskId, owner, { expectedVersion: body.expectedVersion as number, requestId: body.requestId, candidateId:body.candidateId as string|undefined })) }
      ensure(typeof body.planId === "string", "INVALID_INPUT", "需要 planId")
      if (action === "recover") return json(await bridge.recover(body.taskId, owner, body.planId))
      ensure(Number.isSafeInteger(body.expectedVersion) && body.testPermission === true, "TEST_PERMISSION_REQUIRED", "需要版本及明确的一次测试许可", 403)
      return json(await bridge.execute(body.taskId, owner, {planId: body.planId, expectedVersion: body.expectedVersion as number, requestId: body.requestId, testPermission: true}))
    } catch (e) {
      if (e instanceof PurchaseError) return json({ error: { code: e.code, message: e.message } }, e.status)
      if (e instanceof TaskError) return json({ error: { code: e.code, message: e.message } }, e.httpStatus)
      return json({ error: { code: "BRIDGE_UNAVAILABLE", message: "桥接请求未完成，请查询原任务和购买记录" } }, 500)
    }
  }
}
