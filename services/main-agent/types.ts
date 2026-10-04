import type { Requirement } from "../../types/index"
import type { ShoppingPortResult } from "./shopping-port"

export type TaskIntent = "compare" | "purchase" | "unclear"
// The conversational Main Agent uses HKD units. Downstream shopping/payment contracts
// retain integer minor units and receive an explicit conversion at the adapter boundary.
export type MainAgentRequirement = Omit<Requirement, "budget"> & {
  budget: { maxHKD: number; scope: Requirement["budget"]["scope"] }
}
export type RequirementDraft = Partial<Pick<MainAgentRequirement, "category" | "query" | "currency" | "destination" | "hardConstraints" | "preferences" | "excludedProductIds" | "allowAlternativeProducts">> & {
  budget?: Partial<MainAgentRequirement["budget"]>
  quantity?: number
}
export type TaskStatus = "needs_clarification" | "ready_to_search" | "shopping" | "result_ready" | "needs_verification" | "no_match" | "failed"
export type Interpretation = {
  intent: TaskIntent
  requirementDraft: RequirementDraft
  missingFields: string[]
  clarificationQuestions: string[]
}
export type MainTask = Interpretation & {
  taskId: string
  userId: string
  requirementVersion: number
  requirement: MainAgentRequirement | null
  status: TaskStatus
  shoppingResult: ShoppingPortResult | null
  shoppingHistory?: { requirementVersion: number; result: ShoppingPortResult; archivedAt: string }[]
  shoppingRequest?: import("./shopping-port").ShoppingPortInput | null
  conversationRevision?: number
  messages?: { requestId: string; role: "user" | "assistant"; content: string; at: string; errorCode?: string }[]
  events: { sequence: number; at: string; requirementVersion: number; type: string; detail: string }[]
}
const taskErrorBrand = Symbol.for("deepsleep.task-error")
export class TaskError extends Error {
  readonly [taskErrorBrand] = true
  // Next route bundles can load separate class identities while sharing the in-memory runtime.
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[taskErrorBrand] === true
  }
  constructor(public code: string, message: string, public httpStatus = 400) { super(message) }
}
