import type {
  AgentError,
  Authorization,
  Candidate,
  CheckPurchaseInput,
  Constraint,
  EvaluateCandidatesInput,
  EvaluationRecommendation,
  EvaluationResult,
  Fact,
  PurchaseCheck,
  Requirement,
  VerificationRequest,
} from "../../types/index.ts"

export type FieldPolicy = {
  direction: "min" | "max"
  label: string
}

export type AgentBPolicy = {
  offerTtlMs: number
  catalogFactTtlMs: number
  purchaseOfferTtlMs: number
  maxRecommendations: number
  fieldPolicies: Record<string, FieldPolicy>
}

export type EvaluateOptions = Partial<
  Omit<AgentBPolicy, "fieldPolicies">
> & {
  now?: () => Date
  fieldPolicies?: Record<string, FieldPolicy>
}

export type PurchaseCheckContext = {
  getAuthorizationById: (
    authorizationId: string,
  ) => Promise<Authorization | null>
  now?: () => Date
  purchaseOfferTtlMs?: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

export const DEFAULT_FIELD_POLICIES: Readonly<Record<string, FieldPolicy>> = {
  totalPrice: { direction: "min", label: "性价比" },
  deliveredTotalMinor: { direction: "min", label: "性价比" },
  netItemPriceMinor: { direction: "min", label: "价格" },
  itemPriceMinor: { direction: "min", label: "价格" },
  shippingMinor: { direction: "min", label: "配送成本" },
  weightGrams: { direction: "min", label: "便携" },
  performanceScore: { direction: "max", label: "性能" },
  ramGB: { direction: "max", label: "内存" },
  storageGB: { direction: "max", label: "存储" },
  batteryLifeHours: { direction: "max", label: "续航" },
  rating: { direction: "max", label: "口碑" },
}

export const DEFAULT_AGENT_B_POLICY: Readonly<AgentBPolicy> = {
  offerTtlMs: 5 * MINUTE_MS,
  catalogFactTtlMs: 24 * HOUR_MS,
  purchaseOfferTtlMs: MINUTE_MS,
  maxRecommendations: 3,
  fieldPolicies: DEFAULT_FIELD_POLICIES,
}

export class AgentBValidationError extends Error {
  readonly error: AgentError

  constructor(message: string, details: string[]) {
    super(message)
    this.name = "AgentBValidationError"
    this.error = {
      code: "INVALID_INPUT",
      message,
      retryable: false,
      details,
    }
  }
}

type ResolvedField =
  | {
      state: "known"
      value: number | string | boolean
      evidenceFields: string[]
    }
  | {
      state: "unknown"
      fields: string[]
      reason: string
    }

type ScoredCandidate = {
  candidate: Candidate
  score: number
  satisfied: string[]
  tradeoffs: string[]
  evidenceFields: string[]
  preferenceValues: Map<string, number>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}

function pushIf(
  issues: string[],
  condition: boolean,
  message: string,
): void {
  if (condition) issues.push(message)
}

function validateFact(
  value: unknown,
  path: string,
  issues: string[],
  allowedValue: (factValue: unknown) => boolean,
): void {
  if (!isRecord(value)) {
    issues.push(`${path} 必须是 Fact 对象`)
    return
  }

  pushIf(
    issues,
    value.value !== null && !allowedValue(value.value),
    `${path}.value 类型无效`,
  )
  // A failed lookup has no observed provenance; it is valid only for an unknown fact.
  const unknownPlaceholder = value.value === null && value.status === "unverified" &&
    value.source === "" && value.fetchedAt === ""
  pushIf(issues, !unknownPlaceholder && !isNonEmptyString(value.source), `${path}.source 不能为空`)
  pushIf(issues, !unknownPlaceholder && !isIsoDate(value.fetchedAt), `${path}.fetchedAt 必须是 ISO 时间`)
  pushIf(
    issues,
    !["verified", "unverified", "mock"].includes(String(value.status)),
    `${path}.status 无效`,
  )
}

export function assertRequirement(value: unknown): asserts value is Requirement {
  const issues: string[] = []
  if (!isRecord(value)) {
    throw new AgentBValidationError("购物需求输入无效", ["requirement 必须是对象"])
  }

  pushIf(issues, !isNonEmptyString(value.taskId), "taskId 不能为空")
  pushIf(
    issues,
    !Number.isSafeInteger(value.requirementVersion) || Number(value.requirementVersion) < 0,
    "requirementVersion 必须是非负安全整数",
  )
  pushIf(issues, !isNonEmptyString(value.category), "category 不能为空")
  pushIf(issues, !isNonEmptyString(value.query), "query 不能为空")
  pushIf(issues, !isNonEmptyString(value.currency), "currency 不能为空")

  if (!isRecord(value.budget)) {
    issues.push("budget 必须是对象")
  } else {
    pushIf(
      issues,
      !Number.isSafeInteger(value.budget.maxMinor) || Number(value.budget.maxMinor) < 0,
      "budget.maxMinor 必须是非负安全整数",
    )
    pushIf(
      issues,
      value.budget.scope !== "item" && value.budget.scope !== "delivered",
      "budget.scope 必须是 item 或 delivered",
    )
  }

  if (!Array.isArray(value.hardConstraints)) {
    issues.push("hardConstraints 必须是数组")
  } else {
    value.hardConstraints.forEach((constraint, index) => {
      const path = `hardConstraints[${index}]`
      if (!isRecord(constraint)) {
        issues.push(`${path} 必须是对象`)
        return
      }
      pushIf(issues, !isNonEmptyString(constraint.field), `${path}.field 不能为空`)
      pushIf(
        issues,
        !["lte", "gte", "eq", "in", "notIn"].includes(String(constraint.op)),
        `${path}.op 无效`,
      )
      const constraintValue = constraint.value
      const scalar =
        typeof constraintValue === "number" ||
        typeof constraintValue === "string" ||
        typeof constraintValue === "boolean"
      const stringArray =
        Array.isArray(constraintValue) &&
        constraintValue.every((item) => typeof item === "string")
      pushIf(issues, !scalar && !stringArray, `${path}.value 类型无效`)
      if (constraint.op === "in" || constraint.op === "notIn") {
        pushIf(issues, !stringArray, `${path}.value 在 ${constraint.op} 操作下必须是字符串数组`)
      }
    })
  }

  if (!Array.isArray(value.preferences)) {
    issues.push("preferences 必须是数组")
  } else {
    let totalWeight = 0
    value.preferences.forEach((preference, index) => {
      const path = `preferences[${index}]`
      if (!isRecord(preference)) {
        issues.push(`${path} 必须是对象`)
        return
      }
      pushIf(issues, !isNonEmptyString(preference.field), `${path}.field 不能为空`)
      pushIf(
        issues,
        !isFiniteNonNegativeNumber(preference.weight),
        `${path}.weight 必须是非负有限数`,
      )
      if (isFiniteNonNegativeNumber(preference.weight)) totalWeight += preference.weight
      pushIf(
        issues,
        preference.source !== "explicit" && preference.source !== "inferred",
        `${path}.source 无效`,
      )
    })
    if (value.preferences.length > 0) {
      pushIf(
        issues,
        Math.abs(totalWeight - 1) > 1e-6,
        "preferences.weight 合计必须为 1",
      )
    }
  }

  if (!Array.isArray(value.excludedProductIds)) {
    issues.push("excludedProductIds 必须是数组")
  } else {
    pushIf(
      issues,
      !value.excludedProductIds.every(isNonEmptyString),
      "excludedProductIds 只能包含非空字符串",
    )
  }

  pushIf(
    issues,
    value.destination !== undefined && !isNonEmptyString(value.destination),
    "destination 存在时不能为空",
  )

  if (issues.length > 0) {
    throw new AgentBValidationError("购物需求输入无效", issues)
  }
}

export function assertCandidate(value: unknown, path = "candidate"): asserts value is Candidate {
  const issues: string[] = []
  if (!isRecord(value)) {
    throw new AgentBValidationError("候选商品输入无效", [`${path} 必须是对象`])
  }

  pushIf(issues, !isNonEmptyString(value.productId), `${path}.productId 不能为空`)
  pushIf(
    issues,
    value.skuId !== null && !isNonEmptyString(value.skuId),
    `${path}.skuId 必须是非空字符串或 null`,
  )
  pushIf(
    issues,
    value.offerId !== null && !isNonEmptyString(value.offerId),
    `${path}.offerId 必须是非空字符串或 null`,
  )
  pushIf(issues, !isNonEmptyString(value.title), `${path}.title 不能为空`)
  pushIf(issues, !isNonEmptyString(value.url), `${path}.url 不能为空`)

  if (!isRecord(value.attributes)) {
    issues.push(`${path}.attributes 必须是对象`)
  } else {
    Object.entries(value.attributes).forEach(([field, fact]) => {
      pushIf(issues, !isNonEmptyString(field), `${path}.attributes 字段名不能为空`)
      validateFact(
        fact,
        `${path}.attributes.${field}`,
        issues,
        (factValue) =>
          typeof factValue === "number" ||
          typeof factValue === "string" ||
          typeof factValue === "boolean",
      )
    })
  }

  if (value.offer !== null) {
    if (!isRecord(value.offer)) {
      issues.push(`${path}.offer 必须是对象或 null`)
    } else {
      pushIf(issues, !isNonEmptyString(value.offer.currency), `${path}.offer.currency 不能为空`)
      const moneyValue = (factValue: unknown) =>
        Number.isSafeInteger(factValue) && Number(factValue) >= 0
      validateFact(value.offer.itemPriceMinor, `${path}.offer.itemPriceMinor`, issues, moneyValue)
      validateFact(value.offer.shippingMinor, `${path}.offer.shippingMinor`, issues, moneyValue)
      validateFact(value.offer.discountMinor, `${path}.offer.discountMinor`, issues, moneyValue)
      validateFact(
        value.offer.stock,
        `${path}.offer.stock`,
        issues,
        (factValue) => factValue === "available" || factValue === "unavailable",
      )
      validateFact(
        value.offer.deliverable,
        `${path}.offer.deliverable`,
        issues,
        (factValue) => typeof factValue === "boolean",
      )
    }
  }

  if (!Array.isArray(value.missingFields) || !value.missingFields.every(isNonEmptyString)) {
    issues.push(`${path}.missingFields 必须是非空字符串数组`)
  }

  if (issues.length > 0) {
    throw new AgentBValidationError("候选商品输入无效", issues)
  }
}

export function assertAuthorization(
  value: unknown,
  path = "authorization",
): asserts value is Authorization {
  const issues: string[] = []
  if (!isRecord(value)) {
    throw new AgentBValidationError("购买授权输入无效", [`${path} 必须是对象`])
  }

  pushIf(issues, !isNonEmptyString(value.authorizationId), `${path}.authorizationId 不能为空`)
  pushIf(issues, !isNonEmptyString(value.allowedOfferId), `${path}.allowedOfferId 不能为空`)
  pushIf(
    issues,
    !Number.isSafeInteger(value.maxTotalMinor) || Number(value.maxTotalMinor) < 0,
    `${path}.maxTotalMinor 必须是非负安全整数`,
  )
  pushIf(
    issues,
    !Number.isSafeInteger(value.maxQuantity) || Number(value.maxQuantity) < 1,
    `${path}.maxQuantity 必须是正安全整数`,
  )
  pushIf(issues, !isNonEmptyString(value.currency), `${path}.currency 不能为空`)
  pushIf(issues, !isIsoDate(value.expiresAt), `${path}.expiresAt 必须是 ISO 时间`)

  if (issues.length > 0) {
    throw new AgentBValidationError("购买授权输入无效", issues)
  }
}

function validateCandidates(candidates: unknown): asserts candidates is Candidate[] {
  if (!Array.isArray(candidates)) {
    throw new AgentBValidationError("候选商品输入无效", ["candidates 必须是数组"])
  }
  candidates.forEach((candidate, index) => assertCandidate(candidate, `candidates[${index}]`))

  const identities = new Set<string>()
  const duplicates: string[] = []
  candidates.forEach((candidate) => {
    const identity = [candidate.productId, candidate.skuId ?? "", candidate.offerId ?? ""].join("::")
    if (identities.has(identity)) duplicates.push(identity)
    identities.add(identity)
  })
  if (duplicates.length > 0) {
    throw new AgentBValidationError("候选商品输入无效", [
      `candidates 含重复商品身份：${duplicates.join(", ")}`,
    ])
  }
}

function canonicalField(field: string): string {
  return field.replace(/^attributes\./, "").replace(/^offer\./, "")
}

function isDynamicOfferField(field: string): boolean {
  return [
    "totalPrice",
    "deliveredTotalMinor",
    "netItemPriceMinor",
    "itemPriceMinor",
    "shippingMinor",
    "discountMinor",
    "stock",
    "deliverable",
  ].includes(canonicalField(field))
}

function resolveFact<T extends number | string | boolean>(
  fact: Fact<T> | undefined,
  evidenceField: string,
  ttlMs: number,
  now: Date,
): ResolvedField {
  if (!fact || fact.value === null) {
    return {
      state: "unknown",
      fields: [evidenceField],
      reason: `${evidenceField} 缺失`,
    }
  }
  if (fact.status !== "verified") {
    return {
      state: "unknown",
      fields: [evidenceField],
      reason: `${evidenceField} 尚未核验`,
    }
  }

  const fetchedAt = Date.parse(fact.fetchedAt)
  if (!Number.isFinite(fetchedAt) || fetchedAt > now.getTime() + MINUTE_MS) {
    return {
      state: "unknown",
      fields: [evidenceField],
      reason: `${evidenceField} 获取时间无效`,
    }
  }
  if (now.getTime() - fetchedAt > ttlMs) {
    return {
      state: "unknown",
      fields: [evidenceField],
      reason: `${evidenceField} 已过期`,
    }
  }

  return {
    state: "known",
    value: fact.value,
    evidenceFields: [evidenceField],
  }
}

function resolveField(
  candidate: Candidate,
  rawField: string,
  policy: AgentBPolicy,
  now: Date,
): ResolvedField {
  const field = canonicalField(rawField)

  if (field === "productId") {
    return { state: "known", value: candidate.productId, evidenceFields: ["productId"] }
  }
  if (field === "skuId") {
    return candidate.skuId === null
      ? { state: "unknown", fields: ["skuId"], reason: "skuId 缺失" }
      : { state: "known", value: candidate.skuId, evidenceFields: ["skuId"] }
  }
  if (field === "offerId") {
    return candidate.offerId === null
      ? { state: "unknown", fields: ["offerId"], reason: "offerId 缺失" }
      : { state: "known", value: candidate.offerId, evidenceFields: ["offerId"] }
  }

  if (field === "totalPrice" || field === "deliveredTotalMinor") {
    const item = resolveField(candidate, "itemPriceMinor", policy, now)
    const shipping = resolveField(candidate, "shippingMinor", policy, now)
    const discount = resolveField(candidate, "discountMinor", policy, now)
    const parts = [item, shipping, discount]
    const unknownParts = parts.filter(
      (part): part is Extract<ResolvedField, { state: "unknown" }> => part.state === "unknown",
    )
    if (unknownParts.length > 0) {
      return {
        state: "unknown",
        fields: [...new Set(unknownParts.flatMap((part) => part.fields))],
        reason: unknownParts.map((part) => part.reason).join("；"),
      }
    }
    const knownParts = parts as Extract<ResolvedField, { state: "known" }>[]
    const [itemValue, shippingValue, discountValue] = knownParts.map((part) => Number(part.value))
    if (discountValue > itemValue) {
      return {
        state: "unknown",
        fields: ["offer.itemPriceMinor", "offer.discountMinor"],
        reason: "优惠金额大于商品价格，需要重新核验",
      }
    }
    return {
      state: "known",
      value: itemValue + shippingValue - discountValue,
      evidenceFields: [...new Set(knownParts.flatMap((part) => part.evidenceFields))],
    }
  }

  if (field === "netItemPriceMinor") {
    const item = resolveField(candidate, "itemPriceMinor", policy, now)
    const discount = resolveField(candidate, "discountMinor", policy, now)
    const parts = [item, discount]
    const unknownParts = parts.filter(
      (part): part is Extract<ResolvedField, { state: "unknown" }> => part.state === "unknown",
    )
    if (unknownParts.length > 0) {
      return {
        state: "unknown",
        fields: [...new Set(unknownParts.flatMap((part) => part.fields))],
        reason: unknownParts.map((part) => part.reason).join("；"),
      }
    }
    const knownParts = parts as Extract<ResolvedField, { state: "known" }>[]
    const itemValue = Number(knownParts[0].value)
    const discountValue = Number(knownParts[1].value)
    if (discountValue > itemValue) {
      return {
        state: "unknown",
        fields: ["offer.itemPriceMinor", "offer.discountMinor"],
        reason: "优惠金额大于商品价格，需要重新核验",
      }
    }
    return {
      state: "known",
      value: itemValue - discountValue,
      evidenceFields: [...new Set(knownParts.flatMap((part) => part.evidenceFields))],
    }
  }

  if (isDynamicOfferField(field)) {
    if (!candidate.offer) {
      return {
        state: "unknown",
        fields: [`offer.${field}`],
        reason: `offer.${field} 缺失`,
      }
    }
    const fact = candidate.offer[field as keyof Candidate["offer"]]
    if (typeof fact === "string") {
      return { state: "known", value: fact, evidenceFields: ["offer.currency"] }
    }
    return resolveFact(
      fact as Fact<number | string | boolean> | undefined,
      `offer.${field}`,
      policy.offerTtlMs,
      now,
    )
  }

  return resolveFact(
    candidate.attributes[field],
    `attributes.${field}`,
    policy.catalogFactTtlMs,
    now,
  )
}

function matchesConstraint(value: number | string | boolean, constraint: Constraint): boolean {
  switch (constraint.op) {
    case "lte":
      return typeof value === "number" && typeof constraint.value === "number" && value <= constraint.value
    case "gte":
      return typeof value === "number" && typeof constraint.value === "number" && value >= constraint.value
    case "eq":
      return value === constraint.value
    case "in":
      return typeof value === "string" && Array.isArray(constraint.value) && constraint.value.includes(value)
    case "notIn":
      return typeof value === "string" && Array.isArray(constraint.value) && !constraint.value.includes(value)
  }
}

function formatConstraint(constraint: Constraint): string {
  const renderedValue = Array.isArray(constraint.value)
    ? constraint.value.join(", ")
    : String(constraint.value)
  return `${constraint.field} ${constraint.op} ${renderedValue}`
}

function verificationRequest(
  candidate: Candidate,
  fields: string[],
  reason: string,
): VerificationRequest {
  return {
    productId: candidate.productId,
    skuId: candidate.skuId,
    offerId: candidate.offerId,
    fields: [...new Set(fields)].sort(),
    reason,
  }
}

function mergeVerificationRequests(requests: VerificationRequest[]): VerificationRequest[] {
  const merged = new Map<string, VerificationRequest>()
  requests.forEach((request) => {
    const key = [request.productId, request.skuId ?? "", request.offerId ?? ""].join("::")
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, request)
      return
    }
    existing.fields = [...new Set([...existing.fields, ...request.fields])].sort()
    if (!existing.reason.includes(request.reason)) {
      existing.reason = `${existing.reason}；${request.reason}`
    }
  })
  return [...merged.values()]
}

