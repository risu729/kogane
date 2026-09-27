# ADR 0026: A collector's unit coverage is a claim about what the run set out to collect

- Status: proposed
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

| Collector                                                                                                 | Unit on success                                                                                                                                                                                                                            | Why that is what the collector captured                                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| MyJCB                                                                                                     | `complete` (this ADR; was `partial`) when every month is read whole; the menu's schedule pages are outside the coverage (ADR 0005's amendment (c)); a connection stopped at a month is `partial` with its stop code (ADR 0005's amendment) | see below                                                                                                    |
| GLOBAL PASS                                                                                               | `partial` (unchanged)                                                                                                                                                                                                                      | page 1 per selected month; a month over ten statements has more (amendment of 2026-09-27, `first_page_only`) |
| Vpass                                                                                                     | `complete` only when each month's captured rows equal the provider's stated total; otherwise `partial` (ADR 0023)                                                                                                                          | see the amendment below                                                                                      |
| Mizuho                                                                                                    | `partial` when the page shows more history (`history-pagination-unverified`), else `complete`                                                                                                                                              | per page                                                                                                     |
| Mobile Suica                                                                                              | `complete` only when the collector proved it reached the end of the history                                                                                                                                                                | per run                                                                                                      |
| Money Forward ME, Sony Bank, SBI Securities, SBI Shinsei, SBI VC Trade, SMBC Direct, V Point, V Point Pay | `complete`                                                                                                                                                                                                                                 | the collector's own run status                                                                               |
| St. George                                                                                                | no units                                                                                                                                                                                                                                   | the run status alone                                                                                         |

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
- **GLOBAL PASS shared runs are not parsed.** A successful run registers as
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

- Status: proposed; accepted when #273 merges
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

- Status: proposed; accepted when #281 merges
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

- Status: proposed; accepted when the amending PR merges
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
