import type { DatabaseSync } from "node:sqlite"
import { migratePaymentDatabase } from "./schema.ts"

export type PaymentRuleRow = Record<string, string | number | null>

export class PaymentRepository {
  readonly db: DatabaseSync
  constructor(db: DatabaseSync) { this.db = db; migratePaymentDatabase(db) }

  cards(userId: string): PaymentRuleRow[] {
    return this.db.prepare(`SELECT * FROM payment_cards WHERE user_id=? ORDER BY card_id`).all(userId) as PaymentRuleRow[]
  }
  fee(cardId: string): PaymentRuleRow | undefined {
    return this.db.prepare(`SELECT * FROM payment_fee_rules WHERE card_id=? ORDER BY rule_version DESC LIMIT 1`).get(cardId) as PaymentRuleRow | undefined
  }
  benefits(cardId: string, type: string): PaymentRuleRow[] {
    return this.db.prepare(`SELECT * FROM payment_benefits WHERE card_id=? AND benefit_type=? ORDER BY benefit_id`).all(cardId,type) as PaymentRuleRow[]
  }
  usage(userId: string, benefitId: string, period: string): number {
    const row = this.db.prepare(`SELECT used_minor FROM payment_benefit_usage WHERE user_id=? AND benefit_id=? AND period=?`).get(userId,benefitId,period)
    return row ? Number(row.used_minor) : 0
  }
  settlementRate(cardId: string, from: string, to: string): PaymentRuleRow | undefined {
    return this.db.prepare(`SELECT * FROM payment_fx_quotes WHERE quote_type='settlement' AND card_id=? AND from_currency=? AND to_currency=? ORDER BY fetched_at DESC LIMIT 1`).get(cardId,from,to) as PaymentRuleRow | undefined
  }
  referenceRate(from: string, to: string): PaymentRuleRow | undefined {
    return this.db.prepare(`SELECT * FROM payment_fx_quotes WHERE quote_type='reference' AND card_id IS NULL AND from_currency=? AND to_currency=? ORDER BY fetched_at DESC LIMIT 1`).get(from,to) as PaymentRuleRow | undefined
  }

  recordBenefitSettlement(input: { eventId: string; userId: string; benefitId: string; period: string; amountMinor: number; settledAt: string }): boolean {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO payment_benefit_settlements VALUES (?,?,?,?,?,?)`).run(
        input.eventId,input.userId,input.benefitId,input.period,input.amountMinor,input.settledAt).changes
      if (inserted) this.db.prepare(`INSERT INTO payment_benefit_usage VALUES (?,?,?,?)
        ON CONFLICT(user_id,benefit_id,period) DO UPDATE SET used_minor=used_minor+excluded.used_minor`).run(
          input.userId,input.benefitId,input.period,input.amountMinor)
      this.db.exec("COMMIT")
      return inserted === 1
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
}
