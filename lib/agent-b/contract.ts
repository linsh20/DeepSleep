import { createHash } from "node:crypto"
import { AgentBValidationError, assertCandidate, assertRequirement } from "./index.ts"
import { optimizePaymentMethods } from "./payment.ts"
import { assessCondition, buildScoringConditions } from "../../services/search-filter.ts"
import type {
  ShoppingCandidate, CandidateAudit, ConditionCheck, Constraint, ContractBPolicy,
  ContractBResult, ContractEvaluationInput, Fact, ProductIdentity, Authorization, PurchaseCheck, PaymentOrder, Candidate,
} from "../../types/index.ts"

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().trim()
const identity = (c: ShoppingCandidate): ProductIdentity => ({ productId: c.productId, skuId: c.skuId, offerId: c.offerId })
const key = (c: ProductIdentity) => JSON.stringify([c.productId, c.skuId, c.offerId])
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0
const money = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
function requireValid(ok: unknown, message: string): asserts ok {
  if (!ok) throw new AgentBValidationError("契约输入无效", [message])
}
const standardAttributes: Record<string, "number" | "string" | "boolean"> = {
  category: "string", brand: "string", series: "string", productName: "string", shade: "string",
  volumeMl: "number", packageType: "string", weightGrams: "number", ramGB: "number",
  storageGB: "number", performanceScore: "number", batteryLifeHours: "number", rating: "number",
}
const systemIds = ["identity", "category", "currency", "excluded", "quote-context", "budget", "stock", "delivery", "quantity", "channel-allowlist", "low-price-risk"]

function schema(policy: ContractBPolicy): Record<string, "number" | "string" | "boolean"> {
  return {
    ...Object.fromEntries(Object.entries({ ...standardAttributes, ...policy.attributeSchema }).map(([k, v]) => [`attributes.${k}`, v])),
    "text.searchable": "string", "offer.itemPriceMinor": "number", "offer.shippingMinor": "number",
    "offer.discountMinor": "number", "offer.stock": "string", "offer.deliverable": "boolean",
    "quote.otherFeesMinor": "number", "quote.totalMinor": "number", "quote.estimatedDeliveryAtMs": "number",
    "quote.canFulfillQuantity": "boolean", "merchant.platformId": "string", "merchant.name": "string",
  }
}

