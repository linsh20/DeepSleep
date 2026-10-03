import { MainTaskOrchestrator } from "./orchestrator"
import { durableStore } from "./storage"
import { DevelopmentRequirementInterpreter } from "./requirement-interpreter"
import { ShoppingStub } from "./shopping-port"
import type { StubScenario } from "./shopping-port"
import { createBigBigTransport, ModelRequirementInterpreter } from "./model-interpreter"
import { createAgentHttp } from "./http"

const local = globalThis as typeof globalThis & { deepSleepMainModel?: ReturnType<typeof createBigBigTransport> }
export async function agentHttp(...args: Parameters<ReturnType<typeof createAgentHttp>>) {
  if (process.env.NODE_ENV !== "development") return Response.json({ error: { code: "DEVELOPMENT_ONLY" } }, { status: 404 })
  const store = durableStore()
  const scenario = process.env.MAIN_AGENT_STUB_SCENARIO ?? "plan"
  if (!["plan", "no_match", "needs_verification", "failure", "timeout", "delayed"].includes(scenario)) throw new Error("Invalid MAIN_AGENT_STUB_SCENARIO")
  const model = local.deepSleepMainModel ??= createBigBigTransport(() => process.env.LLM_API_KEY)
  const agent = new MainTaskOrchestrator(store.main, new DevelopmentRequirementInterpreter(), new ShoppingStub(scenario as StubScenario), { modelInterpreter: new ModelRequirementInterpreter(model.complete) })
  return createAgentHttp(agent, true, store.main.sessions, model.status)(...args)
}
