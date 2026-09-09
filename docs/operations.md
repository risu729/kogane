# Operations: health signals, load budgets, retention and recovery drills

Non-sensitive observability, the D1-oriented load harness, retention classes
and the recovery drills the design review asks for (root review 08 section 2,
architecture addendum 12 sections 5-8). This page says what exists today, what
is a gap, and what is explicitly not decided here.

Nothing on this page carries an amount, an account number, a member id, a token
or a provider URL. Operational monitoring gets ids, routes, safe codes, counts
and durations; the numbers themselves are read through the authorized audit
path.

## 1. Health signals

Root review 08 section 2 asks for coverage of the same subject range from
Layer A through to the read model, not just "no failed jobs".

| Signal (review 08 section 2)               | Where it is served today                                                                                | Gap                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Latest sealed artifact arrival             | pipeline `GET /status`: `freshness.latestSealedAtMs`, `freshness.latestSealedArtifactFetchedAtMs`       | -                                                       |
| Eligible / unsupported / oversized reasons | evidence-browser metadata API (parse health); pipeline safe failure codes on jobs                       | Not aggregated into one "why is there no job" counter   |
| Oldest pending age, per-lane backlog       | pipeline `GET /status`: `lanes.<lane>.{pending,running,done,failed}`, `lanes.<lane>.oldestPendingAgeMs` | -                                                       |
| Parsed Layer B versus sealed identity      | identity audit (`docs/identity-audit.md`)                                                               | Not exposed as a single coverage percentage per source  |
| Candidate versus active                    | `published_parse_runs` versus successful `parse_runs`; `GET /publication/consistency`                   | Candidate releases themselves are the next step (A04)   |
| Latest complete snapshot                   | complete-snapshot projection used by every reader                                                       | Not surfaced as a freshness signal on `/status`         |
| Raw integrity verification result          | raw-evidence verification tables                                                                        | Not summarised on `/status`                             |
| Notification backlog                       | pipeline `GET /status`: `workItems.unprocessed`, `workItems.oldestUnprocessedAgeMs`                     | -                                                       |
| Lane liveness and replay progress          | pipeline `GET /status`: `laneState[]`, `replayPlans[]`                                                  | -                                                       |
| Report generation                          | `report_job` scheduled stage log line (only while `REPORTS_ENABLED` is on)                              | Not on `/status`; add when the flag becomes the default |

Addendum 12 section 5 also asks the operational metrics to separate freshness,
coverage, resolution, publication and safety. Today `/status` covers freshness,
publication and lane backlog; resolution (unresolved identities, missing rules
or prices) and safety (authorization refusals, stale approvals, idempotency
conflicts, refused exports) are counted in their own subsystems and are not yet
one dashboard. Showing an old value and reporting that collection is stale are
two different statements and must both be visible.

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

`services/evidence-browser/test/load.test.ts` measures the reader with it. It is
opt-in, because building the fixture through the real ingest path is slow and
the numbers only mean something when the shape was chosen deliberately:

```sh
cd services/evidence-browser
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

| Drill                              | Setup                                                       | What must hold                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raw store only                     | R2 objects survive, D1 catalogue lost                       | Objects are content-addressed, so they can be re-catalogued; but runs, seals, decisions and reports are not rebuildable from bytes.                                                                                |
| D1 only                            | D1 survives, R2 objects unreachable                         | Catalogue rows stay readable; raw download and re-parse fail loudly (`raw_object_missing`), never silently return an old parse as fresh.                                                                           |
| Outbox unsent                      | Decision accepted, downstream notification not delivered    | The dispatcher re-sends; the decision itself is not applied twice (idempotency receipt).                                                                                                                           |
| Corrupted publication root         | `published_parse_runs` inconsistent with `parse_runs`       | `GET /publication/consistency` lists it; `POST /publication/repair` is bounded, idempotent, records its actor.                                                                                                     |
| Stale worker finishing late        | An old lease-holder completes after its lease expired       | Fencing rejects the late publish; the result stays an unadopted candidate.                                                                                                                                         |
| Restore after evidence restriction | A restriction is recorded, then an older backup is restored | The restriction must be re-applied before serving: `purgeRestrictedExplanations()` re-purges cached explanation nodes and re-downgrades the affected runs. Current authorization outranks a restored past context. |

The last drill is the one most easily got wrong: restoring a backup taken before
a use prohibition would otherwise resurrect cached explanations of evidence that
may no longer be used.

Migration order for anything in this area stays: additive tables and contracts →
dual-read comparison → candidate verification → adoption → old path retired.
A cleanup must not delete the versions that a preserved report or the current
financial view still needs.
