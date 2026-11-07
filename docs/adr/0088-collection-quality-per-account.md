# ADR 0088: Regroup one source's collection quality cells by the accounts their captures' observations name; serve every collection quality read over MCP through one service

- Status: proposed
- Date: 2026-11-07
- Issue: [#542](https://github.com/risu729/kogane/issues/542) (TODO 2: source ×
  account/card × data type × period)
- Related: [ADR 0045](0045-collection-quality-read.md) (the cell read this
  composes), [ADR 0073](0073-instrument-coverage-per-source.md) (the
  per-source identity counts beside it), [identity](../identity.md),
  [roadmap, layers 0–5](../roadmap.md#layers-05--coverage-and-cross-source-identity)
- Builds on: [ADR 0081](0081-ui-parity-through-mcp.md) (every read page has
  an MCP read over the same service),
  [ADR 0084](0084-mcp-operator-authority-without-delegation.md) (every MCP
  client holds the whole-store grant)

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

ADR 0081 also requires an MCP read for every read page, over the same
application service. The collection quality page's two routes
(`GET /api/collection-quality` and `GET /api/collection-quality/<source>`)
had none: the parity guard listed both as gaps, and each route made its
grant, scope, store, query and bound checks itself, running its table check
through the D1 binding.

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

For the agent reads:

1. **One service per read that grades grant, scope, store, request and
   bound; the route and a page read of `page-read-tools.ts` both call it, and
   both answer the route's codes.** Chosen: one set of checks, and one
   answer per input on every transport, as `kogane.identity.read` does.
2. **MCP tools that call the routes' query functions after their own
   checks.** Rejected: two copies of the checks, which ADR 0081 point 2
   rules out.
3. **Answer agents the service's own `FinancialError` codes** (as first
   proposed in #1063). Rejected: the same refusal would carry a different
   status and code on the page and over MCP, and moving the route onto those
   codes would change its published answers.

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
7. **One service per read, for the page and the agent**
   ([ADR 0081](0081-ui-parity-through-mcp.md)). The collection quality page
   has three reads; each has one service in
   `packages/application/src/query/collection-quality.ts`:
   `readCollectionQualitySummaryForGrant` (`GET /api/collection-quality`),
   `readCollectionQualityCellsForGrant` (`GET /api/collection-quality/<source>`)
   and `readAccountCoverageForGrant` (this ADR's route). Each decides, in this
   order: `evidence.read`, then whole-store scope (both before any
   statement), then the scheduling and collection tables
   (`COLLECTION_QUALITY_TABLES_SQL`, read model), then the request (the
   source id, the keys, the offset, whether the source is a visible CORE
   source), then the bound. Each refusal is one closed
   `CollectionQualityRefusal`. The summary's Alarm relay
   (`services/app/src/collection-quality-alarms.ts`) is passed to the
   service, which overlays only matching reservations. Before this ADR the
   summary and cell routes made those checks in the App route itself, with
   the table check run there through the D1 binding.
8. **One reader for both transports, the route's codes on both.**
   `readCollectionQuality(env, grant, read, request)`
   (`services/app/src/collection-quality-api.ts`) calls the service and turns
   its refusal into the `HttpError` the route has always answered
   (`403 forbidden`, `403 scope_restricted`, `404 not_found` for a missing
   table or an unknown source, `400 invalid_query`, `400 invalid_offset`,
   `413 result_limit_exceeded`). The route calls it with the reader grant;
   its bodies, statuses and headers are byte-equal to the route before the
   services moved.
9. **Three page reads.** `kogane.collection-quality.summary` (`{}`),
   `kogane.collection-quality.cells` (`{ source, offset? }`, offset an
   integer from 0 to 9,999,999) and `kogane.collection-quality.accounts`
   (`{ source }`) are page reads of `services/app/src/page-read-tools.ts`,
   the pattern `kogane.identity.read` set: on `/mcp` and on
   `POST /api/agent/v1/collection-quality.*`, `evidence.read` over the whole
   store (else `403 unauthorized` / `403 evidence_restricted` before the
   argument is read), a closed argument (else `400 invalid_request`), then
   `readCollectionQuality` with the caller's grant. A served read is
   `{ schemaVersion: "kogane-page-read-v1", data: <the route's body> }`, so
   the stored account labels travel under `data`; a refusal is the route's
   status and closed code. Each call leaves one audit record (ADR 0064)
   under the R0 operation `collection-quality.summary`, `.cells` or
   `.accounts` (catalogue entries on the agent paths) with a row count only:
   sources listed, cells on the page (truncated when more follow), or cells
   read; never a source, an account, a period or a reason. Since
   [ADR 0084](0084-mcp-operator-authority-without-delegation.md) every MCP
   client holds the whole-store grant, so all three are listed to every MCP
   client.

No migration, index, writer or grant is added.

## Consequences

- Per source, a person can read which periods of each account's card
  statements, bank movements or balances are current, which are held back
  by a newer capture that is not, and which captures name no account and
  why; an agent reads the same answer, and the summary and cell pages too.
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
    it is served only to the authenticated reader and an MCP client, never
    logged; a label longer than 512 characters fails the wire check, so the
    client shows the read as failed rather than a cut label.
- The parity guard (`services/app/test/ui-mcp-parity.test.ts`) maps the
  three routes to their tools; `/api/collection-quality` and
  `/api/collection-quality/:source` leave its gap list.
- A tool input outside the closed schema is `400 invalid_request` even where
  the route would answer `400 invalid_query` or `400 invalid_offset` for the
  same value, as for every page read. A store without the tables and a
  malformed argument is `400 invalid_request` to a tool and `404 not_found`
  on the route, because the tool reads its argument before the store.
- The summary over MCP waits up to the relay's five-second deadline when
  schedules are enabled, as the page does.
- Old and new clients deploy together with the App Worker; a client newer
  than the Worker gets 404 in the account view only.
- The three tools and their catalogue entries need the owner's approval
  before merge (AGENTS.md, Merging). Since ADR 0084 they are live for every
  MCP client the MCP Access application admits as soon as this ships.
- Numbering: first proposed as ADR 0082 (#1054, with the summary and cell
  reads as an amendment in #1063); 0082 is now another proposal's number
  (#1064), so this ADR is 0088. As first proposed, the tools answered the
  service's `FinancialError` codes, which differed from the route's, and
  were graded by `AGENT_API_GRANTS`; both are gone here.

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
  as `limit_exceeded`), and the account period bound refused whole; the
  capability, perimeter and source refusals of `readAccountCoverageForGrant`
  before any read; and, for every store, each cell of the paged cell read
  appears exactly once with the same state and reasons.
- `packages/application/test/collection-quality-read.test.ts`: the gate's
  order and statement counts for each read, the summary's alarm overlay and
  bound, the cell request's order of refusals, each service equal to its
  query.
- `packages/read-model/test/collection-quality.test.ts`: the cell page's
  digest is unchanged; on the scaled store without statistics the account
  read reaches publications, identity runs, seals, identity observations,
  mappings and accounts by key, reads no observation table, and scans
  nothing whole outside the cell read's own relations; timings printed, not
  asserted.
- `packages/observation-shared/test/account-coverage-contract.test.ts`: the
  wire check accepts the shape only under its own source's path and refuses
  unsorted or repeated accounts, empty periods, zero observations, a
  standing that contradicts the cell state, unknown codes and statuses, and
  more cells than the bound.
- `services/app/test/collection-quality-parity.test.ts`: every route answer,
  across paths, query strings, methods, reader grants, stores with and
  without the tables, relay modes and the row bound, byte-equal to the
  frozen pre-refactor route in `legacy-collection-quality-api.ts`.
- `services/app/test/collection-quality-api.test.ts`: the routes over the
  real Worker (answers, path checks, refusals, Access, GET-only, absence
  without CORE 0065, the bound, nothing written).
- `services/app/test/page-read-collection-quality.test.ts`: each tool
  listed exactly to `evidence.read` over the whole store, and to an MCP
  client; each answering its route's body under `data`, or its route's
  status and code (unknown source, store without the tables, the summary
  bound), on `/mcp` and `/api/agent/v1/*`; closed-argument and grant
  refusals; one R0 `read` audit record per call with its row count and no
  source. `agent-api.test.ts`, `mcp-client.test.ts` and
  `mcp-sdk-client.test.ts` pin the tools in the published lists and
  schemas; `ui-mcp-parity.test.ts` maps the three routes.
- `apps/web/test/collection-quality.browser.test.ts`: Chromium at 375 px on
  the production build: the default view never requests the account read;
  the account view shows the account, its unresolved status, data type,
  standing and count, the pending month apart with its reason, and no
  page-wide horizontal scroll.
- `mise run //packages/read-model:ci`, `//packages/application:ci`,
  `//packages/observation-shared:ci`, `//services/app:ci`, `//apps/web:ci`,
  `//experiments/observation-pipeline-local:ci`, `mise run ci:root`.
