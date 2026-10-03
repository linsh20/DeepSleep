// Test-only frozen compatibility fixture for retained pre-integration regressions.
import {
  canonicalField, identityKey, MockProductProvider, offerFields, ProductProviderError,
} from "./product-provider"
import type { ProductProvider, RawProduct } from "./product-provider"
import type {
  AttributeValue, ShoppingCandidate as Candidate, Fact, ProductIdentity, Requirement, SearchErrorCode,
  SearchPlan, SearchResult, VerificationRequest,
} from "../../types/shopping"

type SearchInput = { requirement: Requirement; limit: number }
type VerifyInput = { requirement: Requirement; candidates: Candidate[]; requests: VerificationRequest[] }
const money = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const scalar = (value: unknown): value is AttributeValue =>
  typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function validIdentity(value: ProductIdentity): boolean {
  if (!value || !nonempty(value.productId) ||
      !(value.skuId === null || nonempty(value.skuId)) ||
      !(value.offerId === null || nonempty(value.offerId))) return false
  const ids = [value.productId, value.skuId, value.offerId].filter((id) => id !== null)
  return new Set(ids).size === ids.length
}

function validRequirement(value: Requirement): boolean {
  return !!value && nonempty(value.taskId) && Number.isSafeInteger(value.requirementVersion) &&
    value.requirementVersion >= 0 && nonempty(value.category) && nonempty(value.query) &&
    typeof value.currency === "string" && /^[A-Za-z]{3}$/.test(value.currency) &&
    !!value.budget && money(value.budget.maxMinor) && ["item", "delivered"].includes(value.budget.scope) &&
    Array.isArray(value.hardConstraints) && value.hardConstraints.every((constraint) => {
      if (!constraint || typeof constraint.field !== "string" || !canonicalField(constraint.field)) return false
      if (constraint.op === "lte" || constraint.op === "gte") {
        return typeof constraint.value === "number" && Number.isFinite(constraint.value)
      }
      if (constraint.op === "in" || constraint.op === "notIn") {
        return Array.isArray(constraint.value) && constraint.value.every((entry) => typeof entry === "string")
      }
      return constraint.op === "eq" && scalar(constraint.value)
    }) &&
    Array.isArray(value.preferences) && value.preferences.every((preference) =>
      preference && typeof preference.field === "string" && !!canonicalField(preference.field) &&
      typeof preference.weight === "number" && Number.isFinite(preference.weight) && preference.weight >= 0 &&
      ["explicit", "inferred"].includes(preference.source)) &&
    Array.isArray(value.excludedProductIds) && value.excludedProductIds.every(nonempty) &&
    (value.destination === undefined || nonempty(value.destination))
}

/** Deterministic recall only; preferences request facts but never affect ordering. */
export function buildSearchPlan(requirement: Requirement): SearchPlan {
  if (!validRequirement(requirement)) throw new ProductProviderError("INVALID_INPUT", "Invalid requirement.")
  const constraints = requirement.hardConstraints.map((constraint) => ({
    ...constraint, field: canonicalField(constraint.field)!,
    value: Array.isArray(constraint.value) ? [...constraint.value] : constraint.value,
  }))
  return {
    category: requirement.category.trim().toLowerCase(),
    terms: requirement.query.trim().toLowerCase().split(/\s+/),
    currency: requirement.currency.toUpperCase(), budget: { ...requirement.budget },
    constraints, excludedProductIds: [...requirement.excludedProductIds],
    requiredFields: [...new Set([
      ...constraints.flatMap(({ field }) => factDependencies(field)),
      ...requirement.preferences.flatMap(({ field }) => factDependencies(canonicalField(field)!)),
    ])],
    destination: requirement.destination,
  }
}

function factDependencies(field: string): string[] {
  if (field === "netItemPriceMinor") return ["offer.itemPriceMinor", "offer.discountMinor"]
  if (field === "totalPrice" || field === "deliveredTotalMinor") {
    return ["offer.itemPriceMinor", "offer.shippingMinor", "offer.discountMinor"]
  }
  return [field]
}

function warning(error: unknown): string {
  const messages: Record<SearchErrorCode, string> = {
    INVALID_INPUT: "Invalid input or unsupported field path.",
    SOURCE_UNAVAILABLE: "Product source failed or returned invalid data.",
    TIMEOUT: "Product source exceeded the request timeout.",
    UNSUPPORTED_CATEGORY: "Product source does not support this category.",
  }
  const code = error instanceof ProductProviderError ? error.code : "SOURCE_UNAVAILABLE"
  return `${code}: ${messages[code]}`
}

function result(requirement: Requirement, candidates: Candidate[], status: SearchResult["status"], warnings: string[]): SearchResult {
  return {
    taskId: requirement?.taskId ?? "", requirementVersion: requirement?.requirementVersion ?? 0,
    candidates, status, warnings: [...new Set(warnings)],
  }
}

