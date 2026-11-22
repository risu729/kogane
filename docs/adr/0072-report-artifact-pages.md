# ADR 0072: List and re-display fixed report artifacts in the web UI

- Status: accepted (merged 2026-11-06 in #928)
- Date: 2026-11-06
- Related: [calculation policies and reports](../calculation-and-reports.md#4-reports-are-not-projections),
  [frontend](../frontend.md), [current status](../current-status.md)

## Context

The Processor's report job stores a fixed holdings-view report whenever its
input manifest changes, and the App Worker re-displays one by id
(`GET /api/v2/reports/{id}`, `/explanation`, `/export`). No route listed the
stored reports, so the operator could reach a report only by already knowing
its id, and the Japanese UI showed none of them. `/api/v2/activity` and
`/api/v2/obligations` are also unread by the UI, but no production writer
creates an obligation revision, and the recognised card purchases that make up
most of the activity already have their own page (カード利用).

## Options considered

1. A page per unread route (reports, activity, obligations), each shallow.
2. Reports only: a catalogue route plus a list page and a detail page with the
   stored body, its events and its cached explanation.
3. Reports from the existing detail route alone, with the id typed in.

## Decision

Choose option 2.

- `GET /api/v2/reports?offset=N` lists `report_artifacts` newest first
  (`created_at DESC, report_id DESC`), 50 per page, with `nextCursor` and no
  total. It returns catalogue columns only: it reads no body from R2, derives
  no replayability and counts nothing, so the list cannot disagree with the
  re-display of one report. Only `offset` is accepted (a single
  non-negative decimal up to 1,000,000). It answers 404 where the store has no
  `report_artifacts` table.
- `/api/meta` advertises `reportArtifacts` from the same table check. The
  client shows the 評価レポート navigation entry and requests the routes only
  when it is advertised.
- The client validates every answer against
  `packages/observation-shared/src/report-artifact-contract.ts`: exact keys,
  the domain's own `validReportBody`, the path's report id, capabilities equal
  to `replayCapabilities(replayability)`, a missing body only with
  `unavailable`, and an explanation only for an explainable report.
- The pages are read only. Amounts are the stored exact decimals widened to
  minor units by string work and formatted by the shared formatter; a decimal
  with more places than the unit's minor unit is shown verbatim. An unvalued
  holding shows its reason, never zero, and a partial subtotal is labelled as a
  subtotal of the valued holdings only. Recompute and share-corrected-version
  stay commands with no route, so the page offers no button for them.

## Consequences

The operator can open every stored report, see which holdings were valued and
why the rest were not, follow its events and its explanation down to the
position and valuation observations it read, and see when a restriction or a
missing body stops the explanation. The list sorts the whole table per page:
there is no index on `created_at`, which is acceptable while the job writes a
report only when its inputs change; a migration adds one if the catalogue
grows. Paging is by offset: a report stored between two page loads shifts
the older rows by one, so the next page can repeat a row; none is skipped,
because `report_artifacts` rows are never updated or deleted. Activity and
obligations remain without a page. `/export` is not used
by the UI (changed by the amendment below).

## Verification

`services/app/test/reports-api.test.ts` checks the list order, paging, query
refusals and Access gate, and that the real list, detail and explanation
answers pass the client contract (and a restricted one claiming `explain`
does not). `services/processor/test/reports.test.ts` checks that the body and
explanation node the job stores pass the same contract.
`apps/web/test/report-artifacts-contract.test.ts` checks refusals and the
amount formatting; `apps/web/test/reports.browser.test.ts` drives both pages in
Chromium with synthetic answers.

## Amendment: the export link, and no agent report read yet (2026-11-06)

- Status: accepted (merged 2026-11-06 in #942)

### Context

Two limits were left open above: the detail page did not offer
`/api/v2/reports/{id}/export`, and no agent or MCP tool reads reports. No
agent tool reads a report by id either (`services/app/src/read-tools.ts`,
`agent-service.ts` and `mcp.ts` publish none), so the question is whether to
add a list, a list and a detail read, or neither. The
[AI operation path plan](../plans/2026-10-ai-operation-path.md#53-reads-searches-and-details)
lists a detail and explanation read as row D18 (`kogane.reports.read`, new,
`/export` not exposed).

### Options considered

1. An export link on the detail page; an agent list tool alone.
2. An export link; an agent list and detail read together.
3. An export link; no agent report read yet, with the constraints a later
   read must meet written down.

### Decision

Choose option 3.

- The detail page links to `/export` (`reportExportUrl`, the id encoded as
  one path segment, a same-origin `download` link that is never fetched or
  parsed by the client) only while the report's `capabilities.export` is
  true. That is exactly when the reader serves it: it refuses `/export` for
  a `restricted` report (`403 evidence_restricted`) and for one whose body
  is gone (`403 evidence_restricted` without a complete run, else
  `404 not_found`), which the detail route shows as `unavailable`,
  and the client contract already requires those capabilities to be
  `replayCapabilities(replayability)` and a missing body to be
  `unavailable`. A report without export says why, and no link points at a
  refusal.
- No agent tool lists or reads reports. A list alone would hand an agent ids
  it cannot open. A detail read is not a transport of the operator route:
  the operator route still returns a restricted report's preserved body,
  while current authorization outranking a past context means an agent read
  would have to refuse it; the body covers `perimeter:all-visible-evidence`
  with per-account rows, so only a whole-store grant could read it; and the
  holdings figures an agent needs are already answered live by the
  `holdings` intent with its quality dimensions. No caller has asked for a
  fixed report through the agent API.
- A later ADR that adds agent report reads adds the list and the detail
  together, under `records.read` on `"*"` sources and accounts (the rule of
  the other whole-store reads), published only while `/api/meta` reports
  `reportArtifacts`, refusing a restricted or unavailable report outright,
  never exposing `/export`, with HTTP and MCP parity and the common R0 read
  audit. This refines plan row D18: the list is added with the detail, an
  explanation read is refused wherever the detail read is, and because the
  operator reader returns a restricted report's body, the detail tool cannot
  be a bare call of that reader as the plan's other rows are.

### Consequences

The operator can save a report's export from its page whenever the server
would serve it. Agents still cannot see reports; that is a written limit in
[the agent API](../agent-api.md#tools), not an omission.

### Verification

`apps/web/test/reports.browser.test.ts` checks that the link is present with
the encoded href for a replayable and an artifact-preserved report, absent
with its reason for a restricted and an unavailable one, and that following
it downloads `/export` for an id that must be encoded.

## Amendment: the agent report read (2026-11-07)

- Status: accepted (risu's decision of 2026-11-07, recorded as
  [ADR 0081](0081-ui-parity-through-mcp.md): every UI read has an MCP read
  over the same reader)

ADR 0081 is the later decision the amendment above anticipated. Its
`kogane.reports.read` follows the constraints written there: the list and
the detail ship together, with the explanation, under `records.read` on
`"*"` sources and accounts; the tool is published only while
`report_artifacts` exists; `/export` is not reachable from any argument; HTTP
and MCP answer alike and each call is an R0 read in the audit log. The
detail is the operator reader called with `refuseRestricted`, so it is not a
bare call of that reader: a report whose explanation is refused (restricted,
or without a complete run and without its body) is `403 evidence_restricted`
on every view, and a report whose body has left R2 behind a complete run is
`404 not_found`, the codes `/export` answers for the same reports. The list
is the operator's list, so it still names restricted reports; opening one is
refused. `services/app/test/page-read-reports.test.ts` checks the parity, both
refusals while the operator page still answers (also for a body that leaves
R2 while it is read), the closed schema, the audit rows, and that the tool is
neither listed nor served without the table.

## Amendment: a report cut at its row bound is not complete (2026-11-18)

- Status: accepted (merged 2026-11-20 in [#1422](https://github.com/risu729/kogane/pull/1422))
- Date: 2026-11-18
- Owner approval: required before merge, for the `partition` field added to
  the published `kogane.reports.read` answer (see Consequences)

### Context

The report job (`services/processor/src/report-job.ts`) reads at most
`maxRows` positions (500 by default) and records `coverage.truncated` when
more were in scope. It took `partition` from `summarizeValuation` over the
rows it kept, so a truncated report whose kept rows were all valued was
stored `complete`, and the detail page labelled its subtotal 評価額の合計
(the whole valuation) and said every holding was valued, beside the notice
that positions past the bound were left out. A figure that leaves positions
out was presented as the whole (INV05, [ADR 0001](0001-domain-axes.md)).

### Options considered

1. Leave the stored partition and rely on the truncation notice. Rejected:
   the badge, the subtotal's label and the note still state the whole, and
   `kogane.reports.read` hands an agent `partition: "complete"`.
2. Refuse a `complete` body with `truncated: true` in `validReportBody`.
   Rejected: report bodies are append-only, so a body already stored that way
   would become unreadable instead of being shown as what it is.
3. Write `partial-verified-scope` for a truncated report whose kept rows are
   all valued, and have only the web page read a stored `complete` body with
   `truncated: true` as `partial-verified-scope`. Rejected: the page would
   say partial while `kogane.reports.read` hands an agent `complete` for the
   same stored body, two answers for one read ([ADR 0081](0081-ui-parity-through-mcp.md)).
4. As option 3, but the report reader states the partition beside the
   stored body, so the page and the MCP read show the same one.

### Decision

Option 4. One domain function, `reportPartition(partition, truncated)` in
`packages/domain/src/reports.ts`, gives `partial-verified-scope` for a
`complete` partition with `truncated: true` and every other partition as
it is. The report job stores `reportPartition(summarizeValuation(...).partition, truncated)`;
the subtotal is unchanged and is the subtotal of the rows the report holds.
The report reader `readReportRoute` (`services/app/src/reports-api.ts`),
which answers both `GET /api/v2/reports/{id}` (and `/export`) and
`kogane.reports.read`, adds `partition`, the same function over the stored
body, beside `body`. The wire contract
(`packages/observation-shared/src/report-artifact-contract.ts`) requires
that field and refuses a detail whose `partition` is not the one its body
implies. The page shows that `partition` for the badge, the note and the
subtotal's label. The stored body and its digest are unchanged, and `body`
is still answered exactly as stored.

### Consequences

- A new truncated report gets a new body, so its digest differs from the one
  the old rule would have written. Reports already stored are not
  rewritten: their `body.partition` still reads `complete`, and the
  answer's `partition` says `partial-verified-scope`, on the page, over
  HTTP and over MCP alike.
- The detail answer has one more field, on the route, `/export` and
  `kogane.reports.read`. The MCP tool's definition (name, description,
  input schema) does not change, but its result does: like `nextPage` in
  [ADR 0081's amendment of 2026-11-08](0081-ui-parity-through-mcp.md#amendment-no-card-settlement-page-offers-a-next-page-its-budget-refuses-2026-11-08),
  a field added to a published tool's answer is an addition to the wire
  the owner approves before this merges. A client that checks the answer's
  keys exactly must accept `partition`; the web client refuses a detail
  without it, so the client and the App Worker deploy together.
- `/export` is the same JSON answer with `view: "export"`, not the stored
  bytes, so the downloaded file gains `partition` too; its `body` and the
  report's `contentDigest` are unchanged. The catalogue list states no
  partition, so it cannot disagree with the detail.
- Limit: the report id and context id are digests of the input manifest,
  which lists the positions the report kept but not whether more were in
  scope. A store whose first `maxRows` positions are the same with and
  without positions past the bound gives the same report id, so the job
  reuses whichever body was stored first, with its own `truncated` and
  partition. This is as before this amendment; the reused body states its
  own truncation, and `partition` follows it. The
  [amendment of 2026-11-19](#amendment-a-report-id-names-the-code-that-computed-its-body-2026-11-19)
  closes this limit: the manifest names `truncated`.

### Verification

`services/processor/test/report-job-truncated.test.ts` stores two valued
positions: the job without a bound writes `complete`, and with `maxRows: 1`
it writes `partial-verified-scope` with one valued row and
`truncated: true`. `services/app/test/page-read-reports.test.ts` stores a
body `complete` with `truncated: true`: the route and `kogane.reports.read`
give the same answer, with the body as stored and `partition:
"partial-verified-scope"`. `apps/web/test/report-artifacts-contract.test.ts`
refuses a detail whose `partition` is not its body's, and
`apps/web/test/reports.browser.test.ts` shows such a body as
確認できた範囲のみ評価 with 評価できた保有資産だけの小計, never 評価額の合計.

## Amendment: a report id names the code that computed its body (2026-11-19)

- Status: accepted (merged 2026-11-20 in [#1453](https://github.com/risu729/kogane/pull/1453))
- Date: 2026-11-19
- Owner approval: required before merge. The report ids, context ids and run
  ids the published `kogane.reports.read` answer names are minted from a
  manifest with five more fields, and the explanation view's `inputManifest`
  carries them (see Consequences)

### Context

The report job (`services/processor/src/report-job.ts`) derives
`reportId`, `contextId` and the run id from the digest of its input manifest,
and returns the stored report as soon as a report with that id exists,
before it values anything. The manifest named the inputs (perimeter, unit,
knowledge boundary, position, valuation and chosen price ids) and two
policies: `decimalPolicyRelease` and `instrumentValuationPolicyId`. The
second names only the instrument-class method table. Nothing named the
code that turns those inputs into the body:

- the snapshot price selection, `SNAPSHOT_PRICE_SQL` and the closed rule list
  it admits ([ADR 0020](0020-price-promotion-by-rule.md), `PRICE_RULE_IDS`);
- the valuation, `valueHolding` (with `valueAtPrice`) and
  `summarizeValuation` in `packages/domain/src/calculation.ts`;
- the job's own assembly: the instrument class it values under,
  `quantityFromNormalizedDecimal`, the row and unvalued-reason mapping, the
  coverage, `reportPartition` and the body schema.

A change to any of these that gives another body for the same stored inputs
left the id unchanged, so the job kept serving the body the old code
computed unless someone bumped `report-inputs-v1` by hand. Nobody did when
the amendment of 2026-11-18 changed `reportPartition`: the job reuses a
truncated report already stored as `complete` instead of writing the body
the new rule gives (the reader states the new partition beside it). The chosen price
ids do cover a selection change that picks another set of prices, but not
one that keeps the set (a rule added to the list that matches no stored
claim, or the same prices given to other holdings). The rebuildable
projections already fold their code into their ids: `projectionBuildDigest`
and `rewardProjectionBuildDigest` digest their release constants into
`snapshotIdentity` (INV09).

One input the body depends on was missing too: whether positions were cut at
the row bound. The manifest lists the kept positions only, so the same first
`maxRows` positions with and without positions past the bound gave one id,
and the job reused whichever body was stored first: a body stored `complete`
and `truncated: false` was served for a scope that had grown past the bound
(INV05; the limit the amendment of 2026-11-18 records).

### Options considered

1. Keep bumping the manifest version by hand. Rejected: nothing ties it to
   the code, and the change of 2026-11-18 shows it is forgotten.
2. Fold one build digest into the ids outside the manifest, as
   `snapshotIdentity` does. Rejected: the context id would no longer be the
   digest of the manifest the explanation shows, so a reader could not tell
   which code computed a report.
3. Name each release in the manifest and bump its schema to
   `report-inputs-v2`.

### Decision

Option 3. The manifest gains the four releases, `ReportBuildReleases`, and
the cut:

| Field                   | Value today                     | Covers                                                              |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `priceSelectionRelease` | `report-snapshot-price-v1`      | `SNAPSHOT_PRICE_SQL` and `priceObservation`                         |
| `priceRuleIds`          | `PRICE_RULE_IDS`, sorted        | the closed rule list; the selection binds this same list            |
| `valuationRelease`      | `holding-valuation-v1`          | `valueHolding`, `valueAtPrice` as it calls it, `summarizeValuation` |
| `reportBuildRelease`    | `report-holdings-v1:build-v1`   | the job's assembly, `reportPartition`, the body schema              |
| `truncated`             | the body's `coverage.truncated` | more positions were in scope than the bound kept                    |

`SNAPSHOT_PRICE_RELEASE` and `REPORT_BUILD_RELEASE` live in the report job,
`HOLDING_VALUATION_RELEASE` in `packages/domain/src/calculation.ts`;
`REPORT_BUILD_RELEASE` starts with `REPORT_BODY_SCHEMA_VERSION`, so a body
schema bump changes it. The manifest schema is `report-inputs-v2`. The wire
contract (`packages/observation-shared/src/report-artifact-contract.ts`)
accepts a `report-inputs-v1` manifest with exactly its old fields, as stored,
and a `report-inputs-v2` manifest with exactly the v1 fields, the four
releases (the rule list sorted) and `truncated` (a boolean). `maxRows` itself
is not named: the kept ids and `truncated` fix the body whatever the bound
was.

### Consequences

- Reports already stored keep their ids, context ids, runs and bodies;
  nothing is rewritten. A request after the deploy names a new manifest, so
  the first sweep writes one new report for the current inputs even when no
  evidence changed: one calculation run with its result rows (one per
  holding and one per provider value), the body and its explanation in R2,
  one `report_artifacts` row and one `generated` event. Every later bump of
  a release costs the same: one new report for the inputs the next sweep
  sees, never a recompute of the reports already stored. The catalogue
  grows by one row each time.
- The answer's shape does not change for the list, the body or the ids, but
  the ids of every report written after the deploy differ from what the old
  manifest would have given, and the explanation view's `inputManifest` has
  `schemaVersion: "report-inputs-v2"`, the four release fields and
  `truncated`. The MCP
  tool's definition is unchanged; its result changes, which the owner
  approves before this merges, as for `partition` above. A client that
  checks the manifest's keys exactly must accept both versions.
- The Processor deploys before the App
  ([rollout](../rollout.md#4-deployment-order)). If a sweep writes a report
  between the two, the web page refuses that report's explanation until the
  App, with the new contract, is deployed; the body and the MCP read are
  unaffected.
- Limits: the releases are kept by hand. Only `SNAPSHOT_PRICE_SQL` is pinned
  to its release by a frozen digest; a change to `valueHolding`,
  `summarizeValuation`, `reportPartition` or the job's assembly that does not
  bump its release is not caught by a test. The 評価レポート page does not
  show the four releases or `truncated`; they are in the explanation answer
  (the page states the cut from the body). The limit the amendment of
  2026-11-18 records is closed: a cut and a whole report over the same kept
  positions are two reports, and the job never reuses a report written
  before this amendment, whose v1 manifest gives another id.
- The [historical next-milestone plan](../plans/2026-09-next-milestone.md)
  named `report-inputs-v2` for a dated valuation job (P2-4). That plan was
  never accepted; this amendment takes the name, and a later manifest takes
  the next free version.

### Verification

`services/processor/test/report-job-releases.test.ts` checks that the
shipped releases are the ones the manifest names, pins
`SNAPSHOT_PRICE_SQL`'s digest to `SNAPSHOT_PRICE_RELEASE`, and stores one
synthetic valued position: the same inputs under the same releases reuse the
report, and each of the four releases changed in turn (a rule added that
matches no claim, so the same price is chosen) gives a new report id and
context id, a new `report_artifacts` row and no reuse, while the earlier
report keeps its id, context and body. With the release fields removed from
the manifest digest, that test fails on reuse.
`services/processor/test/report-job-truncated.test.ts` reads every position
into a `complete` report, then adds one whose code sorts past the bound and
runs the job with `maxRows` at the earlier count: the kept position ids are
the same, and the job writes a new `partial-verified-scope` report with
`truncated: true` in its manifest instead of reusing the `complete` one;
with `truncated` held `false` in the manifest that test fails on reuse.
`apps/web/test/report-artifacts-contract.test.ts` accepts a v2 manifest and
the stored v1 one, and refuses a v2 manifest missing one of its added
fields, with an unsorted rule list, a `truncated` that is not a boolean or
an extra field, a v1 manifest with the v2 fields, and an unknown version.

## Amendment: a decimal with more places than its unit holds is grouped, not verbatim (2026-11-21)

- Status: proposed
- Date: 2026-11-21

### Context

The decision above shows a decimal with more places than its unit's minor
unit "verbatim", while every other amount on the page goes through
`formatAmount` with its integer digits grouped in threes. The same report
then wrote `1,200,000 JPY` beside `1234567.5 JPY`, and the client's other
exact-decimal displays (settlement, reward, reconstructed and latest-balance
quantities) were ungrouped as well.

### Options considered

1. Keep the verbatim text for the decimals the minor unit cannot hold.
2. Group the integer digits of every exact decimal in threes and keep every
   fraction digit, by string work in `apps/web/src/money.ts`.

### Decision

Choose option 2. A decimal with more places than its unit's minor unit, or
in a unit with no known minor unit, is shown through `formatDecimal`: the
sign, integer digits grouped in threes, and every fraction digit at the
decimal's own scale. It is still never rounded, and it never passes through
a Number.

### Consequences

The report page writes `34,567.5 JPY` and `1,234,567.5 JPY`. Nothing stored,
exported or read by an agent changes; this is display only. Checks that no
sum is shown look for both the grouped and the ungrouped text.

### Verification

`apps/web/test/money.test.ts` holds `formatDecimal` to `formatAmount` for
JPY, USD and AUD on seeded random coefficients and keeps text that is not a
plain decimal unchanged; `apps/web/test/reports.browser.test.ts` pins
`34,567.5 JPY` and `1,234,567.5 JPY` and fails with the earlier verbatim
text.

## Amendment: the report job reads its positions from one cut (2026-11-21)

- Status: proposed
- Date: 2026-11-21

### Context

The report job (`services/processor/src/report-job.ts`) reads the current
positions through the evidence reader's `listPositions`, 500 positions a page
at offsets 0, 500, 1000, … in the order source, account, security code, id,
until the in-scope set passes `maxRows` or the store ends. Each page is a
separate read of whatever is current at that moment; nothing pins a
publication mark, snapshot id or instant across the pages (the knowledge
cutoff only drops rows whose artifact was recorded after it). The job kept a
row once per observation id, which covers a row that a parse published
between two reads shifts onto the next page under the same id.

It did not cover a republish. A re-parse published in place of an
artifact's run (a release re-parse, or any later parse of an artifact
recorded before the cutoff), or a newer complete capture that becomes the
dataset's current snapshot, brings the same holdings back under new
observation ids. When it lands between two page reads and adds a row that
sorts before the next offset, the next page starts one row earlier, on the
new run's copy of the holding the previous page read last: the report held
that holding twice, under two ids, and counted it twice in its subtotal
(INV06). A republish that removes a row before the offset skips a row
instead. Both need more than one page of positions; a store that fits one
page is read in one statement.

### Options considered

1. Keep one row per holding key (source, account, code) instead of per id.
   Rejected: it merges two snapshots into one report silently, keeping the
   first page's run for some holdings and the next page's for the others,
   and it would also merge two positions a store holds under one key.
2. Pin a mark before the first page (the newest `publication_events` id, the
   exclusions and the snapshot policies) and compare it after the last.
   Rejected for this job: the current positions also depend on fetch run
   seals, terminal reports and unit reports, so a mark has to list every
   relation the snapshot predicates read and stay in step with them.
3. After the last page, check the ids read against the current positions
   with the same predicate the pages use, start again from the first page
   when they are not one cut, and refuse when the cut keeps moving.

### Decision

Option 3. `POSITION_CUT_SQL` (`packages/read-model/src/sql.ts`) reads, over
the same current-positions text `positionsSql` pages, the number of current
rows, how many of the ids read are among them, and how many current rows
sort at or before the greatest row read. The job sends every id the pages
returned, those recorded after the cutoff included. The read is one cut when
all three answers agree with the number of ids read (the current-row count
only when the pages reached the store's end): every row read is still
current, and the rows read are exactly the current rows up to the last one,
so none was skipped and no holding came back under a second id. When they
disagree, the job reads every page again from the first; when the second
read is not one cut either, it stores nothing and returns
`skipped: "snapshot_changed"`, and the next sweep tries again. The check is
on the set of ids, not on the order the pages returned them: rows published
before the next offset and gone again by the check can bring a row onto a
later page than rows that sort behind it while the set passes. The job
therefore sorts a passing read back into the page order (source, account,
code, id, compared as SQLite compares TEXT) before it applies `maxRows`, so a
truncated report keeps the cut's first rows.

### Consequences

- The manifest, the body and `REPORT_BUILD_RELEASE` do not change: a read
  that was one cut gives the same ids, and so the same report, as before. A
  report already stored from a moved cut names ids of two runs; a later read
  of the same store names one run's ids, so it is a new report, and the
  stored one keeps its id and body.
- `snapshot_changed` joins `flag_off` and `invalid_knowledge_cutoff` as a
  closed `skipped` code in the `report_job` lane's result.
- Cost: one more read per attempt that makes the same whole-store snapshot
  passes as one page, reaches the bound row by key and reads the id list
  once; a moved cut costs one more read of every page.
- Limits: the check proves the read was one cut at the moment of the check;
  the decimals, the prices and the knowledge boundary are read after it, as
  before, and the prices are named by id in the manifest. A cut that holds
  one holding twice by itself (two current captures of a dataset without a
  snapshot policy listing the same account and code) is not a paging fault
  and is not refused here. Rows a parse adds before the next offset between
  two reads are no longer left out silently: the check fails and the read
  starts again.

### Verification

`services/processor/test/report-job-page.test.ts` re-parses the second
artifact between the first and second page read with one more holding that
sorts first: before this amendment the report held 502 rows for 501
holdings, one of them twice; now the job reads again and stores the report a
read of the republished store alone gives (502 holdings, each once). A store
republished between every two reads is refused as `snapshot_changed` and no
report is stored. Rows published before the second read and re-parsed away
before the check bring an in-scope row onto the second page behind rows that
sort after it; with a bound of 485 the report is the one a read of the
settled store gives, and with the read kept in arrival order that test
fails. `services/processor/test/report-job-order.test.ts` checks that sort
against SQLite's `ORDER BY` on 1000 seeded random sets of text (ASCII,
Japanese, combining marks, characters above U+FFFF) and ids (small and
52-bit), shuffled and already in order; with UTF-16 string comparison or
text comparison of ids it fails. `packages/read-model/test/position-cut.test.ts` checks
`POSITION_CUT_SQL` against an oracle (the final cut read with nothing moving)
on 40 seeded random stores where a re-parse, a newer complete capture, a new
parse or nothing lands between two page reads: the check passes exactly when
the ids read are a prefix of the final cut (and all of it when the pages
reached the end), and whenever it passes no holding was read twice. With
either the read-ids or the prefix comparison dropped from the pass rule, that
test fails. Its plan check on the complete CORE schema without table statistics
finds no scan the page read does not make besides the JSON argument, the
bound row searched by key, and the id lists and the bound each evaluated
once.

## Amendment: a cached explanation that is not JSON is refused as such (2026-11-21)

- Status: proposed
- Date: 2026-11-21

### Context

The report reader `readReportRoute` (`services/app/src/reports-api.ts`)
answers `GET /api/v2/reports/{id}/explanation` and `kogane.reports.read`
with `view: "explanation"`. It parsed the cached explanation node
(`reports/<digest>.explanation`) with no refusal of its own, while the body
view refuses a stored body that does not parse with
`503 report_body_invalid`. An unparsable node therefore threw an exception
the reader did not name; the Worker's `catalogue` wrap answered it
`503 catalogue_read_failed` on the route, `/api/agent/v1/reports.read` and
`/mcp`, and the request log and audit record carried that code. That code
says the store could not be read, which is not what happened: the store
answered, and the cached node beside an intact body is not JSON. A bare call
of the reader, outside the wrap, ended in an unhandled exception.

### Options considered

1. Leave it. Rejected: an agent or operator reading `catalogue_read_failed`
   looks for a store outage and may retry, and the log cannot tell a corrupt
   cache from an unreadable store.
2. Reuse `report_body_invalid`. Rejected: that code is not generic. It says
   the report's own body cannot be served, and the web page shows it as
   such (保存された内容が、レポートの形式として読み取れません). Here the body
   is intact and still served by the detail view; only a node of retention
   class `cache` is bad.
3. A closed code of the explanation's own, raised exactly as the body view
   raises its parse failure.

### Decision

Option 3. The reader reads the cached node's text, parses it in a `try`, and
refuses a parse failure with `HttpError(503, "report_explanation_invalid")`.
The status is the body view's `503`; the code names the explanation. As
every `HttpError` of a read, it is the route's `{error, requestId}`, the
agent paths' `{error}` (an `isError: true` result on `/mcp`), the request
log's `errorCode` and the audit record's `result_code`, and none of the
stored text.

### Consequences

- The status is unchanged (`503`); the closed code a client sees for this
  fault changes from `catalogue_read_failed` to `report_explanation_invalid`.
- The node is still served as cached when it parses: the reader adds no
  shape check (the body view checks `validReportBody`). The web client's
  contract (`validReportExplanationNode`) refuses a malformed node it
  receives; an agent receives it as stored. A shape check in the reader
  would refuse more, and is not decided here.
- Limit: an explanation node over the size bound is still refused with
  `503 report_body_too_large`, the body's code.

### Verification

`services/app/test/page-read-reports.test.ts` stores a report whose body is
intact and whose cached explanation is not JSON. The operator route answers
`503` with `{error: "report_explanation_invalid", requestId}`,
`/api/agent/v1/reports.read` and `/mcp` answer the same code (`isError: true`
on `/mcp`), the request log carries that `errorCode`, every audit record of
the reads is `failed` with that `result_code`, the stored text appears in
none of them, and the body view still answers `200`. Without the reader's
refusal the test fails: the route answers `catalogue_read_failed`.
