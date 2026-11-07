# ADR 0082: Regroup one source's collection quality cells by the accounts their captures' observations name

- Status: proposed
- Date: 2026-11-07
- Issue: [#542](https://github.com/risu729/kogane/issues/542) (TODO 2: source ×
  account/card × data type × period)
- Related: [ADR 0045](0045-collection-quality-read.md) (the cell read this
  composes), [ADR 0073](0073-instrument-coverage-per-source.md) (the
  per-source identity counts beside it), [identity](../identity.md),
  [roadmap, layers 0–5](../roadmap.md#layers-05--coverage-and-cross-source-identity)

## Context

The roadmap's phase 3 is done when "coverage is visible per account and data
type", and phase 2 needs "coverage of the card's statements and the bank's
debits". The collection quality cells of ADR 0045 are per source × fetch unit
× dataset × period. A fetch unit key is a collector's acquisition partition
(a Vpass card token, a MyJCB connection, a Money Forward account digest, or
none at all for SMBC, Sony Bank or GLOBAL PASS); it is not an account, and
ADR 0045 says so on every cell (`取得単位のキーと整理済みの口座は同一とは限りません`).
Which account a capture covers is known only from the identity layer: each
published parse's sealed identity run maps each observation to a source
account, and the current account mapping maps that to an `accounts` target
with a status (`identified`, `provider-local`, `aggregate`, `unresolved`).
No read put the cells and those accounts side by side, so "which months of
this card's statements, and which of this bank account's debits, are
current" could only be answered by reading two pages and joining them by
hand.

## Options considered

1. **Map fetch units to accounts by the accounts a unit's earlier captures
   named.** Rejected: it would attribute a failed or empty attempt to an
   account by inference, and a unit key is not an account (a MyJCB connection
   holds several cards; SMBC has no unit). That is a guessed provider
   semantic (ADR 0004).
2. **A new account coverage query that restates the cell rules per
   account.** Rejected: a second answer to "which capture is current" that
   could drift from the cells and from the Transactions/Balances reads
   ADR 0045 composes, and a second equality proof.
3. **Add account columns to the paged cell read.** Rejected: one cell can
   name several accounts, so the page's row shape would change for every
   client, and grouping by account across pages needs the whole source
   anyway.
4. **Share the cell read's CTEs unchanged and add the accounts each cell's
   captures name; regroup in the application.** Chosen.

## Decision

1. **SQL.** `packages/read-model/src/collection-quality.ts` splits the cell
   read into `CELL_RESULT_CTES` (everything up to and including `cq_result`,
   the source's cells unpaged) and the page's `SELECT … LIMIT 500 OFFSET ?2`;
   the page's text is byte-identical (its SHA-256 is pinned in
   `test/collection-quality.test.ts`). `ACCOUNT_COVERAGE_SQL` selects every
   cell from the same CTEs, in the same order, with `accounts_json`: for the
   cell's newest capture (`cq_newest`) and current capture (the `cq_members`
   artifacts of the run `cq_current` chose), the accounts their published
   parses' observations name, read exactly as the cell's
   `unresolved_identities` count reads them (the newest sealed eligible
   identity run per parse, its identity observations, each one's current
   account mapping), counted per capture, account, mapping status and
   observation kind. It reads no observation table and no unit key.
2. **Service.** `queryAccountCoverage(executor, { sourceId })`
   (`packages/application/src/query/collection-quality.ts`) maps each row
   through the cell page's own `cell()` (state and reasons) and regroups:
   - **accounts**, sorted by id, each with its label (`accounts.label`), the
     current mapping statuses of the source accounts that name it here, and
     its **data types** — (dataset, parser, observation kind) — each with
     its **periods**: the cell's unit key, period, rule, state and reasons;
     the capture that names the account and how many of its observations it
     holds; and a closed `standing`: `current` (the current capture names
     it and is the newest), `older-current` (the current capture names it
     while a newer capture is not current) or `newest-not-current` (only the
     newest capture names it and it is not, or not wholly, current);
   - **unattributed**: every cell neither capture's observations name an
     account in (no artifact, parse pending, failed or unpublished, a
     publication with no observation, or no identity run recorded), with the
     cell's own reasons.
3. **Bounds.** The whole source is read in one statement, never paged and
   never cut: more than 2,000 cells, or more than 10,000 account period
   entries, is refused whole (`413 result_limit_exceeded`). The cost is the
   cell read's (ADR 0045) plus keyed lookups per capture artifact.
4. **Route.** `GET /api/collection-quality/<sourceId>/accounts`, inside the
   collection quality dispatcher: the same Access gate, the reader grant's
   `evidence.read` over the whole store (decided before any read), GET and
   HEAD only, no parameter (`400 invalid_query`), 404 for an unknown or
   invisible source and where CORE 0065's tables are absent.
5. **Wire check.** `validAccountCoverage`
   (`packages/observation-shared/src/collection-quality-contract.ts`),
   reached through `validCollectionQualityResponse` by path: version 1, the
   path's source, closed statuses, kinds, standings and reasons, a standing
   consistent with the cell state, at least one observation per period,
   sorted unique accounts, and the bounds.
