import type { Requirement } from "../../types/index"
import type { ShoppingPortResult } from "./shopping-port"

// Main-agent-only types. Canonical shared Requirement stays in types/index.ts.
export type TaskIntent = "compare" | "purchase" | "unclear"
export type RequirementDraft = Partial<Pick<Requirement, "category" | "query" | "currency" | "destination">> & {
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
  events: { sequence: number; at: string; requirementVersion: number; type: string; detail: string }[]
}
export class TaskError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message) }
}
