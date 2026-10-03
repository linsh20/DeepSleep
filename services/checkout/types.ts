import type { ContractBResult, PaymentContext, ShoppingCandidate, Requirement } from "../../types"
export type CheckoutEvidence = {
  kind:"demo_catalog_checkout_v1"; catalogVersion:string; sourceDecisionId:string;
  sourceCandidate:ShoppingCandidate; reviewedCandidate:ShoppingCandidate;
  requirement:Requirement; quantity:number; offerId:string; quoteId:string; paymentOptionId:"stripe_test_card";
  paymentContext:PaymentContext; review:ContractBResult; expiresAt:number;
}
