# ADR 0005: Decide the MyJCB statement state from the page, not export links

- Status: accepted; the
  [2026-09-27 amendment](#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months)
  is proposed
- Date: 2026-09-25
- Implemented by: #248
- Carried by:
  [observations](../observations.md#myjcb-statement-state-from-the-page-statement-parser-110),
  `creditStatementState` in `services/collector-myjcb/src/parsers.ts`,
  `readMyJcbStatementPage` in `packages/domain/src/myjcb-statement-page.ts`

## Context

The MyJCB collector treated `detailMonth` 0, and 1 without export links, as
`unconfirmed`. The surveyed connection offers no export links in any month, so
position 1, the newest closed statement, was always recorded as
`unconfirmed`, although every production capture of that page carries exactly
one `<h1>カードご利用代金明細(確定分)</h1>`. Statement parser 1.0.1 rejected
every position-1 page, and recognition treated its posted charges as
`authorized`.

## Options considered

1. Keep export links as the signal. Rejected: it is wrong on the surveyed
   connection.
2. Re-state the stored rows in a ledger parser release. Rejected: a ledger
   artifact holds no page evidence, the snapshot slot comes from append-only
   artifact metadata, and the state is part of each row's external id, so a
   re-stated row would be a new key.
3. Read the state from the page with a position-aware rule that the collector
   and the statement parser share. Chosen.

## Decision

- Only the `(確定分)` heading states that a page is closed. The ledger amount
  labels (`今回のお支払い金額` for confirmed, `ご利用金額` for unconfirmed)
  must agree with it.
- Position 0 is always `unconfirmed`. A page without the heading whose ledger
  is missing or has no rows is `unknown` and gets no ledger artifact. A page
  that contradicts itself stops the run with `credit-statement-state` at any
  position. (Amended 2026-09-27, [below](#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months):
  it stops the connection, not the run, and the months captured before it
  are kept.)
- Older positions do not stop the run: every production run captured
  positions 7 and 8 with empty ledgers and no heading.
- `readMyJcbStatementPage` is the one reader of headings, rows and labels.
  Statement parser 1.1.0 uses it, and the collector manifest's state becomes a
  cross-check only (`statement_state_differs_from_manifest`).

## Consequences

- Stored position-1 rows stay `unconfirmed` observations, the record of what
  the collector said at the time; they stop being current on the first run of
  the fixed collector.
- Position 0's pending rows are no longer displaced from the connection's one
  unconfirmed snapshot slot by position 1. (Amended by
  [ADR 0016](0016-myjcb-pending-statement-slots.md): each pending statement
  now has its own slot.)
- The next position change of a statement (1 → 2) still changed its keys until
  [ADR 0007](0007-myjcb-statement-identity.md).

## Verification

Collector, parser and processor tests on synthetic pages. The production
evidence was read as counts only.

## Amendment 2026-09-27: a stop ends the connection and keeps its captured months

- Status: proposed; accepted when the amending PR merges
- Date: 2026-09-27
- Carried by: `collectCredit`, `collectConnection` and `connectionStopCode`
  in `services/collector-myjcb/src/collector.ts`, `CONNECTION_STOP_CODES` in
  `services/collector-myjcb/src/types.ts`, `myJcbRunPlan` in
  `services/collector-myjcb/src/shared-collection.ts`,
  [ADR 0026](0026-collector-unit-coverage.md) (the MyJCB row),
  [collection: MyJCB](../collection.md#myjcb-servicescollector-myjcb-kogane-myjcb-collector-poc),
  [MyJCB source note](../sources/myjcb.md)

### Context

A contradiction on one page (this ADR), a failed month fetch, a failed export
or a ledger that did not parse threw out the whole connection: the Worker
kept none of its artifacts, and the terminal recorded the unit as `unknown`
with `collector_failed` (or no unit at all when the run failed). The collector
manifest coarsened every failure to `collector-failure`. So a stored terminal
said neither which stage stopped the connection nor which months had been
captured. The MyJCB collector reported `collector_failed` on 7 of the 14
nights before this amendment, and the only record of why was the Worker's
logs, which expire.

### Decision

A contradiction stops the connection, not the run; captured months are kept
as a partial unit with a stop code.

- `collectCredit` reads the credit months in ascending `detailMonth` order,
  one at a time. A month is kept whole or not at all: its page, ledger and
  exports join the connection's artifacts only once every one of them was
  read. When a month's fetch, statement state, period, ledger parse or export
  fails, the connection stops at that month. It keeps the credit menu, the
  past-months response, every month before it and its `discovery.json`, and
  reads nothing further (no later month, no debit menu).
- Such a connection is `partial`. Its summary and the collector manifest
  carry `stopCode`, `stopPosition` (the `detailMonth` it stopped at) and
  `capturedMonthCount`. Its manifest failure entry is
  `{ connectionId, operation: "collect", code, position }`, and its terminal
  unit is `partial` with `safeErrorCode` set to the stop code.
- A connection that stops before its first month (login, discovery, the
  credit menu, the first detail page that carries the past-months
  discriminator, or the past-months response) keeps nothing. It is `failed`
  (`human-required` for `human_required`), its unit is `unknown` with the stop
  code, and its failure entry has no position. A failed debit read (`debit`)
  is handled the same way; shared mode refuses debit captures in any case
  (`artifact_dataset_unobserved`). When every connection of a
  run keeps nothing, the run is `failed` and persists only its terminal, as
  before. Its units are now still written, each with its stop code, so the
  terminal says where every connection stopped. Registration still refuses
  such a run (`provider_run_failed`): it is recorded, not sealed, and its
  units are not registered.
- The stop codes are a closed list (`CONNECTION_STOP_CODES`): `human_required`,
  `login`, `discovery`, `credit_menu`, `credit_first_detail`,
  `credit_past_months`, `month_fetch`, `month_parse`,
  `credit_statement_state`, `credit_statement_period`, `ledger_parse`,
  `export_fetch`, `debit`, `no_route` and `unclassified`. Each collector stop
  condition maps to one stage through a `Record` over every condition, so a
  new condition does not compile without a stage. `unclassified` is an error
  that names no stage. The manifest rebuilds each connection and failure from
  these closed fields and refuses a plan whose code is not on the list
  (`manifest_stop_code_invalid`) or whose position is not a `detailMonth`
  (`manifest_stop_position_invalid`). No error message, HTTP body, provider
  text or amount is stored or logged.
- The run's `safeErrorCode` is the stop code when every connection that is
  not whole stopped at the same stage (as `human_required` already was);
  otherwise it stays `collector_partial` or `collector_failed`.
- A month whose page shows rows without a stated state still keeps its page
  without a ledger and makes the connection `partial` with
  `collector_partial` (ADR 0026). It is not a stop.

Registration is unchanged. A `partial` unit with a safe error code registers
as a `failed` unit report, so the run is `partial` in
`observation_fetch_runs` and `not_eligible` for parse jobs, exactly as a
connection that withheld a month's rows is (ADR 0026). Nothing about
eligibility is loosened. The months a stopped connection captured are
catalogued and sealed but not parsed. What changes is that the evidence and
the cause are kept: the captured months exist as stored artifacts, and the
terminal and the manifest say where the connection stopped and how many
months it captured.

### Options considered

1. Keep discarding the connection and log more detail. Rejected: logs expire,
   and the cause would still not be in the stored evidence.
2. Keep the captured months and make them parseable. Rejected: it would need
   a partial unit to be eligible, which is exactly what ADR 0026 keeps closed.
   A later month missing from a run must not read as a whole snapshot.
3. Keep the captured months as a `partial` unit with a closed stop code.
   Chosen.

### Consequences

- A stopped connection's run registers `partial` and is never parsed, as
  before. Its captured months are recoverable evidence: a later parser change
  or eligibility decision could read them without a new capture, and nothing
  here makes that decision.
- Production terminals written before this amendment keep `collector_failed`
  and no months. They are immutable.
- The stop position and the count of captured months are recorded. The stage
  is the collector's own, and it does not say what the provider meant.
- `r2-write` is not a stop code: the collector writes nothing until the run's
  plan is persisted, and a failed put leaves no terminal (G1-01).

### Verification

- `services/collector-myjcb/test/credit-statement-state.test.ts`:
  `collectCredit` stopping at position k keeps positions below k and nothing
  from k on, for a failed fetch (`month_fetch`), a contradicting page
  (`credit_statement_state`), a page naming no month
  (`credit_statement_period`), a ledger header missing a label
  (`ledger_parse`), and a failed export, which also drops that month's page
  and ledger (`export_fetch`). The stop log carries codes and counts only. A
  failure at the menu or the past-months response is thrown. Every stop
  condition maps to a closed code. The Worker, with a session connection
  whose month 2 returns HTTP 500, persists months 0 and 1 as a `partial` unit
  with `month_fetch` and a manifest with `stopPosition: 2` and
  `capturedMonthCount: 2`, without the response body. Through the manual
  trigger, an error message, an HTTP error body or an unparsable page that
  carries a digit string, a merchant-like word and a URL, at a month, at the
  credit menu, at the past-months response or at login, reaches no stored
  byte, no log line and no HTTP response; only the stop code does.
- `services/collector-myjcb/test/shared-collection.test.ts`: the stopped unit,
  its artifacts and its manifest entries; distinct stages keep distinct unit
  codes; a failure before the first month keeps nothing and its `unknown`
  unit carries the code; free text passed into a summary or a failure does
  not reach the manifest, and an unknown code or position refuses the plan;
  the Worker with no browser records `login`.
- `services/processor/test/myjcb-shared-r2.test.ts`: the collector's real
  plan for a stopped connection registers and seals, catalogues its captured
  artifacts, has run status `partial` and unit report `failed` with
  `month_fetch`, is sealed under `terminal-registration-v2`, and ends
  `not_eligible` with nothing parsed. A failed run whose only unit stopped
  before its first month persists only its terminal (unit `unknown`, 0
  artifacts, the stop code) and registration records it as blocked
  `provider_run_failed` with no fetch run and nothing sealed.
  `services/processor/test/collector-plans.test.ts` (the successful plan) is
  unchanged and passes.
- No production data was read for this amendment.
