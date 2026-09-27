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

| Collector                                                                                                 | Unit on success                                                                                                              | Why that is what the collector captured                                                                               |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| MyJCB                                                                                                     | `complete` (this ADR; was `partial`); a connection stopped at a month is `partial` with its stop code (ADR 0005's amendment) | see below                                                                                                             |
| GLOBAL PASS                                                                                               | `partial` (unchanged)                                                                                                        | one page per selected month; whether a month's page is paginated has not been observed (`paginationStatus: unproven`) |
| Vpass                                                                                                     | `complete` only when each month's captured rows equal the provider's stated total; otherwise `partial` (ADR 0023)            | see the amendment below                                                                                               |
| Mizuho                                                                                                    | `partial` when the page shows more history (`history-pagination-unverified`), else `complete`                                | per page                                                                                                              |
| Mobile Suica                                                                                              | `complete` only when the collector proved it reached the end of the history                                                  | per run                                                                                                               |
| Money Forward ME, Sony Bank, SBI Securities, SBI Shinsei, SBI VC Trade, SMBC Direct, V Point, V Point Pay | `complete`                                                                                                                   | the collector's own run status                                                                                        |
| St. George                                                                                                | no units                                                                                                                     | the run status alone                                                                                                  |

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
code shows it after deploy.
