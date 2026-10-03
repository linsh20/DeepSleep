import type { Candidate } from "../types"
import { identityKey } from "./product-provider"

export type PopularitySelection = {
  candidates: Candidate[]
  scores: Map<string, number | null>
  applied: boolean
}

export function selectByPopularity(candidates: Candidate[], limit = 10): PopularitySelection {
  const knownSales = candidates
    .map((candidate) => numericAttribute(candidate, "salesCount"))
    .filter((value): value is number => value !== null)
  const maxSales = Math.max(0, ...knownSales)
  const scores = new Map<string, number | null>()

  const ranked = candidates.map((candidate, index) => {
    const rating = numericAttribute(candidate, "rating")
    const sales = numericAttribute(candidate, "salesCount")
    const ratingScore = rating === null ? null : Math.min(1, Math.max(0, rating / 5))
    const salesScore = sales === null ? null : maxSales === 0 ? 1 : Math.log1p(sales) / Math.log1p(maxSales)
    const parts = [
      ratingScore === null ? null : { weight: 0.6, value: ratingScore },
      salesScore === null ? null : { weight: 0.4, value: salesScore },
    ].filter((part): part is { weight: number; value: number } => part !== null)
    const score = parts.length === 0
      ? null
      : parts.reduce((sum, part) => sum + part.weight * part.value, 0) /
        parts.reduce((sum, part) => sum + part.weight, 0)
    scores.set(identityKey(candidate), score)
    return { candidate, index, rating, sales, score }
  })

  ranked.sort((left, right) =>
    compareDescending(left.score, right.score) ||
    compareDescending(left.rating, right.rating) ||
    compareDescending(left.sales, right.sales) ||
    left.index - right.index ||
    identityKey(left.candidate).localeCompare(identityKey(right.candidate)))

  return {
    candidates: (candidates.length > limit ? ranked.slice(0, limit) : ranked).map(({ candidate }) => candidate),
    scores,
    applied: candidates.length > limit,
  }
}

function numericAttribute(candidate: Candidate, field: string): number | null {
  const value = candidate.attributes[field]?.value
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function compareDescending(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}
