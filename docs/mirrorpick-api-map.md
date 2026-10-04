# MirrorPick page / API map

All endpoints are same-origin `/api/agent/…`. Session ownership comes only from the existing HttpOnly cookie. Type imports from MainTask, PurchaseBridge, Authorization and Confirmation are erased from the browser bundle. Canonical shopping fields come from types/index.ts.

| Component | Endpoint | Request | Response and state | Errors |
|---|---|---|---|---|
| Boot and history | POST session; GET tasks/:id | {}; taskId only in URL | Existing cookie; owned MainTask messages/draft/result | Invalid known IDs filtered; never creates a replacement identity in localStorage |
| New chat | POST tasks | requestId | MainTask | Uncertain retry retains ID |
| Composer | POST messages | taskId, expectedVersion, requestId, message | Conversation and clarification | Model missing/error; version conflicts; explicit refresh |
| Requirement form | POST tasks/:id/requirements | expectedVersion, requestId, intent, requirementDraft | Updated MainTask; other hard rules, preferences, excluded IDs retained | Invalid JSON, money, constraints; stale version |
| Search / comparison | POST tasks/:id/search | expectedVersion, requestId | Actual candidates, source timestamps, audits and missing facts | No-match / verification / failed all remain non-payable |
| Model status | GET model | none | model.state | No configured key is clearly disclosed |
| Authorization | GET risk/state; POST risk/authorization | terms whitelist, expectedVersion, requestId, explicitlyConfirmed | Scope and versioned authorization | Unsupported scope / stale authorization; no automatic new product selection |
| Revoke | POST risk/revoke | expectedVersion, requestId | New revoked version | Does not promise refunds or cancellation of submitted payment |
| Checkout eligibility | POST purchases/prepare | taskId, expectedVersion, requestId, candidateId tuple | Saved quote/plan or explicit unsupported/no-match/verification/failed outcome | HTTP 200 never interpreted as permission |
| Execute | POST purchases/execute | taskId, planId, expectedVersion, requestId, testPermission:true | Purchase state; inspect operation.errorCode even on HTTP 200 | Original operation's risk decision; no automatic execution |
| Soft exception dialog | POST risk/confirmation | confirmationId, accept | accepted flag; refresh risk state | Deadline from expiresAt, rejection and expiry; never itself pays |
| Receipts | GET purchases/state?taskId=… | none | Independent order/payment statuses including historical versions | Unknown is not failed or succeeded |
| Reconciliation | POST purchases/recover | taskId, planId, requestId | Same original operation | No replacement payment |

IDs are kept for uncertain mutation retries in the active client; after reload, authoritative plan/operation IDs come from GET. Local storage holds only known task IDs and the active task ID; display titles are reloaded from owned tasks. Read responses have a generation and sequence guard. Polling is read-only, visible-page-only, every five seconds for pending operations/confirmation, and stops on terminal payment states. Closing a native dialog never grants consent.

## Initial Authorization preference preview (2026-10-04 revision)

`components/mirrorpick/authorization.tsx` renders the supplied initial-agreement design. The 5 categories, 4 merchant preferences and 9 payment preferences are not backend IDs. `Sign & submit` only stores an in-memory page draft; it never invokes the `save` callback, authorization endpoint, or payment API. Reload clears the draft. Profile/skin/signature data is not sent to any endpoint.

The explicit **Sandbox authorization settings** button opens `sandbox-authorization.tsx`, preserving the prior exact-scope submission and current authorization values. Only this separate form invokes `save(AuthorizationTerms)` with the dynamic server whitelist. No scope expansion, budget clamping or preferred-wallet-to-Stripe mapping occurs.
