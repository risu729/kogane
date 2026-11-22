# Frontend foundation

The Japanese evidence browser in `apps/web` can be
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
as decimal strings and use the shared exact formatters in `apps/web/src/money.ts`:
`formatAmount` for integer minor units, and `formatDecimal` (or
`formatDecimalText` for a compact wire quantity) for an exact decimal such as
a settlement, reward, report or subtotal quantity. Both group integer digits
in threes and keep the sign and every fraction digit, never through floating point;
`test/money.test.ts` holds them to the same text for each known currency.
Counts are printed as plain digits, without separators, and nothing in the
client calls `toLocaleString` or `Intl.NumberFormat`. Provider text remains
escaped React text. The frontend never reads SQLite or R2 directly.

Transaction filters, search, sort, and page selection, balance source/account,
currency/unit and kind filters, plus position filters and page selection,
survive visits to detail pages within the current tab. A page selection
belongs to the server window it was chosen in: the next 500 rows or a changed
server filter open at their first page. They reset on reload
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
refresh failures retain previously authorized records with an explicit warning:
`QueryBoundary` shows them under `更新できませんでした。前回読み込んだ{label}を表示しています。`
("could not refresh; showing the {label} loaded earlier") with a retry, or under its
offline 前回読み込んだ notice while a read is paused. `収集スケジュール`
("collection schedules") renders through it, and so do the two correction
histories (`訂正履歴を見る` on an instrument candidate, `取得元の口座の訂正履歴を見る`
on an account candidate), which are read again when reopened. While the schedules page shows an earlier
answer it also holds 依頼を送信 and the re-survey 採用/却下, which decide from what
it shows ([schedules](schedules.md#schedule-administration)).
The ホーム page's `判断待ち` panel does not go through `QueryBoundary`: a failed read
there shows no total and no earlier lines (INV05). It uses the shared states directly: `Loading`
(a status) while the first read waits, and `ErrorState` (an alert with
`判断待ちの件数を再試行`) once a read fails. The alert stays, its button saying 再試行中…,
while that retry or a refresh after an earlier answer is in flight; a refresh that starts
on its own after a failed first read shows `Loading` again.

## Design tokens and stylesheet layout

`apps/web/src/styles.css` is an index of `@import` lines; the rules live in
`apps/web/src/styles/`, imported in cascade order:

| File             | Holds                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`     | Every colour, type size, spacing step, radius and shadow, as `:root` custom properties                                                                    |
| `base.css`       | Reset, body, links, focus ring, headings, `summary`, code, value and list helpers                                                                         |
| `shell.css`      | App shell: sidebar, brand, navigation, workspace bar, source notice, main, footer                                                                         |
| `components.css` | Panels and note tones, badges, buttons, filters, key/value grids, states, pagination, disclosures, tiles, provenance chain, code preview                  |
| `tables.css`     | Scroll region, cell defaults, sortable headers, the transaction/balance/identity column contracts                                                         |
| `pages.css`      | Page-specific layouts: overview, source cards, positions, observation lists, rewards, settlement, card ownership, card purchases, reported state, reports |

`styles/schedules.css` is not in the index: `pages/Schedules.tsx` imports it
directly, and it still carries raw pixel sizes and fallback colours beside its
token references. `balance-display.css` stays beside its component. Responsive rules sit next to
the rule they modify, not in one media block, so page work touches one file.

The scales in `tokens.css`:

- Type: `--text-xs` (11px) through `--text-3xl` (32px) in eight steps. Nothing
  renders below `--text-xs`; the smallest-text colour `--text-3` clears WCAG AA
  on every surface it is printed on (the ratios are in the file).
- Spacing: `--space-1` (4px) to `--space-8` (40px) on a 4px grid.
- Radii: `--radius-sm` (controls, badges), `--radius-md` (nested cards,
  disclosures), `--radius-lg` (panels; `--radius` is its alias).
- Tones: `--ok-*`, `--warn-*`, `--bad-*`, `--sup-*` triples (foreground,
  background, border) shared by badges, notes and states; `--code-*` for the
  evidence preview palette.

Rule: new CSS uses tokens. Raw colours, pixel sizes and radii belong only in
`tokens.css`; a value that has no token gets one there first. The documented
exceptions are drawn geometry: the brand mark, the empty-state symbol, the
provenance chain rail, and the main column's `max-width`.

### Shared primitives

Pages compose these instead of writing their own markup or rules:

| Need                          | Use                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Page header                   | `.page-head` with the `<h1>` and a `.lede`; `.footnote` for caveats                                                                   |
| Grouped content               | `Panel` (`.panel` with `.panel-head`, `.panel-note`, `.panel-body`); content inside a panel always sits in `.panel-body`              |
| Key/value facts               | `Kv` / `KvRow`                                                                                                                        |
| Status words                  | `Badge`, `StatusBadge`, `LineageBadge`; an absent value is `Nullable`, in words naming what is absent, never blank                    |
| Loading, error, empty, stale  | `QueryBoundary` (with `isEmpty`/`empty`), `ErrorState`, `EmptyState`                                                                  |
| Notices                       | `Notice` (`.panel-note` tones `-warn`/`-bad`) at panel level; `Notice` with `inline` (`.notice`) inside a body                        |
| Filters                       | `.filter-grid` with `.filter-field` controls, one bar per panel spanning edge to edge                                                 |
| Free-text and checkbox inputs | `.field` (label + input/textarea) and `.check-field`; never a bare native control                                                     |
| Actions                       | `.button` in a `.button-row`; toggles carry `aria-pressed`                                                                            |
| Paging                        | `Pagination` (offset or cursor) rendering `.pagination`, a named group whose status speaks its label; one label per pager on a page   |
| Tables                        | `.table-scroll` region with `role="region"`, `tabIndex`, a `<caption>` and a class that sets `min-width`; `.cell-time` for timestamps |
| Disclosures                   | `.detail-disclosure` (framed; frameless as a panel's last child or when it holds panels) or `.inline-disclosure` (in cells and cards) |
| Lists                         | `.plain-list` (stacked; an `<ol>` keeps its numbers), `.warning-list` (parser warnings, reason and blocker codes)                     |
| Long tokens                   | `.wrap-any`; `.visually-hidden` for captions whose text is already on screen                                                          |
| Codes as words                | `displayLabel` or `ownEntry` (`labels.ts`) for a code a table may lack: only own keys answer, so `constructor` is unknown             |
| Evidence chains               | `ChainStep` in an `<ol className="chain">`: record → parse → original; usage → statement → debit; a candidate's pending → posted row  |
| Review candidates             | A `.panel` with a `.settlement-head`, then a `.settlement-disclosure` open while a decision is due (see below)                        |
| Figures kept apart            | `.tiles` of `.tile` (value, then label) in a `role="list"`; one tile per state and unit, never a combined tile                        |

A list paged by an opaque cursor uses `CursorPager` (in `pagination.tsx`, over
`Pagination`): its buttons say 前のページ and 次のページ, its status says
続きがあります or 最後のページです unless the page passes its own, and its
buttons, its read-again action included, wait while a read of the list is in
flight. Waiting is `aria-disabled` and ignores a press rather than `disabled`,
so a button the owner pressed, or sits on during a background read, keeps the
focus; a button with nowhere to go (no earlier page, no more rows) is
`disabled`. The 監査ログ, 依頼の一覧, latest balance and evidence browser lists
use it.

The 口座・銘柄 lists the server pages by offset name the rows a page shows
(1–2件); these reads count no total. A page with no rows says 表示なし, and only
an empty first page says the list is empty: a later page that comes back empty,
because the list shrank, says that this page lists nothing and keeps its pager.

A review candidate (a card settlement on `カード照合` ("card reconciliation"), a pending-to-posted link on
`カード利用` ("card usage")) is one panel. Its `.settlement-head` holds the title, a status
`Badge` and the identifying `.settlement-facts`. The review sits under a
`.settlement-disclosure` that starts open only while a decision is due, and
always on a card settlement's own page (`/reconciliation/<proposalId>`). The
decision is a `.settlement-decision`: a required `.settlement-reason`, a button
per action the candidate allows, and a footnote that planning decides nothing.
The pending-to-posted review also states each action's effect in words.

An unknown value says why (INV05). When the answer carries a closed reason
for it, the page shows that reason: `不明（<code>）` (`SettlementQuantity`,
`DateValue`, the 次回の引落 amounts and a not-listed card's due date), or the
reason in words beside a badge (引落口座は不明). When the answer sends a bare
null, `Nullable` names what is missing rather than a bare 不明 (a payable
with no due date recorded on 基準日の保有状況 is 引落予定日未記録). A due or
debit date the card reconciliation reads send as null carries its closed
reason (`paymentDateReason`, `debitDateReason`), and `NullableDate` shows it
as `不明（<code>）`; a null without one, which their wire contracts refuse,
would read 年月日として読める記録なし. An identifier is printed
`namespace / scope / value`; an empty scope is part of the key and stays
empty, never a dash.

The application frame is `AppShell`, used by both the observation client and
the evidence-only client; navigation entries come from one list with icons.

## API metadata and capabilities

`/api/meta` describes the connection. Its `source.kind` (`local-store`,
`central-store`, or a future name) and `source.classification` are labels
only; every UI decision reads `capabilities`, so renaming a connection cannot
change what the client sends or shows. The capability object, the query
parameters each capability unlocks, and the client argument builder are one
definition in `packages/observation-shared/src/api-schema.ts`. The response
validator (`validApiResponse`) checks the object against that schema, both
servers derive their accepted parameters from it, and the same
conformance checks (`packages/observation-shared/test-support/api-conformance.ts`) run against the local store,
the local synthetic snapshot adapter, and the production Worker. Capabilities are never
an authorization switch: Access JWT verification, closed responses on auth
failure, and `no-store` apply before any capability is read.

| Capability             | Values                  | Local / demo | Production                    | Effect in the client                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------- | ------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractVersion`      | `observation-api-v1`    | yes          | yes                           | Validator rejects any other version                                                                                                                                                                                                                                                                                                                         |
| `readOnly`             | `true`                  | yes          | yes                           | No write control exists                                                                                                                                                                                                                                                                                                                                     |
| `rawEvidence`          | `true`                  | yes          | yes                           | `/api/raw/<sha256>` links                                                                                                                                                                                                                                                                                                                                   |
| `liveCollectors`       | `false`                 | yes          | yes                           | Refresh never means a collector ran                                                                                                                                                                                                                                                                                                                         |
| `measureViews`         | `balances`, `summaries` | none         | both                          | `view=` is sent only for an advertised view                                                                                                                                                                                                                                                                                                                 |
| `identityReadModes`    | `latest`, `as-recorded` | none         | both                          | With `latest`, the `口座・銘柄` ("accounts and instruments") page and link exist; its `/api/identity/*` reads send no `identityRead=` (the server default `latest` applies). No control sets the parameter: an `identityRead=` already in the page URL is forwarded on transaction, balance, v2 balance and position list reads only for an advertised mode |
| `paginationVersion`    | `none`, `offset-v1`     | `none`       | `offset-v1`                   | Coverage record, next-page links, no client column sort                                                                                                                                                                                                                                                                                                     |
| `balancesV2`           | boolean                 | false        | sealed snapshot               | The `最新の残高` ("latest balances") read-model section exists; the v2 balance routes are requested                                                                                                                                                                                                                                                         |
| `balancesV2Pagination` | `none`, `keyset-v2`     | `none`       | `keyset-v2` when `balancesV2` | Cursor paging over one fixed snapshot, with a "read the newest snapshot" action                                                                                                                                                                                                                                                                             |
| `collectionFilters`    | boolean                 | false        | true                          | Server filter controls replace client record controls                                                                                                                                                                                                                                                                                                       |
| `organizedDisplay`     | boolean                 | false        | true                          | Rows carry `organization`                                                                                                                                                                                                                                                                                                                                   |
| `financialProducts`    | boolean                 | false        | true                          | Organized rows may carry a product claim                                                                                                                                                                                                                                                                                                                    |
| `evidenceHistory`      | boolean                 | false        | true                          | The `取得履歴` ("capture history") route and link exist                                                                                                                                                                                                                                                                                                     |
| `sharedQuery`          | boolean                 | false        | true                          | Summary counts come from `GET /api/v2/query`, not page arithmetic                                                                                                                                                                                                                                                                                           |
| `reportArtifacts`      | boolean                 | false        | `report_artifacts` present    | The `評価レポート` ("valuation reports") route and link exist; the report routes are requested                                                                                                                                                                                                                                                              |
| `pendingDecisions`     | boolean                 | false        | true                          | The ホーム page's `判断待ち` panel exists and `GET /api/v2/decisions/pending` is requested ([ADR 0126](adr/0126-pending-decisions-summary.md)); a store without the route is never probed                                                                                                                                                                   |

`balancesV2` is the one capability that also depends on stored state: the
production Worker advertises it only when the balance projection has a sealed
snapshot, so a capability is never a promise the store cannot keep (see
[Balance read model](balance-read-model.md)). While READ is bound the v2
balance paths still exist and answer 503 until that snapshot is published. A
path whose own capability is missing answers 404, not 400: there is no route
to reject a parameter for.

A server refuses with 400 any query parameter its capabilities do not grant;
the client never sends one. While metadata is loading, capabilities are
unknown: dependent list queries stay disabled and pages show their loading
state rather than requesting with guessed defaults. Changing the schema fails
the pinned contract tests in both `apps/web` and
`services/app`, so a one-sided edit cannot pass CI.

## Shared figures and the AI hand-off

A page that does its own arithmetic and an assistant that does its own can
hand a person two different numbers from the same data, and neither can be
shown to be wrong. Where the server advertises `sharedQuery`, the Overview
page's summary counts therefore come from `GET /api/v2/query?intent=coverage`
— the shared application service (`packages/application`) that the agent API
also calls, with the same scope rules — instead of summing rows in the client.
While that read is loading or after it fails, the counts show the loading or
error state and are not replaced by client arithmetic: the Overview's own run
list is a bounded window of the newest runs, not the whole history. On a
store without that capability the page keeps its own arithmetic, so the
local pipeline experiment and snapshot conformance tests are unaffected.

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

From the repository root:

```sh
mise run install
mise run //experiments/observation-pipeline-local:preview
```

Preview builds the UI, creates a new temporary database, and populates it
only from committed synthetic fixtures. It serves on `127.0.0.1:8787` and
reports synthetic data through `/api/meta`. It does not read or modify the
regular `state/` database. A normal shutdown removes its temporary store.
An abrupt process termination can leave a temporary `kogane-preview-*`
directory; it contains only synthetic data.

Because `/api/meta` reports `source.classification: synthetic`, the client
mounts no financial or evidence view, and no command view other than the
schedules page below. Every such route (`取引` ("transactions"), `残高` ("balances"), `保有資産` ("holdings"), `原本・証跡` ("originals and evidence") and the
others) shows only `表示対象の記録がありません` ("there are no records to display") and `接続先を確認してください。` ("check the connection"),
even though the preview API still serves the fixtures
([synthetic display test](../apps/web/test/synthetic-display.browser.test.ts)).
The preview is therefore a check of the shell and that guard, not of the
financial pages. `収集スケジュール` ("collection schedules") (`/schedules`), `監査ログ` ("audit log") (`/audit`),
`依頼の一覧` ("request list") (`/operations`) and
`依頼の経過` ("request progress") (`/operations/op_<id>`) are drawn outside that guard, but the
preview serves none of `/api/ops/v1/schedules`, `/api/v2/audit`,
`/api/ops/v1/operations` and `/api/ops/v1/operations/{id}`: the schedules page shows its load-error
messages, the audit page says that this source provides no audit log, the
request list says that this source does not provide it, and the
operation page says the operation is not found.

`mise run //experiments/observation-pipeline-local:serve` continues to read the regular local store. Its metadata
reports the data classification as unknown: an operator may have ingested
real evidence, synthetic evidence, or both. An existing store must never be
labelled synthetic merely because it is local. Neither mode is a connection
to the production collector database.

## Production API handoff

The browser and local query layer share type-only response contracts in
`packages/observation-shared/src/api-contract.ts`. These describe the local
pipeline experiment (`experiments/observation-pipeline-local`), not a frozen
production database schema. Production adapters should
map the domain to a versioned read API, with an explicit revision when
semantics change. In particular, the experiment's numeric identifiers and raw
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
  inventing freshness thresholds: a freshness state is shown only where the
  API states one under a named policy (collection quality's
  `collection-freshness-v1`, the reported state's `dated-state-freshness-v1`).
- Authenticated browser access and protected raw-evidence routes. No admin
  or ingestion credential is embedded in frontend code or browser storage.
- Parser warnings, superseded observations, partial collection, and failure
  responses. Missing data is not zero and an API failure is not an empty list.

Raw-evidence D1/R2 integration remains owned by the backend work. Changes
here neither migrate its schema nor deploy or trigger collectors. The
read-only browser can be replaced without losing evidence or observations.

The first production adapter is implemented separately in
`services/app`, with the same frontend built in evidence mode.
It reads sealed Sony Bank runs and their artifacts from the central raw store;
it does not populate the local parsed-observation endpoints. See the
[production evidence browser](production-evidence-browser.md) for its versioned
contract, authentication, deployment configuration, and verification.

## Verification

```sh
mise run //apps/web:ci              # typecheck, the three builds, unit and browser tests
mise run //experiments/observation-pipeline-local:ci   # the experiment's suite over the built client
```

`CHROMIUM_PATH` can select an existing Chromium/Chrome executable; without it
the browser tests use the Playwright-managed Chromium, which CI installs
(`web:browser`) and fails on when it cannot run. Tests exercise exact amounts,
untrusted provider text, provenance links, filtering, mobile layout, and
request failure/retry behavior against synthetic data.
