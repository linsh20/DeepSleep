import type { PurchaseExecutionService } from "./service"
import type { SqlitePurchaseRepository } from "./repository"
import { PurchaseError, ensure } from "./types"
async function rawBody(request: Request, limit: number) {
  const reader = request.body?.getReader()
  ensure(reader, "INVALID_INPUT", "缺少请求体")
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new PurchaseError("INPUT_TOO_LARGE", "请求体过大", 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString("utf8")
}
function only(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)), "INVALID_INPUT", "请求含不支持字段")
}
export function createPurchaseHttp(service: PurchaseExecutionService, repo: SqlitePurchaseRepository, enabled: boolean) {
  const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(value, { status, headers: { "Cache-Control": "no-store", ...extra } })
  return async (request: Request, action: string) => {
    try {
      ensure(enabled, "DEVELOPMENT_ONLY", "沙盒入口仅限本地开发", 404)
      ensure(["session", "fixture", "state", "execute", "reconcile", "webhook"].includes(action), "NOT_FOUND", "接口不存在", 404)
      ensure(request.method === (action === "state" ? "GET" : "POST"), "METHOD_NOT_ALLOWED", "方法不支持", 405)
      if (action === "webhook") return json(await service.webhook(await rawBody(request, 131072), request.headers.get("stripe-signature") ?? ""))
      const url = new URL(request.url)
      if (request.method === "POST") ensure(request.headers.get("origin") === `${url.protocol}//${request.headers.get("host") ?? url.host}`, "FORBIDDEN", "需要同源请求", 403)
      const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)deepsleep_sandbox=([a-f0-9-]{72})(?:;|$)/)?.[1]
      const session = repo.session(cookie)
      if (action === "state") {
        ensure(session, "SESSION_REQUIRED", "请建立沙盒演示会话", 401)
        const id = url.searchParams.get("planId")
        return json(id ? { view: service.get(id, session.owner) } : { views: service.list(session.owner) })
      }
      ensure(request.headers.get("content-type")?.startsWith("application/json"), "INVALID_INPUT", "需要 JSON 请求", 415)
      let body: unknown
      try { body = JSON.parse(await rawBody(request, 8192)) } catch (e) { if (e instanceof PurchaseError) throw e; throw new PurchaseError("INVALID_INPUT", "JSON 格式错误") }
      if (action === "session") {
        only(body, [])
        const next = session ?? repo.newSession()
        return json({ mode: "sandbox_only" }, 200, { "Set-Cookie": `deepsleep_sandbox=${next.token}; Path=/api/sandbox-purchase; HttpOnly; SameSite=Strict; Max-Age=2592000${url.protocol === "https:" ? "; Secure" : ""}` })
      }
      ensure(session, "SESSION_REQUIRED", "请建立沙盒演示会话", 401)
      only(body, action === "fixture" ? ["requestId"] : action === "execute" ? ["requestId", "planId", "expectedVersion", "testPermission"] : ["planId"])
      if (action === "fixture") {
        ensure(typeof body.requestId === "string", "INVALID_INPUT", "缺少 requestId")
        return json({ view: await service.createFixture(session.owner, body.requestId) })
      }
      ensure(typeof body.planId === "string" && body.planId.length <= 100, "INVALID_INPUT", "需要方案 ID")
      if (action === "reconcile") return json({ view: await service.reconcile(body.planId, session.owner) })
      ensure(typeof body.requestId === "string" && Number.isSafeInteger(body.expectedVersion), "INVALID_INPUT", "需要 requestId 和版本")
      return json({ view: await service.execute(session.owner, { planId: body.planId, expectedVersion: body.expectedVersion as number, requestId: body.requestId, testPermission: body.testPermission === true }) })
    } catch (e) {
      if (e instanceof PurchaseError) return json({ error: { code: e.code, message: e.message } }, e.status)
      return json({ error: { code: "PURCHASE_UNAVAILABLE", message: "购买操作不可用；请查询原操作，不创建新操作替代未知结果" } }, 500)
    }
  }
}
