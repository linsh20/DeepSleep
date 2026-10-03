import type { RankedSearchResult, StructuredSearchInput } from "../types"

export async function productSearchResponse(
  request: Request,
  action: (input: StructuredSearchInput) => Promise<RankedSearchResult>,
): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > 100_000) {
    return failure("INVALID_INPUT: Request body is too large.", 400)
  }
  let input: unknown
  try {
    input = await request.json()
  } catch {
    return failure("INVALID_INPUT: Expected a JSON object.", 400)
  }
  try {
    const result = await action(input as StructuredSearchInput)
    const status = result.status !== "failed" ? 200
      : result.warnings.some((warning) => warning.startsWith("INVALID_INPUT:")) ? 400
      : result.warnings.some((warning) => warning.startsWith("TIMEOUT:")) ? 504
      : result.warnings.some((warning) => warning.startsWith("UNSUPPORTED_CATEGORY:")) ? 422
      : 503
    return Response.json(result, { status, headers: { "Cache-Control": "no-store" } })
  } catch {
    return failure("SOURCE_UNAVAILABLE: Unable to process the product request.", 503, resultIdentity(input))
  }
}

function failure(
  warning: string,
  status: number,
  identity = { taskId: "", requirementVersion: 0 },
): Response {
  const result: RankedSearchResult = {
    ...identity,
    status: "failed",
    outcome: "failed",
    candidates: [],
    filterLogs: [],
    warnings: [warning],
    message: "商品搜索失败。",
  }
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } })
}

function resultIdentity(value: unknown): { taskId: string; requirementVersion: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { taskId: "", requirementVersion: 0 }
  }
  const record = value as Record<string, unknown>
  return typeof record.taskId === "string" && Number.isSafeInteger(record.requirementVersion)
    ? { taskId: record.taskId, requirementVersion: record.requirementVersion as number }
    : { taskId: "", requirementVersion: 0 }
}