function validate(input: ContractEvaluationInput, policy: ContractBPolicy) {
  requireValid(record(input) && record(input.requirement), "input.requirement 必须为对象")
  requireValid(record(policy) && nonempty(policy.policyVersion), "缺少 policyVersion")
  requireValid(["development_mock", "verified_sources"].includes(policy.dataEnvironment), "dataEnvironment 无效")
  requireValid(Array.isArray(policy.merchantAllowlist) && policy.merchantAllowlist.every(x => record(x) && nonempty(x.id) && nonempty(x.platformId)), "白名单格式无效")
  requireValid(Array.isArray(policy.priceBenchmarks), "priceBenchmarks 必须为数组")
  for (const b of policy.priceBenchmarks) {
    requireValid(record(b) && nonempty(b.productId) && nonempty(b.skuId) && b.currency === "HKD" && nonempty(b.destination) &&
      money(b.medianUnitPriceMinor) && b.medianUnitPriceMinor > 0 && money(b.offerCount) && money(b.sellerCount) &&
      b.sellerCount <= b.offerCount && nonempty(b.source) && Number.isFinite(Date.parse(b.fetchedAt)) &&
      Array.isArray(b.excludedOfferIds) && b.excludedOfferIds.every(nonempty), "价格基准格式无效")
  }
  for (const ttl of [policy.offerTtlMs ?? 300000, policy.staticTtlMs ?? 86400000]) requireValid(Number.isFinite(ttl) && ttl > 0, "TTL 必须大于 0")
  const ratio = policy.lowPriceRatio ?? 0.5
  requireValid(Number.isFinite(ratio) && ratio > 0 && ratio < 1, "lowPriceRatio 必须介于 0 和 1")
  if (policy.attributeSchema) requireValid(record(policy.attributeSchema) && Object.entries(policy.attributeSchema).every(([k,v]) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(k) && ["number", "string", "boolean"].includes(v)), "attributeSchema 无效")
  if (policy.categoryAliases) requireValid(record(policy.categoryAliases) && Object.values(policy.categoryAliases).every(nonempty), "categoryAliases 无效")
  const r = input.requirement
  // Reuse base shape validation, while validating new constraints and relative weights below.
  assertRequirement({ ...r, allowAlternativeProducts: undefined, hardConstraints: [], preferences: [] })
  requireValid(r.currency === "HKD" && nonempty(r.destination), "本轮只支持 HKD，destination 必填")
  requireValid(Number.isSafeInteger(input.quantity) && input.quantity > 0, "quantity 必须为正整数")
  requireValid(input.sourceTaskId === r.taskId && input.sourceRequirementVersion === r.requirementVersion, "A 结果任务或需求版本不匹配")
  if (input.sourceSearchInput) {
    const s = input.sourceSearchInput
    const must = (v: unknown) => v === 0 || v === 1
    const bound = (v: unknown) => v === null || money(v)
    requireValid(record(s) && s.taskId === r.taskId && s.requirementVersion === r.requirementVersion, "A 搜索条件任务或版本不匹配")
    requireValid(record(s.product_name) && nonempty(s.product_name.value) && must(s.product_name.must) &&
      (s.product_name.aliases === undefined || Array.isArray(s.product_name.aliases) && s.product_name.aliases.every(nonempty)), "A 品名条件无效")
    requireValid(Array.isArray(s.range_conditions) && s.range_conditions.every(c => record(c) && ["priceMinor", "volumeMl"].includes(c.field) &&
      must(c.must) && bound(c.min) && bound(c.max) && (c.min !== null || c.max !== null) && (c.min === null || c.max === null || c.min <= c.max)), "A 范围条件无效")
    for (const groups of [s.include_keywords, s.exclude_keywords]) requireValid(Array.isArray(groups) && groups.every(c => record(c) &&
      must(c.must) && Array.isArray(c.keywords) && c.keywords.length > 0 && c.keywords.every(nonempty) &&
      (c.scope === undefined || c.scope === "all" || c.scope === "ingredients")), "A 关键词条件无效")
  }
  requireValid(["complete", "partial", "failed"].includes(input.searchStatus), "searchStatus 无效")
  requireValid(r.allowAlternativeProducts === undefined || typeof r.allowAlternativeProducts === "boolean", "allowAlternativeProducts 无效")
  const fields = schema(policy)
  function condition(c: Constraint) {
    requireValid(record(c) && nonempty(c.field) && Object.hasOwn(fields, c.field), `未知条件字段：${c?.field}`)
    requireValid(c.id === undefined || nonempty(c.id), "条件 id 无效")
    const type = fields[c.field]
    requireValid(["eq", "lte", "gte", "in", "notIn", "containsAny", "notContainsAny"].includes(c.op), "未知操作符")
    if (["containsAny", "notContainsAny"].includes(c.op)) {
      requireValid(c.field === "text.searchable" && Array.isArray(c.value) && c.value.length > 0 && c.value.every(nonempty), "文本操作符只支持 text.searchable 和非空关键词数组")
    } else if (["in", "notIn"].includes(c.op)) {
      requireValid(type === "string" && Array.isArray(c.value) && c.value.length > 0 && c.value.every(nonempty), "集合条件必须为字符串集合")
    } else {
      requireValid(typeof c.value === type && (type !== "number" || Number.isFinite(c.value)), "条件目标值类型无效")
      if (c.op !== "eq") requireValid(type === "number", "比较操作符必须使用数值")
    }
  }
  requireValid(Array.isArray(r.hardConstraints) && Array.isArray(r.preferences), "条件和偏好必须为数组")
  const ids = new Set([...systemIds.map(id => `system:${id}`),
    ...(input.sourceSearchInput ? buildScoringConditions(input.sourceSearchInput).map(c => `search:${c.id}`) : [])])
  const takeId = (id: string) => { requireValid(!ids.has(id), `重复或保留 conditionId：${id}`); ids.add(id) }
  r.hardConstraints.forEach((c, i) => { condition(c); takeId(c.id ?? `hard:${i}`) })
  r.preferences.forEach((p, i) => {
    requireValid(record(p) && Object.hasOwn(fields, p.field) && Number.isFinite(p.weight) && p.weight > 0 &&
      ["explicit", "inferred"].includes(p.source) && Array.isArray(p.conditions) && p.conditions.length > 0, "偏好必须提供正权重与非空 conditions，旧偏好需显式适配")
    requireValid(p.id === undefined || nonempty(p.id), "偏好 id 无效")
    p.conditions.forEach(condition)
    takeId(p.id ?? `prefer:${i}`)
  })
  requireValid(Number.isFinite(r.preferences.reduce((sum,p) => sum + p.weight, 0)), "偏好权重合计溢出")
  requireValid(Array.isArray(input.candidates), "candidates 必须为数组")
  requireValid(input.searchStatus !== "failed" || input.candidates.length === 0, "全部数据源失败时不能携带可用候选；使用 partial")
  const seen = new Set<string>()
  for (const c of input.candidates) {
    assertCandidate(c)
    if (c.skuId && c.offerId) { requireValid(!seen.has(key(c)), "重复 Offer 身份，请 A 先去重"); seen.add(key(c)) }
    if (c.text !== undefined) requireValid(record(c.text) && record(c.text.searchable), "text.searchable 格式无效")
    if (c.merchant !== undefined) requireValid(record(c.merchant) && nonempty(c.merchant.id) && record(c.merchant.name), "merchant 格式无效")
    if (c.quote !== undefined) requireValid(record(c.quote) && Number.isSafeInteger(c.quote.quantity) && c.quote.quantity > 0 && nonempty(c.quote.destination) &&
      [c.quote.totalMinor, c.quote.otherFeesMinor, c.quote.estimatedDeliveryAtMs].every(record), "quote 格式无效")
    for (const [path,type] of Object.entries(fields)) {
      const f = factAt(c, path)
      if (f === undefined) continue
      requireValid(record(f) && (f.value === null || typeof f.value === type) && ["verified", "unverified", "mock"].includes(f.status), `${path} Fact 类型无效`)
      const placeholder = f.value === null && f.status === "unverified" && f.source === "" && f.fetchedAt === ""
      requireValid(placeholder || (nonempty(f.source) && Number.isFinite(Date.parse(f.fetchedAt))), `${path} 缺少来源/时间`)
      requireValid(f.validUntil === undefined || Number.isFinite(Date.parse(f.validUntil)), `${path}.validUntil 无效`)
      if (typeof f.value === "number") requireValid(Number.isFinite(f.value) && (!/Minor$|AtMs$/.test(path) || money(f.value)), `${path} 数值无效`)
      requireValid(f.source !== "mock-dataset" || f.status === "mock", "演示来源不得标记为真实核验")
    }
  }
}

