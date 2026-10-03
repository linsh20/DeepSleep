# Product search and data agent (A)

Shared types now live in `types/index.ts`; `types/shopping.ts` re-exports them.
See [A/B integration](agent-integration.md) for the server-side search/evaluate/verify workflow.

This module recalls product facts. It does not parse user conversations, score
recommendations, authorize purchases, or place orders. The homepage's product
search panel uses these APIs through server-side route handlers. The legacy
purchase demo is preserved in a separate collapsed section.

## Homepage demo

Run `npm run dev` and open `http://localhost:3000`. Click **Search products** to
recall offers. Adjust the HKD budget or choose item-only/delivered scope; edit a
field to clear stale results, then search again. **Look up missing facts** on
Light Wireless Headphones fills weight to 180 g; Travel Wireless Headphones
fills battery life to 32 hours. Some other missing facts remain unknown.
**Exclude product** excludes every SKU/offer for that product and reruns search;
**Reset exclusions** restores them. Demo facts are explicitly labeled Mock.

The browser calls `POST /api/products/search` and `POST /api/products/verify`
with the same JSON inputs as the public functions below. Both return a
`SearchResult`, including structured errors (400 invalid input, 422 unsupported
category, 503 source unavailable, 504 timeout). They are read-only and uncached.
The client cancels superseded requests and checks task ID and requirement version
before displaying results. No purchase decision or recommendation is generated
by this panel; the old independent purchase demo remains available below it.

## Public API

```ts
import { searchCandidates, verifyFacts } from "@/services/search-agent"
import type { Requirement } from "@/types/shopping"

const requirement: Requirement = {
  taskId: "shopping-123",
  requirementVersion: 1,
  category: "Electronics",
  query: "wireless headphones",
  currency: "HKD",
  budget: { maxMinor: 50000, scope: "delivered" },
  hardConstraints: [
    { field: "attributes.weightGrams", op: "lte", value: 250 },
  ],
  preferences: [
    { field: "attributes.batteryLifeHours", weight: 1, source: "explicit" },
  ],
  excludedProductIds: [],
  destination: "HK",
}

const result = await searchCandidates({ requirement, limit: 10 })
const candidate = result.candidates.find((item) =>
  item.missingFields.includes("attributes.weightGrams"),
)

if (candidate) {
  const refreshed = await verifyFacts({
    requirement,
    candidates: result.candidates,
    requests: [{
      productId: candidate.productId,
      skuId: candidate.skuId,
      offerId: candidate.offerId,
      fields: ["attributes.weightGrams"],
      reason: "Decision module needs the weight constraint checked.",
    }],
  })
  // Only accept refreshed results for the active taskId + requirementVersion.
  console.log(refreshed)
}
```

`limit` is an integer from 1 to 100. Requirement versions are nonnegative integers.
All amounts are nonnegative safe integers in minor units (HKD 500 = 50000).
Query matching is case-insensitive and requires all whitespace-separated terms.
The mock source supports Electronics; other categories return
`UNSUPPORTED_CATEGORY`. No model, network, or API key is needed. Mock is the
default; `PRODUCT_DATA_MODE=mock` is compatible but not required. There is no LLM
integration or real provider selection in this version.

## Shared field conventions

| Path | Value / unit |
| --- | --- |
| `attributes.weightGrams` | number, grams |
| `attributes.batteryLifeHours` | number, hours |
| `attributes.color`, `attributes.brand` | string |
| `attributes.wireless` | boolean |
| `offer.itemPriceMinor`, `offer.shippingMinor`, `offer.discountMinor` | integer minor units |
| `offer.stock` | `available` or `unavailable` |
| `offer.deliverable` | boolean |

Other simple attribute names are supported. Bare names such as `weightGrams`
are accepted and normalized to `attributes.weightGrams`. Verification operates
only on Fact fields; identity, title, URL and currency are not patchable fields.
`missingFields` uses canonical paths and may also contain `skuId`, `offerId`, and
`offer`. Requested but unavailable attributes have `value: null`.

