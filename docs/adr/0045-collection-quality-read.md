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
capture as stored; the read computes no age and judges nothing stale
(superseded by the amendment of 2026-11-08 below: ages are counted under
`collection-freshness-v1`).

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

- Status: accepted (merged 2026-10-09 in #630)
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
explicitly withheld. No age, stale threshold or retention cap is invented
(ages: superseded by the amendment of 2026-11-08).

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

## Amendment 2026-10-09: a page, actual reservations and missing-unit states

- Status: accepted (merged 2026-11-06)
- Issue: #542 (implementation; production acceptance remains open)

### Context and options

The read exists but has no page. Starting every cell from an artifact loses a
newly declared unit whose attempt produced no file. Enabled settings alone do
not prove an Alarm reservation; a failed reservation read must not mean none.
Published parses can contain no observations or unresolved identities.

Extending the artifact-backed read with declared attempts, the current
published parse's stored row counts and eligible sealed identity runs avoids
new projections or writers. Inferring an account from an opaque unit key, a
provider retention failure from a generic parser refusal, or a stale threshold
from elapsed time is rejected: none has the necessary stored evidence.

### Decision

`/collection-quality` consumes the shared strict contract in the observation
and evidence clients. It reads the summary first and reads cells only for a
chosen source, 500 per page, with continuation explicit. Source selection and
paging use the URL. Query errors, no captures and no observations have distinct
messages. Refresh only re-reads stored state. UTC instants are displayed as
stored, including actual attempt start separately from its nominal schedule.

The expanded strict wire shape has `apiVersion: 2` (3 since the amendment of
2026-11-08); version-1 replies are not rendered by this page. The quality version is separate from metadata's version.

The summary adds stored future nominal/due times and `alarm` with `observed`
or `unavailable` plus a nullable actual time. The App reads a bounded internal
Processor route through the existing service binding, after the reader's
capability and all-source/all-account scope check. The Processor enumerates
the current `collection_schedules`, then calls only each named DO's read-only
`alarmTime`. It does not reconcile, release a lease or execute collection.
A failed RPC is unavailable; a successful null is observed absence. A relay
failure, timeout, invalid response or changed schedule configuration leaves
that schedule unavailable. This exposes reservation counts/times under the
same authenticated evidence reader boundary as schedule status, with no grant,
MCP tool, authentication change or settings mutation.

The newest declared unit of each producer/unit that has no visible artifact
is an attempt cell: null dataset/parser/period, zero stored artifacts and
observations, no current capture, `unit_without_artifacts`, its stored outcome
and safe failure code. These are counts of missing records, never financial
zeros or complete-empty acquisition claims. A successful artifact capture
suppresses the unit-only row after recovery. Existing artifact cells can still
show an older current capture and `not_in_latest_run` alongside the failed
attempt. The per-source union is ordered and paged as a whole.

The newest capture reports observation-row counts of its published parses and
unresolved account observation counts from each parse's newest eligible sealed
identity policy, using current mapping revisions. No provider amount, label,
account identifier or body is read for these counts. A missing identity run is
`identity_not_recorded`; unresolved mappings are `identity_unresolved`; a
published parse with no rows is `published_without_observations`. None asserts
provider-history completeness. Every cell carries `retention_not_assessed`:
stored parser refusals do not identify whether a provider retention cap was
reached. Unit outcome absence/unknown is explicitly `unit_outcome_unknown`.

### Consequences and verification

The page now distinguishes stopped, unsupported, authentication-waiting,
missing-file, pending/refused/unpublished parse, empty publication, unresolved
identity, unavailable Alarm read and older-current states. No stale or retention
threshold is invented (a stale threshold: superseded by the amendment of
2026-11-08). The indexed full-CORE plan guard includes new bounded
per-source CTEs while retaining base-table negative controls and frozen
financial-query digests. Synthetic tests cover missing units, recovery, empty
publication, identity policy revisions, restricted authority before enumeration,
Alarm failures/configuration races, read-only browser refresh and existing
currentness. Production acceptance still follows the scoped read-only checklist
in [the completion plan](../plans/2026-10-collection-quality-completion.md).

## Amendment 2026-11-07: an agent read of the same page

- Status: accepted (risu's decision of 2026-11-07, recorded as
  [ADR 0081](0081-ui-parity-through-mcp.md))

This ADR added no MCP tool. ADR 0081 requires one for every UI read, so
`kogane.collection-quality.read` answers `GET /api/collection-quality` and
`/api/collection-quality/{source}` through the route's own reader. Because the
cells carry the provider fetch-unit keys described above, it requires
`evidence.read` on `"*"` sources and accounts, the capability of the evidence
routes (not the `summary.read` that row D17 of the
[AI operation path plan](../plans/2026-10-ai-operation-path.md#53-reads-searches-and-details)
named), and is published only while the five scheduling and run tables exist.
Every MCP client holds the whole-store grant, `evidence.read` included
([ADR 0084](0084-mcp-operator-authority-without-delegation.md)), so it is
listed to every client the MCP Access application admits. The answer travels under `data`, as untrusted provider
content, and each call is an R0 read in the audit log.

[ADR 0088](0088-collection-quality-per-account.md) adds the per-account view
of one source's cells to this tool as `view: "accounts"`, over the same
reader, capability and store feature.

## Amendment 2026-11-08: freshness per source and cell

- Status: accepted (merged in #1127). The owner accepted these states, provisionally, on
  2026-11-08 at 03:19 UTC, answering the Phase 3 plan's question "Freshness
  states: `same-day` / `recent` (1–3 days) / `stale`, plus `human_required`,
  `disabled` and `no_capture`?" in [the Phase 3 plan](../plans/2026-11-phase3-coverage-identity.md)
  (3d, recorded under its decisions; spelled with
  hyphens here, like `dated-state-freshness-v1`'s states)
- Issue: #542 (Phase 3, layers 0–5: "coverage is visible per account and data
  type")

### Context and options

The read stated each capture time and judged no age, so a source whose
newest capture is a month old (SMBC Direct is collected only by hand) read
the same as one collected this morning, and a person had to do the date
arithmetic for every cell. The reported state already classifies a snapshot's
age under `dated-state-freshness-v1` (`same-day`, `recent` up to 3 days,
`stale`), for the daily collectors these sources are.

1. **Keep showing times only.** Leaves the judgement to every reader, and an
   agent reading over MCP has to restate a threshold of its own.
2. **A threshold per source from its schedule.** Every collector with a
   schedule is daily today, so it would give the same answer as one
   threshold, with a second configuration to keep in step.
3. **One versioned policy, computed per request in the application query
   (chosen).** It reuses the reported state's thresholds, adds the states
   that explain why data is not fresh from what is already stored. It leaves
   the existing SQL texts unchanged and adds one small read of a source's own
   jobs for the cells route.

### Decision

`collection-freshness-v1` (`packages/domain/src/collection-freshness.ts`).
Each answer names `freshnessAsOf: { policy, at, date }`: the one instant every
age is counted to (the route's request time; tests pass a fixed one) and its
Asia/Tokyo civil date. Each source and each cell carries
`freshness: { state, ageDays }`:

- The age is in Asia/Tokyo civil days from the capture's date to that date. A
  cell's is its current capture's (none with no current capture); a source's
  is its newest visible fetch run's (`latestFetchRun.completedAt`), whatever
  that run's outcome: the cells say per data type whether a current capture is
  that new. A capture dated after the as-of date (a collector clock ahead of
  the reader's) is age 0, never negative.
- `same-day` (0), `recent` (1–3) and `stale` (more) are
  `dated-state-freshness-v1`'s thresholds.
- What the source waits on explains data that is `stale` or has no capture,
  and replaces that state: `human-required` when one of its jobs collects only
  by hand (`kind: "manual"`) or a job's newest attempt stopped on a "a person
  must act" code (`human_required*`, `manual_agreement_required`, the codes
  that already give `user_action_required`), or, for a cell, its unit's own
  failure code is one; otherwise `disabled` when the source has supported
  collecting jobs (`collection`, `manual`, `email`; not a keepalive) and none
  is enabled. An unsupported job can never be enabled (CORE 0065's CHECK), so
  it does not say collection was switched off: V Point Pay's only job is the
  unsupported app job while its e-mail path, which has no job, still
  delivers, so V Point Pay reads `stale` or `no-capture`, not `disabled`.
  A fresh capture stays `same-day` or `recent` whatever the source waits on.
- Otherwise data with no capture is `no-capture`, with no age.

The contract checks each pair against the policy (`consistentFreshness`), each
age against the capture it is of and the answer's as-of date, and the as-of
date against its instant.
`apiVersion` is 3. The cells route reads the source's own jobs and their newest
receipts (`SOURCE_JOBS_SQL`, keyed by the job sources of the source's
collectors and their aliases), so one source's cells are still served when the
store has more jobs than the summary's bound. `kogane.collection-quality.read`
answers the same and its description names the policy.

With production as read through `kogane.collection-quality.read` on
2026-11-08 at about 03:25 UTC, SMBC Direct
reads `human-required` with its age, a source with only a disabled job and no
capture (PRESTIA bank) `disabled` with no age, St.George `stale` (its blocked
coordinator has no stored "a person must act" code; its fix is #450), and
V Point's `reauthentication_pending` attempt is not a wait (its e-mail
triggered run completes).

### Consequences and verification

- A source's age is that of its newest fetch run, successful or not, so a
  failing source whose last partial run was yesterday reads `recent`; its
  reasons (`latest_run_not_successful`, `acquisition_failed`) and its cells say
  what that capture holds.
- A blocked coordinator or a lapsed session without a stored code is not
  `human-required`; adding such a code to a collector moves it there with no
  change here.
- No migration, table, writer, grant or tool is added; the policy is code and
  a new version is a new name.
- The per-account view ([ADR 0088](0088-collection-quality-per-account.md),
  its own `apiVersion` 1) is unchanged: its periods state their capture
  times and carry no freshness. ADR 0088's
  [amendment of 2026-11-08](0088-collection-quality-per-account.md#amendment-2026-11-08-freshness-per-account-data-type-and-period)
  later applies this policy to that view (`apiVersion` 3), using each period's
  named capture independently of standing and carrying the provider catalogue.
- Synthetic tests: `packages/domain/test/collection-freshness.test.ts`
  (Tokyo dates across midnight and offsets, every threshold, waits, refusals,
  and that the contract's check accepts exactly the policy's answers);
  `packages/application/test/collection-quality-query.test.ts` (cell ages at
  and across a Tokyo midnight, a clock ahead, a person's wait before a stopped
  job, source ages and waits for manual, disabled, terms-agreement, never
  captured and collector-less sources, a configured job's source map, and
  contract refusals); a unit's own code in
  `collection-quality-empty-units.test.ts`; the plan of `SOURCE_JOBS_SQL` in
  `packages/read-model/test/collection-quality.test.ts`; route and tool parity
  under one clock in `services/app/test/page-read-reports.test.ts`; the page's
  labels in `apps/web/test/collection-quality.browser.test.ts`.

## Amendment 2026-11-08: retain failed terminal reasons

Status: accepted (merged 2026-11-09 in [#1201](https://github.com/risu729/kogane/pull/1201), with migration 0086).

A registration refusal such as `provider_run_failed` explains why CORE did not
seal a run, but loses the validated terminal's reason for the provider failure.
Reading R2 on every quality query would couple a bounded D1 read to raw-object
access. Keeping only the registration code leaves the reason unavailable after
short-lived operational logs expire.

Store the failed terminal's optional closed run-level code in the immutable
`collection_runs.provider_failure_code` column at first sighting. Keep the
manifest grammar and leave old or unvalidated rows NULL; no backfill or evidence
rewrite is performed. Expose a separate normalized `failureCode` on latest
receipt terminals and unregistered groups, grouping by both registration and
provider codes. The existing `safeCode` display grammar remains unchanged.
The shared summary/cell contract advances to version 5; HTTP, MCP and UI use
one application result. No capability, grant or provider operation is added.

Migration and storage tests cover exact grammar boundaries and immutability;
registration tests cover refused and registered failed terminals, absent and
invalid codes, and redelivery. Query tests check normalization and distinct
buckets, frozen SQL differential tests preserve old counts and selection, and
the browser renders both views with the existing accessibility checks.

## Amendment: V Point recovery is current state, while failed receipts remain history (2026-11-11)

Status: proposed. Related: [#1301](https://github.com/risu729/kogane/issues/1301).

Context. Both observed daily expired-session reads completed automatic email
login and a separate successful post-auth collection. The original scheduled
receipt intentionally remained failed. Treating it as permanently requiring a
person would misstate recovery; omitting any session-refresh reason would leave
an unresolved expiry as a generic failure.

Options considered: rewrite the original receipt as successful; treat every
pending receipt as a permanent owner action; leave expiry generic; or derive
current waiting state from the existing failed receipt and newest registered
fetch. The last option is selected. Receipts and raw evidence remain immutable.

Decision. Only V Point's `reauthentication_pending` and
`human_required_session_refresh` receipt codes are a current session-refresh
action while unresolved. A registered successful newest fetch clears that
current action only when its completion is strictly later than the actual
failed occurrence's finish time, falling back to its start. Nominal time does
not establish recovery. Equal, invalid or absent times and partial/failed later
fetches leave recovery unresolved. The scheduled receipt, its failure code and
failed acquisition reasons remain in the read after recovery. V Point Pay and
unrelated authentication codes retain their existing interpretation.

The cell and account readers reuse the existing bounded schedule-quality SQL
for V Point so they have the same actual failure anchor as the summary. They
refuse more than 200 configured jobs rather than silently truncating that read.
Other sources keep their source-keyed waiting-state query. SQL text, authority,
credential flow and provider behavior are unchanged.

Consequences. The UI/MCP wire contract's existing `user_action_required` reason
exposes the owner's existing session-refresh option during unresolved recovery.
The automatic email flow remains the first path, and this reason does not prove
a person must intervene immediately. A later registered success clears current
waiting state without hiding the failed attempt. A successful but unregistered
terminal alone cannot establish recovery in this read.

Verification. Synthetic SQLite tests exercise actual-time versus nominal-time
ordering, equal and missing/invalid anchors, failed/partial later runs, a newer
failure after yesterday's success, source isolation, summary/cell/account
agreement and the shared job bound. Native collector tests exercise expired
read, challenge, email and successful separate persistence while retaining the
original failed terminal. The [dated source note](../sources/v-point.md#2026-11-11-scheduled-session-refusal-and-automatic-email-recovery)
records production evidence and the unproven scheduled-success acceptance.

## Amendment 2026-11-19: a status view, one line per configured job

- Status: proposed (until this amendment's PR merges)
- Date: 2026-11-19
- Issue: [#1414](https://github.com/risu729/kogane/issues/1414) ("which sources
  are failing, and is anything stuck?" in one or two calls, each under 8 KB),
  with the owner's recovered rule from #1301 in its comment of 2026-11-19, and
  the owner's reviewed design "proposal v2", Unit B.
- Builds on: [ADR 0081](0081-ui-parity-through-mcp.md) (one reader for the
  page and its MCP read), [ADR 0088](0088-collection-quality-per-account.md)
  (`view` on this tool), and this ADR's
  [V Point amendment](#amendment-v-point-recovery-is-current-state-while-failed-receipts-remain-history-2026-11-11).
- Owner approval: required before merge. It changes the published input
  schema and description of `kogane.collection-quality.read` (a new `view`
  value) and adds a query to its route: decision D3 of proposal v2. No
  catalogue operation, capability, grant, table or migration is added.

### Context

To tell whether collection is stuck, a client read `kogane.schedules.read`
(about 95 KB) for each job's newest receipt and combined it with that job's
occurrences and runs by hand. The collection quality summary carries only the
newest receipt, and the cells, which say which datasets stopped publishing,
are over 200 KB for Vpass. Vpass's finalized statements stopped publishing
for more than two months while every receipt read `completed`, and V Point's
daily `reauthentication_pending` receipt, which its email follow-up run
recovers about 20 seconds later, read as a failure.

### Options considered

1. **A new tool and catalogue operation (`kogane.collection.status`).** First
   drafted for this issue, then rejected in proposal v2's review: a second
   catalogue entry, audit label and listing for an answer composed from this
   tool's own reads.
2. **Relay the Processor's schedule store**, as `kogane.schedules.read` does.
   Rejected: the Processor's snapshot is the large answer this replaces, and
   the receipts and runs are in CORE already.
3. **A `status` view of this tool and its summary route (chosen).**

### Decision

1. **Route and tool.** `GET /api/collection-quality?view=status` (that query
   exactly; any other query on the summary path stays `400 invalid_query`) and
   `kogane.collection-quality.read` with `{ view: "status" }` (no `source`, no
   `offset`; either is `400 invalid_request` with its ref) call
   `readCollectionQuality`, which calls `queryCollectionQualityStatus`
   (`packages/application/src/query/collection-quality-status.ts`). Same
   Access gate, reader grant, `evidence.read` over the whole store, store
   feature and audit label as the summary; the audit record counts the job
   lines.
2. **Reads**, all in CORE, never the Processor:
   - every configured job through the unchanged `SCHEDULE_QUALITY_SQL`;
   - `STATUS_OCCURRENCES_SQL`: the newest 101 receipts of each job
     (`STATUS_OCCURRENCE_WINDOW` 100, plus one that only says more exist),
     through `UNIQUE(schedule_id, nominal_at)`: an `OFFSET 100` on that index
     finds the window's edge and the window is a range of it;
   - `STATUS_RUNS_SQL`: the newest 100 visible fetch runs of each CORE source
     a collecting job names (`STATUS_RUN_WINDOW`), through
     `idx_fetch_runs_source`, with whether each succeeded
     (`successfulFetchRuns`, the predicate the summary's V Point recovery
     reads);
   - the unchanged `CELL_QUALITY_SQL` of each CORE source an enabled
     collecting job names, page by page and mapped by the cell page's own
     `cell()`, so its reasons are the cell page's; more than 2,000 cells (the
     account view's bound) is `413 result_limit_exceeded`, never cut.

   Row bound: at most 200 configured jobs (`COLLECTION_QUALITY_ROW_BOUND`,
   refused past it), so at most 101 receipts per job, 100 runs per source and
   2,000 cells per source are read. Query bound: three queries plus one cell
   page (500 cells) per 500 cells of each source read, at most five pages a
   source before the refusal; the sources are those of
   `COLLECTOR_SOURCE_IDS` (16 CORE sources), so the read runs at most 83
   queries, under D1's 1,000 queries per Worker invocation. Each cell page is
   the query the cell page itself runs for that source and offset.

3. **Answer** (`COLLECTION_STATUS_API_VERSION` 1, wire check
   `validCollectionStatus`): `{ apiVersion, view: "status", asOf, sources }`,
   one line per configured job in id order:
   - `job`, `source` (the job's source in the alarm-job vocabulary; null for
     the Processor tick), `enabled`. Proposal v2 named the line by `source`
     alone; `job` is added because two configured jobs share a source
     (`sbi-vc-trade`) and the Processor tick has none;
   - `lastRun`: the newest receipt's `at` (its actual start), `status`,
     `failureCode` when it has one, and `recovered: { at, by: "fetch_run" }`
     when the rule below recovered it; null when the job has no receipt;
   - `lastSuccessAt`: the newer of the newest completed receipt in the window
     (its finish, else its start) and the newest successful fetch run of the
     job's source in the run window; null when the read holds neither;
   - `failuresSinceSuccess`: the failed receipts (`failed`, `uncertain`,
     `not_dispatched`; a `started` one is skipped) newer than the newest
     receipt that completed or was recovered, read from the newest 101 (the
     edge receipt included, so a running newest receipt does not turn an
     exact count of 100 or fewer into `"100+"`); when none of those is a
     success and the job holds more than 100, `"100+"` (at least 100);
   - `failureCode`: the newest counted failure's code (`unclassified` when it
     stored none), null when nothing is counted;
   - `state`, closed, the first that holds: `disabled` (the job is not
     enabled); `needs-owner` (the newest counted failure's code is one of the
     `user_action_required` codes, an unrecovered V Point
     `reauthentication_pending` or `human_required_session_refresh` reading as
     `human_required_session_refresh` as the summary reads it, or a
     not-publishing dataset carries the cell reason `user_action_required`);
     `failing` (any counted failure); `degraded` (a not-publishing dataset's
     `ageDays` is more than 3); `ok`;
   - `notPublishing`: for an enabled collecting job, each dataset of its
     source that some parser names (a cell of it has a parse job or a
     recorded parse) and that has cells whose newest capture has no published
     parse: `dataset`, `units` (distinct unit keys among those cells),
     `newestParsedCapture` (the newest current capture, or newest capture with
     a published parse, among the dataset's cells; null when none),
     `ageDays` (Asia/Tokyo civil days from it, or, when it is null, from the
     oldest of those unpublished captures, to `asOf`) and `reasons` (those
     cells' stored reasons, without `retention_not_assessed` and the identity
     reasons). No new reason code. A disabled job, a keepalive and the
     Processor tick list none, because nothing of theirs is read; the page
     says so for a disabled job.
4. **Recovered rule** (the owner's, #1414): a failed receipt is recovered when
   a visible successful fetch run (`successfulFetchRuns`: `success` with no
   failure) of the job's CORE source completed strictly after the receipt
   finished (its start when it has no finish) and strictly before the next
   receipt of the job started (or at any later time, for the newest receipt).
   The earliest such run is `recovered.at`. A recovered receipt keeps its code
   in `lastRun`, is not counted, and ends the count as a success does. A
   failed or partial run, or one at or before the failure's finish, recovers
   nothing. Nominal times decide nothing. Only collecting jobs (`collection`,
   `manual`, `email`) are recovered by runs; a keepalive or the Processor tick
   only by its own completed receipt.

   The owner's words are "a successful collection of the same source", and
   the summary's V Point recovery (this ADR's V Point amendment,
   `currentSessionFailure`) already reads exactly `successfulFetchRuns`, so
   the view reads the same predicate and both answers of the tool agree.
   Requiring a published parse as well (the first draft of this amendment)
   was rejected in review: V Point's follow-up run (`runCollection` after the
   email code, `services/collector-vpoint/src/worker.ts`) stores
   `balance-info`, `smfg-point` and `history-page-NNNN`, which register
   within seconds through the queue, but their parses publish on a later
   Processor tick (`observation_sweep` runs before `collection_scan`, every
   5 minutes, `docs/processor.md` §2 and §6), so every day the view
   would read `needs-owner` for V Point until that tick, while the summary
   read nothing waiting: the false alarm the owner asked to remove. Whether
   the run's data publishes is reported apart, as `notPublishing`, and turns
   the job `degraded` past 3 days. Proposal v2's "a run that only
   re-authenticates and publishes nothing does not count" holds without a
   publication check: V Point's re-authentication request
   (`ensureEmailChallenge`, then `VPointReauthenticationPendingError`) stores
   nothing and ends `failed`, and the email handler's own run is a V Point
   Pay run (`v-point-pay`), not a `v-point` one.

5. **Page.** The collection quality page shows the view as a table at its
   top (`収集の状況（実行予定ごと）`), from the same route.

### Consequences

- An assistant answers "which sources are failing, is anything stuck?" with
  one call. The synthetic store with all 17 configured jobs, three weeks of
  receipts each and several not-publishing datasets answers in about 4.6 KB
  including the page-read envelope.
- V Point's daily failure followed by its email follow-up reads `ok` with the
  code under `lastRun`; a run of failures reads `failing` with its count; a
  Vpass-style stop of one dataset under completed receipts reads `degraded`
  once its newest parsed capture is more than 3 days old.
- Open limits:
  - a recovery is seen only within the newest 100 runs of the source; an older
    failure that the run window does not reach is counted as unrecovered;
  - run ids follow registration order, so a run registered far out of its
    completion order may fall outside the run window;
  - `lastSuccessAt` is null when neither window holds a success, which says
    nothing about older history;
  - a successful run recovers a failure whether or not its parses have
    published yet; a parse that never publishes shows only under
    `notPublishing` (and `degraded` after 3 days), not as a failure;
  - a dataset no parser names (no parse job, no recorded parse) is never
    listed; a dataset whose newest capture is published with no observation
    (`published_without_observations`, #450) is published, so it is not listed
    either;
  - a keepalive's failure is on its own line, not on the collecting job's.
- Each request runs one cell read per enabled collecting source (12 in
  `config/alarm-jobs.json`), one page per 500 cells, so the view costs about
  as much as reading each of those sources' cell pages once.

### Verification

Synthetic stores only, no production access:

- `packages/application/test/collection-quality-status.test.ts`: every
  configured job listed in order; `ok`, `failing`, `needs-owner` (MyJCB's
  `human_required`, SBI VC's `manual_agreement_required`, an unrecovered V
  Point session, a unit waiting on the owner), `degraded` and `disabled`;
  failed, uncertain and not-dispatched receipts counted and a running one
  skipped; 100, 101 and 140 failures (`100`, `"100+"`), a success inside
  the window bounding the count, a running newest receipt over 99 or
  100 failures (`99`, `"100+"`), and a completed or recovered edge receipt
  under 100 failures (`100`); the recovered rule (recovered and `ok`; daily
  recoveries; no run; a succeeded run whose parse is still pending, or that
  stored nothing, recovers as the summary's V Point recovery reads it; a
  failed run, a partial run, a run at or before the failure's finish do not;
  a success after the next receipt started; an uncertain receipt anchored at
  its start; the earliest qualifying run);
  `lastSuccessAt` as the newer of the two; datasets listed, aged and reasoned,
  a dataset never published aged from its capture, a disabled job's none;
  every answer passes `validCollectionStatus` and the route's path check; all
  17 configured jobs with history stay under 8 KB including the envelope; the
  store is unchanged.
- `packages/read-model/test/collection-quality-status.test.ts`: the windows'
  rows (101 receipts per job, 100 runs per source with their success flag,
  a short history whole) and their plans on a store with a year of receipts
  and runs and no statistics: receipts by `UNIQUE(schedule_id, nominal_at)`
  for the window and its edge, runs by `idx_fetch_runs_source` and each run's
  visibility by key, no full scan but the request's JSON array, no parse or
  observation table.
- `services/app/test/collection-quality-api.test.ts`: the route at
  `?view=status` (every configured job, the wire check, nothing written) and
  its refusals (`?view=cells`, a repeated or extra parameter, Access, POST, a
  store without the scheduling tables).
- `services/app/test/page-read-reports.test.ts`: the route, `/api/agent/v1/*`
  and `/mcp` give one body for `{ view: "status" }`; `source` or `offset` with
  it is `400 invalid_request`; the audit record counts the job lines.
- `apps/web/test/collection-quality.browser.test.ts`: Chromium at 375 px on the
  production build: the table at the top, its failing, ok and disabled lines,
  a dataset waiting for its parse, one status request, no page-wide
  horizontal scroll, and the accessibility audit.