6. **Page.** `/collection-quality?source=<id>&view=accounts` shows
   `口座 × データ種別 × 期間`: one panel per account (label, id and mapping
   status in words), its data types with their periods, standing, capture
   link, observation count and reasons, and a panel
   `口座に対応付けられない保存記録`. A view switch (`取得単位ごと` /
   `口座ごと`) sits beside the cell list; the default view's requests are
   unchanged.
7. **One service for the page and the agent** ([ADR 0081](0081-ui-parity-through-mcp.md)).
   `readAccountCoverageForGrant({ grant, sql, sourceId })` decides the
   grant (`evidence.read`, else `unauthorized`), the whole-store perimeter
   (`evidence_restricted` with `scope:source` / `scope:account`), the source
   (`invalid_query` with `source` when malformed or not visible) and the
   bounds (`budget_exceeded`) before or around `queryAccountCoverage`. The
   route calls it with the reader grant and maps its refusals to the
   collection quality route's codes (403, 404, 413). The agent read
   `kogane.collection-quality.accounts` (on `/mcp` and
   `POST /api/agent/v1/collection-quality.accounts`, `read-tools.ts`) calls
   it with the caller's grant: input a closed object with one required key,
   `source` (the route's source grammar; anything else is
   `400 invalid_request` on both transports), listed by `tools/list` only to
   a grant holding `evidence.read` over the whole store, and answering the
   route's body unchanged. Each call leaves one audit record (ADR 0064)
   under the R0 operation `collection-quality.accounts` with the number of
   cells read, never a source, an account or a period.

No migration, index, writer or grant is added.

## Consequences

- Per source, a person can read which periods of each account's card
  statements, bank movements or balances are current, which are held back
  by a newer capture that is not, and which captures name no account and
  why.
- Open limits, stated rather than hidden:
  - a period no capture of the source has is not listed: nothing here knows
    which statement months or debit ranges a provider should have, so no
    gap is claimed missing and no run of months is claimed complete;
    `retention_not_assessed` stays on every cell;
  - the read is per source: an account that two sources name (a bank seen
    directly and through Money Forward, once a mapping links them) is listed
    under each source, and no cross-source total or merge is made;
  - whether an account is the owner's is not decided here (card ownership
    has its own review); every account a source's observations name is
    listed with its mapping status;
  - a cell with no current capture whose newest capture is unpublished names
    no account, even when an older capture of the same slot did: the older
    capture is not the cell's newest or current one;
  - the account label is a stored label, as the identities page shows it;
    it is served only to the authenticated reader, never logged; a label
    longer than 512 characters fails the wire check, so the client shows
    the read as failed rather than a cut label.
- Old and new clients deploy together with the App Worker; a client newer
  than the Worker gets 404 in the account view only.
- The agent read adds an `operation-path/catalogue.ts` entry and a read
  tool, which needs the owner's approval before merge (AGENTS.md, Merging).
  The two collection quality routes this view extends get their MCP reads
  in the amendment below.
- As first proposed, the account read did not check for CORE 0065's
  scheduling tables on the agent path, because it reads none of them. The
  amendment below moves that check into the service, so every collection
  quality read makes it on every transport.

## Verification

Synthetic data only, no production access:

- `packages/application/test/account-coverage.test.ts`, over complete-CORE
  stores with identity rows written append-only: an unknown source and an
  empty source; Vpass statement months per account (current, older-current
  behind a refused page, an unresolved mapping kept as status and reason, a
  unit with no file left unattributed, never attributed through its unit
  key); a container snapshot whose newest partial capture names a new
  account (`newest-not-current`); empty and identity-less publications
  unattributed with their reasons; a corrected mapping (a second revision)
  moving the periods to the reviewed account with both revisions stored;
  two source accounts reviewed onto one account, in a capture that is both
  the newest and the current one, under an older sealed and a newer unsealed
  policy run, listed as one period with the newest sealed run's observations
  (INV06); nothing written; the cell bound refused whole (and, under a grant,
  as `budget_exceeded`), and the account period bound refused whole; the capability, perimeter and source refusals of `readAccountCoverageForGrant` before any read; and, for every store, each
  cell of the paged cell read appears exactly once with the same state and
  reasons.
- `packages/read-model/test/collection-quality.test.ts`: the cell page's
  digest is unchanged; on the scaled store without statistics the account
  read reaches publications, identity runs, seals, identity observations,
  mappings and accounts by
  key, reads no observation table, and scans nothing whole outside the cell
  read's own relations; timings printed, not asserted.
- `packages/observation-shared/test/account-coverage-contract.test.ts`: the
  wire check accepts the shape only under its own source's path and refuses
  unsorted or repeated accounts, empty periods, zero observations, a
  standing that contradicts the cell state, unknown codes and statuses, and
  more cells than the bound.
