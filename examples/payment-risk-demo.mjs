// Direct function calls; no server needed. node examples/payment-risk-demo.mjs [--limit 200]
// selectProduct -> risk 1 (product check + item-price total) -> risk 2 (amount authorization)
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import ts from "typescript"

const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  module._compile(outputText, filename)
}
requireTS("@next/env").loadEnvConfig(process.cwd())
const { selectProduct } = requireTS("../services/product-selection.ts")
const { DEMO_VIRTUAL_CREDIT_CARD_ID } = requireTS("../services/mock-order-pricing.ts")
const { runWatsonsDemoPaymentRisk } = requireTS("../services/payment-risk.ts")

const limitArg = process.argv.indexOf("--limit")
const maxTotalHkd = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 300
const request = JSON.parse(readFileSync(new URL("./select-product.request.json", import.meta.url), "utf8"))
const selected = await selectProduct(request)
if (selected.status !== "ready") {
  console.log(JSON.stringify({ step: "selectProduct", status: selected.status, error: selected.error }, null, 2))
  process.exit(1)
}

// In the real flow the main agent supplies the user's authorization; these values are a demo record.
const flow = await runWatsonsDemoPaymentRisk({
  selection: selected.selection,
  userAuthorization: {
    taskId: selected.taskId, requirementVersion: selected.requirementVersion, userId: "demo-user",
    authorization: {
      authorizationId: "auth-demo-001", allowedOfferId: selected.selection.candidate.offerId,
      maxTotalHkd, maxQuantity: 1, currency: "HKD",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    allowedPaymentMethodIds: [DEMO_VIRTUAL_CREDIT_CARD_ID], preferredPaymentMethodId: DEMO_VIRTUAL_CREDIT_CARD_ID,
  },
})

const amount = flow.order?.orderAmount ?? flow.pricing.selection?.orderAmount
console.log(JSON.stringify({
  status: flow.status, stage: flow.stage,
  product: selected.selection.candidate.title, offerId: selected.selection.candidate.offerId,
  itemPriceHkd: amount?.unitPriceHkd ?? null, paymentMethodId: amount?.paymentMethodId ?? null,
  virtualCardChargeHkd: amount?.billingTotal ?? null, virtualCardFeeHkd: amount?.billingFee ?? null,
  totalHkd: amount?.totalHkd ?? null, maxTotalHkd,
  reasons: flow.risk?.reasons ?? flow.pricing.reasons,
  readyForMockOrder: flow.order !== null,
}, null, 2))
