// One short, non-streaming request. Never prints credentials, headers or provider body.
import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
const key = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")).LLM_API_KEY?.trim() : undefined
if (!key) {
  console.log("MODEL_NOT_CONFIGURED: 请在项目 .env.local 本地填写 LLM_API_KEY。未发送请求。")
  process.exitCode = 2
} else {
  try {
    const response = await fetch("https://api.bigbigapi.com/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-6.1-sol-plus", stream: false, messages: [{ role: "user", content: "Reply only OK." }] }),
    })
    if (!response.ok) { console.log(`MODEL_HTTP_ERROR: HTTP ${response.status}; 未重试或换模型。`); await response.body?.cancel(); process.exitCode = 1 }
    else {
      const data = await response.json()
      const choice = data.choices?.[0]
      const ok = choice?.finish_reason === "stop" && choice.message?.content?.trim() === "OK"
      console.log(ok ? "CONNECTED: Chat Completions /chat/completions; requested model gpt-6.1-sol-plus; non-streaming OK." : "MODEL_INVALID_RESPONSE: 未通过短回复校验。")
      if (!ok) process.exitCode = 1
    }
  } catch { console.log("MODEL_CONNECTION_FAILED: 网络失败或20秒超时；未重试。请检查供应商和本地网络。"); process.exitCode = 1 }
}
