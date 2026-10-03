import type { Requirement } from "../../types/index"
import type { ShoppingPortResult } from "./shopping-port"

// Main-agent-only types. Canonical shared Requirement stays in types/index.ts.
export type TaskIntent = "compare" | "purchase" | "unclear"
export type RequirementDraft = Partial<Pick<Requirement, "category" | "query" | "currency" | "destination" | "hardConstraints" | "preferences" | "excludedProductIds" | "allowAlternativeProducts">> & {
  budget?: Partial<Requirement["budget"]>
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
  requirement: Requirement | null
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
