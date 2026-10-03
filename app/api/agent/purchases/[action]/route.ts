import { purchaseBridgeHttp } from "@/services/purchase-bridge/runtime"
export const runtime = "nodejs"
async function handle(request: Request, context: { params: Promise<{ action: string }> }) {
  return purchaseBridgeHttp(request, (await context.params).action)
}
export const GET = handle
export const POST = handle
