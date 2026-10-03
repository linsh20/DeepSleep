import type { Requirement } from "../../types/index"
import { TaskError } from "./types"
import type { Interpretation, RequirementDraft, TaskIntent } from "./types"

export interface RequirementInterpreter {
  interpret(input: {
    userMessage: string
    currentIntent?: TaskIntent
    currentDraft: RequirementDraft
    context: { role: "user" | "assistant"; content: string }[]
    developmentInput?: { intent: TaskIntent; requirementDraft: RequirementDraft }
  }, signal: AbortSignal): Promise<Interpretation>
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskError("INVALID_INPUT", "需要 JSON 对象")
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TaskError("INVALID_INPUT", "包含不支持的字段")
}
export function intentValue(value: unknown): TaskIntent {
  if (value !== "compare" && value !== "purchase" && value !== "unclear") throw new TaskError("INVALID_INPUT", "意图无效")
  return value
}
export function draftValue(value: unknown): RequirementDraft {
  const source = object(value)
  keys(source, ["category", "query", "currency", "destination", "budget", "quantity"])
  const draft: RequirementDraft = {}
  for (const key of ["category", "query", "currency", "destination"] as const) {
    const v = source[key]
    if (v === undefined || v === null || v === "") continue
    if (typeof v !== "string" || v.length > 1000) throw new TaskError("INVALID_INPUT", `${key} 格式无效`)
    if (v.trim()) draft[key] = v.trim()
  }
  if (draft.currency && draft.currency !== "HKD") throw new TaskError("INVALID_INPUT", "本轮开发输入只支持 HKD")
  if (source.quantity !== undefined && source.quantity !== null) {
    if (!Number.isSafeInteger(source.quantity) || Number(source.quantity) < 1 || Number(source.quantity) > 100) throw new TaskError("INVALID_INPUT", "数量须为 1–100 的整数")
    draft.quantity = Number(source.quantity)
  }
  if (source.budget !== undefined && source.budget !== null) {
    const b = object(source.budget)
    keys(b, ["maxMinor", "scope"])
    const budget: NonNullable<RequirementDraft["budget"]> = {}
    if (b.maxMinor !== undefined && b.maxMinor !== null) {
      if (!Number.isSafeInteger(b.maxMinor) || Number(b.maxMinor) <= 0) throw new TaskError("INVALID_INPUT", "预算须为正整数港仙")
      budget.maxMinor = Number(b.maxMinor)
    }
    if (b.scope !== undefined && b.scope !== null && b.scope !== "") {
      if (b.scope !== "item" && b.scope !== "delivered") throw new TaskError("INVALID_INPUT", "预算口径无效")
      budget.scope = b.scope
    }
    if (Object.keys(budget).length) draft.budget = budget
  }
  return draft
}
export function clarify(intent: TaskIntent, requirementDraft: RequirementDraft): Interpretation {
  const missingFields: string[] = []
  const clarificationQuestions: string[] = []
  const need = (field: string, complete: unknown, question: string) => {
    if (!complete) { missingFields.push(field); clarificationQuestions.push(question) }
  }
  need("intent", intent !== "unclear", "你希望比较方案，还是提出购买任务？本轮均不执行购买。")
  need("category", requirementDraft.category, "请填写商品类别。")
  need("query", requirementDraft.query, "请填写商品名称及所需品牌、色号、容量、正装或补充装。")
  need("currency", requirementDraft.currency, "请明确币种（本轮支持 HKD）。")
  need("budget.maxMinor", requirementDraft.budget?.maxMinor, "预算上限是多少港币（HKD 元）？")
  need("budget.scope", requirementDraft.budget?.scope, "预算是商品金额还是含运费总额？")
  need("quantity", requirementDraft.quantity, "需要多少件？")
  need("destination", requirementDraft.destination, "配送地区是什么？无需填写详细地址。")
  return { intent, requirementDraft, missingFields, clarificationQuestions }
}
export function completeRequirement(value: Interpretation, taskId: string, requirementVersion: number): Requirement | null {
  // Recompute completeness ourselves; neither interpreter nor browser controls readiness.
  const draft = draftValue(value.requirementDraft)
  if (clarify(intentValue(value.intent), draft).missingFields.length) return null
  if (!draft.category || !draft.query || !draft.currency || !draft.destination || !draft.budget?.maxMinor || !draft.budget.scope) return null
  return { taskId, requirementVersion, category: draft.category, query: draft.query,
    currency: draft.currency, destination: draft.destination,
    budget: { maxMinor: draft.budget.maxMinor, scope: draft.budget.scope },
    hardConstraints: [], preferences: [], excludedProductIds: [] }
}

// Explicit form adapter; no model, keyword inference, or canned model replies.
export class DevelopmentRequirementInterpreter implements RequirementInterpreter {
  async interpret(input: Parameters<RequirementInterpreter["interpret"]>[0]): Promise<Interpretation> {
    if (!input.developmentInput) throw new TaskError("MODEL_UNAVAILABLE", "模型尚未接入，请使用开发输入表单")
    return clarify(intentValue(input.developmentInput.intent), draftValue(input.developmentInput.requirementDraft))
  }
}
