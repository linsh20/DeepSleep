import { durableStore } from "../main-agent/storage"
import { currentTaskResolver } from "../purchase-bridge/service"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { SqlitePurchaseRepository } from "./repository"
import { DemoMerchantAdapter } from "./demo-merchant"
import { SandboxExecutionGate } from "./gate"
import { StripeSandboxPaymentAdapter } from "./stripe-sandbox"
import { PurchaseExecutionService } from "./service"
import { createPurchaseHttp } from "./http"
const local = globalThis as typeof globalThis & { deepSleepSandboxRepository?: SqlitePurchaseRepository }
export async function purchaseHttp(request: Request, action: string) {
  // No filesystem mutation during Next build or on disabled production requests.
  if (process.env.NODE_ENV !== "development") return Response.json({ error: { code: "DEVELOPMENT_ONLY", message: "沙盒入口仅限开发" } }, { status: 404 })
  if (!local.deepSleepSandboxRepository) {
    const dir = join(process.cwd(), ".data")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    local.deepSleepSandboxRepository = new SqlitePurchaseRepository(join(dir, "sandbox-purchase.sqlite"))
  }
  const repo = local.deepSleepSandboxRepository
  const payment = new StripeSandboxPaymentAdapter(() => ({ key: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET }))
  const service = new PurchaseExecutionService(repo, new DemoMerchantAdapter(repo), new SandboxExecutionGate(), payment, { currentTask: currentTaskResolver(durableStore().main) })
  return createPurchaseHttp(service, repo, true)(request, action)
}
