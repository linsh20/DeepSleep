// One short, non-streaming request. Never prints credentials, headers or provider body.
import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
const env = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")) : {}
const key = env.LLM_API_KEY?.trim()
const endpoint = env.LLM_API_URL?.trim()
const model = env.LLM_MODEL?.trim()
const timeoutMs = Number(env.LLM_TIMEOUT_MS || 60000)
if (!key) {
  console.log("MODEL_NOT_CONFIGURED: 请在项目 .env.local 本地填写 LLM_API_KEY。未发送请求。")
  process.exitCode = 2
} else if (!endpoint || !model || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
  console.log("MODEL_CONFIG_INVALID: 请检查 LLM_API_URL、LLM_MODEL 和 LLM_TIMEOUT_MS。未发送请求。")
  process.exitCode = 2
} else {
  let connected = false
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "Reply only OK." }] }),
        })
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500
          await response.body?.cancel()
          if (retryable && attempt < 2) continue
          console.log(`MODEL_HTTP_ERROR: HTTP ${response.status}; 已尝试 ${attempt} 次。`)
          process.exitCode = 1
          break
        }
        const data = await response.json()
        const choice = data.choices?.[0]
        connected = choice?.finish_reason === "stop" && choice.message?.content?.trim() === "OK"
        console.log(connected ? `CONNECTED: ${new URL(endpoint).pathname}; requested configured model; non-streaming OK.` : "MODEL_INVALID_RESPONSE: 未通过短回复校验。")
        if (!connected) process.exitCode = 1
        break
      } catch {
        if (attempt === 2) throw new Error("connection failed")
      }
    }
  } catch { console.log("MODEL_CONNECTION_FAILED: 网络失败或超时；已尝试 2 次。请检查供应商和本地网络。"); process.exitCode = 1 }
}
