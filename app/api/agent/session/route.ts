import { agentHttp } from "@/services/main-agent/runtime"
export const runtime = "nodejs"
export async function POST(request: Request) { return agentHttp(request, "session") }