function buildPolicy(options: EvaluateOptions = {}): AgentBPolicy {
  const fieldPolicies = {
    ...DEFAULT_FIELD_POLICIES,
    ...(options.fieldPolicies ?? {}),
  }
  const policy: AgentBPolicy = {
    offerTtlMs: options.offerTtlMs ?? DEFAULT_AGENT_B_POLICY.offerTtlMs,
    catalogFactTtlMs:
      options.catalogFactTtlMs ?? DEFAULT_AGENT_B_POLICY.catalogFactTtlMs,
    purchaseOfferTtlMs:
      options.purchaseOfferTtlMs ?? DEFAULT_AGENT_B_POLICY.purchaseOfferTtlMs,
    maxRecommendations:
      options.maxRecommendations ?? DEFAULT_AGENT_B_POLICY.maxRecommendations,
    fieldPolicies,
  }

  const issues: string[] = []
  pushIf(issues, !Number.isFinite(policy.offerTtlMs) || policy.offerTtlMs <= 0, "offerTtlMs 必须大于 0")
  pushIf(
    issues,
    !Number.isFinite(policy.catalogFactTtlMs) || policy.catalogFactTtlMs <= 0,
    "catalogFactTtlMs 必须大于 0",
  )
  pushIf(
    issues,
    !Number.isFinite(policy.purchaseOfferTtlMs) || policy.purchaseOfferTtlMs <= 0,
    "purchaseOfferTtlMs 必须大于 0",
  )
  pushIf(
    issues,
    !Number.isInteger(policy.maxRecommendations) || policy.maxRecommendations < 1,
    "maxRecommendations 必须是正整数",
  )
  Object.entries(policy.fieldPolicies).forEach(([field, fieldPolicy]) => {
    pushIf(issues, !isNonEmptyString(field), "FieldPolicy 字段名不能为空")
    pushIf(
      issues,
      !isRecord(fieldPolicy) ||
        (fieldPolicy.direction !== "min" && fieldPolicy.direction !== "max") ||
        !isNonEmptyString(fieldPolicy.label),
      `FieldPolicy ${field} 必须包含有效的 direction 和 label`,
    )
  })
  if (issues.length > 0) throw new AgentBValidationError("Agent B 策略无效", issues)
  return policy
}