function factAt(c: ShoppingCandidate, path: string): Fact<number | string | boolean> | undefined {
  const [section, field] = path.split(".")
  const container = (c as unknown as Record<string, unknown>)[section]
  return record(container) && Object.hasOwn(container, field) ? container[field] as Fact<number | string | boolean> : undefined
}

/** Pure decision evaluation. Caller persists decisionRecord; no order or shared-state mutation. */
export async function evaluateShoppingCandidates(raw: ContractEvaluationInput, policy: ContractBPolicy): Promise<ContractBResult> {
  validate(raw, policy)
  const input = structuredClone(raw)
  const { requirement: r, quantity } = input
  const now = policy.now?.() ?? new Date()
  requireValid(Number.isFinite(now.getTime()), "now 必须是有效日期")
  const at = now.getTime()
  const warnings = new Set<string>()
  let conflictingRequirement = false
  if (r.allowAlternativeProducts === false && !r.hardConstraints.some(c => c.field === "attributes.productName" && c.op === "eq")) {
    conflictingRequirement = true
    warnings.add("禁止替换指定商品，但缺少 attributes.productName 精确条件，需要主 Agent 补充身份")
  }
  for (const field of new Set(r.hardConstraints.map(c => c.field))) {
    const conditions = r.hardConstraints.filter(c => c.field === field)
    const lower = Math.max(-Infinity, ...conditions.filter(c => c.op === "gte" || c.op === "eq" && typeof c.value === "number").map(c => Number(c.value)))
    const upper = Math.min(Infinity, ...conditions.filter(c => c.op === "lte" || c.op === "eq" && typeof c.value === "number").map(c => Number(c.value)))
    const equals = conditions.filter(c => c.op === "eq").map(c => typeof c.value === "string" ? normalize(c.value) : c.value)
    if (lower > upper || new Set(equals).size > 1) {
      conflictingRequirement = true
      warnings.add(`${field}: 用户硬条件互相矛盾，需要主 Agent 复问`)
    }
  }
  if (policy.dataEnvironment === "development_mock") warnings.add("development_mock：仅模拟匹配，不能用于真实购买")
  if (input.searchStatus === "partial") warnings.add("部分来源不可用；结论仅覆盖当前已获取候选")
  const aliases = policy.categoryAliases ?? {}
  const category = (s: string) => normalize(aliases[normalize(s)] ?? s)
  const usable = (c: ShoppingCandidate, path: string): number | string | boolean | null => {
    const f = factAt(c, path)
    if (!f || f.value === null || f.status === "unverified") return null
    if (f.status === "mock" && policy.dataEnvironment !== "development_mock") return null
    const fetched = Date.parse(f.fetchedAt)
    const ttl = /^(offer|quote)\./.test(path) ? policy.offerTtlMs ?? 300000 : policy.staticTtlMs ?? 86400000
    if (fetched > at || at - fetched >= ttl || (f.validUntil && Date.parse(f.validUntil) <= at)) return null
    return f.value
  }
  const check = (id: string, value: boolean | null, fields: string[], reason: string): ConditionCheck => ({
    conditionId: id, outcome: value === null ? "unknown" : value ? "match" : "mismatch", evidenceFields: fields, reason,
  })
  const matches = (c: ShoppingCandidate, cond: Constraint): boolean | null => {
    const value = usable(c, cond.field)
    if (value === null) return null
    switch (cond.op) {
      case "eq": return typeof value === "string" && typeof cond.value === "string" ? normalize(value) === normalize(cond.value) : value === cond.value
      case "lte": return Number(value) <= Number(cond.value)
      case "gte": return Number(value) >= Number(cond.value)
      case "in": return (cond.value as string[]).some(x => normalize(x) === normalize(String(value)))
      case "notIn": return !(cond.value as string[]).some(x => normalize(x) === normalize(String(value)))
      case "containsAny": return (cond.value as string[]).some(x => normalize(String(value)).includes(normalize(x)))
      case "notContainsAny": return !(cond.value as string[]).some(x => normalize(String(value)).includes(normalize(x)))
    }
  }
  const and = (values: (boolean | null)[]) => values.includes(false) ? false : values.includes(null) ? null : true
  const totals = new Map<ShoppingCandidate, number | null>()
  const audits: CandidateAudit[] = input.candidates.map(c => {
    const checks: ConditionCheck[] = []
    const add = (id: string, v: boolean | null, fields: string[], reason: string) => checks.push(check(`system:${id}`, v, fields, reason))
    add("identity", c.skuId && c.offerId ? true : null, [], "需要明确 SKU 和 Offer")
    const cat = usable(c, "attributes.category")
    add("category", cat === null ? null : category(String(cat)) === category(r.category), ["attributes.category"], "商品类别必须符合需求")
    add("currency", c.offer ? c.offer.currency === r.currency : null, ["offer.currency"], "币种必须一致")
    add("excluded", !r.excludedProductIds.includes(c.productId), [], "遵守用户商品排除列表")
    const context = !!c.quote && c.quote.quantity === quantity && normalize(c.quote.destination) === normalize(r.destination!)
    add("quote-context", context ? true : null, ["quote.quantity", "quote.destination"], "报价必须绑定本次数量和地区；不匹配需重新报价")
    const price = usable(c, "offer.itemPriceMinor"), discount = usable(c, "offer.discountMinor")
    const shipping = usable(c, "offer.shippingMinor"), fees = usable(c, "quote.otherFeesMinor"), quoted = usable(c, "quote.totalMinor")
    const item = context && typeof price === "number" && typeof discount === "number" ? price * quantity - discount : null
    const total = item !== null && typeof shipping === "number" && typeof fees === "number" ? item + shipping + fees : null
    const consistent = item !== null && money(item) && total !== null && money(total) && total === quoted
    totals.set(c, consistent ? total : null)
    const budgetAmount = r.budget.scope === "item" ? item !== null && money(item) ? item : null : consistent ? total : null
    add("budget", budgetAmount === null ? null : budgetAmount <= r.budget.maxMinor,
      r.budget.scope === "item" ? ["offer.itemPriceMinor", "offer.discountMinor"] : ["offer.itemPriceMinor", "offer.discountMinor", "offer.shippingMinor", "quote.otherFeesMinor", "quote.totalMinor"],
      budgetAmount === null ? "费用缺失、报价不一致或金额无效" : `本次数量金额 ${budgetAmount}，预算上限 ${r.budget.maxMinor}`)
    const stock = usable(c, "offer.stock"), delivery = usable(c, "offer.deliverable")
    add("stock", stock === null ? null : stock === "available", ["offer.stock"], "必须有货")
    add("delivery", delivery === null || !context ? null : delivery === true, ["offer.deliverable"], "必须可配送至请求地区")
    if (quantity > 1) { const can = usable(c, "quote.canFulfillQuantity"); add("quantity", !context || can === null ? null : can === true, ["quote.canFulfillQuantity"], "商户必须可履约本次销售单位数量") }
    const platform = usable(c, "merchant.platformId")
    add("channel-allowlist", !c.merchant || platform === null || !policy.merchantAllowlist.length ? null : policy.merchantAllowlist.some(m => m.id === c.merchant!.id && m.platformId === platform), ["merchant.platformId"], "商户及平台必须在服务端白名单")
    const benchmark = policy.priceBenchmarks.filter(b => b.productId === c.productId && b.skuId === c.skuId && b.currency === r.currency &&
      normalize(b.destination) === normalize(r.destination!) && b.offerCount >= 5 && b.sellerCount >= 3 && b.excludedOfferIds.includes(c.offerId ?? "") &&
      at >= Date.parse(b.fetchedAt) && at - Date.parse(b.fetchedAt) < 7 * 86400000).sort((a,b) => Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt))[0]
    if (!benchmark) warnings.add(`${c.productId}: benchmark_insufficient（未完成异常低价统计检查，不据此单独淘汰）`)
    else add("low-price-risk", item === null || !money(item) ? null : item / quantity < benchmark.medianUnitPriceMinor * (policy.lowPriceRatio ?? 0.5) ? null : true,
      ["offer.itemPriceMinor", "offer.discountMinor"], "低于可比中位价阈值时需专项复查；不能仅凭低价断定假货")
    r.hardConstraints.forEach((cond,i) => checks.push(check(cond.id ?? `hard:${i}`, matches(c, cond), [cond.field], `${cond.field} ${cond.op} ${JSON.stringify(cond.value)}`)))
    // A retains unknown hard conditions. Its score (including unknown=3) is not proof.
    if (input.sourceSearchInput) {
      for (const condition of buildScoringConditions(input.sourceSearchInput).filter(x => x.must === 1)) {
        const sourceCandidate = { ...c, category: c.category ?? "", searchableText: c.searchableText ?? {} } as Candidate
        const assessment = assessCondition(sourceCandidate, condition)
        const fields = assessment.evidenceFields.map(f => f === "title" ? "attributes.productName" : f)
        const fresh = fields.every(f => usable(c, f) !== null)
        checks.push(check(`search:${condition.id}`, !fresh || assessment.state === "unknown" ? null : assessment.state === "pass", fields, assessment.reason))
      }
    }
    const preferenceChecks = r.preferences.map((p,i) => check(p.id ?? `prefer:${i}`, and(p.conditions!.map(cond => matches(c,cond))), p.conditions!.map(cond => cond.field), `偏好条件组 ${p.id ?? i}`))
    const sum = r.preferences.reduce((s,p) => s+p.weight,0)
    const weight = (state: string) => r.preferences.reduce((s,p,i) => s+(preferenceChecks[i].outcome === state ? p.weight : 0),0)
    return { ...identity(c), checks, preferenceChecks,
      disposition: checks.some(x => x.outcome === "mismatch") ? "rejected" : checks.some(x => x.outcome === "unknown") ? "needs_verification" : "eligible",
      scoreLowerBound: sum ? 100 * (weight("match") / sum) : null,
      scoreUpperBound: sum ? 100 * ((weight("match") + weight("unknown")) / sum) : null,
    }
  })
  const ranked = input.candidates.map((c,i) => ({ c, audit: audits[i] })).filter(x => x.audit.disposition === "eligible").sort((a,b) =>
    (b.audit.scoreLowerBound ?? 0)-(a.audit.scoreLowerBound ?? 0) ||
    ((totals.get(a.c) ?? Infinity) - (totals.get(b.c) ?? Infinity) || 0) || (key(a.c) < key(b.c) ? -1 : key(a.c) > key(b.c) ? 1 : 0))
  const recommendations: ContractBResult["recommendations"] = ranked.slice(0,1).map(({c,audit}) => ({
    ...identity(c), rank: 1, evidenceStatus: policy.dataEnvironment === "development_mock" ? "mock" : "verified",
    checks: audit.checks, preferenceChecks: audit.preferenceChecks, scoreLowerBound: audit.scoreLowerBound, scoreUpperBound: audit.scoreUpperBound,
    explanation: `${policy.dataEnvironment === "development_mock" ? "模拟数据：" : ""}满足当前硬条件，按已证实偏好下界、可比较总价和稳定身份排序选为首选。`,
    tradeoffs: [...audit.preferenceChecks.filter(x => x.outcome !== "match").map(x => `${x.conditionId}: ${x.outcome}`),
      ...(ranked.some(x => x !== ranked[0] && x.audit.scoreUpperBound !== null && x.audit.scoreUpperBound >= (audit.scoreLowerBound ?? 0)) ? ["偏好分数区间重叠，不能断言必然最佳"] : [])],
  }))
  const configurationMissing = !policy.merchantAllowlist.length
  const status: ContractBResult["status"] = conflictingRequirement || configurationMissing || input.searchStatus === "failed" ? "failed" : recommendations.length ? "result_ready" : audits.some(a => a.disposition === "needs_verification") ? "needs_verification" : "no_match"
  const verificationRequests = audits.filter(a => a.disposition !== "rejected").flatMap(a => {
    const fields = [...new Set([...a.checks, ...a.preferenceChecks].filter(x => x.outcome === "unknown").flatMap(x => x.evidenceFields))]
    return fields.length ? [{ productId: a.productId, skuId: a.skuId, offerId: a.offerId, fields, reason: "补查未知、过期或存在矛盾的事实，并保持报价上下文一致" }] : []
  })
  const logs = new Map<string, ContractBResult["diagnostics"]["filterLogs"][number]>()
  for (const audit of audits) for (const c of audit.checks) {
    const row = logs.get(c.conditionId) ?? { conditionId: c.conditionId, inputCount: 0, matchedCount: 0, rejectedCount: 0, unknownCount: 0 }
    row.inputCount++
    row[c.outcome === "match" ? "matchedCount" : c.outcome === "mismatch" ? "rejectedCount" : "unknownCount"]++
    logs.set(c.conditionId,row)
  }
  const selected = status === "result_ready" ? recommendations[0] : null
  let paymentOptimization: ContractBResult["paymentOptimization"]
  if (input.paymentContext !== undefined) {
    requireValid(input.paymentContext?.taskId === r.taskId && input.paymentContext.requirementVersion === r.requirementVersion, "支付上下文任务或需求版本不匹配")
    const candidate = selected ? ranked[0].c : null
    let order: PaymentOrder | null = null
    if (candidate?.quote && candidate.offer && totals.get(candidate) !== null) {
      const facts = [candidate.offer.itemPriceMinor, candidate.offer.discountMinor, candidate.offer.shippingMinor,
        candidate.quote.otherFeesMinor, candidate.quote.totalMinor]
      // A total must not outlive any of its component facts.
      const validUntil = new Date(Math.min(...facts.map(f => Math.min(Date.parse(f.fetchedAt) + (policy.offerTtlMs ?? 300000),
        f.validUntil ? Date.parse(f.validUntil) : Infinity)))).toISOString()
      order = { taskId: r.taskId, requirementVersion: r.requirementVersion,
        quote: { ...identity(candidate), quantity, destination: r.destination!, currency: r.currency, totalMinor: totals.get(candidate)! },
        total: { ...candidate.quote.totalMinor, validUntil, status: facts.some(f => f.status === "mock") ? "mock" : candidate.quote.totalMinor.status },
        maxUpfrontMinor: r.budget.scope === "delivered" ? r.budget.maxMinor : null }
    }
    paymentOptimization = optimizePaymentMethods(order, input.paymentContext, {
      ...policy.payment, policyVersion: policy.policyVersion, dataEnvironment: policy.dataEnvironment, now: () => now,
    })
  }
  const decisionRecord = {
    decisionId: createHash("sha256").update(JSON.stringify({input, audits, policy: { ...policy, now: undefined }, checkedAt: now.toISOString()})).digest("hex"),
    taskId: r.taskId, requirementVersion: r.requirementVersion, checkedAt: now.toISOString(), policyVersion: policy.policyVersion,
    dataEnvironment: policy.dataEnvironment, requestSnapshot: {requirement: r, quantity}, candidateSnapshots: input.candidates, audits, selected,
    ...(paymentOptimization ? { paymentContextSnapshot: input.paymentContext, paymentOptimization } : {}),
  }
  const result: ContractBResult = { taskId: r.taskId, requirementVersion: r.requirementVersion, dataEnvironment: policy.dataEnvironment, status,
    candidates: input.candidates, recommendations: selected ? recommendations : [], decisionRecord,
    ...(paymentOptimization ? { paymentOptimization } : {}),
    diagnostics: { searchStatus: input.searchStatus, countUnit: "offer", candidateChecks: audits, filterLogs: [...logs.values()], verificationRequests,
      warnings: [...warnings], nextAction: conflictingRequirement ? "clarify" : configurationMissing ? "resolve_configuration" : status === "needs_verification" ? "verify" : status === "no_match" ? "search" : "none" },
    ...(status === "failed" ? {error: {code: conflictingRequirement ? "INVALID_INPUT" as const : "SOURCE_UNAVAILABLE" as const, message: conflictingRequirement ? "用户硬条件互相矛盾" : configurationMissing ? "服务端未配置渠道白名单" : "全部数据源不可用", retryable: !configurationMissing && !conflictingRequirement}} : {}),
  }
  if (selected) {
    const candidate = ranked[0].c
    result.plan = { title: `${candidate.title} × ${quantity}`,
      notice: policy.dataEnvironment === "development_mock" ? "模拟选品，不代表真实购买或支付授权。" : "选品已通过；下单前仍需订单核价与最终风控。",
      priceMinor: candidate.quote && totals.get(candidate) !== null ? structuredClone(candidate.quote.totalMinor)
        : { value: null, source: "", fetchedAt: "", status: "unverified" } }
  } else if (status === "no_match") result.reason = "本次候选未满足全部硬条件，不代表全市场不存在匹配商品。"
  else if (status === "needs_verification") result.missingFacts = [...new Set(verificationRequests.flatMap(x => x.fields))]
  // Validate invariants before exposing an executable-looking recommendation.
  requireValid(result.recommendations.length <= 1 && (status !== "result_ready" || result.recommendations.length === 1), "结果状态与推荐数量矛盾")
  for (const rec of result.recommendations) requireValid(rec.checks.every(c => c.outcome === "match") &&
    [rec.scoreLowerBound, rec.scoreUpperBound].every(n => n === null || Number.isFinite(n) && n >= 0 && n <= 100), "输出审核或分数无效")
  return structuredClone(result)
}

