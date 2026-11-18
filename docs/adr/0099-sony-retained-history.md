# ADR 0099: Sony Bank scheduled collection includes all retained deposit history

- Status: proposed
- Date: 2026-11-10
- Issue: [1231](https://github.com/risu729/kogane/issues/1231)

## Context

Only the current JST month was requested. A failed run on the first day of a
month left the prior month's last day unrequested. The owner observed that
all eleven currencies accept an omitted start and an end of yesterday; CSV
row counts match the declared JSON totals. No opening date needs to be guessed.
The current Sony parser contract required a closed window. ADR 0092 requires
that only complete official CSV contributes current deposit transactions.

## Options considered

1. Guess an opening date or walk artificial monthly ranges. Neither is needed
   when the provider accepts one range covering everything it retains.
2. Replace monthly requests. The issue explicitly retains these requests.
3. Keep monthly requests as evidence and publish the complete retained range.

## Decision

Choose option 3. In one authenticated session, validate the unchanged monthly
queries and then all retained history through yesterday for every currency.
Use the observed omitted-start request with `sortSelect=00002`,
three-row pages and the same date selection for CSV. Keep canonical artifact
names for retained history. Store monthly responses under `monthly-*` names,
which the existing closed production dataset selector leaves without a dataset.
This avoids a second current publication input and requires no registration
contract revision. Historical monthly CSV remains deduplicated against retained
CSV through the existing occurrence-qualified external IDs and reader ranking.

Terminals name `full_snapshot`, a null start and yesterday as the end. The
Processor maps Sony's null start to the Sony-only `retainedHistoryEnd` metadata
field, which participates in the parser input fingerprint. The common closed
`runWindow` type is unchanged. Sony history parsers accept this explicit field
while still requiring valid metadata and enforcing the upper date bound.
Missing metadata and empty, invalid or reversed dates still fail. All four
parsers in the shared Sony module receive patch releases and refreshed digests;
the shared Sony decoder and retained CSV row order are described below.

Every JSON page must match the stable declared total, its expected page size,
and `returnCnt` when supplied; CSV logical row counts must match the JSON total.
Missing or inconsistent pages/CSV and the 1,000-page cap fail closed with
allowlisted codes. No JSON transaction fallback, cursor, manual range parameter
or remote operation is introduced. The retained walk is bounded by the per-currency page cap.

## Consequences

Every later successful daily run recovers earlier missed dates, including a
missed first-day run. No account-opening date or coverage before the provider's
retention is claimed. Monthly bytes remain inspectable; the full official CSV
is the only new current transaction input. Raw evidence remains append-only.
Failure still persists no fetched artifacts, as before; a later run retries the
whole retained range. Histories beyond the page cap remain explicitly failed.
`cash_movement` is collected for retained yen and foreign ordinary deposits;
other Sony product limits remain separately named in the catalogue.

## Verification

Synthetic tests exercise all eleven currencies, monthly and omitted-start
request shapes, exact paging, matching CSV and a short retained CSV after a
complete monthly one. The production dataset selector and transaction SQL
prove evidence-only monthly artifacts, month-end recovery, legacy overlap,
repeated runs and preservation of identical-row occurrences. Parser tests
cover open-start JSON/CSV with end-date rejection, and Processor tests pin the
Sony-only metadata boundary. All tests use synthetic data; deployment and
production ingestion are not claimed.

## Amendment 2026-11-11: observed encoding and retained row order

Read-only owner-browser checks for [1295](https://github.com/risu729/kogane/issues/1295)
and [1302](https://github.com/risu729/kogane/issues/1302) establish that `00002`
returns newest-first dates and reverses the within-day transaction chain.
Retained CSV parsing therefore emits oldest-first, retaining original row
locators and occurrence-qualified identities. Monthly parsing is unchanged.
The source document records the shape without account-specific counts.

The observed JPY octet-stream CSV declares UTF-8 but contains strict Shift-JIS
bytes. One shared Sony decoder permits strict Shift-JIS fallback only after
strict UTF-8 failure for that octet-stream declaration (or the already supported
absent charset). A strict UTF-8 success is never retried merely because the
schema differs. Exact headers, row widths and JSON-total agreement remain
mandatory; no replacement decoding or general charset guessing is added.
Collector failures carry a closed validation branch and allowlisted column
counts only. Diagnostic replays preserve Sony's explicit retained end exactly
as the Processor does. Synthetic parser/collector and native read-model cases
cover the mislabeled bytes, refusals, original row locators and final same-day
balance. No deployment or successful scheduled run is claimed.

Same-day latest-balance ties prefer the complete official CSV to JSON. A JSON
page can finish publication after the CSV or split a day across pages, so
reversing each JSON page cannot establish a global transaction order. The
reader's date ordering stays first: a newer JSON date remains newer, and
JSON-only evidence keeps its previous behavior. Synthetic regressions publish
same-day JSON across pages before and after the CSV, preserve monthly CSV
behavior, and compare the amended query to frozen SQL on a scaled random store
with unrelated-source, JSON-only and older-CSV controls and unchanged plans.

For Sony history only, same-day ties first select the newer capture cohort
(`fetch_run.started_at`, then its run id), then prefer CSV within that cohort.
An older CSV replay cannot displace a newer JSON-only correction. JSON-only
retained history keeps the legacy same-day/page-order limitation; it is not a
substitute for the complete official CSV and is not guaranteed to identify a
day's final transaction. Unrelated sources keep their existing ordering.

## Amendment 2026-11-18: a mid-core failure keeps the finished steps as a partial run

- Status: proposed
- Date: 2026-11-18
- Amends: this ADR's consequence "Failure still persists no fetched artifacts",
  and the matching consequence of
  [ADR 0092](0092-sony-history-csv-only.md#amendment-2026-11-18-a-refused-window-stops-a-partial-core-run)
- Carried by: `CORE_STEPS`, `CoreProgress` and `collectSonyBank` in
  `services/collector-sony-bank/src/sony-bank.ts`; `runSharedCollection` in
  `src/worker.ts`; `CORE_STEP_CODES`, `assertStoppedCoreScope` and
  `sonyBankRunPlan` in `src/shared-collection.ts`; `CoreStepOutcome` in
  `src/types.ts`

### Context

The core run is one authenticated session of five steps, in this order:
`login` (no artifact), `gross-balance` (`gross-balance.json`),
`monthly-history` (the month window's JSON pages and CSVs for all eleven
currencies, stored under `monthly-*` names), `retained-history` (the
omitted-start pages and CSVs for all eleven currencies, under the canonical
names the parsers read) and `wallet` (`wallet-history-YYYY-MM.html`); the
`collection-summary.json` is built after the last step. Until now any throw
discarded everything: the run was `failed` with no artifact and no
`manifest.json`, so a WALLET failure lost a complete, validated retained
history, and the only stored diagnosis was the terminal's closed code. The
realised-gains and documents supplements already keep what they fetched before
a failure (ADR 0100), as do other collectors (Mobile Suica,
[ADR 0104](0104-mobile-suica-retained-history.md); MyJCB,
[ADR 0005](0005-myjcb-statement-state-from-page.md)).

Keeping artifacts is safe only if no reader can take a partial core run for a
full one. What the Processor and parsers do with a `partial` Sony core run,
checked against the code on 2026-11-18:

- Parse eligibility (`unitParseable`, `artifactSql` in
  `services/processor/src/worker.ts`) is run-scoped for every Sony core
  dataset: no `dataset_snapshot_policies` row gives `gross-balance`, the
  history datasets or `wallet-history-*` the `unit` scope (only
  `delivered-document-pdf` has it, migration 0089). A run that is not a clean
  success gets no parse job, and every collection lane creates jobs through
  that statement.
- Each Sony core parser also refuses such a run itself
  (`requireSuccessfulRun` in `packages/parsers/src/parsers/sony-bank.ts`),
  unless unit scope admitted it, which it cannot here.
- The one `account` unit carries the run's error code, so its unit report is
  `failed` (`unitReportRequest`), and the run registers as `partial`.
- The `retainedHistoryEnd` mapping (null start) applies only to artifacts that
  reach a parser, which a partial run's do not.
- Collection quality and the operation trail show the provider outcome
  `partial` with its code; the trail names a run with no parse
  `not_adopted`, as for any partial run of a run-scoped dataset.

### Options considered

1. Keep the all-or-nothing core. Nothing is misread, but validated evidence
   and the stored diagnosis are lost on every late failure.
2. Keep each finished step's artifacts, one step at a time. A step's artifacts
   are kept only once every request of that step, across all eleven
   currencies, has been validated; the step that threw keeps nothing.
3. Keep artifacts per currency/window, so a retained walk that failed in USD
   still keeps its JPY CSV. This would put a partial set under the canonical
   names in one run and need per-currency units to say which are whole; the
   gain over option 2 is small while the core stays evidence-only.

### Decision

Choose option 2. `collectSonyBank` appends a step's artifacts to the caller's
`CoreProgress` only after the step returns, under exactly the names a
complete run gives them; with retained history requested, the month window
keeps its `monthly-*` names even when the retained step never finishes, so a
canonical history name always means the complete retained range. On a throw
it records `{completed, failed, notAttempted}` with closed step names and
rethrows the original error unchanged, so failure classification is as
before. `runSharedCollection` then stores the finished steps' artifacts:
`partial` when there is at least one (in practice from `gross-balance` on),
`failed` with no artifact when the stop came at `login` or `gross-balance`
(or the credential). Supplements still run only after a complete core.

A stopped core run states its scope:

- `manifest.json` carries `coreSteps` (`completed`, `failed`,
  `notAttempted`), the failure entry's `operation` is the stopped step, and
  `transactionCount` is null unless the retained step finished (INV05: a
  missing total is not 0). The run's result carries the same null.
- No `collection-summary.json` is written and, since WALLET is the last step,
  no `wallet-history-*` artifact and no `wallet-months` range.
- The terminal keeps `full_snapshot` with a null start as the request, and
  says `providerOutcome: partial`, `coverageStatus: partial`, with the
  account unit `partial`. Its code is the allowlisted history reason when
  there is one (ADR 0092 keeps those in the terminal, unit and report);
  otherwise it names the step: `core_monthly_history_failed`,
  `core_retained_history_failed` or `core_wallet_failed`. A `failed` core run
  keeps `collector_failed`.
- `sonyBankRunPlan` refuses (`core_partial_scope_invalid`) a stopped run whose
  artifacts a finished step did not produce: a canonical history name before
  the retained step finished, an unprefixed month-window file, a summary or a
  WALLET page.

### Consequences

A late failure no longer discards validated balance and history evidence, and
its manifest says exactly which steps finished and which did not run. The kept
artifacts are evidence only: no parser reads them while the core datasets stay
run-scoped, so the run adds no observation and changes no current balance or
transaction. Making them parseable (for example per-step units with unit
scope) would be a separate decision. Raw evidence stays append-only.

A stopped core run with at least one artifact is a persisted `partial` run, so
the alarm records the occurrence `completed` (`scheduledResult`), as it
already does for partial supplements and other collectors; the run's
`partial` outcome and code stay visible in collection quality. Before this
amendment the same failure recorded the occurrence `failed`. A later
successful run still recovers the whole retained range.

### Verification

Synthetic tests only; no provider was contacted and no production data was
read. Collector tests run the real shared collection path: a refused month
CSV keeps only the balance (`partial`, the CSV reason, `coreSteps` stopped at
`monthly-history`); a short retained CSV keeps the balance and `monthly-*`
files with no canonical history name; a WALLET failure keeps the balance and
both ranges with `core_wallet_failed`, no WALLET page, summary or
`wallet-months` range, and a `completed` scheduled result; a balance failure
stays `failed` with no artifact. Plan tests pin the manifest fields, the
reason precedence and each `core_partial_scope_invalid` refusal. The
Processor's collector-plan test registers a stopped core plan end to end: the
run registers `partial`, the unit carries `core_wallet_failed`, and the
parse gate admits none of its artifacts, while the successful plan's
balance, CSV and statement are admitted.
