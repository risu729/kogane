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

- Status: proposed
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
  own truncation, and `partition` follows it.

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
