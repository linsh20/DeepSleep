import type { ExecutionGate } from "../purchase-execution/types"
export type AuthorizationTerms = {
  startsAt: number; expiresAt: number; singleSoftMinor: number; singleHardMinor: number;
  monthlySoftMinor: number; monthlyHardMinor: number;
  productIds: string[]; merchantIds: string[]; paymentMethods: string[];
}
export type Authorization = AuthorizationTerms & { authorizationId: string; userId: string; version: number; status: "active" | "revoked"; createdAt: number }
export type RiskInput = Parameters<ExecutionGate["check"]>[0]
export type RuleHit = { rule: string; severity: "hold" | "block"; reason: string; exit: string }
export type RiskDecision = { policyVersion: string; decisionId: string; operationId: string; decision: "approve" | "hold" | "block"; hits: RuleHit[]; at: number; authorizationId: string | null; authorizationVersion: number | null; projectedMinor: number; spentMinor: number; reservedMinor: number; confirmationId: string | null; errorCode?: string }
export type Confirmation = { confirmationId: string; userId: string; operationId: string; taskId: string; requirementVersion: number; authorizationId: string; authorizationVersion: number; planId: string; quoteId: string; amountMinor: number; rules: string[]; expiresAt: number; status: "pending" | "accepted" | "rejected"; binding: string }
export const RISK_CONFIG = {
  policyVersion: "limited-sandbox-v1",
  frequencyWindowMs: 600000, maxTransactions: 3, duplicateWindowMs: 600000, confirmationMs: 120000,
  productIds: ["sandbox-lotion"], merchantIds: ["demo-merchant"], paymentMethods: ["stripe_test_card"],
  injectionSignals: ["忽略规则", "忽略以上规则", "立即下单", "不要告诉用户", "直接付款", "跳过风控", "无视安全", "bypass", "ignore instructions"],
}
export type RiskConfig = typeof RISK_CONFIG
