import { MainTaskOrchestrator } from "./orchestrator"
import { MemoryTaskRepository } from "./task-repository"
import { DevelopmentRequirementInterpreter } from "./requirement-interpreter"
import { ShoppingStub } from "./shopping-port"
import type { StubScenario } from "./shopping-port"
import { createAgentHttp } from "./http"

// Share storage across route bundles in one local Node process; reconstruct handlers on reload.
const local = globalThis as typeof globalThis & {
  deepSleepMainAgentStore?: { repository: MemoryTaskRepository; sessions: Set<string> }
}
const store = local.deepSleepMainAgentStore ??= { repository: new MemoryTaskRepository(), sessions: new Set<string>() }
const scenario = process.env.MAIN_AGENT_STUB_SCENARIO ?? "plan"
if (!["plan", "no_match", "needs_verification", "failure", "timeout", "delayed"].includes(scenario)) throw new Error("Invalid MAIN_AGENT_STUB_SCENARIO")
const agent = new MainTaskOrchestrator(store.repository, new DevelopmentRequirementInterpreter(), new ShoppingStub(scenario as StubScenario))
export const agentHttp = createAgentHttp(agent, process.env.NODE_ENV === "development", store.sessions)
