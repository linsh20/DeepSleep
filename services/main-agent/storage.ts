import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { SqlitePurchaseRepository } from "../purchase-execution/repository"
import { SqliteTaskRepository } from "./sqlite-repository"
const local = globalThis as typeof globalThis & { deepSleepDurableMain?: { purchase: SqlitePurchaseRepository; main: SqliteTaskRepository } }
export function durableStore() {
  if (!local.deepSleepDurableMain) {
    mkdirSync(join(process.cwd(), ".data"), { recursive: true, mode: 0o700 })
    const purchase = new SqlitePurchaseRepository(join(process.cwd(), ".data/sandbox-purchase.sqlite"))
    local.deepSleepDurableMain = { purchase, main: new SqliteTaskRepository(purchase.db) }
  }
  return local.deepSleepDurableMain
}
