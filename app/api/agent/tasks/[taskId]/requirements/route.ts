import { agentHttp } from "@/services/main-agent/runtime"
export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return agentHttp(request, "save", (await context.params).taskId)
}
