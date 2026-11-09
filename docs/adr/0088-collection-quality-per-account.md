# ADR 0088: Regroup one source's collection quality cells by the accounts their captures' observations name

- Status: accepted (merged 2026-11-08 in [#1112](https://github.com/risu729/kogane/pull/1112))
- Date: 2026-11-08
- Issue: [#542](https://github.com/risu729/kogane/issues/542) (TODO 2: source ×
  account/card × data type × period)
- Related: [ADR 0045](0045-collection-quality-read.md) (the cell read this
  composes, and its 2026-11-07 amendment: `kogane.collection-quality.read`),
  [ADR 0073](0073-instrument-coverage-per-source.md) (the per-source identity
  counts beside it), [identity](../identity.md),
  [roadmap, layers 0–5](../roadmap.md#layers-05--coverage-and-cross-source-identity)
- Builds on: [ADR 0081](0081-ui-parity-through-mcp.md) (every read page has
  an MCP read over the same reader),
  [ADR 0084](0084-mcp-operator-authority-without-delegation.md) (every MCP
  client holds the whole-store grant)
- Amends: `kogane.collection-quality.read` (ADR 0045's 2026-11-07 amendment,
  #1082) with a `view` argument

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

Since #1082, the summary and one source's cells are one MCP tool,
`kogane.collection-quality.read`, which calls `readCollectionQuality` in
`services/app/src/collection-quality-api.ts`, the reader both routes call.
A new read page must have its MCP read in the same change (ADR 0081).

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

For the agent read:

1. **A `view` argument on `kogane.collection-quality.read`**, which builds
   the account route's path and calls the same reader. Chosen: one tool per
   page, as `kogane.reports.read` picks a report's body or explanation with
   `view`, and one more route on the reader that already answers the other
   two.
2. **A separate tool for the account view.** Rejected: a second catalogue
   entry, audit label and tool listing for a third route of the same page,
   reader, capability and store feature.

## Decision

1. **SQL.** `packages/read-model/src/collection-quality.ts` splits the cell
   read into `CELL_RESULT_CTES` (everything up to and including `cq_result`,
   the source's cells unpaged) and the page's `SELECT … LIMIT 501 OFFSET ?2`;
   the page's text is byte-identical to the shipped text, frozen in
   `test/collection-quality-cells-legacy-sql.ts` with its SHA-256.
   `ACCOUNT_COVERAGE_SQL` selects every cell from the same CTEs, in the same
   order, with `accounts_json`: for the cell's newest capture (`cq_newest`)
   and current capture (the `cq_members` artifacts of the run `cq_current`
   chose), the accounts their published parses' observations name, read
   exactly as the cell's `unresolved_identities` count reads them (the newest
   sealed eligible identity run per parse, its identity observations, each
   one's current account mapping), counted per capture, account, mapping
   status and observation kind. It reads no observation table and no unit
   key.
2. **Query.** `queryAccountCoverage(executor, { sourceId })`
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
   entries, is refused whole (`CollectionQualityLimitError`, answered
   `413 result_limit_exceeded`). The cost is the cell read's (ADR 0045) plus
   keyed lookups per capture artifact.
4. **Route.** `GET /api/collection-quality/<sourceId>/accounts`, inside the
   collection quality dispatcher and its reader `readCollectionQuality`: the
   same Access gate, the reader grant's `evidence.read` over the whole store
   (decided before any read), GET and HEAD only, no query at all, not even
   `?` (`400 invalid_query`), 404 for a malformed, unknown or invisible
   source and where CORE 0065's tables are absent.
5. **Wire check.** `validAccountCoverage`
   (`packages/observation-shared/src/collection-quality-contract.ts`),
   reached through `validCollectionQualityResponse` by path: version 1, the
   path's source, closed statuses (`MAPPING_STATUSES`), kinds
   (`OBSERVATION_KINDS`), standings (`ACCOUNT_STANDINGS`) and reasons, a
   standing consistent with the cell state, at least one observation per
   period, sorted unique accounts, and the bounds.
6. **Page.** `/collection-quality?source=<id>&view=accounts` shows
   `口座 × データ種別 × 期間`: one panel per account (label, id and mapping
   status in words; an empty stored label is headed `ラベルのない口座`), its
   data types with their periods, standing, capture
   link, observation count and reasons, and a panel
   `口座に対応付けられない保存記録`. A view switch (`取得単位ごと` /
   `口座ごと`) sits beside the cell list; the default view's requests are
   unchanged.
7. **MCP.** `kogane.collection-quality.read` takes
   `{ source?, view?, offset? }`: `view` is `cells` (the default) or
   `accounts`, and names one source's page, so `view` without `source`, or
   `offset` with `view: "accounts"`, is `400 invalid_request`. With
   `view: "accounts"` the tool calls `readCollectionQuality` with the
   account route's path, so it answers the route's body under `data`, or the
   route's status and closed code. Its capability (`evidence.read` over the
   whole store), store feature (`collectionQuality`), catalogue entry
   (`collection-quality.read`, R0) and audit label are unchanged. Its audit
   record counts the cells the account view read (its `cells`), never an
   account, a label or a period; the summary and the cell page keep their
   counts. The UI parity guard maps
   `/api/collection-quality/:source/accounts` to the tool.

No migration, index, writer, grant or catalogue entry is added.

## Consequences

- Per source, a person can read which periods of each account's card
  statements, bank movements or balances are current, which are held back
  by a newer capture that is not, and which captures name no account and
  why; an agent reads the same answer through the same reader.
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
    it is served only to the authenticated reader and an MCP client, under
    `data`, and never logged; a label longer than 512 characters fails the
    wire check, so the client shows the read as failed rather than a cut
    label.
- A tool input outside the closed schema is `400 invalid_request` even where
  the route would answer `400 invalid_query` for the same request, as for
  every page read.
- The tool's description and input schema change (a new optional `view`),
  so its published MCP definition changes; that needs the owner's approval
  before merge (ADR 0081, AGENTS.md). Since ADR 0084 the view is live for
  every MCP client the MCP Access application admits as soon as this ships.
- Old and new clients deploy together with the App Worker; a web client
  newer than the Worker gets 404 in the account view only.
- Numbering and history: first proposed as ADR 0082 (#1054), then as 0088
  in #1073 together with separate `kogane.collection-quality.summary`,
  `.cells` and `.accounts` tools over grant-graded application services.
  #1082 shipped the summary and cells as one tool over the routes' reader
  first; this ADR keeps only the account view and adds it to that tool.

## Verification

Synthetic data only, no production access:

- `packages/read-model/test/collection-quality-differential.test.ts`: the
  frozen cell page's digest; on 24 seeded random stores (tied and ordered
  captures, failed and partial runs and units, missing files, parses
  published, pending, failed, superseded or never queued, complete and
  partial claims, sealed and unsealed identity runs under one or two
  policies, corrected mappings; the seeds together draw each state), the
  current cell page equals the frozen one page for page, and the account
  read's cells equal the frozen page's cells row for row, every named
  account with at least one observation, and the newest capture's
  observations under an `unresolved` mapping sum to the frozen page's
  `unresolved_identities` for every cell.
- `packages/read-model/test/collection-quality.test.ts`: the cell page's
  text equals the frozen text; on the scaled store without statistics the
  current and frozen pages are equal for every source and offset, the
  account read's cells equal them, the account read reaches publications,
  identity runs, seals, identity observations, mappings and accounts by
  key, reads no observation table, and scans nothing whole outside the cell
  read's own relations; timings printed, not asserted.
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
  (INV06); nothing written; the cell and account period bounds refused
  whole; and, for every store, each cell of the paged cell read appears
  exactly once with the same state and reasons.
- `packages/observation-shared/test/account-coverage-contract.test.ts`: the
  wire check accepts the shape only under its own source's path and refuses
  unsorted or repeated accounts, empty periods, zero observations, a
  standing that contradicts the cell state, unknown codes and statuses, and
  more cells than the bound.
- `services/app/test/collection-quality-api.test.ts`: the account route over
  the real Worker (answer, path checks, refusals, Access, GET-only, absence
  without CORE 0065, nothing written).
- `services/app/test/page-read-reports.test.ts`: the tool's routes include
  the account route; `view: "accounts"` answers the route's body under
  `data` on `/mcp` and `/api/agent/v1/*`, and an unknown source the route's
  404; `view` without `source`, `offset` with the account view, an unknown
  view and a path in `source` are `400 invalid_request` on both transports;
  the audit record counts the cells read. `agent-api.test.ts` pins the
  tool's properties; `mcp-client.test.ts` refuses an MCP token on the
  account route; `ui-mcp-parity.test.ts` maps it.
- `apps/web/test/collection-quality.browser.test.ts`: Chromium at 375 px on
  the production build: the default view never requests the account read;
  the account view shows the account, its unresolved status, data type,
  standing and count, the pending month apart with its reason, no page-wide
  horizontal scroll, and passes the accessibility audit; a source whose
  observations name no account shows that this proves no absence, with its
  records apart; a `413` answer shows only the refusal, no account, period or
  count; both views pass the accessibility audit too.
- `mise run //packages/read-model:ci`, `//packages/application:ci`,
  `//packages/observation-shared:ci`, `//services/app:ci`, `//apps/web:ci`,
  `//experiments/observation-pipeline-local:ci`, `mise run ci:root`,
  `mise exec -- hk check --all --no-fail-fast`.

## Amendment 2026-11-08: freshness per account, data type and period

- Status: accepted (merged 2026-11-09 in [#1197](https://github.com/risu729/kogane/pull/1197))
- Date: 2026-11-08
- Issue: [#1139](https://github.com/risu729/kogane/issues/1139)
- Builds on: [ADR 0045's freshness amendment](0045-collection-quality-read.md#amendment-2026-11-08-freshness-per-source-and-cell)
  and [ADR 0087](0087-provider-data-type-catalogue.md).
- Owner approval: required before merge. The earlier Phase 3 plan approved
  current-capture ages in principle; this amendment follows the later issue's
  explicit named-capture rule, including captures that are not current.

### Context and options

The account view already groups saved cells by account, parser, observation
kind and period. It names the capture that contains that account's observations
and states its adoption separately. The provider catalogue already describes
what each source offers, including gaps. Neither belongs in a new table.

Copying the cell's current-capture freshness onto every account period can
name a capture that does not contain that account. Giving a
`newest-not-current` period no age conceals the timestamp it actually names.
The chosen rule ages the named capture and retains `standing` as the separate
statement about current data. This follows the literal acceptance contract of
[#1139](https://github.com/risu729/kogane/issues/1139), refining the earlier
[Phase 3 plan](../plans/2026-11-phase3-coverage-identity.md#3d-freshness-per-cell-code--adr-0045-amendment-after-1112).

### Decision

- One `freshnessAsOf: { policy, at, date }` applies to the whole answer.
  Every period uses its own `capture.capturedAt` under
  `collection-freshness-v1`, even with `standing: newest-not-current`.
  Source wait is read through the cells route's `SOURCE_JOBS_SQL`; the
  period's `user_action_required` reason has the same precedence as on cells.
- Each parser group and account carries the freshness of its newest named
  capture, selected by instant across its periods (and, for an account,
  across all groups). Equal instants retain the response's stable group/period order;
  the strict contract accepts either tied newest period's value. A wait on
  an older period does not replace the newest period's wait state.
- `ACCOUNT_COVERAGE_API_VERSION` is 3. The answer owns `dataTypesVersion`
  and source-level `dataTypes`, using the unchanged provider catalogue.
  Each parser group has `providerTypes: ProviderDataType[]`: reverse parser
  membership in that source's catalogue, in catalogue order. An unknown
  parser maps to `[]`; a source without a catalogue has `dataTypes: null`.
  A parser can describe multiple provider types; observation kind is never
  used to guess a provider type.
- The strict wire check requires the version, catalogue and as-of, closed
  distinct provider types, exact reverse membership, policy-consistent
  freshness pairs, each period's age from its capture and Tokyo as-of date,
  and each group's exact freshness from a newest capture.
- The account page reuses `Freshness`, `DATA_TYPE_LABELS` and `DataTypes`.
  It shows account, parser and period ages and the account answer's own
  catalogue with partial/uncollected tracking links. It explains adoption
  independently. The catalogue remains visible when no account is named.
- `kogane.collection-quality.read` with `view: accounts` uses the same
  reader and response on HTTP and MCP; its description states these fields.
  No grants, tools, tables, migrations or catalogue contents change.

### Consequences and verification

Freshness describes the named evidence's age, not its adoption or history
completeness. A stale month beside a fresh one remains visible without making
the account stale. Cell and account-period freshness agree whenever their
named captures agree; different captures can legitimately have different ages.
Clients and App deploy together because older account shapes are rejected.
The MCP description changes and this proposed amendment require owner approval
before merge under ADR 0081 and AGENTS.md.

Synthetic tests cover all source catalogue/parser reverse memberships, unknown
parsers, named non-current captures, Tokyo midnight, source/manual/unit wait
precedence, newest capture selection across types, strict malformed responses,
matching-capture cell parity, HTTP/MCP equality, and the production browser view
at 375 px with an accessibility audit. No production collection is exercised.
