import { purchaseHttp } from "@/services/purchase-execution/runtime"
export const runtime = "nodejs"
type Context = { params: Promise<{ action: string }> }
export async function GET(request: Request, context: Context) { return purchaseHttp(request, (await context.params).action) }
export async function POST(request: Request, context: Context) { return purchaseHttp(request, (await context.params).action) }