Item-budget retrieval compares item price minus discount; delivered-budget
retrieval additionally includes shipping. If any needed amount is unknown, the
candidate remains in recall for downstream verification. Known constraint
violations are filtered; unknown constraints remain. A discount of zero is an
explicit dataset fact, not a fallback for unknown discounts. Stock and
deliverability only filter recall when explicitly constrained. These filters do
not constitute risk approval. Preferences request facts without scoring or
reordering candidates. Results retain source order.

Facts from the mock source, including fetched null values, always use
`source: "mock-dataset"`, `status: "mock"`, and the lookup timestamp. URLs use
`example.invalid` and are not real product listings. Delivery data is for HK;
other destinations leave shipping and deliverability unknown. Omitting the
destination uses the mock dataset's HK default.

## Verification and result status

Identity is the exact tuple `(productId, skuId, offerId)`, including nulls.
Duplicates of that tuple collapse during search. Different SKUs or offers stay
separate. Repeated verification requests for a tuple are combined into one
lookup. Only requested fields can change, and input objects are never mutated.
An unsuccessful or null lookup cannot erase a valid existing fact. A successful
lookup may refresh a requested fact and its provenance. Fields that are still
unknown appear in `missingFields`; a failed lookup for a previously absent
attribute leaves null with empty source/time and `unverified` status, meaning no
source was successfully observed. No offer is synthesized when `offer` is null;
recall again if a complete new offer is needed. Currency changes during lookup
are reported and do not overwrite facts in an existing offer.

- `complete`: retrieval succeeded (including zero matches), or requested facts
  are present after verification. Missing facts in initial recall alone do not
  mean the source was partially unavailable.
- `partial`: source coverage is partial, a record/fact is malformed, some
  verification operations fail, requested facts remain unknown, or a refresh
  could not obtain a new fact and retained an existing one.
- `failed`: invalid input, total source failure/timeout, all returned records
  unusable, or all requested lookup operations failed. Verification can return
  the original candidates even when its status is failed.

Warnings use `INVALID_INPUT`, `SOURCE_UNAVAILABLE`, `TIMEOUT`, or
`UNSUPPORTED_CATEGORY` prefixes for agent-generated errors. Provider warnings
are preserved. Providers must not put credentials or private response bodies in
warnings. Arbitrary thrown exception messages are not exposed.

## Adding a provider

Implement `ProductProvider` in `services/product-provider.ts`, then compose:

```ts
const agent = createSearchAgent(new RealProductProvider(), { timeoutMs: 5000 })
await agent.searchCandidates({ requirement, limit: 10 })
```

Provider search receives the deterministic `SearchPlan`, limit, original
requirement and cancellation signal. It must honor query/category/currency and
known budget/constraint filters, preserve unknowns, and report source coverage
as complete or partial. Apply the limit to unique eligible identities so
duplicates do not underfill recall. Agent code additionally enforces exclusions,
deduplication, normalization and final limit. Detail lookup receives exact
identity and requested paths, plus the requirement (including destination).
Return only facts actually observed for that tuple. Raw values share the
returned record's provenance; providers needing multiple upstream sources should
resolve that provenance explicitly before adapting records.

Calls have a default five-second timeout and receive an aborted signal on timeout.
Real providers should pass this signal to network calls to cancel work. Use
`ProductProviderError` for known error codes. Returning an incomplete search
response is different from reaching the caller's requested limit.

Integrate from the server-side main workflow. A future provider with credentials
must enforce Next.js's server-only boundary; never use `NEXT_PUBLIC_` for keys.
Decision/risk modules must interpret null and mock facts explicitly and validate
the active requirement version before using results.

## Demo coverage and checks

The 16 rows contain one exact duplicate, multiple SoundPro SKUs and store offers,
within-budget and over-budget headphones, shipping-induced overspend, explicit
discounts, unavailable stock, unavailable delivery, missing offer/IDs, permanently
missing facts, and details that fill weight or battery life. Speaker, keyboard,
and power-bank records exercise other electronics queries.

```sh
node --test tests/search-agent.test.mjs tests/product-search-http.test.mjs
npx tsc --noEmit
npm run lint
npm run build
```

The tests use Node's built-in runner and the existing TypeScript dependency, with
no added framework or dependency changes. Run on Node 20+; verification here uses
Node 24. Existing `next/font/google` usage may require Google Fonts connectivity
during a production build.
