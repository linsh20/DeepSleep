import type { SqlitePurchaseRepository } from "../purchase-execution/repository"
import type { Authorization, Confirmation, RiskDecision } from "./types"
export class RiskRepository {
  readonly db
  constructor(readonly purchase: SqlitePurchaseRepository) {
    this.db = purchase.db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS risk_authorizations (owner TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,version));
      CREATE TABLE IF NOT EXISTS risk_requests (owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS risk_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS risk_decisions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, operation_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS risk_confirmations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, operation_id TEXT NOT NULL, binding TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(operation_id,binding));
      CREATE TABLE IF NOT EXISTS risk_reservations (operation_id TEXT PRIMARY KEY REFERENCES sandbox_operations(id), owner TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), month TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','spent','released')), at INTEGER NOT NULL, settled_at INTEGER);
    `)
  }
  current(owner: string): Authorization | null {
    const row = this.db.prepare("SELECT data FROM risk_authorizations WHERE owner=? ORDER BY version DESC LIMIT 1").get(owner)
    return row ? JSON.parse(String(row.data)) : null
  }
  audit(owner: string, at: number, kind: string, data: unknown) { this.db.prepare("INSERT INTO risk_audit(owner,at,kind,data) VALUES (?,?,?,?)").run(owner,at,kind,JSON.stringify(data)) }
  confirmation(id: string, owner: string): Confirmation | null {
    const row = this.db.prepare("SELECT data FROM risk_confirmations WHERE id=? AND owner=?").get(id,owner)
    return row ? JSON.parse(String(row.data)) : null
  }
  saveConfirmation(c: Confirmation) { this.db.prepare("INSERT INTO risk_confirmations VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(c.confirmationId,c.userId,c.operationId,c.binding,JSON.stringify(c)) }
  saveDecision(owner: string, decision: RiskDecision) { this.db.prepare("INSERT INTO risk_decisions VALUES (?,?,?,?,?)").run(decision.decisionId,owner,decision.operationId,decision.at,JSON.stringify(decision)) }
  view(owner: string) {
    return { authorization: this.current(owner),
      decisions: this.db.prepare("SELECT data FROM risk_decisions WHERE owner=? ORDER BY rowid DESC LIMIT 100").all(owner).map(r=>JSON.parse(String(r.data))),
      confirmations: this.db.prepare("SELECT data FROM risk_confirmations WHERE owner=? ORDER BY rowid DESC LIMIT 100").all(owner).map(r=>JSON.parse(String(r.data))),
      reservations: this.db.prepare("SELECT operation_id,amount,month,state,at,settled_at FROM risk_reservations WHERE owner=? ORDER BY at DESC").all(owner),
      audit: this.db.prepare("SELECT at,kind,data FROM risk_audit WHERE owner=? ORDER BY id DESC LIMIT 100").all(owner).map(r=>({...r,data:JSON.parse(String(r.data))})),
    }
  }
}