async function timed<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ProductProviderError("TIMEOUT", "Provider timed out.")
          reject(error)
          controller.abort(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function getFact(candidate: Candidate, path: string): Fact<AttributeValue> | undefined {
  if (path.startsWith("attributes.")) return candidate.attributes[path.slice(11)]
  return candidate.offer?.[path.slice(6) as typeof offerFields[number]]
}

function setFact(candidate: Candidate, path: string, fact: Fact<AttributeValue>): void {
  if (path.startsWith("attributes.")) candidate.attributes[path.slice(11)] = fact
  else if (candidate.offer) Object.assign(candidate.offer, { [path.slice(6)]: fact })
}

function markMissing(candidate: Candidate, requiredFields: string[]): Candidate {
  const fields = new Set([
    ...requiredFields, ...Object.keys(candidate.attributes).map((key) => `attributes.${key}`),
    ...offerFields.map((key) => `offer.${key}`),
  ])
  candidate.missingFields = [
    ...(candidate.skuId === null ? ["skuId"] : []),
    ...(candidate.offerId === null ? ["offerId"] : []),
    ...(candidate.offer === null ? ["offer"] : []),
    ...[...fields].filter((path) => getFact(candidate, path)?.value == null),
  ].sort()
  return candidate
}

function normalize(raw: RawProduct, requiredFields: string[], warnings: string[]): Candidate {
  if (!validIdentity(raw) || !nonempty(raw.title) || !nonempty(raw.category) ||
      !nonempty(raw.url) || !/^https?:\/\//.test(raw.url) || !nonempty(raw.source) ||
      !nonempty(raw.fetchedAt) || !Number.isFinite(Date.parse(raw.fetchedAt)) ||
      !["verified", "unverified", "mock"].includes(raw.status) || !record(raw.attributes)) {
    throw new ProductProviderError("SOURCE_UNAVAILABLE", "Malformed product.")
  }
  const fact = <T>(value: unknown, valid: (input: unknown) => input is T): Fact<T> => {
    if (value != null && !valid(value)) warnings.push(`SOURCE_UNAVAILABLE: Invalid fact on ${raw.productId}.`)
    return {
      value: value != null && valid(value) ? value : null,
      source: raw.source, fetchedAt: raw.fetchedAt, status: raw.status,
    }
  }
  const attributes: Candidate["attributes"] = {}
  for (const key of new Set([
    ...Object.keys(raw.attributes),
    ...requiredFields.filter((path) => path.startsWith("attributes.")).map((path) => path.slice(11)),
  ])) {
    if (canonicalField(`attributes.${key}`)) attributes[key] = fact(raw.attributes[key], scalar)
  }
  let offer: Candidate["offer"] = null
  if (raw.offer != null) {
    if (!record(raw.offer) || typeof raw.offer.currency !== "string" || !/^[A-Za-z]{3}$/.test(raw.offer.currency)) {
      warnings.push(`SOURCE_UNAVAILABLE: Invalid offer on ${raw.productId}.`)
    } else {
      offer = {
        currency: raw.offer.currency.toUpperCase(),
        itemPriceMinor: fact(raw.offer.itemPriceMinor, money),
        shippingMinor: fact(raw.offer.shippingMinor, money),
        discountMinor: fact(raw.offer.discountMinor, money),
        stock: fact(raw.offer.stock, (value): value is "available" | "unavailable" => value === "available" || value === "unavailable"),
        deliverable: fact(raw.offer.deliverable, (value): value is boolean => typeof value === "boolean"),
      }
    }
  }
  return markMissing({
    productId: raw.productId, skuId: raw.skuId, offerId: raw.offerId,
    title: raw.title, url: raw.url, attributes, offer, missingFields: [],
  }, requiredFields)
}

/** Inject a provider here when adding a real API; public input/output stay stable. */
export function createSearchAgent(provider: ProductProvider, options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ProductProviderError("INVALID_INPUT", "timeoutMs must be a positive integer.")
  }

  async function searchCandidates(input: SearchInput): Promise<SearchResult> {
    const requirement = input?.requirement
    try {
      const plan = buildSearchPlan(requirement)
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new ProductProviderError("INVALID_INPUT", "limit must be between 1 and 100.")
      }
      const response = await timed((signal) => provider.search(plan, input.limit, { signal, requirement }), timeoutMs)
      if (!response || !Array.isArray(response.products) || !["complete", "partial"].includes(response.status) ||
          (response.warnings !== undefined && (!Array.isArray(response.warnings) || !response.warnings.every((entry) => typeof entry === "string")))) {
        throw new ProductProviderError("SOURCE_UNAVAILABLE", "Malformed search response.")
      }
      const warnings = [...(response.warnings ?? [])]
      const candidates = new Map<string, Candidate>()
      let rejected = 0
      for (const raw of response.products) {
        try {
          const candidate = normalize(raw, plan.requiredFields, warnings)
          if (plan.excludedProductIds.includes(candidate.productId)) continue
          const key = identityKey(candidate)
          if (!candidates.has(key)) candidates.set(key, candidate)
        } catch (error) {
          rejected++
          warnings.push(warning(error))
        }
      }
      const status = rejected > 0 && rejected === response.products.length ? "failed" :
        response.status === "partial" || warnings.length > 0 ? "partial" : "complete"
      if (response.status === "partial") warnings.push("SOURCE_UNAVAILABLE: Source returned only partial results.")
      return result(requirement, [...candidates.values()].slice(0, input.limit), status, warnings)
    } catch (error) {
      return result(requirement, [], "failed", [warning(error)])
    }
  }

  async function verifyFacts(input: VerifyInput): Promise<SearchResult> {
    const requirement = input?.requirement
    if (!validRequirement(requirement) || !Array.isArray(input?.candidates) || !Array.isArray(input?.requests) ||
        !input.candidates.every((candidate) => validIdentity(candidate) && record(candidate.attributes) &&
          (candidate.offer === null || record(candidate.offer)) && Array.isArray(candidate.missingFields) &&
          candidate.missingFields.every((field) => typeof field === "string")) ||
        !input.requests.every((request) => validIdentity(request) && typeof request.reason === "string" &&
          Array.isArray(request.fields) && request.fields.every((field) =>
            typeof field === "string" && /^(attributes|offer)\./.test(canonicalField(field) ?? "")))) {
      return result(requirement, [], "failed", [warning(new ProductProviderError("INVALID_INPUT", "Invalid verification request."))])
    }
    const candidates = structuredClone(input.candidates)
    const groups = new Map<string, { identity: ProductIdentity; fields: Set<string> }>()
    for (const request of input.requests) {
      if (!request.fields.length) continue
      const key = identityKey(request)
      const group = groups.get(key) ?? { identity: request, fields: new Set<string>() }
      request.fields.forEach((field) => group.fields.add(canonicalField(field)!))
      groups.set(key, group)
    }
    const outcomes = await Promise.all([...groups].map(async ([key, { identity, fields }]) => {
      const targets = candidates.filter((candidate) => identityKey(candidate) === key)
      const warnings: string[] = []
      if (!targets.length) return { failed: true, warnings: [`INVALID_INPUT: Requested candidate ${identity.productId} is not in this result.`] }
      try {
        const raw = await timed((signal) => provider.getProductDetails(identity, [...fields], { signal, requirement }), timeoutMs)
        if (!raw || identityKey(raw) !== key) throw new ProductProviderError("SOURCE_UNAVAILABLE", "No matching details.")
        const normalized = normalize(raw, [...fields], warnings)
        for (const target of targets) {
          for (const field of fields) {
            const previous = getFact(target, field)
            const incoming = getFact(normalized, field)
            // A price fact cannot be copied into an offer denominated in another currency.
            const sameCurrency = !field.startsWith("offer.") || target.offer?.currency === normalized.offer?.currency
            if (incoming && sameCurrency && (incoming.value !== null || previous?.value == null)) {
              setFact(target, field, incoming)
            }
            if (incoming?.value == null && previous?.value != null) {
              warnings.push(`SOURCE_UNAVAILABLE: Could not refresh ${field} for ${identity.productId}; retained existing fact.`)
            }
            if (getFact(target, field)?.value == null) {
              warnings.push(`SOURCE_UNAVAILABLE: ${identity.productId} has no fact for ${field}.`)
            } else if (!sameCurrency) {
              warnings.push(`SOURCE_UNAVAILABLE: Offer currency changed for ${identity.productId}.`)
            }
          }
        }
      } catch (error) {
        warnings.push(warning(error))
        return { failed: true, warnings }
      } finally {
        for (const target of targets) {
          for (const field of fields) {
            if (!getFact(target, field)) setFact(target, field, { value: null, source: "", fetchedAt: "", status: "unverified" })
          }
          markMissing(target, [...target.missingFields.filter((field) => canonicalField(field) === field), ...fields])
        }
      }
      return { failed: false, warnings }
    }))
    const warnings = outcomes.flatMap((outcome) => outcome.warnings)
    const status = outcomes.length > 0 && outcomes.every((outcome) => outcome.failed) ? "failed" :
      warnings.length ? "partial" : "complete"
    return result(requirement, candidates, status, warnings)
  }

  return { searchCandidates, verifyFacts }
}

const defaultAgent = createSearchAgent(new MockProductProvider())
export const searchCandidates = defaultAgent.searchCandidates
export const verifyFacts = defaultAgent.verifyFacts
