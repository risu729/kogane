# ADR 0072: List and re-display fixed report artifacts in the web UI

- Status: proposed (takes effect when this PR merges)
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
by the UI.

## Verification

`services/app/test/reports-api.test.ts` checks the list order, paging, query
refusals and Access gate, and that the real list, detail and explanation
answers pass the client contract (and a restricted one claiming `explain`
does not). `services/processor/test/reports.test.ts` checks that the body and
explanation node the job stores pass the same contract.
`apps/web/test/report-artifacts-contract.test.ts` checks refusals and the
amount formatting; `apps/web/test/reports.browser.test.ts` drives both pages in
Chromium with synthetic answers.
