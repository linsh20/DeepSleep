import { mkdirSync } from "node:fs"
import { dirname,resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { seedMockPaymentData } from "../lib/payment-data/seed.ts"

const path = resolve(process.argv[2] ?? "data/payment/payment.demo.sqlite")
mkdirSync(dirname(path),{recursive:true})
const db = new DatabaseSync(path)
try { seedMockPaymentData(db); console.log(`Seeded development_mock payment data: ${path}`) }
finally { db.close() }
