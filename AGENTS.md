<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# DeepSleep development rules

## Workflow

- Start from the latest `main` and use a short-lived branch (`feat/*`, `fix/*`, or `docs/*`), normally merging within about one hour.
- Sync `main` again before merging. Resolve conflicts, rerun relevant checks, then merge and delete the short branch.
- Keep commits scoped to the current task. Preserve unrelated staged, unstaged, and untracked work; never use destructive Git commands to discard it.
- Use Conventional Commit messages such as `feat: ...`, `fix: ...`, and `docs: ...`.

## Architecture boundaries

- Main Agent owns conversation, requirement parsing, task orchestration, and requirement versioning.
- Agent A owns search planning, product recall, normalization, deduplication, exclusions, and requested fact verification.
- Agent B owns candidate evaluation, verification requests, ranking, and recommendation.
- Payment risk owns authorization and final pre-purchase checks. A recommendation is never purchase authorization.
- Keep secrets and provider calls server-side. Client components handle UI interaction only.

## Shared contracts

- `types/index.ts` is the canonical shared type source. `types/shopping.ts` is a compatibility re-export; do not duplicate shared types.
- Use integer minor currency units (`HKD 500 = 50000`). Keep currencies consistent across requirements, offers, and authorizations.
- Product, SKU, and Offer IDs are distinct. Candidate identity is `(productId, skuId, offerId)`.
- Unknown facts use `null`, never `0`, empty strings, or invented values. Preserve fact `source`, `fetchedAt`, and `status`.
- Mock facts use `source: "mock-dataset"` and `status: "mock"`.
- Use canonical fields such as `attributes.weightGrams`, `attributes.batteryLifeHours`, `offer.shippingMinor`, and `offer.stock`.
- Every result carries `taskId` and `requirementVersion`; consumers must reject stale or mismatched results.

## Agent and error behavior

- Prefer deterministic TypeScript rules when sufficient. LLM use is optional and must have a non-LLM fallback.
- LLMs must not invent price, stock, shipping, specifications, provenance, recommendation evidence, or authorization.
- A single product failure must not fail the whole search. Use `partial` for usable incomplete results and `failed` for total failure. Zero matches after a successful search is `complete`.
- Normalize known errors to `INVALID_INPUT`, `SOURCE_UNAVAILABLE`, `TIMEOUT`, or `UNSUPPORTED_CATEGORY`; never expose secrets or private upstream responses.
- Bound network and verification work with cancellation, timeouts, and finite retry/verification rounds.
- Verification updates only requested identities and fields, retains existing valid facts on failure, and never promotes Mock facts to verified.

## Security and configuration

- Read credentials from server-side environment variables. Never commit credentials or expose them with `NEXT_PUBLIC_`.
- Real-time product facts must come from an attributable product data source; an LLM is not a substitute for a product API.
- Recheck dynamic facts and backend authorization immediately before purchase. Do not implement or simulate a real transaction without explicit scope.

## Validation and documentation

- Run relevant tests plus `npm run lint`, `npx tsc --noEmit`, and `npm run build` before merging. The current full test command is `npm test`.
- Test normal, empty, invalid, partial-failure, total-failure, timeout, deduplication, exclusion, missing-field, exact-verification, Mock provenance, and requirement-version cases as applicable.
- Update `README.md` or module docs with public interfaces, field units, Mock coverage, validation results, limitations, and cross-module requirements.
