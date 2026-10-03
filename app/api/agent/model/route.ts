import { agentHttp } from "@/services/main-agent/runtime"
export const runtime = "nodejs"
export async function GET(request: Request) { return agentHttp(request, "model") }