function validatePreferencePolicies(requirement: Requirement, policy: AgentBPolicy): void {
  const unsupported = requirement.preferences
    .map((preference) => canonicalField(preference.field))
    .filter((field) => !policy.fieldPolicies[field])
  if (unsupported.length > 0) {
    throw new AgentBValidationError("存在未约定评分方向的偏好字段", [
      `请先为以下字段配置 FieldPolicy：${[...new Set(unsupported)].join(", ")}`,
    ])
  }
}

function normalizedScore(
  value: number,
  values: number[],
  direction: FieldPolicy["direction"],
): number {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return 1
  return direction === "max" ? (value - min) / (max - min) : (max - value) / (max - min)
}

function selectDiverseRecommendations(
  scored: ScoredCandidate[],
  requirement: Requirement,
  policy: AgentBPolicy,
): { item: ScoredCandidate; label: string }[] {
  if (scored.length === 0) return []
  const byOverallScore = [...scored].sort(
    (left, right) => right.score - left.score || left.candidate.productId.localeCompare(right.candidate.productId),
  )
  const selected: { item: ScoredCandidate; label: string }[] = [
    { item: byOverallScore[0], label: "综合最优" },
  ]
  const used = new Set([byOverallScore[0].candidate.productId])

  const preferences = [...requirement.preferences].sort((left, right) => right.weight - left.weight)
  for (const preference of preferences) {
    if (selected.length >= policy.maxRecommendations) break
    const field = canonicalField(preference.field)
    const fieldPolicy = policy.fieldPolicies[field]
    const candidatesWithValue = scored.filter((item) => item.preferenceValues.has(field))
    candidatesWithValue.sort((left, right) => {
      const leftValue = left.preferenceValues.get(field) ?? 0
      const rightValue = right.preferenceValues.get(field) ?? 0
      return fieldPolicy.direction === "max" ? rightValue - leftValue : leftValue - rightValue
    })
    const representative = candidatesWithValue.find(
      (item) => !used.has(item.candidate.productId),
    )
    if (representative) {
      selected.push({ item: representative, label: `${fieldPolicy.label}优先` })
      used.add(representative.candidate.productId)
    }
  }

  for (const item of byOverallScore) {
    if (selected.length >= policy.maxRecommendations) break
    if (!used.has(item.candidate.productId)) {
      selected.push({ item, label: "备选" })
      used.add(item.candidate.productId)
    }
  }
  return selected
}

