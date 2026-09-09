# Frontend foundation

The Japanese evidence browser in `poc/observation-pipeline/web` can be
developed while production raw-evidence ingestion continues. It displays
source observations and their provenance. It does not calculate net worth,
cross-currency totals, reconciled transactions, or P&L.

## Stack decision

Continue the existing, lockfile-pinned stack:

| Responsibility                             | Library                                       |
| ------------------------------------------ | --------------------------------------------- |
| UI                                         | React 19 + TypeScript                         |
| Development and bundling                   | Vite 8                                        |
| API requests, cache, cancellation, refresh | TanStack Query 5                              |
| Transaction table                          | TanStack Table 9                              |
| Local read-only API                        | Hono 4 on Bun                                 |
| Verification                               | Bun tests + Playwright in Chromium            |
| Presentation                               | Shared React components and CSS design tokens |

Evidence code previews use Shiki 4 with a lazy, fine-grained JSON/XML highlighter
and its JavaScript regex engine. Tokens become escaped React text with fixed CSS
classes; the content security policy does not need inline styles, script execution,
or WebAssembly permissions. No additional component, state, or chart library is required.
Navigation keeps the existing small History API router. Monetary values stay
as decimal strings and use the shared exact formatter; provider text remains
escaped React text. The frontend never reads SQLite or R2 directly.

Transaction filters, search, sort, and page selection, balance source/account,
currency/unit and kind filters, plus position filters and page selection,
survive visits to detail pages within the current tab. They reset on reload
and are never written to URL parameters, browser history state, localStorage,
or sessionStorage. Route changes update the document title and focus the new
heading; typing and API refreshes do not move focus.

Response validation requires decimal-integer minor units, safe nonnegative
numeric identifiers, matching requested/detail identifiers, and lowercase
64-character SHA-256 hashes. Malformed responses produce an error rather than
displaying a different record or converting a blank amount to zero.

Lists distinguish missing records from filters that match no records. Date
range controls identify reversed ranges and report records excluded because
their date is unknown. Counts describe only the returned records, not complete
financial-institution coverage. These controls are available in the local
observation preview; the deployed evidence mode still shows raw records only.

Authentication failures (401/403) clear the rejected response from the in-memory
query cache and hide its records. A failed retry cannot restore them; a successful
response is required. Connection metadata gates observation pages as well. Other
refresh failures retain previously authorized records with an explicit warning.

## API metadata and capabilities

`/api/meta` describes the connection. Its `source.kind` (`local-store`,
`central-store`, or a future name) and `source.classification` are labels
only; every UI decision reads `capabilities`, so renaming a connection cannot
change what the client sends or shows. The capability object, the query
parameters each capability unlocks, and the client argument builder are one
definition in `poc/observation-pipeline/shared/api-schema.ts`. The response
validator (`validApiResponse`) checks the object against that schema, both
servers derive their accepted parameters from it, and the same
conformance checks (`test/api-conformance.ts`) run against the local store,
the hosted synthetic demo, and the production Worker. Capabilities are never
an authorization switch: Access JWT verification, closed responses on auth
failure, and `no-store` apply before any capability is read.

| Capability             | Values                  | Local / demo | Production                    | Effect in the client                                                                    |
| ---------------------- | ----------------------- | ------------ | ----------------------------- | --------------------------------------------------------------------------------------- |
| `contractVersion`      | `observation-api-v1`    | yes          | yes                           | Validator rejects any other version                                                     |
| `readOnly`             | `true`                  | yes          | yes                           | No write control exists                                                                 |
| `rawEvidence`          | `true`                  | yes          | yes                           | `/api/raw/<sha256>` links                                                               |
| `liveCollectors`       | `false`                 | yes          | yes                           | Refresh never means a collector ran                                                     |
| `measureViews`         | `balances`, `summaries` | none         | both                          | `view=` is sent only for an advertised view                                             |
| `identityReadModes`    | `latest`, `as-recorded` | none         | both                          | The 口座・銘柄 page and link exist; `identityRead=` is sent only for an advertised mode |
| `paginationVersion`    | `none`, `offset-v1`     | `none`       | `offset-v1`                   | Coverage record, next-page links, no client column sort                                 |
| `balancesV2`           | boolean                 | false        | flag + snapshot               | The 最新の残高 read-model section exists; the v2 balance routes are requested           |
| `balancesV2Pagination` | `none`, `keyset-v2`     | `none`       | `keyset-v2` when `balancesV2` | Cursor paging over one fixed snapshot, with a "read the newest snapshot" action         |
| `collectionFilters`    | boolean                 | false        | true                          | Server filter controls replace client record controls                                   |
| `organizedDisplay`     | boolean                 | false        | true                          | Rows carry `organization`                                                               |
| `financialProducts`    | boolean                 | false        | true                          | Organized rows may carry a product claim                                                |
| `evidenceHistory`      | boolean                 | false        | true                          | The 取得履歴 route and link exist                                                       |
| `sharedQuery`          | boolean                 | false        | true                          | Summary counts come from `GET /api/v2/query`, not page arithmetic                       |

