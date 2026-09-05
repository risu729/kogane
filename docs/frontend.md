# Frontend foundation

The Japanese evidence browser in `poc/observation-pipeline/web` can be
developed while production raw-evidence ingestion continues. It displays
source observations and their provenance. It does not calculate net worth,
cross-currency totals, reconciled transactions, or P&L.

## Stack decision

Continue the existing, lockfile-pinned stack:

| Responsibility | Library |
| --- | --- |
| UI | React 19 + TypeScript |
| Development and bundling | Vite 8 |
| API requests, cache, cancellation, refresh | TanStack Query 5 |
| Transaction table | TanStack Table 9 |
| Local read-only API | Hono 4 on Bun |
| Verification | Bun tests + Playwright in Chromium |
| Presentation | Shared React components and CSS design tokens |

No additional component, state, or chart library is required for this scope.
Navigation keeps the existing small History API router. Monetary values stay
as decimal strings and use the shared exact formatter; provider text remains
escaped React text. The frontend never reads SQLite or R2 directly.

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
- Data classification and connection capabilities. A successful API refresh
  means the UI reread its store, not that a collector ran or that a source is
  current. Display source timestamps without inventing freshness thresholds.
- Authenticated browser access and protected raw-evidence routes. No admin
  or ingestion credential is embedded in frontend code or browser storage.
- Parser warnings, superseded observations, partial collection, and failure
  responses. Missing data is not zero and an API failure is not an empty list.

Raw-evidence D1/R2 integration remains owned by the backend work. Changes
here neither migrate its schema nor deploy or trigger collectors. The
read-only browser can be replaced without losing evidence or observations.

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
