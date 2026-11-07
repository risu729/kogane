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