function assertEvaluationResult(value: EvaluationResult): void {
  const issues: string[] = []
  pushIf(issues, !isNonEmptyString(value.taskId), "输出 taskId 不能为空")
  pushIf(
    issues,
    !Number.isSafeInteger(value.requirementVersion) || value.requirementVersion < 0,
    "输出 requirementVersion 无效",
  )
  pushIf(
    issues,
    !["ready", "needsVerification", "needsSearch"].includes(value.status),
    "输出 status 无效",
  )
  value.recommendations.forEach((recommendation, index) => {
    const path = `recommendations[${index}]`
    pushIf(
      issues,
      !Number.isFinite(recommendation.score) ||
        recommendation.score < 0 ||
        recommendation.score > 1,
      `${path}.score 必须在 0 到 1 之间`,
    )
    pushIf(
      issues,
      !isNonEmptyString(recommendation.productId),
      `${path}.productId 不能为空`,
    )
    pushIf(
      issues,
      recommendation.skuId !== null && !isNonEmptyString(recommendation.skuId),
      `${path}.skuId 无效`,
    )
    pushIf(
      issues,
      recommendation.offerId !== null && !isNonEmptyString(recommendation.offerId),
      `${path}.offerId 无效`,
    )
    pushIf(issues, !isNonEmptyString(recommendation.label), `${path}.label 不能为空`)
    pushIf(
      issues,
      !Array.isArray(recommendation.satisfied) || !recommendation.satisfied.every(isNonEmptyString),
      `${path}.satisfied 无效`,
    )
    pushIf(
      issues,
      !Array.isArray(recommendation.tradeoffs) || !recommendation.tradeoffs.every(isNonEmptyString),
      `${path}.tradeoffs 无效`,
    )
    pushIf(
      issues,
      !Array.isArray(recommendation.evidenceFields) ||
        !recommendation.evidenceFields.every(isNonEmptyString),
      `${path}.evidenceFields 无效`,
    )
  })
  value.rejected.forEach((rejection, index) => {
    pushIf(issues, !isNonEmptyString(rejection.productId), `rejected[${index}].productId 不能为空`)
    pushIf(
      issues,
      !Array.isArray(rejection.reasons) ||
        rejection.reasons.length === 0 ||
        !rejection.reasons.every(isNonEmptyString),
      `rejected[${index}].reasons 无效`,
    )
  })
  value.verificationRequests.forEach((request, index) => {
    pushIf(
      issues,
      !isNonEmptyString(request.productId) ||
        !Array.isArray(request.fields) ||
        request.fields.length === 0 ||
        !request.fields.every(isNonEmptyString) ||
        !isNonEmptyString(request.reason),
      `verificationRequests[${index}] 无效`,
    )
  })
  pushIf(
    issues,
    !Array.isArray(value.searchHints) || !value.searchHints.every(isNonEmptyString),
    "输出 searchHints 无效",
  )
  pushIf(
    issues,
    value.status === "ready" &&
      (value.recommendations.length === 0 || value.verificationRequests.length > 0),
    "ready 结果必须包含推荐且不能包含补查请求",
  )
  pushIf(
    issues,
    value.status === "needsVerification" && value.verificationRequests.length === 0,
    "needsVerification 结果必须包含补查请求",
  )
  pushIf(
    issues,
    value.status === "needsSearch" && value.recommendations.length > 0,
    "needsSearch 结果不能包含推荐",
  )
  if (issues.length > 0) {
    throw new AgentBValidationError("Agent B 生成了无效决策结果", issues)
  }
}

