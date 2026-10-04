import type { DatabaseSync } from "node:sqlite"
import { migratePaymentDatabase } from "./schema.ts"

export function seedMockPaymentData(db: DatabaseSync, options: { userId?: string; now?: Date } = {}): void {
  migratePaymentDatabase(db)
  const userId = options.userId ?? "demo-user"
  const fetchedAt = (options.now ?? new Date()).toISOString()
  const source = "mock-dataset"
  db.exec("BEGIN IMMEDIATE")
  try {
    const card = db.prepare(`INSERT INTO payment_cards
      (card_id,user_id,label,network,last4,payment_channel,billing_currency,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET
      user_id=excluded.user_id,label=excluded.label,network=excluded.network,last4=excluded.last4,
      payment_channel=excluded.payment_channel,billing_currency=excluded.billing_currency,
      status=excluded.status,updated_at=excluded.updated_at`)
    card.run("card-a",userId,"Card A","visa","0001","credit_card","HKD","active",fetchedAt,fetchedAt)
    card.run("card-b",userId,"Card B","mastercard","0002","credit_card","CNY","active",fetchedAt,fetchedAt)

    const fee = db.prepare(`INSERT INTO payment_fee_rules VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fee_rule_id) DO UPDATE SET fee_bps=excluded.fee_bps,fixed_fee_minor=excluded.fixed_fee_minor,
      rule_version=excluded.rule_version,source=excluded.source,evidence_status=excluded.evidence_status,
      fetched_at=excluded.fetched_at,valid_until=excluded.valid_until`)
    fee.run("fee-card-a-v1","card-a",0,0,"mock-v1",source,"mock",fetchedAt,null)
    fee.run("fee-card-b-v1","card-b",100,100,"mock-v1",source,"mock",fetchedAt,null)

    const benefit = db.prepare(`INSERT INTO payment_benefits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(benefit_id) DO UPDATE SET min_spend_minor=excluded.min_spend_minor,
      rate_bps=excluded.rate_bps,amount_minor=excluded.amount_minor,per_tx_cap_minor=excluded.per_tx_cap_minor,
      monthly_cap_minor=excluded.monthly_cap_minor,cap_verified=excluded.cap_verified,
      eligible_category=excluded.eligible_category,eligible_merchant_id=excluded.eligible_merchant_id,
      rule_version=excluded.rule_version,source=excluded.source,evidence_status=excluded.evidence_status,
      fetched_at=excluded.fetched_at,valid_until=excluded.valid_until`)
    // Explicit zero rule distinguishes confirmed no instant offer from an unknown/missing rule.
    benefit.run("instant-card-a-none","card-a","instant_discount","HKD",0,0,0,null,null,1,null,null,"mock-v1",source,"mock",fetchedAt,null)
    benefit.run("cashback-card-a","card-a","future_cashback","HKD",0,100,0,null,null,1,null,null,"mock-v1",source,"mock",fetchedAt,null)
    benefit.run("instant-card-b","card-b","instant_discount","HKD",20000,1000,0,1500,3000,1,null,null,"mock-v1",source,"mock",fetchedAt,null)
    benefit.run("cashback-card-b","card-b","future_cashback","HKD",0,300,0,null,null,1,null,null,"mock-v1",source,"mock",fetchedAt,null)
    db.prepare(`INSERT INTO payment_benefit_usage VALUES (?,?,?,0)
      ON CONFLICT(user_id,benefit_id,period) DO NOTHING`).run(userId,"instant-card-b",fetchedAt.slice(0,7))

    const fx = db.prepare(`INSERT INTO payment_fx_quotes VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fx_id) DO UPDATE SET rate_text=excluded.rate_text,source=excluded.source,
      evidence_status=excluded.evidence_status,fetched_at=excluded.fetched_at,valid_until=excluded.valid_until`)
    fx.run("fx-card-b-hkd-cny","settlement","card-b","HKD","CNY","0.92",source,"mock",fetchedAt,null)
    fx.run("fx-reference-cny-hkd","reference",null,"CNY","HKD","1.08",source,"mock",fetchedAt,null)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