- `services/app/test/collection-quality-api.test.ts`: the route over the
  real Worker (answer, path check, refusals, Access, GET-only, absence
  without CORE 0065, nothing written); the agent read listed only to
  whole-store `evidence.read`, answering the route's body over HTTP and MCP,
  the capability, scope, source and input refusals equal over both
  transports, and one R0 `read` audit record per call with its cell count
  and no source. `agent-api.test.ts`, `mcp-client.test.ts` and
  `instrument-coverage-api.test.ts` pin the tool in the published lists and
  schemas under each grant shape.
- `apps/web/test/collection-quality.browser.test.ts`: Chromium at 375 px on
  the production build: the default view never requests the account read;
  the account view shows the account, its unresolved status, data type,
  standing and count, the pending month apart with its reason, and no
  page-wide horizontal scroll.
- `mise run //packages/read-model:ci`, `//packages/application:ci`,
  `//packages/observation-shared:ci`, `//services/app:ci`, `//apps/web:ci`,
  `//experiments/observation-pipeline-local:ci`, `mise run ci:root`.

## Amendment 2026-11-07: the summary and cell reads over MCP, one gate

- Status: proposed (stacked on the PR that proposes this ADR)

Context. [ADR 0081](0081-ui-parity-through-mcp.md) requires every read page
to have an MCP read over the same application service. Of the three
collection quality routes, only the account view had one; the summary
(`GET /api/collection-quality`) and the cell page
(`GET /api/collection-quality/<source>`) did their grant, scope, store,
query and bound checks in the App route itself, and the account read checked
the store's scheduling tables in the route only, so on a store without them
the route answered 404 and the agent read an uncaught SQL error.

Options considered. (1) One service per read that grades grant, scope,
store, request and bound, with both transports as thin adapters (chosen).
(2) MCP tools that call the routes' query functions after their own checks:
two copies of the checks, which ADR 0081 point 2 rules out. (3) Keep the
table check in the route: the agent read would keep running its query on a
store without the tables, and the transports would not share that refusal.
(4) Also move the route onto the service's error codes: it would change the
route's published answers (404, 413 and the two 400 codes), which nothing
in ADR 0081 asks for and which this amendment keeps byte-equal.

Decision.

- `readCollectionQualitySummaryForGrant`, `readCollectionQualityCellsForGrant`
  and `readAccountCoverageForGrant` (`packages/application/src/query/collection-quality.ts`)
  each decide, in order: `evidence.read`, whole-store scope (both before any
  statement), the scheduling and collection tables
  (`COLLECTION_QUALITY_TABLES_SQL`, read model), the request, the bound. Each
  refusal is one closed `CollectionQualityRefusal` with its
  `FinancialError`; the account read's request becomes `{ source }`.
- `GET /api/collection-quality*` turns the URL into the service's request
  and the refusal into the HTTP error it has always answered; its bodies,
  statuses and headers are unchanged.
- `kogane.collection-quality.summary` (`{}`) and
  `kogane.collection-quality.cells` (`{ source, offset? }`) are new read
  tools, R0 `read` under `evidence.read` on a whole-store grant, listed only
  to such a grant, with catalogue entries `collection-quality.summary` and
  `collection-quality.cells`; their audit records carry row counts only.
  Like the account tool, they need the owner's approval before merge
  (AGENTS.md, Merging).
- The summary's Alarm relay (`services/app/src/collection-quality-alarms.ts`)
  is passed to the service by both transports; the service overlays it.
- A store without the tables is one refusal, `unavailable`, on every
  transport and for all three reads, decided at the same step. The agent
  transports answer it with the service's `FinancialError`,
  `400 unsupported_semantics` (`store:collection-scheduling`); the route
  answers it `404 not_found`, as it always has. The route encodes every
  refusal in its own codes this way (`unknown_source` is `404` there and
  `400 invalid_query` to an agent, a bound `413 result_limit_exceeded` there
  and `413 budget_exceeded` to an agent), as decision 7 already did for the
  account route. So "the same answer for the same input" of ADR 0081 point 2
  holds here for bodies and for which refusal is made, in which order; the
  status and code of a refusal differ by transport, as documented in the
  [agent API](../agent-api.md#collection-quality).

Consequences. The three routes have their MCP reads, so the parity guard's
route-to-tool map can name `kogane.collection-quality.summary` and
`kogane.collection-quality.cells` for the two routes it lists as gaps. The
summary read over MCP waits up to the relay's five-second deadline when
schedules are enabled, as the page does. The committed `AGENT_API_GRANTS`
grants no client `evidence.read`, so no configured client is offered the
tools.

Verification. `packages/application/test/collection-quality-read.test.ts`
(the gate's order and statement counts for each read, the summary's alarm
overlay and bound, the cell request's order of refusals, each service equal
to its query); `services/app/test/collection-quality-parity.test.ts` (every
route answer, across paths, query strings, methods, reader grants, stores
with and without the tables, relay modes and the row bound, byte-equal to the
frozen pre-refactor route in `legacy-collection-quality-api.ts`);
`services/app/test/collection-quality-api.test.ts` (both tools listed only to
whole-store `evidence.read`, answering the routes' bodies over HTTP and MCP
and passing the web client's wire check, every refusal equal on both
transports including the missing tables and the summary bound, audit records
with counts only).