`balancesV2` is the one capability that also depends on stored state: the
production Worker advertises it only when its reader flag is on **and** the
balance projection has a sealed snapshot, so a capability is never a promise
the store cannot keep (see [Balance read model](balance-read-model.md)). A
path whose own capability is missing answers 404, not 400: there is no route
to reject a parameter for.

A server refuses with 400 any query parameter its capabilities do not grant;
the client never sends one. While metadata is loading, capabilities are
unknown: dependent list queries stay disabled and pages show their loading
state rather than requesting with guessed defaults. Changing the schema fails
the pinned contract tests in both `poc/observation-pipeline` and
`services/evidence-browser`, so a one-sided edit cannot pass CI.

## Shared figures and the AI hand-off

A page that does its own arithmetic and an assistant that does its own can
hand a person two different numbers from the same data, and neither can be
shown to be wrong. Where the server advertises `sharedQuery`, the Overview
page's summary counts therefore come from `GET /api/v2/query?intent=coverage`
— the shared application service (`packages/application`) that the agent API
also calls, with the same scope rules — instead of summing rows in the client.
On a store without that capability the page keeps its own arithmetic, so the
local PoC and the synthetic demo are unaffected.

What a page may still decide for itself is unchanged: open and closed
sections, the selected tab, display density, an in-progress input, a
highlight. Filters, sorts, totals and the adopted set are the server's
(addendum 11 §7).

The hand-off in both directions is by reference, never by number or prose:

- The page shows `contextId` and `resultRef` under a disclosure beside the
  counts. Those are what an assistant is given; it reads them back under its
  own permission rather than trusting a figure it was told.
- A proposal an assistant makes is handed back as a `proposalId`, and the
  page reads that back the same way. "Approved" or "matches the original" in
  free text is not evidence of either.
- Asking an assistant to work from what is on screen means sending the same
  `QuerySpec` the page ran, not a screenshot to re-total. When the two sides
  hold different permissions, the assistant gets the summary its own grant
  allows — computed for that grant, not the page's numbers filtered down.

See [Agent API](agent-api.md) for the grants, tools and result contract.

## Safe preview

From `poc/observation-pipeline`:

```sh
bun install --frozen-lockfile
bun run preview
```

Preview builds the UI, creates a new temporary database, and populates it
only from committed synthetic fixtures. It serves on `127.0.0.1:8787` and
reports synthetic data through `/api/meta`. It does not read or modify the
regular `state/` database. A normal shutdown removes its temporary store.
An abrupt process termination can leave a temporary `kogane-preview-*`
directory; it contains only synthetic data.

`bun run serve` continues to read the regular local store. Its metadata
reports the data classification as unknown: an operator may have ingested
real evidence, synthetic evidence, or both. An existing store must never be
labelled synthetic merely because it is local. Neither mode is a connection
to the production collector database.

## Production API handoff

The browser and local query layer share type-only response contracts in
`poc/observation-pipeline/shared/api-contract.ts`. These describe the local
PoC, not a frozen production database schema. Production adapters should
map the domain to a versioned read API, with an explicit revision when
semantics change. In particular, the PoC's numeric identifiers and raw
SHA-based routes must not be assumed to match production run-scoped storage.

Agree on these before the production connection is enabled:

- Opaque identifiers, observation kinds, nullability, decimal strings,
  currencies, and the distinction between source date and collection time.
- Source/account/date filtering and server-side pagination, including a
  cursor and explicit coverage/completeness. Client pagination limits DOM
  rendering only; the current API still returns all matching stored rows.
- Data classification and connection capabilities (the table above). A
  successful API refresh means the UI reread its store, not that a collector
  ran or that a source is current. Display source timestamps without
  inventing freshness thresholds.
- Authenticated browser access and protected raw-evidence routes. No admin
  or ingestion credential is embedded in frontend code or browser storage.
- Parser warnings, superseded observations, partial collection, and failure
  responses. Missing data is not zero and an API failure is not an empty list.

Raw-evidence D1/R2 integration remains owned by the backend work. Changes
here neither migrate its schema nor deploy or trigger collectors. The
read-only browser can be replaced without losing evidence or observations.

The first production adapter is implemented separately in
`services/evidence-browser`, with the same frontend built in evidence mode.
It reads sealed Sony Bank runs and their artifacts from the central raw store;
it does not populate the local parsed-observation endpoints. See the
[production evidence browser](production-evidence-browser.md) for its versioned
contract, authentication, deployment configuration, and verification.

## Verification

```sh
bun run typecheck
bun run build
bunx playwright install chromium
bun test
```

`CHROMIUM_PATH` can select an existing Chromium/Chrome executable. CI installs
Chromium and fails if browser tests cannot run. Tests exercise exact amounts,
untrusted provider text, provenance links, filtering, mobile layout, and
request failure/retry behavior against synthetic data.
