# ADR 0026: A collector's unit coverage is a claim about what the run set out to collect

- Status: accepted (#272, merged 2026-09-27)
- Date: 2026-09-26
- Carried by:
  `services/collector-myjcb/src/shared-collection.ts`,
  [collection: MyJCB](../collection.md#myjcb-servicescollector-myjcb-kogane-myjcb-collector-poc),
  [collection: GLOBAL PASS](../collection.md#prestia-globalpass-kogane-globalpass-collector-poc),
  [processor §3.2 and §3.4](../processor.md#32-failed-runs),
  [MyJCB source note](../sources/myjcb.md),
  `services/collector-myjcb/test/shared-collection.test.ts`,
  `services/processor/test/myjcb-shared-r2.test.ts`,
  `services/processor/test/collector-plans.test.ts`
- Related: [ADR 0021](0021-collector-registration-contract.md) (the
  registration contract collectors state), [ADR 0022](0022-registration-artifact-datasets.md)
  (contract v2 and carry-over), [ADR 0025](0025-myjcb-shared-manifest-metadata.md)
  (which left this blocker open), [ADR 0005](0005-myjcb-statement-state-from-page.md)
  (the MyJCB stop rule)
- Merge order: after #265 (ADR 0021) and #270 (ADR 0025).

## Context

A shared-R2 terminal states a `coverageStatus` for the run and one for each
unit (`packages/collection/src/manifest.ts`). Registration derives each unit's
terminal report from the unit alone (`unitReportRequest` in
`packages/application/src/collection/descriptors.ts`): a unit with a
`safeErrorCode` is `failed`, `complete` is `success`, `partial` is `partial`,
anything else `unknown`. `observation_fetch_runs.status` is `success` only
when the run's outcome is `success` **and** every unit report is `success`
with no failure code. The parse gate admits an artifact when its run is
`success` with no failure (run scope), or when its dataset opted into
`unit-independent-v1` and its own unit's report is `success`. A `partial`
unit therefore keeps its artifacts from being parsed under either rule. The
run's own `coverageStatus` is only recorded on `collection_runs`; nothing
derives an outcome from it.

`myJcbRunPlan` computed `complete` for a successful connection and then
rewrote every `complete` unit to `partial`, on the reasoning that a card
exposes a rolling set of statement periods, so a run is not a claim about the
card's whole history. With ADR 0021 (runs register) and ADR 0025 (the
metadata extractor reads the shared manifest), that rewrite was the last
thing stopping a MyJCB run from parsing: every successful run registered as
`partial`, its work item ended `not_eligible`, and no parse job was created.
The retired importer recorded a successful connection's unit as `success`.
This was the fifth production blocker for MyJCB found on 2026-09-26.

The history argument belongs to the run, not to the unit. A unit's coverage
answers "did this unit capture whole what this run set out to collect?",
which is what the parse gate needs: a `complete` unit may replace the unit's
previous snapshot, a `partial` one may not.

## What each collector's unit coverage means

Checked against each collector's persist path and registered with
`collector-plans.test.ts` (the run status each successful plan gets):

| Collector                                                                                                 | Unit on success                                                                                                                                                                                                                            | Why that is what the collector captured                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| MyJCB                                                                                                     | `complete` (this ADR; was `partial`) when every month is read whole; the menu's schedule pages are outside the coverage (ADR 0005's amendment (c)); a connection stopped at a month is `partial` with its stop code (ADR 0005's amendment) | see below                                                           |
| GLOBAL PASS                                                                                               | `complete` only when every selected month is proven whole against the pager's stated total; otherwise `partial` (amendment of 2026-10-04; was `partial` on every run)                                                                      | every page of each selected month, walked (amendment of 2026-10-04) |
| Vpass                                                                                                     | `complete` only when each month's captured rows equal the provider's stated total; otherwise `partial` (ADR 0023)                                                                                                                          | see the amendment below                                             |
| Mizuho                                                                                                    | `partial` when the page shows more history (`history-pagination-unverified`), else `complete`                                                                                                                                              | per page                                                            |
| Mobile Suica                                                                                              | `complete` only when the collector proved it reached the end of the history                                                                                                                                                                | per run                                                             |
| Money Forward ME, Sony Bank, SBI Securities, SBI Shinsei, SBI VC Trade, SMBC Direct, V Point, V Point Pay | `complete`                                                                                                                                                                                                                                 | the collector's own run status                                      |
| St. George                                                                                                | no units                                                                                                                                                                                                                                   | the run status alone                                                |

For MyJCB, a connection's `success` means the collector enumerated the
credit months from the credit menu and the past-months response and kept,
for every one of them, the redacted page, the ledger it derives from a page
that states its state, and every export the page offers. A page whose state
is `unknown` keeps its HTML and gets no ledger by rule (ADR 0005). When that
page shows no ledger row (the older closed months production shows), nothing
is missing. When it shows rows (no heading, rows at position 2 or later), those
rows are kept only as HTML that no parser reads, so the month is not captured
whole: `collectCredit` counts such months and `collectConnection` reports the
connection `partial`, whose unit is `partial` with `collector_partial`, and
the Worker makes the run `partial` even with no failure entry. A month whose
fetch, statement state, period, ledger or export fails stops the connection
at that month ([ADR 0005's amendment](0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months)):
the months before it are kept, the connection is `partial`, and its unit is
`partial` with the closed stop code of that stage (`month_fetch`,
`credit_statement_state`, `export_fetch`, …). A connection that stops before
its first month (login, the credit menu, the past-months response) keeps no
artifact and its unit is `unknown` with its stop code (`login`,
`human_required`, …). So a MyJCB unit is `complete` only when every month it
enumerated reached a ledger or had no row. Debit datasets are refused before
anything is stored (`artifact_dataset_unobserved`).

A unit is one MyJCB ID (one connection): its root card's statement, which
carries the family, ETC and QUICPay cards under it. Cards reached by switching
to another ID (おまとめログイン) are other connections with their own
credentials; switching is not implemented, so a unit never claims them.

What `complete` rests on and nobody has verified: that one
`detail.html?detailMonth=N&output=web` response carries every row of that
month. The source note lists the row limit as unconfirmed, and the collector
does not reconcile a page's rows with the total it states. The same unknown
keeps GLOBAL PASS `partial`; MyJCB is declared `complete` because the retired
importer recorded the same connections as `success` and every MyJCB parse so
far rests on that claim. This is a limit, written in the source note and in
Consequences, not an observation.

## Options considered

1. **Registration maps a successful run's `partial` units to `success`.**
   Loosens what registration was written to never do ("nothing is widened"),
   for every source, including GLOBAL PASS whose partial claim is real.
2. **The Processor admits `partial` runs for MyJCB.** A genuinely partial
   unit would then replace its previous snapshot. The eligibility rule is one
   definition shared by job creation, the parse gate and the reader
   (`unitScopedEligibilitySql`); changing it for one source is exactly what
   it exists to prevent.
3. **A registration-contract bump that rewrites pre-0026 MyJCB terminals'
   units.** The only way to recover the old runs, but it is a claim made from
   knowledge outside the terminal, about terminals that are immutable
   evidence of what the collector said.
4. **The collector declares each unit's coverage truthfully, for new runs
   only.** Keeps registration and eligibility as they are.

## Decision

**Option 4.** `myJcbRunPlan` states each connection's unit coverage as it
computes it: `complete` for a successful connection, `partial` for one that
reports itself partial (a month whose rows the collector withheld),
`unknown` for a failed or human-required one. The
run's `coverageStatus` stays `partial` on success (a claim about the cards'
history, recorded only) and `unknown` on failure.

GLOBAL PASS keeps `partial`: it has not shown that its capture of a month is
whole, and claiming it would guess provider semantics nobody has observed.
Vpass was decided the same way here and is amended below: its unit is
`complete` only for a run whose every month proves it reached the provider's
stated total. Their consequences are written below as limits. The Processor's
eligibility rules and registration are unchanged.

## Consequences

- A successful MyJCB run registers with unit reports `success`, is `success`
  in `observation_fetch_runs`, gets parse jobs and parses end to end. A
  sibling connection's failure makes the run `partial` but leaves a finished
  connection's unit `success`; its artifacts parse only for a dataset opted
  into `unit-independent-v1`, and no migration opts a MyJCB dataset in.
- A connection with an `unknown` month that shows rows is `partial`, its
  unit registers as `failed` (it carries `collector_partial`), and the run is
  `partial` and `not_eligible`. How often production shows such a page has
  not been measured; the logged `myjcb-credit-statement-unstated` event
  (counts only) says when it happens.
- A connection that stopped at a month (a failed fetch, a contradicting page,
  a period or ledger that does not parse, a failed export) keeps the months
  before it as a `partial` unit carrying its stop code ([ADR 0005's
  amendment](0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months)).
  It registers the same way: its unit report is `failed`, the run is
  `partial` and `not_eligible`, and the captured months are catalogued but
  not parsed. The eligibility rule is unchanged. What is kept is the evidence
  and the cause, not a parse.
- **MyJCB `complete` assumes one detail page holds its whole month.** Whether
  a month's page is capped or paginated has not been observed or confirmed
  (source note, 未確認事項), and nothing compares a page's rows with its
  stated total. If a page were ever truncated, a `complete` unit would miss
  rows. Lifting this limit needs the same evidence GLOBAL PASS needs, or a
  reconciliation of rows against the stated total in `packages/domain`.
- **Terminals written before this deploy stay `partial` and are never
  parsed.** They are immutable. ADR 0022's contract v2 does not change that:
  it registers or carries a run over with unit reports derived from the same
  terminal, so a pre-0026 MyJCB run is `partial` under v2 as under v1. MyJCB
  statements are snapshots that the next capture shows again, so the
  confirmed statements of the months the card still exposes are recovered by
  the first successful run after this deploy. What is lost is pending-only
  history from those days: an unconfirmed row that disappeared before a
  later capture (cancelled, or changed before it was confirmed) is in no
  parsed run. Until the first eligible run, the importer's MyJCB captures
  stay current (ADR 0014, merge safety).
- **GLOBAL PASS shared runs are not parsed** (lifted by the amendment of
  2026-10-04 below, for runs whose months are proven whole). A successful run registers as
  `partial` and is `not_eligible`, as MyJCB's were. Lifting that needs
  evidence that one activity page holds a whole month (a pager that was
  never there, or the owner's confirmation), recorded in the source note,
  and then the collector's declaration can change. This ADR does not guess
  it.
- **Vpass (amended below).** A card run whose months all meet their stated
  totals registers `success`; any other stays `partial` and `not_eligible`.
  Registration still withholds a parser dataset from Vpass captures (ADR
  0022, ADR 0023), so nothing is parsed yet.
- A collector that declares a unit `partial` on success now has to say why in
  its collection section. `collector-plans.test.ts` lists the run status each
  source's successful plan registers as, so a change shows up there.

## Verification

- `services/collector-myjcb/test/shared-collection.test.ts`: a successful
  two-connection run declares both units `complete` and the run `partial`; a
  partial run with a human-required connection keeps the finished
  connection's unit `complete` and the blocked one `unknown` with
  `human_required`; a connection that reports itself `partial`, with no
  failure entry, keeps a `partial` unit with `collector_partial`.
- `services/collector-myjcb/test/credit-statement-state.test.ts`: an empty
  `unknown` page withholds nothing; `unknown` pages that show rows are counted
  as withheld months, which makes `collectConnection` report `partial`.
- `services/processor/test/myjcb-shared-r2.test.ts` (Miniflare, all
  migrations, the operator bootstrap): the collector's real plan, unchanged,
  registers with run status and unit outcome `success`, creates four parse
  jobs, parses with no error and is recognised end to end. The same plan with
  its unit restored to `partial` (a pre-0026 terminal) registers as
  `partial`/`partial` and ends `not_eligible`.
- `services/processor/test/collector-plans.test.ts`: every collector's real
  successful plan registers and seals as before; the last case lists the run
  status each registers as (`partial` only for `prestia-globalpass`; `vpass`
  is `success` for a fixture whose month meets its stated total, and a
  second case shows a month short of it registers `partial`).
- No production data was read for this ADR.

## Amendment: Vpass proves each month against its stated total (#273)

- Status: accepted (#273, merged 2026-09-27)
- Date: 2026-09-27
- Carried by: `services/collector-vpass/src/shared-collection.ts`
  (`monthCheck`, `cardCoverage`),
  [ADR 0023's amendment](0023-vpass-collector-card-binding.md#amendment-option-3-implemented),
  [collection: Vpass](../collection.md#vpass-servicescollector-vpass-kogane-vpass-collector-poc),
  `services/collector-vpass/test/shared-collection.test.ts`,
  `services/processor/test/collector-plans.test.ts`,
  `services/processor/test/vpass-collector-binding.test.ts`

The Vpass collector now does what this ADR said declaring `complete` needs.
Its plan reads each month's stored pages, counts the `meisaiList` rows and
compares them with the total the provider states: `webMeisaiTopK3Vo.allCnt` on
a finalized statement page, `total` on a customized one (the last value the
pages carry, which is the one the walk stopped on). The card unit is
`complete` only when every walked month's count equals its stated total. A
missing or unparsable total is `stated_total_unverified`, a different count
`stated_total_mismatch`, and a card with no month `statement_months_absent`;
each makes the unit `partial`, so the run registers `partial` and the trusted
card binding does not read it. The codes are recorded per month in the run's
`manifest.json` and logged for the card. Nothing is rescaled or inferred from
the count. The run's own `coverageStatus` stays `partial` (the rolling window).

Limit: no fixture in this repository shows whether production finalized
statement pages carry `allCnt`. If they do not, every such month is
`stated_total_unverified` and no Vpass run registers `success`; the logged
code shows it after deploy. (2026-09-27: both fields were seen on the live
site, `allCnt` as a string and `total` as a number, and both are read as
exact counts; the walk's stops and what stays unobserved are in
[ADR 0023's note](0023-vpass-collector-card-binding.md#note-2026-09-27-both-stated-total-fields-are-on-the-live-site).)

## Amendment 2026-09-27: GLOBAL PASS pagination observed; sanitizer refusals get closed codes

- Status: accepted (#281, merged 2026-09-27). Its page-1-only decision, and
  its note that a month of ten or fewer shows no pager, are superseded by the
  [amendment of 2026-10-04](#amendment-2026-10-04-global-pass-walks-every-page-of-a-month).
- Date: 2026-09-27
- Carried by: `services/collector-globalpass/src/sanitize.ts`
  (`GlobalPassSanitizerError`, `GLOBALPASS_SANITIZER_CODES`),
  `services/collector-globalpass/src/pagination.ts`,
  `services/collector-globalpass/src/worker.ts`,
  `services/collector-globalpass/src/model.ts`
  (`GLOBALPASS_PAGINATION_STATUS`), `packages/collector-diagnostics/src/index.ts`,
  [collection: GLOBAL PASS](../collection.md#prestia-globalpass-kogane-globalpass-collector-poc),
  [PRESTIA / GLOBAL PASS source note](../sources/prestia.md#global-pass-activity-pages-and-refusals-2026-09-27),
  `services/collector-globalpass/test/worker-collection.test.ts`,
  `services/collector-globalpass/test/pagination.test.ts`,
  `services/collector-globalpass/test/sanitize.test.ts`,
  `services/processor/test/collector-plans.test.ts`

### Context

Two things were reported on 2026-09-27 by the owner's agent (structure and
counts only):

1. **Every production run fails at the sanitizer, and the cause is
   invisible.** Seven nights out of seven, both selected months failed
   `artifact-write`, the run stored no page and ended `failed`. The
   sanitizer throws one of four closed messages, but the Worker kept only
   `error.name` (`Error`): the diagnostic line said `category: unknown`, and
   the manifest's failure entry said `html_sanitization_failed`. Which check
   refused the pages could not be told.
2. **Account Activities paginates.** A month with more than ten statements
   shows `Found N Result [p/Ppage] Back Next` and at most ten statement
   blocks on a page. Back and Next are POST links; there are no page-number
   links and no page-size setting. Of fifteen months, five had two pages (the
   largest stated total was 20); a month of ten or fewer shows no pager.

Read from the code: the container (`container/server.mjs`, `collectBrowser`)
selects each month, waits, and sends `page.content()` once. It sets no page
size and follows no Next link. **It stores page 1 of a month and nothing
more.** The same report says stored captures had shown a month stating 16
results with 16 rows and no pager link. That cannot come from the render path
in this repository today with the live behaviour above, and nothing here
establishes what produced it (an earlier provider page, the retired
importer's path, or something else). It is recorded as unreconciled.

### Options considered

1. **Walk Next in the container now**, storing one artifact per page or
   joining pages into one. The pager's markup has not been reviewed in any
   stored capture, the sanitizer accepts exactly two reviewed page shapes
   (a paged page's form and hidden-field counts are unknown), and every page
   is refused today for a reason nobody can see. Walking would be written
   against guessed selectors and could not be exercised; a joined page would
   no longer be a provider capture, and one artifact per page needs a
   descriptor and parser contract for page 2.
2. **Declare the unit `complete` when a page states no pager.** A page that
   states no pager is not proof it holds the month; the markup that shows the
   pager is unreviewed.
3. **Make refusals observable and let the page say when it is incomplete;
   keep the unit `partial`.**

### Decision

**Option 3.**

- The sanitizer throws `GlobalPassSanitizerError` whose `code` (and message)
  is one of `globalpass_html_contract_invalid`,
  `globalpass_html_redaction_failed`, `globalpass_html_shape_unreviewed`,
  `globalpass_html_utf8_invalid`. The Worker records that code as the
  failure entry's `errorCode` (operation `sanitization`; the entry keeps its
  four keys), so it is also the terminal's and the unit's `safeErrorCode`.
  `packages/collector-diagnostics` allowlists the error name and the four
  codes, so the `artifact-write` diagnostic line carries `code` and
  `category: response`. Nothing else about the page is emitted.
  `html_sanitization_failed` remains the code of a refusal without a closed
  code; the sanitizer throws none.
- Before sanitizing, the Worker reads the counts a page states from its
  visible text (`activityPageState`): `N` of `Found N Result` and `p/P` of
  `[p/Ppage]`. It logs them as `globalpass-activity-pages` with the month's
  position in the run (never the month). A page that states more than one
  page gets the failure `{operation: "pagination", errorType:
"PaginationError", errorCode: "activity_pages_unwalked"}`; a page whose
  totals or pagers disagree gets `activity_pager_unreadable`. The page itself
  is still stored when the sanitizer accepts it, and the run is `partial`.
  A refused page gets both entries, sanitizer code first.
- The manifest's `paginationStatus` is `first_page_only` (was `unproven`):
  a statement of what the collector does.
- The unit stays `partial` on every run, and the run's coverage too. The
  Processor's registration and eligibility are unchanged; it reads the
  manifest's failures only through the terminal's `safeErrorCode`, whose
  shape did not change.

### Consequences

- The next production run says which sanitizer check refuses the pages, in
  the diagnostic line, the manifest and the terminal. Fixing the refusal is
  a later change that needs that code, and possibly the refused shape
  reviewed from a capture.
- A month over ten statements, once its page passes the sanitizer, is stored
  as page 1 with `activity_pages_unwalked`, so the run is `partial`. The
  parser still sees no GLOBAL PASS shared run (the unit is `partial`), so no
  page 1 is ever read as a whole month.
- Walking Next remains undone. It needs the sanitizer refusal diagnosed, the
  pager's markup and a paged page's form shape reviewed from a capture, and
  a decision on how page 2 is stored and parsed without counting a row
  twice.
- **Limits.** The pager is recognised only by the observed text; if its text
  differs (another language, other spacing than the reader tolerates), a
  paged month is not flagged, which changes nothing about coverage because
  the unit is `partial` regardless. Whether `Found N Result` appears on a
  month of ten or fewer is not known. The stored capture that stated 16
  results with 16 rows is unreconciled. A stored page 1 still gets the
  month's `declared_coverage` range in the terminal (`ranges()` in
  `shared-collection.ts` emits one per stored page); registration stores the
  range, and nothing reads `declared_coverage` for eligibility or parsing
  today, so the month's `activity_pages_unwalked` failure and the `partial`
  unit are what say it is incomplete.

### Verification

- `test/worker-collection.test.ts`: each of the four refusals, driven from a
  synthetic container stream, gives exactly one failure entry
  `{sanitization, GlobalPassSanitizerError, <code>, activity-<month>.html}`,
  an `artifact-write` diagnostic line with `code: <code>` and
  `category: response`, and the code as the terminal's `safeErrorCode`; no
  page marker, password field or heading reaches the logs or the manifest,
  and no page marker reaches DATA. A page stating `[1/2page]` is stored,
  gets `activity_pages_unwalked`, and makes the run `partial`; the log line
  carries counts and the month's position only. A refused paged page gets
  both codes. A `[1/1page]` page leaves the run `success`.
- `test/pagination.test.ts`: the reader across markup and spacing, a
  repeated pager, script/style/comment text ignored, and each decision.
- `test/sanitize.test.ts`: every refusal is a `GlobalPassSanitizerError`
  whose code equals its message, and the four cases cover the four codes.
- `packages/collector-diagnostics/test/diagnostics.test.ts`: the four codes
  are kept with `category: response`; an unlisted code under the same name
  is not echoed.
- `services/processor/test/collector-plans.test.ts`: the collector's real
  plan for a run with a sanitizer code and an unwalked page registers and
  seals, `partial`, with the sanitizer code as the unit's failure code.
- No production data was read for this amendment; the observations above are
  the owner's agent's report.

## Amendment: MyJCB unread months and export offers (2026-09-27)

- Status: accepted (#331)
- Date: 2026-09-27
- Carried by: [ADR 0005's amendment (b)](0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-b-export-links-the-third-ledger-header-and-the-stop-page),
  `connectionErrorCode` in `services/collector-myjcb/src/shared-collection.ts`

Two sentences of the MyJCB section above change.

- "and every export the page offers": export links are now discovered (they
  never were, through a link-resolution bug) and recorded as offers in the
  manifest, not fetched, because the shared bucket refuses the export
  datasets. A MyJCB connection's `complete` covers each month's page and the
  ledger derived from it; an offered export is recorded, and does not make
  the unit `partial`.
- "whose unit is `partial` with `collector_partial`": a month whose rows are
  kept unread is now named in the manifest (`unreadMonths`, codes
  `rows_unstated` and `scheduled_payments_page`). A connection whose unread
  months are all under the observed third ledger header carries
  `scheduled_payments_page`; any other unread month keeps `collector_partial`.
  The unit is `partial` either way, so eligibility is unchanged.

## Amendment: MyJCB schedule pages are outside the coverage (2026-09-27)

- Status: accepted (#337, merged 2026-09-27)
- Date: 2026-09-27
- Carried by: [ADR 0005's amendment (c)](0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-c-the-menus-schedule-pages-are-not-months),
  `readCreditMenuGroups` in `services/collector-myjcb/src/parsers.ts`

"the collector enumerated the credit months from the credit menu and the
past-months response" now reads: the months are the menu's links under
「最新のご利用明細」 and 「過去の明細」 and the past-months response's
available positions. The links under
「ボーナス#回払い・ショッピングスキップ払い」 are payment schedule pages,
not months. They are stored as `credit-schedule-NN.html` evidence that no
parser reads and recorded in the manifest (`schedulePages`,
`schedulePageCount`); whether they show rows, or failed to fetch
(`schedule_page_fetch`), does not change the unit's coverage. So a MyJCB
unit is `complete` when every month it enumerated reached a ledger or had
no row, and a schedule page with rows no longer makes it `partial`. A menu
link under any other heading, or before any heading, stops the connection
before its first month (`credit_menu_group_unrecognized`), so a unit never
claims coverage over a grouping nobody observed.

## Amendment 2026-09-28: GLOBAL PASS sanitizer refusals log a counts-only shape

- Status: accepted (#355, merged 2026-09-28)
- Date: 2026-09-28
- Carried by: `services/collector-globalpass/src/sanitize.ts`
  (`GLOBALPASS_SANITIZER_EXPECTATIONS`, `GlobalPassSanitizerError.detail`,
  `globalPassRefusalShape`, `sanitizerExpectation`),
  `services/collector-globalpass/src/worker.ts`,
  `services/collector-globalpass/src/model.ts` (`expectationCode`),
  `packages/collector-diagnostics/src/index.ts` (`safeShape`,
  `failure(stage, error, { shape })`),
  [collection: GLOBAL PASS](../collection.md#prestia-globalpass-kogane-globalpass-collector-poc),
  [PRESTIA / GLOBAL PASS source note](../sources/prestia.md#global-pass-refusal-shape-diagnostic-2026-09-28),
  `services/collector-globalpass/test/sanitize.test.ts`,
  `services/collector-globalpass/test/worker-collection.test.ts`,
  `packages/collector-diagnostics/test/diagnostics.test.ts`
- Approved by the owner on 2026-09-28 (a counts-only structure diagnostic on
  the refusal).

### Context

The amendment of 2026-09-27 made the refusal's code visible. Since then the
production runs log `artifact-write` failed with
`code: globalpass_html_contract_invalid`, `errorType:
GlobalPassSanitizerError`, `category: response`; seven nights running the
collector has stored no GLOBAL PASS page. (The `terminal` line's
`errorType: UnknownError` is not a second failure: `finish("failed")` emits
error details with no error, which reads as `UnknownError` for every
collector.) `globalpass_html_contract_invalid` is thrown by seventeen
different checks of the sanitizer: a missing doctype, a missing activity
heading, a forbidden token, a login field, an unreviewed hidden name, an
unreviewed URL or event handler, and so on. The log could not say which, nor
what the refused page looked like, so the contract could not be corrected
without someone fetching the page by hand.

### Options considered

- **A. Fetch the page by hand each time.** Works once per incident, needs the
  owner's login and a person's time, and says nothing about the next night.
  Rejected as the standing answer.
- **B. Store the refused HTML** (in R2 or a quarantine bucket). Rejected: the
  page is refused precisely because it may hold unsanitized provider text,
  credentials or a session marker; storing it would put unreviewed provider
  text into storage, against the invariant that logs and stored operational
  records carry counts and closed codes only.
- **C. Log a counts-only shape of the refused page with the refusal.**
  Closed codes for which expectation failed, booleans for the contract's
  landmarks, and counts of markup; no text, attribute value, URL or number
  read from the page. **Chosen.**

### Decision

**Option C.**

- Each check of `sanitizeGlobalPassActivityHtml` throws with a closed
  expectation code (`GLOBALPASS_SANITIZER_EXPECTATIONS`, 22 codes), the
  phase (`input`, the page as received, or `output`, the redacted page), and
  where applicable the element (a closed list of tag names, else `other`)
  and the attribute class (`href`, `src`, `action`, `http_equiv`,
  `event_handler`, `url_attribute`, `name`, `id`, `type`, `value`). The four
  top-level codes are unchanged. The expectation is the first failed check,
  not every failure on the page.
- On a refusal the Worker computes `globalPassRefusalShape(html, error)` and
  passes it to the existing `artifact-write` `collector-diagnostic` line as a
  new `shape` object: the expectation, phase, element and attribute; whether
  the counts were computed (`summarized`); the number of decimal digits of
  the page's byte length and of its visible text length; opening-tag counts
  (`table`, `tr`, `th`, `td`, `form`, `input`, `select`, `button`, `script`,
  `style`, `a`, `link`, `img`, `meta`, `title`, and `blocked` for the refused
  network elements); the counts the two reviewed variants are defined by
  (forms, forms with the static action, hidden inputs, hidden inputs with an
  unlisted name, and each allowed hidden name, with non-empty
  `nablarch_hidden`); landmark booleans (doctype, activity heading, a
  `<title>`, the activity heading inside it, the login field `usrId`, a
  password field, a `<select>`, the redaction sentinel); and the occurrences
  of each forbidden token, keyed by the sanitizer's own token list.
- `packages/collector-diagnostics` keeps a shape only as `safeShape` allows:
  two levels of objects whose keys are in a closed key list (the shape's own
  field names above), values that are non-negative safe integers, booleans,
  or strings from a closed allowlist (the expectation, element, attribute and
  phase codes). Any other key or value is dropped; the line never carries
  more than the two allowlists permit, whatever a caller passes.
- The manifest's sanitization failure entry gains an optional fifth key,
  `expectationCode`, the same closed code. The terminal's `safeErrorCode`
  is unchanged (the four top-level codes); the Processor reads nothing new.
- The page's error banner is not a landmark: no error-banner markup has been
  observed or reviewed on GLOBAL PASS, and a guessed selector would be
  provider semantics nobody has observed ([ADR 0004](0004-payment-type-shapes-from-evidence.md)).

### Consequences

- The `artifact-write` diagnostic line of a refused page may now contain the
  `shape` object above: closed codes, booleans and counts. It still contains
  no provider text, no attribute value, no URL and no number read from the
  page. Exact tag counts can say roughly how many rows a page had; the
  owner approved counts, and lengths are reduced to their number of digits.
- The manifest's failure entry may have five keys. Nothing downstream reads
  it besides the first failure's `errorCode`.
- The next production night's log says which expectation refused the pages
  and what they looked like. Fixing the contract is a later change made from
  that shape; this amendment changes no check, so every page refused before
  is refused the same way now.
- The invariant stays: nothing of a refused page is stored, and logs carry
  counts and closed codes only.
- **Limits.** The shape is computed with the sanitizer's own regular
  expressions, not an HTML parser: a tag inside a script string or comment is
  counted. Only the first failed expectation is named; a page that fails
  several checks shows the rest only through the counts. The expectation
  `redacted_value_unexpected` and `variant_changed` are output-only guards no
  test input reaches while the redaction is correct.

### Verification

- `test/sanitize.test.ts`: a synthetic page for each of the 20 reachable
  expectations gives its top-level code, expectation, element and attribute;
  the shape of each passes `safeShape` unchanged; the cases plus the two
  output-only guards equal `GLOBALPASS_SANITIZER_EXPECTATIONS`; a page with a
  table, a title, a login field and an iframe gives exact counts and
  landmarks; every expectation, element, attribute and phase code survives
  the diagnostics allowlist; adversarial synthetic pages (text in tag names,
  attribute names and values, a 1000-entry class list) give a shape under
  1 KiB with none of that text.
- `test/worker-collection.test.ts`: the four refusals driven through the
  Worker carry `expectationCode` in the manifest and `shape.expectation` in
  the diagnostic line; a refused synthetic statement page (table rows with a
  synthetic merchant, amounts, a date and a card-like number) logs its
  counts, and neither the logs nor the manifest contain any of those strings,
  the page heading, or any 12-character run of the page; every string in the
  logged shape is a closed code. The existing no-provider-text assertions
  (no `private-` marker, password field or heading in logs, manifest or DATA)
  still pass.
- `packages/collector-diagnostics/test/diagnostics.test.ts`: `safeShape`
  drops text, negative and fractional numbers, unknown strings, keys outside
  its closed key list, arrays and a third level; the diagnostic line carries a kept shape on a failure and no
  `shape` when none is passed.
- No production data was read for this amendment.

## Amendment 2026-09-29: GLOBAL PASS activity pages in English

- Status: accepted (#366, merged 2026-09-29)
- Date: 2026-09-29
- Carried by: `services/collector-globalpass/src/sanitize.ts`
  (`ACTIVITY_HEADING`, `isStaticAction`, `MENU_TOGGLE_ONCLICK`),
  [PRESTIA / GLOBAL PASS source note](../sources/prestia.md#global-pass-activity-pages-in-english-2026-09-29),
  `services/collector-globalpass/README.md`,
  `services/collector-globalpass/test/sanitize.test.ts`
- Approved by the owner on 2026-09-29 (accept the activity page in Japanese
  and in English).

### Context

The shape diagnostic of the 2026-09-28 amendment named the refusal on the
next night: every month was refused with `activity_heading_missing` on a
logged-in page (title present, month select present, no login or password
field, no forbidden token). The sanitizer's heading landmark was
「ご利用明細」 or 「利用明細」. The owner's live survey of the same pages
(labels and structure only, no values) found them in English, because the
collector's session is English (the hidden input `engUseFlg`):

- the pages are titled `Account Activities`;
- before a month is selected, the page has no table and is headed
  `Viewing Monthly Account Activities`;
- the page of a selected month has no H2; its H3 is the month, and its table
  headers are English (`Transaction Date`, `Transaction Detail`, …,
  `Applicable Rate`, twelve in all);
- 「ご利用明細」 and 「利用明細」 appear nowhere.

Read against the rest of the contract, the English month page differed in two
more places only: the download form's action is the relative path
`/p/statementInquiry/RW1313010301` instead of the absolute URL of that path on
`www.debit.vpass.ne.jp`, and the `Manage Services` menu link has one onclick
handler outside the reviewed call grammar (it starts with `if` and reads
`window.innerWidth`). Every link, script and image path, hidden input name and
count, and form count matched.

### Options considered

- **A. Switch the session to Japanese** (the page offers a language link).
  Rejected: it adds a navigation step and a provider behaviour (how long the
  language choice persists) nobody has observed, and the activity parser
  already reads the English table headers.
- **B. Accept the English name only.** Rejected: the owner asked that both
  languages be accepted, and nothing observed says the session stays English.
- **C. Accept either name, and admit the two observed English differences
  exactly.** **Chosen.**
- **D. Relax the action and handler checks by pattern** (any same-host
  relative path; any handler without network or storage words). Rejected:
  the sanitizer is the boundary for what reaches R2, and only what was
  observed is admitted ([ADR 0004](0004-payment-type-shapes-from-evidence.md)).

### Decision

**Option C.**

- The activity heading landmark (the input check and the diagnostic's
  `activityHeading`/`activityHeadingInTitle`) is 「ご利用明細」, 「利用明細」 or
  `Account Activities`, matched case-sensitively anywhere in the page, as the
  Japanese names already were.
- A form's action is accepted when it is exactly the absolute URL reviewed
  before or exactly the relative path `/p/statementInquiry/RW1313010301`;
  either counts as the one static-action form of variant A. Nothing else is
  accepted: no other path, host, scheme-relative form, query, fragment or dot
  segment. `<base>` stays a blocked element, so the relative path resolves to
  the page's own host.
- One onclick value is admitted by exact string comparison: the observed
  `Manage Services` toggle, with its `<` written literally or as `&lt;` (a
  DOM serializer may write either). Like every handler, it is stored as
  `return false;`.
- No other check changes: the variants, hidden names and counts, credential
  and forbidden-token checks, URL allowlists and the diagnostic's closed codes
  are as before.

### Consequences

- The English pages the collector receives pass the sanitizer, so the
  nightly run can store GLOBAL PASS months again; whether the whole
  `page.content()` capture matches the surveyed live DOM in every other
  respect is shown only by the next night's run.
- `Account Activities` is a weaker landmark than a page heading: like the
  Japanese names, it is matched anywhere in the page, including a menu link
  on another logged-in page. The landmark alone never admits a page; the
  variant, hidden-input, credential and URL checks still have to pass.
- The stored page keeps the relative action as written; nothing reads it.
- **Limits.** The two English differences were read from the live DOM, not
  from a stored capture. A Japanese page may carry the same differences; they
  are admitted whatever the language. The `&lt;` spelling was not observed; it
  is listed because a serializer may produce it.

### Verification

- `test/sanitize.test.ts`: a variant A page with the Japanese names replaced
  by the English title and heading is accepted, keeps the variant's four
  sentinels and its title, and its refusal shape reports both heading
  landmarks; the English name in the title alone is enough; `Account`,
  `Activities` and `account activities` are refused as
  `activity_heading_missing`. The English page with the relative action and
  the toggle (either spelling) is accepted as variant A, stores the toggle as
  `return false;`, and is sanitized idempotently. Other actions (another
  path, no leading slash, a scheme-relative or other host, `http:`, a query,
  a fragment, a trailing slash, a dot segment, a case change, leading
  whitespace) are refused as `action_unallowed`; altered toggles (another
  class, selector or statement, `>`, surrounding whitespace, entity-encoded
  quotes, a different `if`) and the toggle as `onmouseover` or `onchange` are
  refused as `event_handler_unallowed`.
- On the code of `main` before this change, the two new tests fail
  (reproducing the English page's refusal); on this change they pass.
- No production data was read for this amendment; the survey's labels and
  counts come from the owner.

## Amendment 2026-10-04: GLOBAL PASS walks every page of a month

- Status: accepted (#408, merged 2026-10-03); its empty-month limit is
  amended by
  [the empty-month amendment below](#amendment-2026-10-04-global-pass-empty-months-are-read-as-no-rows)
- Date: 2026-10-04
- Carried by: `services/collector-globalpass/container/server.mjs`
  (`walkActivityPages`, `clickActivityNext`, `readActivityPager`,
  `ACTIVITY_PAGE_CAP`), `services/collector-globalpass/src/pagination.ts`
  (`readActivityPage`, `monthCoverageCode`, `ACTIVITY_PAGE_CAP`),
  `services/collector-globalpass/src/worker.ts`,
  `services/collector-globalpass/src/model.ts` (`artifactFilename`,
  `GLOBALPASS_PAGINATION_STATUS`, `GLOBALPASS_SCHEMA_VERSION`),
  `services/collector-globalpass/src/shared-collection.ts` (`sharedOutcome`),
  `packages/application/src/collection/descriptors.ts`,
  `packages/parsers/src/parsers/global-pass-activity.ts` (1.1.0),
  `packages/read-model/src/sql.ts` (`GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES`),
  [collection: GLOBAL PASS](../collection.md#prestia-globalpass-kogane-globalpass-collector-poc),
  [PRESTIA / GLOBAL PASS source note](../sources/prestia.md#global-pass-pager-and-page-walk-2026-10-04),
  [observations](../observations.md#global-pass-walked-months-and-page-qualified-external-ids-activity-parser-110),
  [read model](../read-model.md#card-snapshot-currentness-and-current-card-usage),
  the tests listed under Verification

### Context

After the English pages were admitted (amendment of 2026-09-29), production
fetch_run 903 (2026-09-29) stored both selected months' activity pages, and
its account unit ended `failed` with `activity_pages_unwalked`: one month had
a second page the collector never read. Every GLOBAL PASS run so far is
`partial`, so `globalpass-activity` has never been parsed from a shared run.

The amendment of 2026-09-27 left walking Next undone because the pager's
markup was unreviewed and guessed selectors would be provider semantics
nobody observed ([ADR 0004](0004-payment-type-shapes-from-evidence.md)). On
2026-10-04 the owner observed the pager on the live site, in English and
then in Japanese (structure, counts, fixed labels and booleans only; the
source note has the detail):

- Month selection, Next and Back are full-page POSTs to the same path,
  `/p/statementInquiry/RW1313010201`, all inside `form nablarch_form5`
  (post, no action; hidden `nablarch_hidden` and `nablarch_submit` only).
- Each page has two identical pagers, `div.nablarch_paging` with
  `div.resultCountHeader` (`Found N Result` / 「検索結果 N件」),
  `div.nablarch_currentPageNumber` (`[p/Ppage]` / 「[p/Pページ]」),
  `div.nablarch_prevSubmit` and `div.nablarch_nextSubmit`. An enabled Next is
  `a.nablarch_nextSubmit` (attributes `class`, `name`, `href`, `onclick`,
  `tabindex`; `onclick` `return window.nablarch_submit(event, this);`); a
  disabled one is plain text. The markup is the same in both languages.
- A two-page month: page 1 `[1/2page]` with ten statement blocks
  (`table.tableStyle4` ×20), page 2 `[2/2page]` with six (×12), the same N on
  both, 10 + 6 = N, the same title, headings and table labels. Back returns
  to page 1. Switching month resets the pager to page 1.
- A month of ten or fewer shows `[1/1page]` with both links disabled (the
  2026-09-27 survey said it shows no pager; it was wrong). A month with no
  statement shows no Found line, no pager and no table.
- A first click on Next that did not navigate was seen once with a browser
  extension's coordinate click; with in-page click events Next and Back
  navigated on the first click every time. It is not site behaviour.

### Options considered

1. **Join a month's pages into one artifact.** One key per month and an
   unchanged parser, but the stored bytes would no longer be a provider
   capture: the sanitizer's reviewed page shape is one document, and a joined
   document is something the provider never sent.
2. **Qualify every page's key** (`activity-YYYY-MM-p1.html`, …). Uniform, but
   every stored run, the parser's key check, the registration descriptor and
   the ledgers name `activity-YYYY-MM.html`; page 1 would change identity for
   no gain.
3. **Page 1 keeps its key; later pages are page-qualified; the Worker proves
   each month whole against the pager's stated total; the unit is `complete`
   only then.** **Chosen.**
4. **Walk the pages but keep the unit `partial`.** Safe, but nothing would
   ever be parsed, which is the blocker this amendment exists to lift, and
   the stated total now gives the proof that amendment asked for.

### Decision

**Option 3.**

- **Walk.** After selecting a month, the container reads the top pager. While
  its Next is an enabled `a.nablarch_nextSubmit`, it clicks it, waits for a
  POST to the activity path on `www.debit.vpass.ne.jp` (the same
  `waitForResponse` pattern month selection uses), waits for
  `domcontentloaded` and for the pager to show the next index, and checks
  that the page states the previous index plus one, the same page count, the
  same total and at least one statement block; otherwise it throws, which
  ends the run as a container error. A click that produced no POST within ten
  seconds is retried once, as plain robustness. It sends one
  `{type: "artifact", month, page, pageCount, html}` line per page, page 1
  first, with the existing 2 MiB limit per page. A month without a pager is
  one page with `pageCount: 1`.
- **Cap.** At most **five pages** a month (`ACTIVITY_PAGE_CAP`, the same
  number in the container and the Worker): fifty statements, where the
  largest month seen stated 20. A month stating more is sent as its first five
  pages and is `activity_pages_unwalked`.
- **Stream contract** (`globalpass-browser-poc-v3`). The Worker accepts a
  month's pages only as 1..min(`pageCount`, 5) in order, with one
  `pageCount`, and the next month only after the last of them; anything else
  is `container_contract_invalid`. A container error may cut a month short;
  that month is decided on the pages it sent.
- **Keys.** Page 1 is `activity-YYYY-MM.html` as before; page N is
  `activity-YYYY-MM-pN.html`. The registration descriptor maps
  `activity-YYYY-MM-p[2-9].html` to `globalpass-activity`; `-p1` and
  two-digit pages stay unmapped.
- **Coverage rule.** A month is proven whole only in one of the two observed
  shapes: (a) one page with no Found line, no pager and no statement block;
  (b) every page states the same `N` and `P` and its own index (equal to its
  walk position), pages 1..P are all captured, and the statement blocks (two
  `table.tableStyle4` each) across the pages add up to `N`. The pager is read
  in English and Japanese. Otherwise the month gets one failure `pagination`
  / `PaginationError` on its page-1 key: `activity_pages_unwalked` (pages
  missing), `activity_pager_unreadable` (conflicting or missing pager text,
  or a page index, page count or total that disagrees) or the new
  `activity_total_mismatch` (blocks do not add up to `N`). A page the
  sanitizer refuses is not stored and keeps its own failure; its counts
  still enter its month's decision.
- **Unit.** The run is `success` only when every selected month is stored
  and proven whole and nothing failed; then the `account` unit is
  `complete`. The run's own coverage stays `partial` (a rolling window). The
  manifest's `paginationStatus` is `pages_walked` (was `first_page_only`), and
  each manifest artifact names its `page`.
- **Logs.** `globalpass-activity-pages` per page (month position, walk page
  and page count, the page's stated total, index, page count and block
  count) and `globalpass-activity-coverage` per month (pages captured, walk
  page count, the closed code when not whole). Counts and closed codes only.
- **Parser** `global-pass-activity@1.1.0`. Accepts both key forms, requires
  the key's month to be the selected month and the page's pager to name the
  key's page (a later page must show one). Page 1 is read exactly as in
  1.0.0. A later page names its page in the external id
  (`global-pass:<fingerprint>:pN:<occurrence>`), the raw locator
  (`html:activity-page=N;activity-record=M`) and `_kogane.identityOrigin`,
  so identical rows on two pages of a month never share an id (INV06), as
  Vpass 1.2.0 does.
- **Currentness.** The Transactions read takes, per source and month, the
  newest run whose activity pages of that month all have an active parse,
  and all its pages, instead of ranking each key alone. Otherwise a page a
  newer run no longer shows would stay current beside the newer page 1 that
  shows its rows again. A run with any page of the month unparsed (pending
  or failed) is passed over for that month as a whole: the month shows the
  newest earlier whole snapshot, or nothing while no run qualifies.

### Consequences

- The first nightly run after deploy whose two months are proven whole
  registers `success`; its pages get `global-pass-activity@1.1.0` jobs. That
  is the first GLOBAL PASS shared run ever parsed, so the parser's table model
  meets the production month page for the first time there: a mismatch fails
  the parse visibly and keeps the evidence (the 2026-09-08 investigation in
  the observations doc found importer-era pages the parser refuses).
- A month that is not proven whole makes the run `partial` and
  `not_eligible`, as before, with a code that says why.
- Importer-era GLOBAL PASS artifacts are re-read under 1.1.0 with the same
  output (all are page-1 keys). No migration is needed: no `active_releases`
  row names the dataset, and maintenance registers the release.
- The terminal's `declared_coverage` range is one per month with a stored
  page, as before per stored page; nothing reads it for eligibility.
- **Limits.**
  - No run has walked a page; the walk is exercised on synthetic pages only.
    Whether `page.content()` after a Next POST equals the surveyed DOM, and
    whether page 2 passes the sanitizer (its form and hidden-input counts
    were not reported), is shown by the first run.
  - The Japanese display was observed live only. The container and the
    Worker read the Japanese pager, and the sanitizer accepts the Japanese
    title and labels (synthetic test), but the parser reads only English table
    labels, so a Japanese page would be stored and fail its parse. The display
    language follows a browser cookie (`set_language()`); `engUseFlg` is `1`
    in both. Whether the server also stores it is not verified; the collector
    logs in with a fresh browser each run and sets no cookie.
  - Whether a page 2 keeps the month selected in its month select is not in
    the report; the parser requires it and fails the page otherwise.
  - A month proven whole in shape (a) (no Found line, no pager, no statement
    block) is stored, but `global-pass-activity@1.1.0` refuses its page with
    the activity-table cardinality check: zero-table pages stay unsupported
    ([observations](../observations.md#remaining-globalpass-shape-investigation-2026-09-08)),
    so such a month gets no observations
    (`packages/parsers/test/global-pass-sanitized-contract.test.ts`; noted
    2026-10-04 with the first shared-run refusal, not a change of this
    decision). `global-pass-activity@1.2.0` lifts this limit: it reads such a
    page as no rows
    ([amendment below](#amendment-2026-10-04-global-pass-empty-months-are-read-as-no-rows)).
  - The walk cap is five pages.
  - Which page a row lands on when statements are added or removed between
    two runs has not been observed. An id that names its page moves with the
    page; no row is lost or merged, and the month's snapshot is replaced
    whole.
  - A month whose page states a total but no pager, or statements without a
    pager, is refused as unreadable: neither shape was observed.

### Verification

- `services/collector-globalpass/test/pagination.test.ts`: both languages'
  totals and pagers, conflicts within a page, script/style/comment text
  ignored, block counting, and the coverage rule: a two-page month walked
  whole (English and Japanese), a `[1/1page]` month, the empty month, pages
  missing, N differing between pages, blocks not adding up, pages out of
  order or repeated, a container page count that disagrees.
- `services/collector-globalpass/test/worker-collection.test.ts`: through the
  Worker from a synthetic container stream in the observed Nablarch shape
  (pager links that pass the sanitizer): a two-page month plus an empty month
  is `success` with keys `activity-2099-02.html`, `activity-2099-02-p2.html`,
  `activity-2099-01.html` and a `complete` unit (both languages); a stop
  after page 1, the five-page cap, N differing, blocks not adding up and a
  non-advancing page give their codes; a refused page 2; ten out-of-order or
  malformed page streams are `container_contract_invalid`; the log lines
  carry no month, page text or label.
- `services/collector-globalpass/test/shared-collection.test.ts`,
  `test/shared-worker.test.ts`, `test/model.test.ts`: the unit is `complete`
  on success and the run `partial`; a walked month's pages are separate
  artifacts with one month range; key scheme and page order.
- `services/collector-globalpass/test/sanitize.test.ts`: a Japanese month page
  with the twelve Japanese labels, both line-break notations and the Japanese
  pager passes the sanitizer.
- `packages/parsers/test/global-pass-parser.test.ts`: page 1 output unchanged
  with or without a pager; page 2 ids and locators qualified (both
  languages); key, pager and month mismatches refused; the observed English
  label set in both notations parses.
- `packages/read-model/test/global-pass-snapshots.test.ts`: identical to a
  frozen copy of the per-key ranking on single-page stores (hand-built and 40
  random) and on a scaled store with the complete CORE schema and no table
  statistics, where walked months also match an independently written model;
  a walked month's pages current together; a page a newer run no longer shows
  is not current; a newer run with an unparsed page keeps the older whole
  month; the Transactions plan reads the artifacts once, as the per-key
  ranking did, and reaches each run's pages through
  `idx_fetch_artifacts_run_role`.
- `services/processor/test/collector-plans.test.ts`: the collector's real
  plan for a walked two-page month plus an empty month registers `success`
  with every page in `globalpass-activity`; the last case lists
  `prestia-globalpass` as `success`. `scripts/artifact-datasets.test.ts`
  covers the page-qualified key.
- Production was read only through the owner's report (counts, shapes and
  fixed labels); no value appears here.

## Amendment 2026-10-04: GLOBAL PASS empty months are read as no rows

- Status: accepted (#474, merged 2026-10-04)
- Date: 2026-10-04
- Carried by: `packages/parsers/src/parsers/global-pass-activity.ts`
  (1.2.0, `emptyMonthPage`),
  [observations](../observations.md#global-pass-empty-months-are-read-as-no-rows-activity-parser-120),
  [PRESTIA / GLOBAL PASS source note](../sources/prestia.md#global-pass-pager-and-page-walk-2026-10-04),
  the tests listed under Verification

### Context

The amendment above calls a month whole in shape (a): one page with no Found
line, no pager and no statement block. That shape is the owner's live
observation of round 8 (2026-10-04, English display): a month with no
statement shows no `Found N Result` line, no pager and no table, while a
month of one to ten statements shows `Found N Result [1/1page]` with both
links disabled. The month select is on every month page (the owner selects
months from it). So since #408 a run whose selected months include an empty
month registers `success`, and its empty page is admitted to parsing.

`global-pass-activity@1.1.0` requires exactly one twelve-header activity
table and refuses such a page (`global-pass activity table cardinality
drift`). The run would never show the month as empty, and with the
per-month currentness of the amendment above the month shows nothing at all,
the same as a month never collected. The 2026-09-08 investigation in the
observations doc kept zero-table pages unsupported until the provider's
explicit empty state was established; the round-8 observation establishes it.

The first shared run after #408 (fetch_run 989, 2026-10-04) stored two
one-page months and 1.1.0 refused both (`parser_rejected`). Which check
refused them is not stored; this amendment does not assume either is an
empty month. It removes one known, observed gap.

### Options considered

1. **Keep refusing zero-table pages.** Safe for the stored data, but every
   run with an empty month keeps a refused page, and an empty month stays
   indistinguishable from an uncollected one.
2. **The collector registers no artifact for an empty month.** The parser
   stays unchanged, but the evidence that the provider said "nothing" is
   lost, and the month's absence again means "not collected" (INV05: a
   missing value is a reason, never a silent zero or a silent gap).
3. **The parser reads the observed empty page as an empty observation set.**
   **Chosen.** The page is kept as evidence and its `ok` parse with no row is
   the reading that the provider stated no statement for that month.

### Decision

**Option 3**, as `global-pass-activity@1.2.0`.

- **Rule.** A page is the empty month only when all of these hold: the
  doctype, the run precondition, exactly one month select with one selected
  month and the key's month equal to it (as in 1.1.0); the key names page 1
  (`activity-YYYY-MM.html`); no `div.nablarch_currentPageNumber`; no element,
  whatever its tag, with one of the pager's classes (`nablarch_paging`, `resultCountHeader`,
  `nablarch_currentPageNumber`, `nablarch_prevSubmit`,
  `nablarch_nextSubmit`); no `Found N Result` / 「検索結果 N件」 and no
  `[p/Ppage]` / 「[p/Pページ]」 in the page's visible text (script, style and
  template text excluded, comments are not text), with the same patterns the
  collector reads; and **no `table` element at all**.
- **Result.** `{ observations: [], warnings: [] }`: no observation, no
  warning, no zero amount. It is the carrier 1.1.0 already uses for a month
  table with no row, and the one the legacy-shape parsers use for a stated
  empty set (`myjcb-skip-payment-schedule`'s empty ledger; Vpass). The parser
  emits no contract-v2 issues or coverage claim on any page, and
  `globalpass-activity` is not a snapshot dataset: its currentness is the
  read model's per-month rule over `ok` parse runs, which needs no claim. A
  warning would say something could not be read, which is not the case.
- **Everything else is unchanged.** Any other page without a table (a pager,
  a Found line or a pager class present, a later page, an unreadable pager or
  select, another month) is refused with the 1.1.0 message. Every page with a
  table gives byte-identical output to 1.1.0.

### Consequences

- An empty month of a `success` run gets an `ok` parse with no observation.
  Under the per-month currentness of the amendment above it becomes that
  month's current snapshot when it is the newest whole capture, so the month
  reads as having no transaction rather than as not collected.
- **Stored pages.** Deploying rewrites nothing. The processor registers the
  1.2.0 release at runtime (no migration: no `active_releases` row names
  this dataset), and the repair lane's cyclic scan adds a 1.2.0 job for every
  eligible `globalpass-activity` artifact the parser accepts. Pages with a
  table re-parse to the same observations, and the `ok` 1.2.0 run supersedes
  the 1.1.0 one. The two pages of fetch_run 989 are re-parsed too; whether
  either becomes `ok` depends on why 1.1.0 refused it. (Both did: see
  _Production result_ below.)
- **Importer-era zero-table pages.** The 2026-09-08 investigation found 20
  importer-era pages with no table that 1.0.0 (and 1.1.0) refused. Any of
  them that shows no pager and no Found line will now parse `ok` with no row.
  A read-only aggregate check of production (2026-10-04) found the 22
  importer-era artifacts that 1.1.0 refuses fall in 7 months, none of which
  has any `ok` capture with rows, so admitting them hides no stored row.
- **Limits.**
  - The empty month was observed in English only. The Japanese display was
    observed for paged months; a Japanese empty page is read by the same rule
    (it has no pager text in either language), but nobody has seen one.
  - The parser cannot tell a provider page that failed to load its list
    from the observed empty month: both would be the same markup. The
    collector waits for the month-selection POST before capturing, and a
    later capture of the same month with rows supersedes the empty reading.
  - **An empty reading hides older rows of the same month.** The read
    model's per-month rule (`GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES`) does not
    look at the row count: a newer run's `ok` empty page is that month's
    current snapshot and an older run's rows for the month stop being
    current, with no reason shown. Nobody has observed a month's statements
    disappearing from the provider's list, so such a pair would be either
    that unobserved provider behaviour or a failed render read as empty.
    Nothing guards against it; it is pinned by
    `packages/read-model/test/global-pass-snapshots.test.ts` ("limit: a newer
    empty month ... supersedes an older capture with rows") so a change to
    it is visible. A guard would change the read model's query and needs its
    own frozen-SQL differential proof; it is not part of this amendment.
    Since [the amendment of 2026-10-08](#amendment-2026-10-08-global-pass-empty-months-that-supersede-rows-are-reported)
    the case is reported, with the currentness unchanged.
  - The rule has met production markup only in the two empty months of
    fetch_run 989 (English display) and the 20 importer-era zero-table
    pages; a Japanese empty page has still not been seen.
  - Two importer-era pages stay refused under 1.2.0, as under 1.0.0 and
    1.1.0. Which check refused them is not stored; the counts-only replay
    (`replay-diagnostics.ts globalpass-activity 2`,
    [operations](../operations.md#replaying-a-parser-rejection)) names it.

### Production result (2026-10-05)

#474 was deployed in Deploy run 269 (2026-10-04, after the deploy-pipeline
fixes #511 and #512); 1.2.0 is registered in `parser_releases` at runtime,
with no migration. The repair lane queued a 1.2.0 job for each of the 72
eligible `globalpass-activity` artifacts (70 importer-era, 2 from fetch_run
989), all terminal by 2026-10-05 05:00Z. Read-only aggregate queries:

- 48 importer-era pages with a table: `ok` with warnings, 372 transaction
  observations, the same pages and row count as 1.1.0; each 1.1.0 `ok` run is
  superseded by its 1.2.0 run.
- 20 importer-era pages (the 2026-09-08 investigation's zero-table pages):
  `ok` with no warning and no observation. So 20 of the 22 importer-era
  refusals were the observed empty month.
- 2 importer-era pages: `parser_rejected`.
- Both fetch_run 989 pages: `ok` with no warning and no observation, so both
  were empty months; the first empty month a shared run has stored.

In all, 70 `ok` (48 with rows, 22 empty pages) and 2 `parser_rejected`. The
22 empty pages fall in 7 months, which are current empty snapshots; none of
those months has an `ok` capture with rows (re-counted 2026-10-05, run 989's
months included), so no stored row is hidden. Shared runs have no
transaction observation yet.

### Verification

- `packages/parsers/test/global-pass-empty-month.test.ts`: the synthetic
  empty month (the shared anonymous fixture with its tables removed) parses
  `ok` with no observation and no warning, deterministically, also with pager
  and Found text inside a script or comment; a zero-table page with the
  observed pager (English or Japanese), a Found line alone (either language,
  with or without its class), a pager alone, an empty pager container, a
  pager link or a pager class on another tag is refused with `table cardinality drift`; an unreadable pager,
  a later page with or without a pager, another month, an unselected or
  missing month select, a missing doctype and a non-success run keep their
  1.1.0 refusals.
- `packages/parsers/test/global-pass-parser.test.ts` (unchanged) passes
  under 1.2.0.
- `packages/read-model/test/global-pass-snapshots.test.ts`: a newer run's
  `ok` empty page (no row) is its month's current snapshot and an older
  run's rows for that month stop being current; a still newer capture with
  rows supersedes the empty one (the limit above, pinned).
- `packages/parsers/test/global-pass-sanitized-contract.test.ts` (#439): the
  collector's synthetic empty month of either variant, after
  `sanitizeGlobalPassActivityHtml`, parses `ok` with no observation and no
  warning; the same page with the pager (English or Japanese) or a Found line
  and no table, or under a page-2 key, stays refused.
- Identity: the shared fixture and 24 variants (pager in both languages,
  page 2 keys, a month table with no row, the live label set, a signed
  amount, an unknown header, refusals) were run through 1.1.0 from
  `origin/main` and through 1.2.0 and their serialized results compared:
  identical except the zero-table, no-pager page, which 1.1.0 refuses and
  1.2.0 reads as no rows.
- `packages/parsers/src/parsers/digests.ts` regenerated; the digest test
  passes.
- Production was read only with read-only aggregate queries (counts); no
  value appears here. The production result above was re-queried the same
  way (parse runs of 1.2.0 by fetch run, status, warnings and observation
  count; 1.1.0 runs by supersession).

## Amendment 2026-10-08: GLOBAL PASS empty months that supersede rows are reported

- Status: proposed
- Date: 2026-10-08
- Carried by: `packages/read-model/src/sql.ts`
  (`GLOBAL_PASS_EMPTY_MONTH_NOTICE_SQL`), `packages/read-model/src/observation-reader.ts`
  (`globalPassEmptyMonths`), `packages/observation-shared/src/api-contract.ts`
  (`ApiMetadata.globalPassEmptyMonths`), `services/app/src/observation-api.ts`
  (`/api/meta`), `apps/web/src/global-pass-empty-months.tsx`,
  [read model](../read-model.md#card-snapshot-currentness-and-current-card-usage),
  the tests listed under Verification

### Context

The empty-month amendment above left one limit open: the read model's
per-month rule does not look at row counts, so a newer run's `ok` empty page
becomes its month's current snapshot and an older run's rows for that month
stop being current, with no reason shown. The parser cannot tell the observed
empty month from a page whose list failed to render (the same markup), and
nobody has observed a month's statements disappearing from the provider's
list, so a month that goes from rows to empty is either that unobserved
provider behaviour or a failed render read as empty.

A read-only aggregate count of production on 2026-10-08 found 16 months with
an `ok` 1.2.0 parse, 7 of them with an empty current snapshot, and none whose
empty current snapshot hides an older capture with rows: the hazard is latent,
not realised. GLOBAL PASS rows reach only the Transactions list; recognition
and settlement do not read them.

### Options considered

1. **Keep the limit as it is.** Consistent with the Vpass and MyJCB rules,
   which do not look at row counts either, but a month's rows can leave the
   lists with no trace (INV05: a missing value is a reason, never a silent
   gap).
2. **Report the case without changing what is current.** **Chosen.** The
   newer empty capture stays current, the older rows stay out, and `/api/meta`
   names the month, the current run and the superseded run so a person checks
   the provider's display. The currentness query is composed verbatim, so no
   differential proof of a changed rule is needed; the new read needs its own
   plan check.
3. **Keep the older rows current when the newer capture is empty.** No silent
   loss, but it asserts a provider semantics nobody has observed (that a
   statement never leaves a month's list); a statement that moved to another
   month would then be counted in both (INV06), and a month that really became
   empty would keep stale rows. It changes the currentness query and needs a
   frozen copy, a differential proof and a plan check of its own. Deferred
   until the owner has observed a month going from rows to empty on the live
   site.
4. **Strengthen the evidence in the collector** (record the stated total and
   block count per page in the manifest; re-select an empty month once and
   compare). The manifest counts help forensics but do not tell the two
   readings apart; the re-select changes the provider interaction and touches
   the collector Worker another change is refactoring. Not part of this
   amendment.

### Decision

**Option 2.**

- **Read.** `GLOBAL_PASS_EMPTY_MONTH_NOTICE_SQL` composes
  `GLOBAL_PASS_ACTIVITY_SNAPSHOT_CTES` unchanged and reports, per source and
  month, the case where the ranked snapshot of rank 1 has no visible
  transaction row (read through the same active chain as the Transactions
  page, so "had rows" means rows the page showed) and some ranked snapshot of
  a lower rank of the same month has one: the current run, the newest older
  run with rows and how many older runs had rows. Only months whose current
  snapshot is empty probe the observations, each by run and month through the
  artifact index. The result is bounded to 100 months plus one row so the
  caller can report truncation.
- **Not reported.** A month that was only ever empty; a newer run that is not
  current (a failed run, or a run with a page that has no active parse), since
  the older rows are then still current; an older capture that was never a
  whole snapshot, since its rows were never shown.
- **Surface.** `ObservationReader.globalPassEmptyMonths()`; `/api/meta`
  carries it as `globalPassEmptyMonths` (`months`: source, `YYYY-MM`, current
  fetch run id, superseded fetch run id, superseded run count; `truncated`),
  validated by the shared response validator; the web app shows a notice
  beside the parsing-health notice naming the months and both runs, saying
  that the lists follow the current capture, that the older rows are not
  brought back automatically, that the provider's display and the capture
  history need a check, and that the count is neither a collection outcome
  nor a freshness claim. The local store omits the field.
- **Unchanged.** Which pages are current, every list, every amount and every
  observation. No row is counted; no evidence is written.

### Consequences

- The limit of the empty-month amendment is no longer silent: when a month's
  current capture is empty over older rows, the owner sees which month and
  which runs, and can look at the provider's live display. That observation,
  not this read, is what would justify option 3 or a parser change.
- `/api/meta` grows by one optional object; clients that do not read it are
  unaffected. The read runs on every metadata request; its cost is the
  snapshot CTEs' one pass over the GLOBAL PASS artifacts plus an index probe
  per empty current month and per older eligible run of such a month.
- **Limits.** The notice cannot say which of the two readings (a true empty
  month, a failed render) happened; only the provider's display can. It does
  not cover a newer capture with fewer rows than an older one, which the
  current rule replaces whole and which no evidence distinguishes from a
  provider correction. Production has been read only with aggregate counts
  (above); the notice has not been seen firing on production data.

### Verification

- `packages/read-model/test/global-pass-snapshots.test.ts`: a newer empty
  month over an older capture with rows is reported with both runs and the
  current set is unchanged before and after the read; a still newer capture
  with rows clears it; a month only ever empty, a failed newer run, a newer
  run with an unparsed page and an older capture that was never whole are not
  reported; several older captures with rows are counted once each and the
  newest is named; the notice text contains the currentness CTEs verbatim; on
  a scaled store with the complete CORE schema, no table statistics and a
  quarter of the captures empty, the notice equals an independently written
  model and the current set equals the snapshot model before and after; the
  plan scans the artifacts once (the snapshot CTEs' pass) and no observation,
  parse or run table whole, and reaches each run's pages through
  `idx_fetch_artifacts_run_role`.
- `services/app/test/api.test.ts`: `/api/meta` carries an empty, valid notice
  on a store without GLOBAL PASS months.
- `apps/web/test/global-pass-empty-months.test.ts`: the response validator
  accepts the shape and refuses a malformed month, a zero superseded count, a
  negative or fractional run id and a missing `truncated`; the notice text
  names the month and both runs, counts the rest, marks truncation, and
  carries the no-freshness sentence.
- Production was read only with a read-only aggregate query (counts of
  months and pages); no value appears here.