export async function evaluateCandidates(
  input: EvaluateCandidatesInput,
  options: EvaluateOptions = {},
): Promise<EvaluationResult> {
  if (!isRecord(input)) {
    throw new AgentBValidationError("评估输入无效", ["input 必须是对象"])
  }
  assertRequirement(input.requirement)
  validateCandidates(input.candidates)

  const policy = buildPolicy(options)
  validatePreferencePolicies(input.requirement, policy)
  const now = options.now?.() ?? new Date()
  if (!Number.isFinite(now.getTime())) {
    throw new AgentBValidationError("评估输入无效", ["now() 必须返回有效时间"])
  }

  const rejected: EvaluationResult["rejected"] = []
  const verificationRequests: VerificationRequest[] = []
  const eligible: {
    candidate: Candidate
    satisfied: string[]
    evidenceFields: string[]
    preferenceValues: Map<string, number>
    missingPreferenceFields: string[]
  }[] = []

  for (const candidate of input.candidates) {
    const reasons: string[] = []
    const unknownFields: string[] = []
    const unknownReasons: string[] = []
    const satisfied: string[] = []
    const evidenceFields: string[] = []

    if (input.requirement.excludedProductIds.includes(candidate.productId)) {
      reasons.push("商品已被用户排除")
    }

    if (candidate.offer && candidate.offer.currency !== input.requirement.currency) {
      reasons.push(
        `币种不匹配：候选为 ${candidate.offer.currency}，需求为 ${input.requirement.currency}`,
      )
    }

    const budgetField =
      input.requirement.budget.scope === "delivered"
        ? "deliveredTotalMinor"
        : "netItemPriceMinor"
    const budgetValue = resolveField(candidate, budgetField, policy, now)
    if (budgetValue.state === "unknown") {
      unknownFields.push(...budgetValue.fields)
      unknownReasons.push(`预算核验失败：${budgetValue.reason}`)
    } else if (
      typeof budgetValue.value !== "number" ||
      budgetValue.value > input.requirement.budget.maxMinor
    ) {
      reasons.push(
        `超出预算：${String(budgetValue.value)} > ${input.requirement.budget.maxMinor}`,
      )
    } else {
      satisfied.push(
        `${input.requirement.budget.scope} 预算不超过 ${input.requirement.budget.maxMinor}`,
      )
      evidenceFields.push(...budgetValue.evidenceFields)
    }

    const stock = resolveField(candidate, "stock", policy, now)
    if (stock.state === "unknown") {
      unknownFields.push(...stock.fields)
      unknownReasons.push(stock.reason)
    } else if (stock.value !== "available") {
      reasons.push("商品无库存")
    } else {
      satisfied.push("有库存")
      evidenceFields.push(...stock.evidenceFields)
    }

    if (input.requirement.destination) {
      const deliverable = resolveField(candidate, "deliverable", policy, now)
      if (deliverable.state === "unknown") {
        unknownFields.push(...deliverable.fields)
        unknownReasons.push(deliverable.reason)
      } else if (deliverable.value !== true) {
        reasons.push(`无法配送至 ${input.requirement.destination}`)
      } else {
        satisfied.push(`可配送至 ${input.requirement.destination}`)
        evidenceFields.push(...deliverable.evidenceFields)
      }
    }

    for (const constraint of input.requirement.hardConstraints) {
      const resolved = resolveField(candidate, constraint.field, policy, now)
      if (resolved.state === "unknown") {
        unknownFields.push(...resolved.fields)
        unknownReasons.push(`${constraint.field}：${resolved.reason}`)
      } else if (!matchesConstraint(resolved.value, constraint)) {
        reasons.push(`不满足硬约束：${formatConstraint(constraint)}`)
      } else {
        satisfied.push(formatConstraint(constraint))
        evidenceFields.push(...resolved.evidenceFields)
      }
    }

    if (reasons.length > 0) {
      rejected.push({ productId: candidate.productId, reasons })
      continue
    }

    if (unknownFields.length > 0) {
      verificationRequests.push(
        verificationRequest(candidate, unknownFields, unknownReasons.join("；")),
      )
      continue
    }

    const preferenceValues = new Map<string, number>()
    const missingPreferenceFields: string[] = []
    for (const preference of input.requirement.preferences) {
      const field = canonicalField(preference.field)
      const resolved = resolveField(candidate, field, policy, now)
      if (resolved.state === "unknown" || typeof resolved.value !== "number") {
        missingPreferenceFields.push(
          ...(resolved.state === "unknown" ? resolved.fields : [preference.field]),
        )
        continue
      }
      preferenceValues.set(field, resolved.value)
      evidenceFields.push(...resolved.evidenceFields)
    }

    if (missingPreferenceFields.length > 0) {
      verificationRequests.push(
        verificationRequest(
          candidate,
          missingPreferenceFields,
          "缺少影响排序的偏好事实，当前排序置信度不足",
        ),
      )
    }

    eligible.push({
      candidate,
      satisfied,
      evidenceFields: [...new Set(evidenceFields)],
      preferenceValues,
      missingPreferenceFields: [...new Set(missingPreferenceFields)],
    })
  }

  const valuesByField = new Map<string, number[]>()
  input.requirement.preferences.forEach((preference) => {
    const field = canonicalField(preference.field)
    valuesByField.set(
      field,
      eligible
        .map((item) => item.preferenceValues.get(field))
        .filter((value): value is number => value !== undefined),
    )
  })

  const scored: ScoredCandidate[] = eligible.map((item) => {
    let score = input.requirement.preferences.length === 0 ? 1 : 0
    const tradeoffs: string[] = []
    for (const preference of input.requirement.preferences) {
      const field = canonicalField(preference.field)
      const value = item.preferenceValues.get(field)
      const fieldPolicy = policy.fieldPolicies[field]
      const values = valuesByField.get(field) ?? []
      if (value === undefined || values.length === 0) {
        tradeoffs.push(`${field} 信息不足，未计入评分`)
        continue
      }
      const dimensionScore = normalizedScore(value, values, fieldPolicy.direction)
      score += preference.weight * dimensionScore
      const bestValue =
        fieldPolicy.direction === "max" ? Math.max(...values) : Math.min(...values)
      if (value !== bestValue) {
        tradeoffs.push(`${field} 不是当前候选中的最优值`)
      }
    }
    return {
      candidate: item.candidate,
      score: Math.round(Math.min(1, Math.max(0, score)) * 1_000_000) / 1_000_000,
      satisfied: item.satisfied,
      tradeoffs,
      evidenceFields: item.evidenceFields,
      preferenceValues: item.preferenceValues,
    }
  })

  const recommendations: EvaluationRecommendation[] = selectDiverseRecommendations(
    scored,
    input.requirement,
    policy,
  ).map(({ item, label }) => ({
    productId: item.candidate.productId,
    skuId: item.candidate.skuId,
    offerId: item.candidate.offerId,
    score: item.score,
    label,
    satisfied: item.satisfied,
    tradeoffs: item.tradeoffs,
    evidenceFields: [...new Set(item.evidenceFields)].sort(),
  }))

  const mergedVerificationRequests = mergeVerificationRequests(verificationRequests)
  let status: EvaluationResult["status"]
  if (mergedVerificationRequests.length > 0) {
    status = "needsVerification"
  } else if (recommendations.length > 0) {
    status = "ready"
  } else {
    status = "needsSearch"
  }

  const rejectedConstraintFields = new Set<string>()
  rejected.forEach((item) => {
    item.reasons.forEach((reason) => {
      input.requirement.hardConstraints.forEach((constraint) => {
        if (reason.includes(constraint.field)) rejectedConstraintFields.add(constraint.field)
      })
    })
  })
  const searchHints =
    status === "needsSearch"
      ? rejectedConstraintFields.size > 0
        ? [
            `补充满足这些硬约束的候选：${[...rejectedConstraintFields].join(", ")}`,
          ]
        : ["补充更多未被排除、币种一致且有库存的候选商品"]
      : []

  const result: EvaluationResult = {
    taskId: input.requirement.taskId,
    requirementVersion: input.requirement.requirementVersion,
    status,
    recommendations,
    rejected,
    verificationRequests: mergedVerificationRequests,
    searchHints,
  }
  assertEvaluationResult(result)
  return result
}

