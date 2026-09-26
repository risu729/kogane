# Reported state on a date

What each provider last reported, per account, on a date the owner chooses,
beside the card statements due around that date. This is phase 8's first
slice ([roadmap](roadmap.md#phases-8--11--dated-reported-and-reconstructed-state)),
decided in [ADR 0019](adr/0019-dated-reported-state.md). It is a list of
provider figures, never a total: nothing is added, converted or netted, and a
container without a capture is named, never shown as zero.

| Layer        | Where                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Snapshot CTE | `SnapshotCteOptions.cutoffParam` in `packages/parsers/src/snapshot-query.ts`                            |
| SQL          | `packages/read-model/src/dated-state.ts`                                                                |
| Policies     | `packages/domain/src/reported-state.ts` (cutoff, freshness, payable status, perimeter)                  |
| Query        | `queryDatedState` in `packages/application/src/query/dated-state.ts`                                    |
| HTTP         | `GET /api/v2/reported-state?date=YYYY-MM-DD` (`services/app/src/reported-state-api.ts`)                 |
| Contract     | `validReportedState` in `packages/observation-shared/src/reported-state-contract.ts`                    |
| Page         | 基準日の保有状況 at `/state` (`apps/web/src/pages/ReportedState.tsx`), capability `reportedStateOnDate` |

## The cutoff

The date `D` is a civil date in Asia/Tokyo. A capture belongs to it when it
was fetched before `(D+1) 00:00` Asia/Tokyo. `observation_fetch_artifacts.fetched_at`
stores every instant as UTC `%Y-%m-%dT%H:%M:%fZ`, so the cutoff is written in
that form (`2026-09-10` → `2026-09-10T15:00:00.000Z`, `reportedStateCutoff`)
and compared as text.

The snapshot is chosen by the same rules as the current state: the policy
table (`dataset_snapshot_policies`), coverage claims under `coverage-v1`, the
confined warning adapter under `legacy-warning-compat-v1`, published parses
and the run or unit scope. `snapshotCtes(relations, { cutoffParam: "?1" })`
adds two clauses and nothing else:

- a dataset snapshot (one fetch run's unit) is eligible only when its newest
  artifact is before the cutoff (`HAVING … AND MAX(fa.fetched_at) < ?1`), so a
  run that crossed midnight is never cut in half;
- an artifact container (Mizuho's account list) is eligible only when its
  artifact is before the cutoff.

Without `cutoffParam` the text is byte for byte what every current reader
composes (`packages/parsers/test/snapshot-cutoff.test.ts` pins the digests of
the shipped text). The parameter must be a `?N` reference; a value is refused.

Consequences the tests pin (`packages/read-model/test/dated-state.test.ts`):
a capture at 00:00 Tokyo on `D+1` is not in `D`; a partial run or a partial
`coverage-v1` claim is never chosen; a complete-empty capture is chosen and
holds nothing; a position absent from the chosen capture is not held, whatever
an older capture said.

## Perimeter

Listed (`dated-state-perimeter-v1`): every container in the snapshot policy
table with `snapshot_selection = 1` and the artifact containers
(`ARTIFACT_SNAPSHOT_CONTAINERS`), except the two aggregates below. Not listed,
and named in `coverage.excluded`:

| Scope                                    | Why                                                              |
| ---------------------------------------- | ---------------------------------------------------------------- |
| MoneyForward                             | An aggregator: it restates accounts the direct sources list      |
| `sbi-account-assets-current`             | A provider total over the accounts the other SBI containers list |
| `sony-bank-gross-balance`                | A provider total (assets and loans) over the Sony accounts       |
| Balances restated after each transaction | Registry `timeBasis: event-reported`; counted in `excludedRows`  |
| Reward units                             | Registry `unitDimension: reward`; counted in `excludedRows`      |

A perimeter container with no snapshot before the cutoff is listed in
`coverage.containersWithoutSnapshot` with `no_complete_snapshot_before_cutoff`.

## The answer

`queryDatedState(sql, { date, source?, account? })` returns:

- `snapshots`: every snapshot chosen for the date, a complete-empty one
  included, each with its capture time, the capture's Tokyo date, its age in
  days and its freshness under `dated-state-freshness-v1`: `same-day` (age 0),
  `recent` (1–3 days), `stale` (more).
- `accounts`: one per (source, provider account), with the snapshots its rows
  came from, its resolved account and identity status (the current account
  mapping of the row's identity, or `not-recorded`), and:
  - `positions`: the provider quantity as decimal text, the instrument mapping,
    and the provider valuations matched as `POSITION_VALUATIONS_SQL` matches
    them (same parse run, account and code, and the locator guard
    `POSITION_VALUATION_LOCATOR`), in the provider's currency;
  - `balances`: the stored decimal-v1 value (or its absence with a reason, never
    zero), the provider metric and the registry metric with its measurement
    kind, sign meaning, aggregation rule and overlap group. The aggregation rule
    says whether a balance could be added across disjoint accounts; nothing here
    adds it.
- `payables`: provider statement totals (`card_statement_facts`' rule restated
  with the cutoff: the newest published capture per statement key before it)
  due on or after `D − 31` days, or without a readable due date and captured
  in the 45 days before the cutoff, each with the resolved card account (the
  keyed form of `card_settlement_fact_ownership`) and the settlement review of
  its (account, source, period), accepted first (the purchases page's
  `SETTLEMENT_SQL`). Status on `D`:

  | Status                      | When                                                                 |
  | --------------------------- | -------------------------------------------------------------------- |
  | `settled_on_or_before_date` | An accepted settlement review whose bank debit is on or before `D`   |
  | `payment_date_unknown`      | Otherwise, no readable due date                                      |
  | `due_after_date`            | Otherwise, due after `D`                                             |
  | `due_unsettled`             | Otherwise (due on or before `D`, no accepted debit on or before `D`) |

  A proposed, rejected or withdrawn review settles nothing.

- `coverage`: containers without a snapshot, stale snapshots, the excluded
  perimeter and excluded row counts, `liabilitiesCoverage: "partial"` with
  `liabilitiesMissing` (`unbilled_card_usage`, `installment_remaining`,
  `loan_balances`, `statements_before_window`), the payable window, and
  `netAssets: "not-computed"`.
- `manifest` (schema, date, cutoff, policy ids, snapshot, statement and
  settlement refs) and `contextId = canonicalDigest(manifest)`.

`source` narrows accounts, payables and coverage to one source; `account` to
one resolved account id. The answer has no total, subtotal or net worth, and
the wire contract refuses one.

## HTTP

`GET /api/v2/reported-state?date=YYYY-MM-DD[&source=…][&account=…]`, GET and
HEAD only, served to every signed-in reader (the reader authority the other
GET routes have; it carries no review action). `400 invalid_date` for a
missing or impossible date, `400 date_in_future` after today in Tokyo,
`400 invalid_query` for any other or repeated parameter, `413
result_limit_exceeded` past 5,000 rows in one read (refused, never cut), and
`404` where the store lacks `dataset_snapshot_policies`, `card_statement_facts`
or `card_settlement_reviews`; `/api/meta` advertises `reportedStateOnDate` on
the same condition.

## Cost

Measured on `bun:sqlite` with every CORE migration and no table statistics, on
the statement-scale store of `packages/read-model/test/card-usage-scale-fixture.ts`
(`STATEMENT_SCALE`: 730 daily captures of three Vpass cards, a MyJCB
connection, SMBC and St.George; 27,006 artifacts, 16,056 published parses,
628,171 transaction and 16,790 balance observations, 5,840 statement totals,
3,763 settlement candidates), with `KOGANE_DATED_STATE_SCALE=full`:

| Read                                  | Median |
| ------------------------------------- | ------ |
| `queryDatedState`, today              | 398 ms |
| `queryDatedState`, a date a year back | 346 ms |
| `DATED_POSITIONS_SQL`                 | 93 ms  |
| `DATED_BALANCES_SQL`                  | 92 ms  |
| `DATED_SNAPSHOTS_SQL`                 | 83 ms  |
| `DATED_STATEMENTS_SQL`                | 105 ms |

The four reads are issued concurrently through the executor, one statement
each, plus the settlement read. What grows with history: the snapshot CTEs
read every artifact once per read (through
`idx_fetch_artifacts_source_dataset_time`), as the current-state reads do, and
the statement read ranks every captured statement total before the cutoff, as
`card_statement_facts` does. Everything else is reached by key: parses through
`published_parse_runs`, observations through their `parse_run_id` indexes,
identities through the identity runs of the chosen parses only, owners through
the keyed ownership CTEs, and reviews through
`card_settlement_candidates_statement_period`. No index was added, so there is
no migration. `packages/application/test/dated-state-scale.test.ts` builds the
smaller `STATEMENT_CI_SCALE` in CI, checks each date's snapshot and statements
against independent queries, fails on a plan that scans an observation, parse,
run or identity table whole, and requires each answer under one second.

## Limits

- Not measured on workerd or D1 itself. The scaled store holds balance
  containers and statements; it has no SBI position containers, so the position
  read's timing there reflects the snapshot CTEs, not many positions.
- Identity, account mappings and settlement reviews are read as they are today,
  not as they were on `D`: a later mapping correction or review changes an
  earlier date's answer (and its `contextId`).
- A settlement's debit date is the reviewed bank row's date, whenever that row
  was captured; the bank capture itself is not bounded by the cutoff.
- Statements due before `D − 31` days are not listed, whatever their status.
- Only the Vpass and MyJCB statement parsers supply payables; unbilled usage,
  installment remainders and loans are not shown (`liabilitiesMissing`).
- Adoption and overlap across sources (`selectAdoptedSet`) are not applied:
  rows are listed per provider account, which is why nothing is added.
  Valuation in a base currency is P2-3.
- Nothing is stored: a reported state has no fixed report or
  `calculation_runs` row yet.
