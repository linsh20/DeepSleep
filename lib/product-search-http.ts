import type { SearchResult } from "../types/shopping"

/** Shared transport for the read-only search/verification endpoints. */
export async function productSearchResponse<T>(request: Request, action: (input: T) => Promise<SearchResult>): Promise<Response> {
  let input: Record<string, unknown>
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body")
    input = body as Record<string, unknown>
  } catch {
    return failure("INVALID_INPUT: Expected a JSON object.", 400)
  }
  const requirement = input.requirement as Record<string, unknown> | undefined
  if (!requirement || typeof requirement.taskId !== "string" ||
      !Number.isSafeInteger(requirement.requirementVersion)) {
    return failure("INVALID_INPUT: A task ID and requirement version are required.", 400)
  }
  const identity = { taskId: requirement.taskId, requirementVersion: requirement.requirementVersion as number }
  if ([input.candidates, input.requests].some((items) => Array.isArray(items) && items.length > 100)) {
    return failure("INVALID_INPUT: At most 100 candidates or requests are supported.", 400, identity)
  }
  try {
    const result = await action(input as T)
    const status = result.status !== "failed" ? 200 :
      result.warnings.some((item) => item.startsWith("INVALID_INPUT:")) ? 400 :
      result.warnings.some((item) => item.startsWith("UNSUPPORTED_CATEGORY:")) ? 422 :
      result.warnings.some((item) => item.startsWith("TIMEOUT:")) ? 504 : 503
    return Response.json(result, { status, headers: { "Cache-Control": "no-store" } })
  } catch {
    return failure("SOURCE_UNAVAILABLE: Unable to process the product request.", 503, identity)
  }
}

function failure(warning: string, status: number, identity = { taskId: "", requirementVersion: 0 }): Response {
  const result: SearchResult = { ...identity, candidates: [], status: "failed", warnings: [warning] }
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } })
}
