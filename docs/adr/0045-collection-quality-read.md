# ADR 0045: Collection quality is a per-request read of stored stage states, in closed codes

Status: accepted
Date: 2026-10-08
Issue: [#542](https://github.com/risu729/kogane/issues/542) (first part)

## Context

A collector existing, a schedule being enabled or a run reporting success
does not show that a given account, card, data type and period was captured,
stored, parsed, adopted as current and how old the current capture is. Each
of those stages is already recorded, in different places:

- the attempt: `collection_schedules`, `collection_schedule_occurrences` and
  `collection_execution_leases` (CORE 0065);
- the acquisition and its registration: `collection_runs` and
  `collection_run_stages` (CORE 0039), linked to the run ids a receipt names;
- the stored evidence: the sealed fetch runs, their units and artifacts and
  the raw objects behind them (`visibleEvidence`, `evidenceExists`);
- parsing: `observation_parse_jobs`, the recorded parse runs and the
  publication projection (`published_parse_runs`), with coverage claims;
- currentness: the dataset snapshot policies (`completeSnapshotCandidates`),
  the GLOBAL PASS, Vpass and MyJCB snapshot CTEs of
  `packages/read-model/src/sql.ts`, and per-query rules of the Transactions and
  Balances reads.

No read put them side by side. `/api/meta` counts parse jobs, the schedule
page lists receipts, and an empty list on any page cannot be told apart from
"nothing was collected", "nothing parsed yet" or "the newest capture was
refused".

## Options considered

1. **A stored projection maintained by the Processor.** A new table, a writer
   and a migration, and a second copy of the currentness rules that can fall
   behind the reads it describes. Not needed for a bounded per-source read.
2. **A new query that restates each dataset's currentness.** Cheaper to write,
   and certain to drift from the Transactions, Balances and Positions reads it
   is meant to explain.
3. **A per-request read that composes the existing rules unchanged** and
   reports what each stored stage says, in closed codes (chosen).

For the wire contract: the other contracts of `packages/observation-shared`
hand-write their guards. This one uses **zod**, the schema library the
repository already pins (4.6.5, used by `services/app`'s operations API), in
its tree-shakable `zod/mini` build, so the web client that validates every
response does not take the full library. Strict objects refuse unnamed fields,
cross-field rules are `refine` checks, and the TypeScript types are inferred
from the schemas, so the shape is stated once. zod is MIT-licensed, has no
dependencies, runs on Bun and workerd (the operations API already runs it
there) and type-checks under TypeScript 7. It validates shape only: it does no
arithmetic and no date handling (instants are checked with the domain's own
`validInstantText`).

## Decision

**Two read-only routes** under the reader authority every signed-in subject has
over the evidence routes, served only where CORE 0065's tables exist:

- `GET /api/collection-quality`: every configured job and every visible CORE
  source. A job is a row of `collection_schedules`, read, never counted in the
  code. A source's collectors are the `COLLECTOR_SOURCE_IDS` entries that
  register under it; a job belongs to the sources its collectors register
  under. Per job: enabled, supported, the held lease, and the newest receipt
  with each run it names as `collection_runs` has it (`registered`, `pending`,
  `blocked`, `unrecorded`), outcome, coverage and code. Per source: its newest
  visible fetch run, its never-registered terminals by code, and reasons.
- `GET /api/collection-quality/<sourceId>?offset=N`: the source's **cells**,
  500 a page.

**A cell** is (dataset, parser, fetch unit, period, MyJCB statement state,
currentness rule) over the source's visible artifacts that a parser dataset,
a parse job or a recorded parse names. The period is the one the dataset's
snapshot CTE partitions on (GLOBAL PASS activity month, Vpass statement month,
MyJCB payment-month slot), otherwise `latest`. For each cell the read states
its newest capture (the newest fetch run by capture time: run success, unit
outcome and code, artifacts, raw objects reachable, parse states of that
parser, failure codes, incomplete coverage claims and their causes) and its
current capture (the newest fetch run with a member of the current set). A
capture that no parse job or parse names is its own cell, counted as not
queued or not eligible, and shown only while it is newer than every parsed
capture of its slot.

**Currentness is composed, never restated.** Membership is decided by
`current_global_pass_snapshots`, `current_vpass_snapshots` with
`VPASS_SNAPSHOT_MEMBER`, `current_myjcb_snapshots` with `MYJCB_LEDGER_MEMBER`,
and otherwise `activeStateProjection` with `completeSnapshotCandidates`'
membership. The newer per-query rules of the Transactions and Balances reads
(SMBC Direct ranges, MoneyForward months, V Point runs, MyJCB past months) are
not composed: their cells carry `query_rule_not_composed`, and a test pins the
list to the reads that apply them.

**Every gap is a reason, never a zero.** The reason lists are closed
(`SOURCE_REASONS`, `CELL_REASONS`); each is read from one stored state. The
stored stage codes (receipt failure, terminal block, unit failure, parse
failure and coverage cause codes) are passed on as stored when they have the
safe-code shape, with no list of their own applied here; any other stored
text reads `unclassified`. Freshness is the capture time of the current
capture as stored; the read computes no age and judges nothing stale.

**Unit keys are shown.** The cells route is a new API aggregation entry that
returns each cell's raw fetch unit key. Unit keys are provider-local opaque
identifiers (class c of
[ADR 0029](0029-data-classification-and-unkeyed-identity.md)): for example
Vpass card tokens and Money Forward account digests (the `-v2-` values
unkeyed digests, the retired importer's `-v1-` values keyed HMACs), MyJCB
connection ids, and Mizuho's branch and account number with a page range. The
route returns them for units whose captures were never parsed or were not
parse-eligible too, so it is not merely a re-return of the `source_account`
values the evidence lists already show. It inherits the authenticated reader
boundary of the evidence routes: every signed-in Access subject holds the
reader grant (`readerGrant`), not only `OPERATOR_SUBJECTS`. It adds no MCP
tool or grant, no external recipient and no stored record or log sink; logs
carry only the route class and status, as before. The owner's separate
security review of this exposure read neither real data nor the current Access
policy. The per-unit view is the point of the read.

**One alias table.** Two jobs' sources differ from the source their
collector writes in its terminal: `vpoint` writes `v-point`, and `vpoint-pay`
is the app collector `v-point-pay`. `SCHEDULE_COLLECTOR_SOURCES` states those
two; a test reads each collector's declared source and checks every configured
job against the registration map.

No migration, writer, table or flag is added.

## Consequences

- Open limits, stated in the read rather than hidden:
  - the per-query rules above are not evaluated, and MoneyForward months and
    SMBC Direct ranges show as one `latest` cell per dataset and unit;
  - a `container-snapshot` cell is current in the sense of the Balances and
    Positions reads; the Transactions read applies no snapshot selection, so
    the transactions a snapshot parser also emits
    (`sbi-shinsei-top-balances-and-activity`) stay listed from a capture this
    read calls not current;
  - an empty current capture (the GLOBAL PASS empty month,
    [ADR 0026's amendment](0026-collector-unit-coverage.md#amendment-2026-10-04-global-pass-empty-months-are-read-as-no-rows))
    is `current` like any other; the read counts no observation. The months
    where such a capture supersedes an older one with rows are named by
    `/api/meta`'s `globalPassEmptyMonths`
    ([ADR 0026's amendment of 2026-10-08](0026-collector-unit-coverage.md#amendment-2026-10-08-global-pass-empty-months-that-supersede-rows-are-reported)),
    not by this read;
  - a provider's retention cap (Mobile Suica's 100 rows) has no stored code of
    its own; it shows as the parser's refusal;
  - unresolved account identity beyond the withheld Vpass collector dataset
    (`dataset_withheld`) is not shown;
  - raw objects are checked in CORE only (a foreign key makes every registered
    artifact's row exist); whether the R2 object is still there is checked by
    the raw download route, not here;
  - only the newest receipt of each job is linked to its runs;
  - there is no page yet; the API is the first part of #542.
- Cost: the summary reads are keyed by job, run id and source.
  `UNREGISTERED_QUALITY_SQL` reads every `collection_runs` row of each visible
  collector source on each call, through the `(source, run_id)` index, so it
  grows with the terminal history (measured once in review on a loaded
  machine with every row never registered, the worst case: about 20 ms at
  4,000 rows and 200 ms at 16,000; not asserted). The cell read
  reaches the source's artifacts through `idx_fetch_artifacts_source_dataset_time`
  and everything else by key; its only whole-store passes are the composed
  snapshot CTEs', which the Transactions, Balances and Positions reads already
  make. A per-source CTE is reached only from a cell of its dataset; measured
  once on `bun:sqlite`, a Sony Bank page took the same time with 0 or 2,000
  GLOBAL PASS pages in the store (not asserted by a test).
- `zod/mini` joins the web bundle through the shared validator: the production
  client's main chunk grows by about 24.7 kB (8.7 kB gzip), this contract
  included (Vite production build, measured locally: 624.53 kB, 180.38 kB
  gzip, to 649.28 kB, 189.11 kB gzip, on `3a1a2a9`; 626.31 kB, 180.94 kB
  gzip, to 651.00 kB, 189.67 kB gzip, on `870bd25`). No `Function`
  constructor or `eval` is in the built chunk, so the `script-src 'self'`
  policy holds.

## Verification

Synthetic only. `packages/read-model/test/collection-quality.test.ts` builds
complete-CORE stores for each distinguished state (current, older-current
behind a pending or refused page, an incomplete coverage claim, unpublished,
not queued, not eligible, a failed unit with its code, an unplaced MyJCB slot,
the Mizuho artifact container, paging), enumerates the jobs from the table, and
checks the plans of every read on a scaled store with no table statistics,
including a negative control. `packages/application/test/collection-quality-query.test.ts`
checks the jobs and aliases against `config/alarm-jobs.json`, every reason and
the contract. `services/app/test/collection-quality-api.test.ts` checks
Access, GET-only, absence without CORE 0065, refusals and that nothing is
written. Production read-only verification of #542 is a separate, later step
and is not claimed here.

## Amendment 2026-10-09: compose the remaining shipped capture selections

- Status: proposed (until its PR merges)
- Issue: part of #542

### Context and options

The first part explicitly withheld six per-query rules. Leaving them withheld
would keep a published but superseded capture labelled current. Copying the
rules into quality would drift from Transactions/Balances. Composing their
unchanged texts is the chosen option. No provider meaning, new acquisition,
financial adoption, writer, migration, grant or MCP tool is introduced.

### Decision

`packages/read-model/src/current-captures.ts` supplies the existing CTEs to
`sql.ts` and quality. The complete rendered Transactions and Balances texts
remain byte-identical to the base; MyJCB past-month CTE names alone gain `cq_`
in the quality composition to avoid colliding with credit-ledger names.

| Parser                                                               | Existing selection                                                                                                           | Quality rule / partition                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `smbc-direct-transactions`                                           | newest eligible published artifact per source and artifact key; capture time then artifact id                                | `smbc-request-key` / `request-key`                          |
| `moneyforward-monthly-transactions`                                  | newest eligible published artifact per source, v1/v2 account unit and existing key month substring; time then id             | `moneyforward-account-month` / `account-month`              |
| `v-point-history-page`, `v-point-balance-info`, `v-point-smfg-point` | latest eligible run with all three parsers and every expected balance/history artifact published; completed time then run id | `v-point-complete-run` / existing dataset/unit/latest cells |
| `myjcb-credit-past-month-balances`                                   | newest eligible published artifact per source and existing connection prefix; time then id                                   | `myjcb-connection` / `connection`                           |

The V Point cell also requires its own published eligible parse: complete run
membership does not turn a different pending parser into published evidence.
MyJCB past-month and V Point balance cells additionally compose Balances'
existing dataset snapshot membership; V Point history follows Transactions
and is not given an extra balance-only policy.
The existing final observation deduplication and balance row ranking are not
capture selection and are not reimplemented in quality.

`request-key` is the full stored artifact key, an opaque request partition,
not a newly parsed date range. `connection` is the existing artifact-key
prefix, not a resolved account or a payment month. These may contain
provider-local identifiers and are returned only through the existing
authenticated reader route; no MCP tool, grant, recipient or log sink is
added. MoneyForward uses the shipped substring expression unchanged, not a
new month inference. The quality contract adds these closed rule/partition
codes without widening the reader authority. Raw evidence is not rewritten.

A published parse with no coverage claim adds `coverage_not_recorded`.
Incomplete/unknown stored claims still add `coverage_incomplete` with their
stored causes. Publication and membership alone never prove full provider
history, missing pages, retention completeness or resolved account identity.
`UNCOMPOSED_QUERY_RULE_PARSERS` is empty today but remains pinned against every
parser-specific guard of the shipped lists, so a new rule must be composed or
explicitly withheld. No age, stale threshold or retention cap is invented.

### Consequences and verification

Synthetic boundary and randomized stores compare capture membership with the
shipped selections, covering missing pages, pending/refused/superseded parses,
account-month and connection separation, equal-time tie-breaking, malformed
parser association, and missing versus complete/incomplete coverage claims.
Frozen base rendered-SQL digests protect the unchanged financial list texts.
The full-CORE scaled fixture adds all four new rule families; query plans are
checked without statistics, with automatic indexes confined to the composed
CTEs, and timings printed rather than asserted. Independent review, hosted CI
and latest-main integration remain merge gates. Production read-only scope
verification of #542 remains separate and is not claimed by these tests.
