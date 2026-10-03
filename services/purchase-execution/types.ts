import type { Requirement } from "../../types/index"
export type SandboxTask = { taskId: string; userId: string; intent: "purchase" | "compare" | "unclear"; requirementVersion: number; requirement: Requirement; quantity: number }
export type SandboxPlan = { planId: string; taskId: string; requirementVersion: number; environment: "sandbox_fixture"; productId: string; skuId: string; merchantId: "demo-merchant"; title: string; quantity: number }
export type Quote = { quoteId: string; planId: string; merchantId: string; productId: string; skuId: string; quantity: number; currency: "HKD"; itemSubtotalMinor: number; shippingMinor: number; totalMinor: number; expiresAt: number; environment: "sandbox_fixture" }
export type MerchantOrder = { orderId: string; operationId: string; quote: Quote; status: "pending_payment" | "confirmed" | "confirmation_failed" }
export type PaymentState = "not_started" | "creating" | "requires_confirmation" | "confirming" | "requires_action" | "processing" | "failed" | "unknown" | "succeeded" | "canceled"
export type PaymentSnapshot = { id: string; livemode: false; amount: number; currency: string; status: Exclude<PaymentState, "not_started" | "creating" | "confirming" | "unknown">; operationId: string; orderId: string; planId: string }
export type PurchaseOperation = {
  operationId: string; userId: string; taskId: string; requirementVersion: number; planId: string; quote: Quote;
  permit: { kind: "one_sandbox_test"; grantedAt: number; requestId: string; planId: string; userId: string };
  orderId: string | null; paymentId: string | null; paymentStatus: PaymentState;
  createKey: string; confirmKey: string; createStartedAt: number | null; confirmStartedAt: number | null;
  providerBinding: string | null; errorCode: string | null; leaseToken: string | null; leaseUntil: number;
}
export interface MerchantOrderPort {
  quote(plan: SandboxPlan): Promise<Quote>
  createPending(operationId: string, quote: Quote): Promise<MerchantOrder>
  get(orderId: string): Promise<MerchantOrder>
  confirm(orderId: string, paymentId: string): Promise<MerchantOrder>
}
export interface PaymentPort {
  configured(): boolean
  configurationId(): string
  create(operation: PurchaseOperation): Promise<PaymentSnapshot>
  confirm(operation: PurchaseOperation): Promise<PaymentSnapshot>
  retrieve(paymentId: string): Promise<PaymentSnapshot>
  verifyWebhook(raw: string, signature: string): { id: string; paymentId: string; operationId?: string } | null
}
export interface ExecutionGate {
  check(input: { mode: "sandbox" | "production"; task: SandboxTask; plan: SandboxPlan; quote: Quote; userId: string; expectedVersion: number; permitted: boolean; now: number; operationId?: string }): { decision: "sandbox_test_only" | "approve" | "hold" | "block"; errorCode?: string }
  settle?(operation: PurchaseOperation, now: number): void
}
const brand = Symbol.for("deepsleep.purchase-error")
export class PurchaseError extends Error {
  readonly [brand] = true
  static [Symbol.hasInstance](v: unknown) { return !!v && typeof v === "object" && (v as Record<symbol, unknown>)[brand] === true }
  constructor(public code: string, message: string, public status = 400) { super(message) }
}
export function ensure(value: unknown, code: string, message: string, status = 400): asserts value {
  if (!value) throw new PurchaseError(code, message, status)
}
