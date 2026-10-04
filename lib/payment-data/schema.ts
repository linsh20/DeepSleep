import type { DatabaseSync } from "node:sqlite"

export function migratePaymentDatabase(db: DatabaseSync): void {
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS payment_cards (
      card_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      network TEXT,
      last4 TEXT,
      payment_channel TEXT NOT NULL,
      billing_currency TEXT NOT NULL CHECK(billing_currency GLOB '[A-Z][A-Z][A-Z]'),
      status TEXT NOT NULL CHECK(status IN ('active','inactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_cards_user_status ON payment_cards(user_id,status);

    CREATE TABLE IF NOT EXISTS payment_fee_rules (
      fee_rule_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES payment_cards(card_id) ON DELETE CASCADE,
      fee_bps INTEGER CHECK(fee_bps IS NULL OR fee_bps BETWEEN 0 AND 10000),
      fixed_fee_minor INTEGER CHECK(fixed_fee_minor IS NULL OR fixed_fee_minor >= 0),
      rule_version TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence_status TEXT NOT NULL CHECK(evidence_status IN ('verified','unverified','mock')),
      fetched_at TEXT NOT NULL,
      valid_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_fee_card ON payment_fee_rules(card_id);

    CREATE TABLE IF NOT EXISTS payment_benefits (
      benefit_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES payment_cards(card_id) ON DELETE CASCADE,
      benefit_type TEXT NOT NULL CHECK(benefit_type IN ('instant_discount','future_cashback')),
      currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
      min_spend_minor INTEGER NOT NULL CHECK(min_spend_minor >= 0),
      rate_bps INTEGER NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
      amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
      per_tx_cap_minor INTEGER CHECK(per_tx_cap_minor IS NULL OR per_tx_cap_minor >= 0),
      monthly_cap_minor INTEGER CHECK(monthly_cap_minor IS NULL OR monthly_cap_minor >= 0),
      cap_verified INTEGER NOT NULL CHECK(cap_verified IN (0,1)),
      eligible_category TEXT,
      eligible_merchant_id TEXT,
      rule_version TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence_status TEXT NOT NULL CHECK(evidence_status IN ('verified','unverified','mock')),
      fetched_at TEXT NOT NULL,
      valid_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_benefit_card_type ON payment_benefits(card_id,benefit_type);

    CREATE TABLE IF NOT EXISTS payment_benefit_usage (
      user_id TEXT NOT NULL,
      benefit_id TEXT NOT NULL REFERENCES payment_benefits(benefit_id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      used_minor INTEGER NOT NULL CHECK(used_minor >= 0),
      PRIMARY KEY(user_id,benefit_id,period)
    );

    CREATE TABLE IF NOT EXISTS payment_fx_quotes (
      fx_id TEXT PRIMARY KEY,
      quote_type TEXT NOT NULL CHECK(quote_type IN ('settlement','reference')),
      card_id TEXT REFERENCES payment_cards(card_id) ON DELETE CASCADE,
      from_currency TEXT NOT NULL CHECK(from_currency GLOB '[A-Z][A-Z][A-Z]'),
      to_currency TEXT NOT NULL CHECK(to_currency GLOB '[A-Z][A-Z][A-Z]'),
      rate_text TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence_status TEXT NOT NULL CHECK(evidence_status IN ('verified','unverified','mock')),
      fetched_at TEXT NOT NULL,
      valid_until TEXT,
      CHECK((quote_type='settlement' AND card_id IS NOT NULL) OR (quote_type='reference' AND card_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_payment_fx_pair ON payment_fx_quotes(quote_type,from_currency,to_currency,card_id);

    CREATE TABLE IF NOT EXISTS payment_benefit_settlements (
      event_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      benefit_id TEXT NOT NULL REFERENCES payment_benefits(benefit_id),
      period TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
      settled_at TEXT NOT NULL
    );`)
}
