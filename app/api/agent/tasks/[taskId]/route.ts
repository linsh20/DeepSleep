import { agentHttp } from "@/services/main-agent/runtime"
export const runtime = "nodejs"
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return agentHttp(request, "get", (await context.params).taskId)
}
