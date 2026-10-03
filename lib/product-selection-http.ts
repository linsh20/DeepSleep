import type { SelectProductRequest, SelectProductResult } from "../types"

export async function productSelectionResponse(
  request: Request,
  select: (input: SelectProductRequest) => Promise<SelectProductResult>,
): Promise<Response> {
  let input: SelectProductRequest
  try {
    input = await request.json()
  } catch {
    return Response.json({ taskId: "", requirementVersion: 0, status: "failed", selection: null,
      searchStatus: "failed", reviews: [], warnings: [],
      error: { code: "INVALID_INPUT", message: "请求必须是 JSON。" } } satisfies SelectProductResult,
    { status: 400, headers: { "Cache-Control": "no-store" } })
  }
  const result = await select(input)
  const status = result.status !== "failed" ? 200
    : result.error?.code === "INVALID_INPUT" ? 400 : result.error?.code === "TIMEOUT" ? 504 : 503
  return Response.json(result, { status, headers: { "Cache-Control": "no-store" } })
}
