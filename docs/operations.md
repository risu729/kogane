# Operations: health signals, load budgets, retention and recovery drills

Non-sensitive observability, the D1-oriented load harness, retention classes
and the recovery drills the design review asks for (root review 08 section 2,
architecture addendum 12 sections 5-8). This page says what exists today, what
is a gap, and what is explicitly not decided here.

Nothing on this page carries an amount, an account number, a member id, a token
or a provider URL. Operational monitoring gets ids, routes, safe codes, counts
and durations; the numbers themselves are read through the authorized audit
path.

Operator _actions_ — request a collection, re-register a run, replay a parse,
rebuild the read model, refresh a session, read what happened — are the
operations API: [ops-api.md](ops-api.md). This page is about the signals, the
budgets, the retention classes and the drills.

## 1. Health signals

Root review 08 section 2 asks for coverage of the same subject range from
Layer A through to the read model, not just "no failed jobs".

| Signal (review 08 section 2)                    | Where it is served today                                                                                | Gap                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Latest sealed artifact arrival                  | pipeline `GET /status`: `freshness.latestSealedAtMs`, `freshness.latestSealedArtifactFetchedAtMs`       | -                                                           |
| Eligible / unsupported / oversized reasons      | evidence-browser metadata API (parse health); pipeline safe failure codes on jobs                       | Not aggregated into one "why is there no job" counter       |
| Oldest pending age, per-lane backlog            | pipeline `GET /status`: `lanes.<lane>.{pending,running,done,failed}`, `lanes.<lane>.oldestPendingAgeMs` | -                                                           |
| Parsed Layer B versus sealed identity           | identity audit (`docs/identity-audit.md`)                                                               | Not exposed as a single coverage percentage per source      |
| Candidate versus active                         | `published_parse_runs` versus successful `parse_runs`; `GET /publication/consistency`                   | Candidate releases themselves are the next step (A04)       |
| Latest complete snapshot                        | complete-snapshot projection used by every reader                                                       | Not surfaced as a freshness signal on `/status`             |
| Raw integrity verification result               | raw-evidence verification tables                                                                        | Not summarised on `/status`                                 |
| Notification backlog                            | pipeline `GET /status`: `workItems.unprocessed`, `workItems.oldestUnprocessedAgeMs`                     | -                                                           |
| Unregistered shared-R2 terminals                | Processor `GET /internal/health`: `registration.unregistered`, `.pending`, `.oldestPendingAgeMs`        | Not summarised on `/status`                                 |
| Operations per invocation vs. documented limits | Processor `invocation_budget` log line per cron and queue invocation (§1.1)                             | Workers Logs only; not persisted                            |
| Lane liveness and replay progress               | pipeline `GET /status`: `laneState[]`, `replayPlans[]`                                                  | -                                                           |
| Event-lane ticks and their counts               | pipeline `GET /status` and `GET /internal/health`: `laneTicks[]`; `processor_lane_ticks` (last day)     | The latest tick per lane only; older ticks are read from D1 |
| Report generation                               | `report_job` scheduled stage log line (only while `REPORTS_ENABLED` is on)                              | Not on `/status`; add when the flag becomes the default     |

Addendum 12 section 5 also asks the operational metrics to separate freshness,
coverage, resolution, publication and safety. Today `/status` covers freshness,
publication and lane backlog; resolution (unresolved identities, missing rules
or prices) and safety (authorization refusals, stale approvals, idempotency
conflicts, refused exports) are counted in their own subsystems and are not yet
one dashboard. Showing an old value and reporting that collection is stale are
two different statements and must both be visible.

### 1.1 Invocation budget probe (issue #87)

