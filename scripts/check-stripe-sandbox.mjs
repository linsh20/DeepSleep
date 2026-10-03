// Explicit, persistent Stripe sandbox smoke test. No provider calls without --execute.
import { readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { parseEnv } from "node:util"
import { createRequire } from "node:module"
import ts from "typescript"
const requireTS = createRequire(import.meta.url)
requireTS.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename)
const { SqlitePurchaseRepository } = requireTS("../services/purchase-execution/repository.ts")
const { DemoMerchantAdapter } = requireTS("../services/purchase-execution/demo-merchant.ts")
const { SandboxExecutionGate } = requireTS("../services/purchase-execution/gate.ts")
const { PurchaseExecutionService } = requireTS("../services/purchase-execution/service.ts")
const { StripeSandboxPaymentAdapter } = requireTS("../services/purchase-execution/stripe-sandbox.ts")

const env = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")) : {}
if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
  console.log("STRIPE_NOT_CONFIGURED: 在服务端 .env.local 添加 STRIPE_SECRET_KEY 和 STRIPE_WEBHOOK_SECRET；未发送 Stripe 请求。")
  process.exit(2)
}
if (!/^sk_test_/.test(env.STRIPE_SECRET_KEY.trim())) { console.log("STRIPE_TEST_KEY_REQUIRED: 拒绝非测试密钥"); process.exit(2) }
if (!process.argv.includes("--execute")) { console.log("测试配置已存在，未验证连接。使用 --execute 明确运行一次 Stripe 沙盒测试；重复运行恢复同一操作。"); process.exit(0) }
// Deliberate server-only diagnosis, never a browser authorization bypass.
const argument = process.argv.find(v => v.startsWith("--diagnostic-db="))?.slice("--diagnostic-db=".length)
if (!argument) { console.log("DIAGNOSTIC_DB_REQUIRED: --execute 必须显式指定 --diagnostic-db=<独立数据库路径>；不打开主购买数据库，旧交易仍留在原库待核实。"); process.exit(2) }
const databasePath = resolve(argument), mainPath = resolve(".data/sandbox-purchase.sqlite")
const sameFile = existsSync(databasePath) && existsSync(mainPath) && (realpathSync(databasePath) === realpathSync(mainPath) || statSync(databasePath).ino === statSync(mainPath).ino && statSync(databasePath).dev === statSync(mainPath).dev)
if (databasePath === mainPath || sameFile) { console.log("DIAGNOSTIC_DB_REJECTED: 支付诊断必须使用独立数据库；不得用新案例掩盖旧交易未知结果。"); process.exit(2) }
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
mkdirSync(".data", { recursive: true, mode: 0o700 })
const repo = new SqlitePurchaseRepository(databasePath)
try {
  const payment = new StripeSandboxPaymentAdapter(() => ({ key: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET }))
  const service = new PurchaseExecutionService(repo, new DemoMerchantAdapter(repo), new SandboxExecutionGate(), payment)
  // Stable fixture request ID prevents rerunning this script from silently making another purchase.
  const view = await service.createFixture("local-stripe-smoke", "stripe_sandbox_smoke_v1")
  const result = await service.execute("local-stripe-smoke", { planId: view.plan.planId, expectedVersion: view.task.requirementVersion, requestId: "stripe_sandbox_smoke_execute", testPermission: true })
  const record = { purpose: "isolated_payment_diagnostic_not_authorization", checkedAt: new Date().toISOString(), mode: "stripe_sandbox", merchant: "simulated", planId: result.plan.planId, operation: result.operation, order: result.order, events: result.events, webhookDeliveryVerified: false }
  writeFileSync(".data/stripe-sandbox-acceptance.json", JSON.stringify(record, null, 2) + "\n", { mode: 0o600 })
  console.log(JSON.stringify({ paymentStatus: result.operation?.paymentStatus, orderStatus: result.order?.status, paymentId: result.operation?.paymentId, errorCode: result.operation?.errorCode, webhookDeliveryVerified: false }))
  if (result.operation?.paymentStatus !== "succeeded" || result.order?.status !== "confirmed") process.exitCode = 1
} catch { console.log("STRIPE_ACCEPTANCE_INCOMPLETE: 原操作保存在SQLite；未重试、未换方案。请查询并恢复原操作。"); process.exitCode = 1 }
finally { repo.close() }