/** Explain exclusively from a persisted snapshot; does not fetch current product data. */
export function explainDecision(record: ContractBResult["decisionRecord"]): string {
  const selected = record.selected
  if (!selected) return "这次审核没有选出最终商品。"
  return [record.dataEnvironment === "development_mock" ? "这是模拟选品记录，未实际下单。" : "这是当时的选品依据，不代表订单已经完成。",
    selected.explanation, ...selected.checks.map(x => `${x.conditionId}: ${x.reason}`), ...selected.tradeoffs,
    ...(record.paymentOptimization?.recommended ? [record.paymentOptimization.recommended.explanation,
      ...record.paymentOptimization.warnings] : [])].join("\n")
}

/** Backend authorization must be queried again. This function never submits orders. */
export async function checkShoppingPurchase(
  input: ContractEvaluationInput & { authorizationId: string | null },
  policy: ContractBPolicy,
  context: { getAuthorizationById: (id: string) => Promise<Authorization | null>; timeoutMs?: number },
): Promise<PurchaseCheck> {
  const snapshot = structuredClone(input)
  let now = policy.now?.() ?? new Date()
  const result = (status: PurchaseCheck["status"], reasons: string[], totalMinor: number | null = null,
    requests: PurchaseCheck["verificationRequests"] = []): PurchaseCheck => ({
    taskId: snapshot.requirement.taskId, requirementVersion: snapshot.requirement.requirementVersion,
    offerId: snapshot.candidates[0]?.offerId ?? null, checkedAt: now.toISOString(), status, reasons, totalMinor, verificationRequests: requests,
  })
  validate(snapshot, policy)
  requireValid(snapshot.candidates.length === 1, "购买复核必须指定一个候选")
  requireValid(Number.isFinite(now.getTime()), "now 无效")
  if (policy.dataEnvironment !== "verified_sources") return result("blocked", ["Mock 环境不能批准真实购买"])
  if (!snapshot.authorizationId || !context?.getAuthorizationById) return result("blocked", ["缺少后端授权查询或授权 ID"])
  let auth: Authorization | null
  const timeoutMs = context.timeoutMs ?? 5000
  requireValid(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "授权查询超时必须为正整数")
  let timer: ReturnType<typeof setTimeout> | undefined
  try { auth = await Promise.race([context.getAuthorizationById(snapshot.authorizationId), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)
  })]) }
  catch { return result("blocked", ["后端授权查询失败或超时"])}
  finally { if (timer) clearTimeout(timer) }
  now = policy.now?.() ?? new Date()
  requireValid(Number.isFinite(now.getTime()), "now 无效")
  if (!auth || auth.authorizationId !== snapshot.authorizationId || auth.allowedOfferId !== snapshot.candidates[0].offerId ||
    auth.currency !== snapshot.requirement.currency || !Number.isFinite(Date.parse(auth.expiresAt)) || Date.parse(auth.expiresAt) <= now.getTime() ||
    !Number.isSafeInteger(auth.maxQuantity) || auth.maxQuantity < snapshot.quantity || !money(auth.maxTotalMinor)) return result("blocked", ["后端授权缺失、失效或不涵盖本次购买"])
  // Even an item-only search budget needs a verified delivered total before purchase.
  const candidate = snapshot.candidates[0]
  const purchasePolicy: ContractBPolicy = { ...policy, now: () => now, offerTtlMs: Math.min(policy.offerTtlMs ?? 60000, 60000),
    payment: { ...policy.payment, factTtlMs: Math.min(policy.payment?.factTtlMs ?? 60000, 60000) } }
  const evaluation = await evaluateShoppingCandidates(snapshot, purchasePolicy)
  if (evaluation.status !== "result_ready") return result(evaluation.status === "needs_verification" ? "needsVerification" : "blocked",
    ["购买前审核未通过", ...evaluation.diagnostics.candidateChecks.flatMap(a => a.checks.filter(c => c.outcome !== "match").map(c => c.reason))], null, evaluation.diagnostics.verificationRequests)
  const delivered = await evaluateShoppingCandidates({ ...snapshot, requirement: { ...snapshot.requirement, budget: { scope: "delivered", maxMinor: auth.maxTotalMinor } } },
    purchasePolicy)
  if (delivered.status !== "result_ready") return result(delivered.status === "needs_verification" ? "needsVerification" : "blocked", ["最终到手价未知或超出授权"], null, delivered.diagnostics.verificationRequests)
  if (snapshot.paymentContext) {
    // Preserve BOTH the user's delivered budget and the authorization cap. Cashback is never deducted.
    const payment = evaluation.paymentOptimization?.status === "ready" ? delivered.paymentOptimization : evaluation.paymentOptimization
    if (payment?.status !== "ready") return {
      ...result(payment?.status === "needs_verification" ? "needsVerification" : "blocked", ["支付方案待核验或含手续费扣款超出需求/授权上限"]),
      paymentOptimization: payment,
    }
    // Re-ranking under a different cap must not silently switch the chosen card at purchase time.
    if (payment.recommended?.optionId !== evaluation.paymentOptimization?.recommended?.optionId) return {
      ...result("blocked", ["授权范围改变了支付方案，需主 Agent 重新确认"]), paymentOptimization: payment,
    }
    return { ...result("approved", ["商品及支付预检查通过；仍需独立最终风控核验支付方式和订单"], candidate.quote!.totalMinor.value), paymentOptimization: payment }
  }
  return result("approved", ["最新硬条件、渠道、报价及后端授权均通过；下单仍由独立执行模块负责"], candidate.quote!.totalMinor.value)
}