function sameAuthorization(left: Authorization, right: Authorization): boolean {
  return (
    left.authorizationId === right.authorizationId &&
    left.allowedOfferId === right.allowedOfferId &&
    left.maxTotalMinor === right.maxTotalMinor &&
    left.maxQuantity === right.maxQuantity &&
    left.currency === right.currency &&
    left.expiresAt === right.expiresAt
  )
}

function purchaseResult(
  input: CheckPurchaseInput,
  checkedAt: string,
  status: PurchaseCheck["status"],
  reasons: string[],
  totalMinor: number | null = null,
  requests: VerificationRequest[] = [],
): PurchaseCheck {
  const result: PurchaseCheck = {
    taskId: input.requirement.taskId,
    requirementVersion: input.requirement.requirementVersion,
    status,
    offerId: input.candidate.offerId,
    totalMinor,
    checkedAt,
    reasons,
    verificationRequests: requests,
  }
  const issues: string[] = []
  pushIf(issues, !isNonEmptyString(result.taskId), "PurchaseCheck.taskId 不能为空")
  pushIf(
    issues,
    !Number.isSafeInteger(result.requirementVersion) || result.requirementVersion < 0,
    "PurchaseCheck.requirementVersion 无效",
  )
  pushIf(
    issues,
    !["approved", "blocked", "needsVerification"].includes(result.status),
    "PurchaseCheck.status 无效",
  )
  pushIf(
    issues,
    result.offerId !== null && !isNonEmptyString(result.offerId),
    "PurchaseCheck.offerId 无效",
  )
  pushIf(
    issues,
    result.totalMinor !== null &&
      (!Number.isSafeInteger(result.totalMinor) || result.totalMinor < 0),
    "PurchaseCheck.totalMinor 无效",
  )
  pushIf(issues, !isIsoDate(result.checkedAt), "PurchaseCheck.checkedAt 无效")
  pushIf(
    issues,
    !Array.isArray(result.reasons) ||
      result.reasons.length === 0 ||
      !result.reasons.every(isNonEmptyString),
    "PurchaseCheck.reasons 无效",
  )
  result.verificationRequests.forEach((request, index) => {
    pushIf(
      issues,
      !isNonEmptyString(request.productId) ||
        !Array.isArray(request.fields) ||
        request.fields.length === 0 ||
        !request.fields.every(isNonEmptyString) ||
        !isNonEmptyString(request.reason),
      `PurchaseCheck.verificationRequests[${index}] 无效`,
    )
  })
  pushIf(
    issues,
    result.status === "approved" && result.totalMinor === null,
    "approved 结果必须包含 totalMinor",
  )
  pushIf(
    issues,
    result.status === "approved" && result.verificationRequests.length > 0,
    "approved 结果不能包含补查请求",
  )
  pushIf(
    issues,
    result.status === "needsVerification" && result.verificationRequests.length === 0,
    "needsVerification 结果必须包含补查请求",
  )
  if (issues.length > 0) {
    throw new AgentBValidationError("Agent B 生成了无效购买检查结果", issues)
  }
  return result
}

