# Payment data service

This server-only module persists opaque card references and mock payment rules in SQLite. It never stores PAN, CVV, PIN, credentials, or payment tokens, and never authorizes or executes a payment.

Initialize the demo database (repeatable):

```powershell
npm run payment:seed
```

`PaymentRepository` scopes cards by `user_id`. `buildPaymentContext()` applies card status, trusted merchant acceptance, merchant/category restrictions, monthly usage, fees, and independent settlement/reference FX facts, then returns the existing Agent B `PaymentContext`. `evaluateWithStoredPaymentMethods()` supplies that context to the existing `evaluateShoppingCandidates()` entry; ranking remains in `lib/agent-b/payment.ts` with the `lowest_upfront_charge` objective.

All supplied seed facts are `mock-dataset` / `mock` and are usable only with the `development_mock` policy. Missing facts remain `unverified`; timestamps stored in the database are preserved. Benefit usage changes only through `recordBenefitSettlement()` after a successful simulated settlement event, whose `event_id` makes updates idempotent.

The current sandbox Checkout continues to use its execution-specific `stripe_test_card`; these demo cards are recommendations, not executable Stripe credentials.
