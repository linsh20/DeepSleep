import type { Constraint, Preference } from "../../types/index"
import { TaskError } from "./types"

// Request-side allowlist, never object paths. Shopping must implement these semantics separately.
const textFields = ["attributes.brand", "attributes.series", "attributes.productName", "attributes.shade", "attributes.packageType", "offer.stock"]
export const conditionFields = [...textFields, "attributes.volumeMl", "quote.estimatedDeliveryAtMs", "offer.deliverable", "text.searchable"]
function fail(message = "条件字段、操作符或值不受支持"): never { throw new TaskError("INVALID_CONDITION", message) }
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail()
  return v as Record<string, unknown>
}
function allowed(v: Record<string, unknown>, names: string[]) { if (Object.keys(v).some(k => !names.includes(k))) fail() }
function text(v: unknown): v is string { return typeof v === "string" && v.trim().length > 0 && v.length <= 300 }
export function stringList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 50 || !v.every(text)) fail()
  return [...new Set(v)]
}
function identity(v: unknown) {
  if (v === undefined) return {}
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(v)) fail("条件 id 格式无效")
  return { id: v }
}
export function constraintValue(value: unknown): Constraint {
  const c = record(value); allowed(c, ["id", "field", "op", "value"])
  const field = c.field, op = c.op, v = c.value
  if (typeof field !== "string" || !conditionFields.includes(field)) fail()
  let valid = false
  if (field === "text.searchable") valid = (op === "containsAny" || op === "notContainsAny") && Array.isArray(v) && v.length > 0 && stringList(v).length > 0
  else if (field === "attributes.volumeMl" || field === "quote.estimatedDeliveryAtMs") valid = ["eq", "gte", "lte"].includes(String(op)) && typeof v === "number" && Number.isFinite(v) && v > 0 && (field !== "quote.estimatedDeliveryAtMs" || Number.isSafeInteger(v))
  else if (field === "offer.deliverable") valid = op === "eq" && typeof v === "boolean"
  else valid = op === "eq" ? text(v) : (op === "in" || op === "notIn") && Array.isArray(v) && v.length > 0 && stringList(v).length > 0
  if (!valid) fail()
  const values = Array.isArray(v) ? stringList(v) : [v]
  if (field === "attributes.packageType" && values.some(x => !["regular", "refill", "sample", "set"].includes(String(x)))) fail()
  if (field === "offer.stock" && values.some(x => !["available", "unavailable"].includes(String(x)))) fail()
  return { ...identity(c.id), field, op: op as Constraint["op"], value: Array.isArray(v) ? stringList(v) : v as Constraint["value"] }
}
export function constraintsValue(value: unknown): Constraint[] {
  if (!Array.isArray(value) || value.length > 50) fail()
  const list = value.map(constraintValue)
  const ids = list.flatMap(c => c.id ? [c.id] : [])
  if (new Set(ids).size !== ids.length) fail("条件 id 重复")
  // Stable order prevents harmless model reordering from creating another search.
  return [...new Map(list.map(c => [JSON.stringify(c), c])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
export function preferencesValue(value: unknown): Preference[] {
  if (!Array.isArray(value) || value.length > 30) fail()
  const list = value.map(raw => {
    const p = record(raw); allowed(p, ["id", "field", "weight", "source", "conditions"])
    if (typeof p.field !== "string" || !conditionFields.includes(p.field) || typeof p.weight !== "number" || !Number.isFinite(p.weight) || p.weight <= 0 || !["explicit", "inferred"].includes(String(p.source))) fail()
    if (!Array.isArray(p.conditions) || !p.conditions.length) fail("主 Agent 的偏好需要明确 conditions；旧偏好须适配后使用")
    const conditions = constraintsValue(p.conditions)
    if (conditions.some(c => c.field !== p.field)) fail("偏好目标字段须与 conditions 一致")
    checkConflicts(conditions)
    return { ...identity(p.id), field: p.field, weight: p.weight, source: p.source as Preference["source"], conditions }
  })
  const ids = list.flatMap(p => p.id ? [p.id] : [])
  if (new Set(ids).size !== ids.length) fail("偏好 id 重复")
  return list.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
const norm = (v: unknown) => typeof v === "string" ? v.normalize("NFKC").toLowerCase() : v
export function checkConflicts(list: Constraint[]) {
  for (const field of conditionFields) {
    const cs = list.filter(c => c.field === field)
    const nums = cs.filter(c => typeof c.value === "number")
    const low = Math.max(-Infinity, ...nums.filter(c => c.op !== "lte").map(c => Number(c.value)))
    const high = Math.min(Infinity, ...nums.filter(c => c.op !== "gte").map(c => Number(c.value)))
    let conflict = low > high
    const eqs = cs.filter(c => c.op === "eq").map(c => norm(c.value))
    if (new Set(eqs).size > 1) conflict = true
    const ins = cs.filter(c => c.op === "in").map(c => (c.value as string[]).map(norm))
    const excluded = cs.filter(c => c.op === "notIn" || c.op === "notContainsAny").flatMap(c => (c.value as string[]).map(norm))
    const candidates = eqs.length ? eqs : ins[0]
    if (candidates && !candidates.some(v => ins.every(xs => xs.includes(v)) && !excluded.includes(v))) conflict = true
    if (cs.filter(c => c.op === "containsAny").some(c => (c.value as string[]).every(v => excluded.includes(norm(v))))) conflict = true
    if (conflict) throw new TaskError("CONDITION_CONFLICT", `${field} 条件相互矛盾，请修正范围或互斥条件；已有需求未修改`)
  }
}
// Internal model patch: replace a selected field group (volume bounds together), or one stable id.
// Empty replacement explicitly removes that target. Other groups always survive.
export function editConditions(current: unknown[], changes: unknown, preference: boolean): unknown[] {
  if (!Array.isArray(changes) || changes.length > 30) fail()
  let output = [...current]
  const targets = new Set<string>()
  for (const raw of changes) {
    const edit = record(raw); allowed(edit, ["field", "id", "replace"])
    if (typeof edit.field !== "string" || !conditionFields.includes(edit.field)) fail()
    identity(edit.id)
    const target = `${edit.field}:${edit.id ?? "*"}`
    if (targets.has(target)) fail("同一目标不能重复修改")
    targets.add(target)
    const replacements = preference ? preferencesValue(edit.replace) : constraintsValue(edit.replace)
    if (replacements.some(c => c.field !== edit.field || (edit.id !== undefined && c.id !== edit.id))) fail()
    output = output.filter(raw => { const c = record(raw); return !(c.field === edit.field && (edit.id === undefined || c.id === edit.id)) }).concat(replacements)
  }
  return output
}
// A hard target supersedes an identical soft target, not unrelated preferences.
export function withoutPromotedPreferences(hard: Constraint[], prefs: Preference[]) {
  return prefs.filter(p => !p.conditions?.every(c => hard.some(h => h.field === c.field && h.op === c.op && (
    JSON.stringify(h.value) === JSON.stringify(c.value) || (h.op === "containsAny" && Array.isArray(h.value) && Array.isArray(c.value) && h.value.every(v => (c.value as string[]).includes(v)))
  ))))
}
