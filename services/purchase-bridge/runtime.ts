import { durableStore } from "../main-agent/storage"
import { DemoMerchantAdapter } from "../purchase-execution/demo-merchant"
import { StripeSandboxPaymentAdapter } from "../purchase-execution/stripe-sandbox"
import { PurchaseBridge } from "./service"
import { bridgeHttp } from "./http"
export async function purchaseBridgeHttp(request: Request, action: string) {
  if (process.env.NODE_ENV !== "development") return Response.json({ error: { code: "DEVELOPMENT_ONLY" } }, {status:404})
  const {main,purchase} = durableStore()
  const payment = new StripeSandboxPaymentAdapter(() => ({key:process.env.STRIPE_SECRET_KEY,webhookSecret:process.env.STRIPE_WEBHOOK_SECRET}))
  return bridgeHttp(new PurchaseBridge(main, purchase, new DemoMerchantAdapter(purchase), payment), main)(request,action)
}
