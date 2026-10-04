import { configuredShoppingPort, SHOPPING_TIMEOUT_MS } from "./shopping-adapter"
import { MainTaskOrchestrator } from "./orchestrator"
import { durableStore } from "./storage"
import { DevelopmentRequirementInterpreter } from "./requirement-interpreter"
import { ShoppingStub } from "./shopping-port"
import type { StubScenario } from "./shopping-port"
import { createBigBigTransport, ModelRequirementInterpreter } from "./model-interpreter"
import { createAgentHttp } from "./http"

const local = globalThis as typeof globalThis & { deepSleepMainModelV2?: { signature: string; transport: ReturnType<typeof createBigBigTransport> } }
export async function agentHttp(...args: Parameters<ReturnType<typeof createAgentHttp>>) {
  if (process.env.NODE_ENV !== "development") return Response.json({ error: { code: "DEVELOPMENT_ONLY" } }, { status: 404 })
  const store = durableStore()
  const scenario = process.env.MAIN_AGENT_STUB_SCENARIO ?? "plan"
  if (!["plan", "no_match", "needs_verification", "failure", "timeout", "delayed"].includes(scenario)) throw new Error("Invalid MAIN_AGENT_STUB_SCENARIO")
  const endpoint = process.env.LLM_API_URL?.trim()
  const modelId = process.env.LLM_MODEL?.trim()
  const modelTimeoutMs = process.env.LLM_TIMEOUT_MS?.trim() ? Number(process.env.LLM_TIMEOUT_MS) : 60000
  const signature = JSON.stringify([endpoint ?? "", modelId ?? ""])
  if (!local.deepSleepMainModelV2 || local.deepSleepMainModelV2.signature !== signature) {
    local.deepSleepMainModelV2 = { signature, transport: createBigBigTransport(() => process.env.LLM_API_KEY, fetch, { endpoint, model: modelId, maxAttempts: 2 }) }
  }
  const model = local.deepSleepMainModelV2.transport
  const stub = process.env.MAIN_AGENT_SHOPPING_MODE === "stub"
  const agent = new MainTaskOrchestrator(store.main, new DevelopmentRequirementInterpreter(), stub ? new ShoppingStub(scenario as StubScenario) : configuredShoppingPort(), { timeoutMs: SHOPPING_TIMEOUT_MS, retries: 0, modelInterpreter: new ModelRequirementInterpreter(model.complete), modelTimeoutMs })
  return createAgentHttp(agent, true, store.main.sessions, model.status)(...args)
}