export async function checkPurchase(
  input: CheckPurchaseInput,
  context?: PurchaseCheckContext,
): Promise<PurchaseCheck> {
  if (!isRecord(input)) {
    throw new AgentBValidationError("购买检查输入无效", ["input 必须是对象"])
  }
  assertRequirement(input.requirement)
  assertCandidate(input.candidate)
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new AgentBValidationError("购买检查输入无效", ["quantity 必须是正安全整数"])
  }
  if (input.authorization !== null) assertAuthorization(input.authorization)

  const now = context?.now?.() ?? new Date()
  if (!Number.isFinite(now.getTime())) {
    throw new AgentBValidationError("购买检查输入无效", ["now() 必须返回有效时间"])
  }
  const checkedAt = now.toISOString()

  if (!input.authorization) {
    return purchaseResult(input, checkedAt, "blocked", ["缺少用户购买授权"])
  }
  if (!context?.getAuthorizationById) {
    return purchaseResult(input, checkedAt, "blocked", ["未配置后端授权记录查询，不能信任调用方提供的授权"])
  }

  let persistedAuthorization: Authorization | null
  try {
    persistedAuthorization = await context.getAuthorizationById(
      input.authorization.authorizationId,
    )
  } catch {
    return purchaseResult(input, checkedAt, "blocked", ["后端授权记录查询失败"])
  }
  if (!persistedAuthorization) {
    return purchaseResult(input, checkedAt, "blocked", ["后端不存在对应的有效授权记录"])
  }
  assertAuthorization(persistedAuthorization, "persistedAuthorization")
  if (!sameAuthorization(input.authorization, persistedAuthorization)) {
    return purchaseResult(input, checkedAt, "blocked", ["调用方授权内容与后端记录不一致"])
  }

  const authorization = persistedAuthorization
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    return purchaseResult(input, checkedAt, "blocked", ["购买授权已过期"])
  }
  if (input.quantity > authorization.maxQuantity) {
    return purchaseResult(input, checkedAt, "blocked", [
      `购买数量 ${input.quantity} 超过授权上限 ${authorization.maxQuantity}`,
    ])
  }
  if (!input.candidate.offerId || authorization.allowedOfferId !== input.candidate.offerId) {
    return purchaseResult(input, checkedAt, "blocked", ["候选 offerId 不在授权范围内"])
  }
  if (!input.candidate.offer) {
    return purchaseResult(
      input,
      checkedAt,
      "needsVerification",
      ["缺少销售方案，必须补查价格、运费、库存和配送信息"],
      null,
      [
        verificationRequest(
          input.candidate,
          [
            "offer.itemPriceMinor",
            "offer.shippingMinor",
            "offer.discountMinor",
            "offer.stock",
            "offer.deliverable",
          ],
          "执行购买前需要完整且最新的销售事实",
        ),
      ],
    )
  }
  if (
    input.candidate.offer.currency !== input.requirement.currency ||
    authorization.currency !== input.requirement.currency
  ) {
    return purchaseResult(input, checkedAt, "blocked", ["需求、报价和授权币种不一致"])
  }

  const purchasePolicy = buildPolicy({
    offerTtlMs:
      context.purchaseOfferTtlMs ?? DEFAULT_AGENT_B_POLICY.purchaseOfferTtlMs,
    purchaseOfferTtlMs:
      context.purchaseOfferTtlMs ?? DEFAULT_AGENT_B_POLICY.purchaseOfferTtlMs,
  })
  const requiredFields = [
    "itemPriceMinor",
    "shippingMinor",
    "discountMinor",
    "stock",
    "deliverable",
  ]
  const resolved = new Map<string, ResolvedField>()
  requiredFields.forEach((field) => {
    resolved.set(field, resolveField(input.candidate, field, purchasePolicy, now))
  })
  const unknown = [...resolved.entries()].filter((entry) => entry[1].state === "unknown")
  if (unknown.length > 0) {
    return purchaseResult(
      input,
      checkedAt,
      "needsVerification",
      ["价格、运费、优惠、库存或配送事实缺失、未核验或已过期"],
      null,
      [
        verificationRequest(
          input.candidate,
          unknown.flatMap(([, value]) =>
            value.state === "unknown" ? value.fields : [],
          ),
          "执行购买前必须重新核验动态报价与履约事实",
        ),
      ],
    )
  }

  const known = Object.fromEntries(
    [...resolved.entries()].map(([field, value]) => [
      field,
      (value as Extract<ResolvedField, { state: "known" }>).value,
    ]),
  )
  if (known.stock !== "available") {
    return purchaseResult(input, checkedAt, "blocked", ["商品当前无库存"])
  }
  if (known.deliverable !== true) {
    return purchaseResult(input, checkedAt, "blocked", ["商品当前不可配送"])
  }

  const itemPriceMinor = Number(known.itemPriceMinor)
  const shippingMinor = Number(known.shippingMinor)
  const discountMinor = Number(known.discountMinor)
  if (discountMinor > itemPriceMinor) {
    return purchaseResult(
      input,
      checkedAt,
      "needsVerification",
      ["优惠金额大于商品价格，报价事实相互矛盾"],
      null,
      [
        verificationRequest(
          input.candidate,
          ["offer.itemPriceMinor", "offer.discountMinor"],
          "价格与优惠需要重新核验",
        ),
      ],
    )
  }

  const itemTotalMinor = (itemPriceMinor - discountMinor) * input.quantity
  const totalMinor = itemTotalMinor + shippingMinor
  if (!Number.isSafeInteger(totalMinor)) {
    return purchaseResult(input, checkedAt, "blocked", ["订单总价超出安全整数范围"])
  }
  const requirementTotal =
    input.requirement.budget.scope === "item" ? itemTotalMinor : totalMinor
  if (requirementTotal > input.requirement.budget.maxMinor) {
    return purchaseResult(input, checkedAt, "blocked", [
      `订单金额 ${requirementTotal} 超过需求预算 ${input.requirement.budget.maxMinor}`,
    ], totalMinor)
  }
  if (totalMinor > authorization.maxTotalMinor) {
    return purchaseResult(input, checkedAt, "blocked", [
      `含配送总价 ${totalMinor} 超过授权上限 ${authorization.maxTotalMinor}`,
    ], totalMinor)
  }

  return purchaseResult(
    input,
    checkedAt,
    "approved",
    [
      "后端授权有效且与销售方案一致",
      "最新报价、库存和配送事实已核验",
      "订单金额同时满足需求预算与授权上限",
    ],
    totalMinor,
  )
}