Cloudflare documents per-invocation limits the collection path is written
against: 32 Worker invocations per request through Service Bindings, 1,000 D1
queries per Worker invocation and 10,000 subrequests per invocation (Workers
Paid). Registration is bounded below them by an operation budget
([processor.md §3.3](processor.md#33-operation-budget-and-staged-registration-issue-87)),
and the deployed Processor measures what it actually does, so the documented
numbers and the runtime can be compared rather than assumed.

Every cron and queue invocation of the Processor runs its bindings through a
meter and ends with one log line, however the invocation ends:

```json
{
  "event": "invocation_budget",
  "trigger": "scheduled",
  "d1Statements": 412,
  "d1Batches": 9,
  "r2Operations": 31,
  "registration": {
    "budget": 500,
    "operations": 0,
    "d1Statements": 0,
    "r2Operations": 0,
    "started": 0,
    "yielded": 0,
    "deferred": 0
  },
  "limitErrors": 0,
  "documented": {
    "workerInvocationsPerRequest": 32,
    "d1QueriesPerInvocation": 1000,
    "subrequestsPerInvocation": 10000
  },
  "overDocumentedD1Queries": false,
  "overDocumentedSubrequests": false
}
```

(The numbers above are illustrative.) The line carries counts, booleans and
the documented constants only — never a key, a statement, an identifier or an
exception message. `d1Statements` counts every statement of a batch, the
conservative reading of D1's "queries per Worker invocation"; `d1Batches` says
how many batches there were for the lenient one. `registration` is the share
spent by terminal registration, which never exceeds its budget.
`limitErrors` counts lane or message failures whose error text named a
platform limit ("Too many API requests by single worker invocation", "Too many
subrequests", "Subrequest depth limit"); the failing lane's own line then
carries `"limit": true` and still only its safe code.

How to read it, in Workers Logs for `kogane-observation-pipeline`, filtered on
`event = invocation_budget`:

- `overDocumentedD1Queries: true` on an invocation that did not fail is the
  runtime saying the documented D1 number is not what was enforced for that
  invocation. It is recorded, not acted on: the registration budget stays a
  fraction of the documented limit either way.
- `limitErrors > 0` is an invocation the platform refused at a limit. The
  failing lane's own line says where it was hit. Registration's own share
  never exceeds its budget, so a limit reached during registration means the
  invocation's other lanes had already spent the rest.
- A queue line with `registration.deferred > 0` is a batch whose later
  messages were retried because the first ones spent the budget; the
  registrations themselves are in the `collection_notification` lines.

The Processor's `fetch` routes (the App's service-binding calls) are not
metered: registration does not run there. The Processor declares no Service
Binding, so none of its invocations calls another Worker;
`scripts/service-binding-chain.test.ts` pins the longest chain in the account
at two (App → Processor).

The persisted side is on the health route. The Processor's `/internal/health`,
which the App relays at `GET /api/ops/v1/health`
([ops-api.md](ops-api.md#get-apiopsv1health--the-release-postchecks-route)),
carries `registration`: the enforced `operationBudget`, the `documented`
limits, and the backlog read from CORE — `unregistered` terminals,
`pending` staged registrations waiting for their next invocation, and
`oldestPendingAgeMs`. A pending count that stays up, or an age that keeps
growing, is a staged registration that is not converging.

### Lane tick records

**The diagnosis this replaces.** The Processor's event lanes —
`purchase_recognition`, `reconciliation_sweep`, `card_settlement_sweep` — and
the other lanes that keep no state of their own left only a Workers Logs line
per tick. Working out whether `purchase_recognition` had run at all, whether it
failed, or whether its flag was simply off meant searching Workers Logs for
`"event":"purchase_recognition"` and its `_failed` twin, and "no line" could
mean off, not deployed, or killed. Since migration 0049 every tick of those
lanes is a row in `processor_lane_ticks`, kept for one day per lane
([processor.md §6.1](processor.md#61-tick-records) lists the lanes and the
counts each keeps).

**The latest tick per lane** is `laneTicks` in the pipeline's `GET /status`
and in its `GET /internal/health`, which the App relays as `processor` in
`GET /api/ops/v1/health` ([ops-api.md](ops-api.md)):

```sh
mise run //services/processor:ops status
```

```jsonc
{
  "laneTicks": [
    {
      "lane": "purchase_recognition",
      "outcome": "ran", // or "skipped-by-flag", or "failed"
      "errorCode": null, // a safe code when failed: a pipeline code or an error class name
      "startedAt": "2026-09-24T03:05:00.412Z",
      "durationMs": 8412,
      "ageMs": 131000, // since the tick finished
      // abridged here: the lane's whole log line, field for field
      "counts": { "scanned": 500, "recognized": 0, "skipped": { "payment_type_unsupported": 12 } },
    },
  ],
}
```

How to read it:

- `ageMs` well over five minutes means the lane has not ticked since: the cron
  is not firing, or the Worker is dying before this lane (an earlier lane
  running into a limit leaves no row for the lanes after it).
- `skipped-by-flag` means the Worker holds the flag off; compare `flags` in the
  internal health answer.
- `failed` gives the same code as the `<lane>_failed` log line. The row never
  holds the exception text; the log line does not either.
- `counts` are the lane's own counts, field for field; for
  `purchase_recognition` it is the whole log line. They are counts, flags and
  closed reason codes only — never an amount, key, account label or provider
  text.

**The last day of one lane**, newest first, straight from CORE (read-only):

```sh
cd services/processor
./node_modules/.bin/wrangler d1 execute kogane-raw-evidence --remote --command \
  "SELECT datetime(started_at_ms/1000,'unixepoch') AS started, finished_at_ms-started_at_ms AS ms,
          outcome, error_code, counts_json
     FROM processor_lane_ticks WHERE lane='purchase_recognition' ORDER BY id DESC LIMIT 24"
```

`SELECT lane, outcome, count(*) FROM processor_lane_ticks GROUP BY lane, outcome`
summarises the day. A row that could not be written is itself logged as
`lane_tick_record_failed` with a code, and never changes what the lane did.

## 2. Load budgets and the D1 harness

The review's design load is a shape, not a forecast:

```text
40 fetch units x 200 observations/day x 365 days x 5 years = 14,600,000 rows
```

`scripts/load-fixture.ts` generates that shape at any size from a seed — made-up
accounts, made-up amounts, nothing copied from `data/`. Run it alone to print
the shape and its checksum:

```sh
bun run scripts/load-fixture.ts
KOGANE_LOAD_DAYS=30 KOGANE_LOAD_UNITS=8 bun run scripts/load-fixture.ts
```

`services/app/test/load.test.ts` measures the reader with it. It is
opt-in, because building the fixture through the real ingest path is slow and
the numbers only mean something when the shape was chosen deliberately:

```sh
cd services/app
KOGANE_LOAD=1 KOGANE_LOAD_DAYS=8 KOGANE_LOAD_UNITS=4 KOGANE_LOAD_OBSERVATIONS=5 \
  bunx vitest run test/load.test.ts --silent=false
```

Without `KOGANE_LOAD=1` the measurement is skipped and only the budget
definitions are checked, so a normal `vitest run` stays fast. `--silent=false`
is what prints the measurement; vitest hides stdout of passing tests.

For each screen (`list`, `latest`, `history`) it records SQL statement count,
rows read (D1 `meta.rows_read`), payload bytes and wall-time p95, at one size
and at four times the history.

| Budget                     | Value                               | Enforced                                         |
| -------------------------- | ----------------------------------- | ------------------------------------------------ |
| SQL statements per screen  | 12                                  | yes                                              |
| Payload bytes per screen   | 1,500,000                           | yes                                              |
| p95 wall time              | 5,000 ms                            | yes (local Miniflare, not a latency measurement) |
| Rows-read growth factor    | ≤ 1.0 × data growth (1.2 tolerance) | yes                                              |
| Design target growth ratio | ≤ 1.5 regardless of data growth     | **no — recorded only**                           |

The last row is the gap. Addendum 12 section 7's pass criterion is that one
screen's query volume is _not proportional to all history_; the current reader
pages by offset over the whole visible set, so rows read grow roughly linearly.
A local run at 40 → 160 observations measured `list` rows read growing about
3.6x for 4x the data, and the harness reports `designTargetMet: false`. That is
finding AR18, measured rather than asserted away. The published balance
projection (A07, migration 0030) is the change that would let the design target
become an assertion; nothing here concludes that D1 is the wrong database.

## 3. Retention classes

Seeded by migration `0034_reports.sql` into `retention_classes`. "Immutable
evidence" is not a promise of unconditional permanent storage of everything, and
it is not a licence to delete on a whim (finding AR17).

| Class                | What it holds                                          | Normal correction    | Effect of removal on replay                            |
| -------------------- | ------------------------------------------------------ | -------------------- | ------------------------------------------------------ |
| `secret-session`     | Credentials, cookies, session and passkey material     | Never retained       | Collection cannot be replayed from stored bytes        |
| `financial-evidence` | Sanitized provider evidence claims are derived from    | Never deletes        | Downgrades affected runs to `restricted`/`unavailable` |
| `reference-evidence` | Product catalogues, rule packages, conversion terms    | New version          | Old versions must survive for old contexts             |
| `decision`           | Human and adopted judgements, approvals, audit history | Supersede, not erase | Unrecoverable by replay                                |
| `report`             | Fixed report artifacts, their bodies and event history | New report           | `artifact-preserved` even when inputs are gone         |
| `cache`              | Rebuildable projections and derived read models        | Rebuild              | None                                                   |
| `log`                | Non-sensitive operational logs                         | Bounded window       | None                                                   |

**What is not decided here.** Every seeded policy carries
`"legalObligation": "undecided"`. The concrete retention periods, the deletion
obligations and the question of which records must be kept and for how long
depend on the applicable contracts and law, and this repository does not decide
them. What the schema does guarantee is that a deletion, key destruction or use
prohibition is recorded in `evidence_use_restrictions` with its actor, reason
and affected manifests, so the consequences can be audited instead of silently
losing reproducibility.

## 4. Recovery drills

Addendum 12 section 8 asks these to be exercised separately, because they fail
differently. A whole-database point-in-time restore is **not** a normal
application rollback: it discards collection and decisions made since that
point.

| Drill                               | Setup                                                                       | What must hold                                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raw store only                      | R2 objects survive, D1 catalogue lost                                       | Objects are content-addressed, so they can be re-catalogued; but runs, seals, decisions and reports are not rebuildable from bytes.                                                                                |
| D1 only                             | D1 survives, R2 objects unreachable                                         | Catalogue rows stay readable; raw download and re-parse fail loudly (`raw_object_missing`), never silently return an old parse as fresh.                                                                           |
| Outbox unsent                       | Decision accepted, downstream notification not delivered                    | The dispatcher re-sends; the decision itself is not applied twice (idempotency receipt).                                                                                                                           |
| Corrupted publication root          | `published_parse_runs` inconsistent with `parse_runs`                       | `GET /publication/consistency` lists it; `POST /publication/repair` is bounded, idempotent, records its actor.                                                                                                     |
| Stale worker finishing late         | An old lease-holder completes after its lease expired                       | Fencing rejects the late publish; the result stays an unadopted candidate.                                                                                                                                         |
| Restore after evidence restriction  | A restriction is recorded, then an older backup is restored                 | The restriction must be re-applied before serving: `purgeRestrictedExplanations()` re-purges cached explanation nodes and re-downgrades the affected runs. Current authorization outranks a restored past context. |
| Terminal written, notification lost | A run persists into the shared DATA bucket, the Queue message never arrives | The `collection_scan` lane finds the run on a later tick and registers it with no provider call and no write to the bucket (U08, G1-04). The queue is a wake-up, never the record.                                 |
| Notification delivered twice        | The same terminal is delivered again after it was registered                | One fetch run, one seal, one completed `registered` stage. The notification id is never the idempotency key; the run identity and terminal digest are (G1-05, G1-11).                                              |
| Poisonous terminal                  | One run's terminal is corrupt or names an object that is gone               | That run alone is blocked with its reason code and the rest of the page registers; no seal, and no `registered` stage claims completion (G1-13, G1-14). A block is write-once, so it is never quietly relabelled.  |
| Page of refused terminals           | More than five terminals on one scan page are blocked or refused retryable  | Each is judged once; afterwards it is answered from its row without spending a registration, so the page finishes and the cursor moves on (ADR 0024). A retryable run is tried again at most once per 24 hours.    |

The last drill is the one most easily got wrong: restoring a backup taken before
a use prohibition would otherwise resurrect cached explanations of evidence that
may no longer be used.

Two operational rules come with the shared-R2 lanes (plan 15 §2). A budget that
runs out yields with progress recorded rather than failing or looping: a
registration that reaches the invocation's operation budget stays unsealed and
is continued on the next scan tick, and a scan page that spends its
registration budget leaves its cursor put. Reading `collection_scan_state`
(or `collectionScan` on the health route): `pages_completed` and
`cycles_completed` count finished pages and walks, not ticks, and
`last_scan_at_ms` says when a tick last ran. A `last_scan_at_ms` that keeps
moving while `pages_completed` does not is a page the scan keeps listing
again; before ADR 0024 such a tick on the first page also counted a cycle. And a request the operations API accepted is never completed by having
been handed over — a queued replay, a projection scheduled for the next tick
and a collector call that does not exist yet all stay short of `completed`
(`docs/processor.md` §7, `contracts/stages.json`).

Migration order for anything in this area stays: additive tables and contracts →
dual-read comparison → candidate verification → adoption → old path retired.
A cleanup must not delete the versions that a preserved report or the current
financial view still needs.

## 5. Releases and rollback

Deployment is automated from `main` with no preview or staging lane. The release
order, the interlock that stops a late run from overwriting a newer release, the
schema-compatibility rule a rollback must satisfy, and the per-case rollback
table are in [CI/CD automation](ci-cd.md#continuous-deployment);
`infra/deploy-order.json` is the ledger it works from.

Merging is not enabling. Every feature the change programme added is behind a
flag that is off in the configuration that ships, and
[Rollout](rollout.md) is the single table of those flags: owner Worker, default,
what turning each one on changes, the resources it needs first, the order they
go on in, how each comes back off, and the one-time GitHub and Cloudflare
settings the owner has to create by hand. Retiring what a flag replaced is the
separate, later decision in
[Legacy path retirement](legacy-retirement.md), which is a checklist of evidence
rather than a set of steps to run.

Two things on this page are the ones a rollback cannot undo: an applied
migration and a recovery drill. A code rollback re-deploys a Worker; it never
restores CORE or R2, and a whole-database restore stays the separate incident
described in section 4.
