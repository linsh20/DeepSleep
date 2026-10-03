import type { Fact, Requirement, SearchErrorCode } from "../../types/index"

// Proposed integration envelope, separate from MainTask. Reuses canonical Requirement/Fact.
// No adapter to services/shopping-agent.ts is installed in this iteration.
export type ShoppingPortInput = { requirement: Requirement; quantity: number }
export type ShoppingPortResult = {
  taskId: string
  requirementVersion: number
  dataEnvironment: "development_mock"
} & (
  | { status: "result_ready"; plan: { title: string; notice: string; priceMinor: Fact<number> } }
  | { status: "no_match"; reason: string }
  | { status: "needs_verification"; missingFacts: string[] }
  | { status: "failed"; error: { code: SearchErrorCode; retryable: boolean } }
)
export interface ShoppingPort {
  search(input: ShoppingPortInput, signal: AbortSignal): Promise<ShoppingPortResult>
}
export type StubScenario = "plan" | "no_match" | "needs_verification" | "failure" | "timeout" | "delayed"
export class ShoppingStub implements ShoppingPort {
  constructor(private scenario: StubScenario = "plan", private delayMs = 1500) {}
  async search({ requirement }: ShoppingPortInput, signal: AbortSignal): Promise<ShoppingPortResult> {
    const base = { taskId: requirement.taskId, requirementVersion: requirement.requirementVersion, dataEnvironment: "development_mock" as const }
    if (this.scenario === "timeout" || this.scenario === "delayed") {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error("aborted")) }
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, this.scenario === "timeout" ? 60000 : this.delayMs)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
    }
    switch (this.scenario) {
      case "no_match": return { ...base, status: "no_match", reason: "开发模拟：没有符合条件的方案" }
      case "needs_verification": return { ...base, status: "needs_verification", missingFacts: ["offer.shippingMinor", "offer.stock"] }
      case "failure": return { ...base, status: "failed", error: { code: "SOURCE_UNAVAILABLE", retryable: true } }
      default: return { ...base, status: "result_ready", plan: {
        title: `开发模拟方案：${requirement.query}`,
        notice: "仅代表 Stub 流程成功；商品、价格、库存与配送均未核验，不可据此购买。",
        priceMinor: { value: null, source: "mock-dataset", fetchedAt: new Date().toISOString(), status: "mock" },
      } }
    }
  }
}
