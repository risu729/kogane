# Publication gate: adopted parse results as an explicit projection

Design-review finding D03 (PR-05 / A05), steps 1-3 of the migration order
the review calls "the most dangerous trap": readers decided what is current
from `parse_runs.status = 'ok' AND superseded_by_parse_run_id IS NULL`, so any
successful parse run that superseded nothing became visible the moment it was
written. A shadow or candidate run could never have existed safely. This
change makes adoption an explicit, atomically maintained pointer, moves every
normal reader onto it, and proves that a successful run outside the pointer
is invisible. It does **not** add candidate runs, releases, activation or
fingerprints; those are the next steps and stay off.

Nothing here changes Layer A/B evidence, parser versions, supersession
maintenance, response shapes or the set of rows readers see today. Verified
locally with synthetic data only; no production claim is made.

## Four concepts

| Concept               | Question                                                   | Where it lives after this change                                                                                                                   |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution attempt     | Did the parser run; where did it fail?                     | `parse_runs` (`pending` / `ok` / `error`), `observation_parse_jobs`. Append-only once terminal, as before.                                         |
| Transformation result | What did this input and this parser version produce?       | `parse_runs` row plus its observation rows. Immutable.                                                                                             |
| Adopted release       | Which result do normal reads use for this artifact/parser? | `published_parse_runs` (pointer, mutable through the writer only) with `publication_events` (append-only history). `release_id` is reserved, NULL. |
| Read snapshot         | Which evidence did one report actually use?                | Unchanged: the complete-snapshot CTEs still choose the latest complete capture, now over published runs only.                                      |

Success and adoption are two facts. For the compatibility period they still
coincide for every normal parse, because the writer sets both in one
transaction; but a reader can no longer confuse them.

## Projection contract (migration 0026)

`published_parse_runs` — one row per `(fetch_artifact_id, parser_name)`:

- `parse_run_id` names the adopted run; `parser_version`, `published_at`,
  `publication_kind` (`normal` | `activation` | `rollback`) and `release_id`
  (NULL until the adoption PR) describe the pointer.
- Triggers: a row may only name a run of the same artifact and parser with
  `status = 'ok'` (insert and update); rows are never deleted. A unique index
  on `parse_run_id` means a run is adopted only under its own key.
- Updates happen only through the observation-pipeline writer and the repair
  route below. Nothing else writes it.

`publication_events` — append-only: `fetch_artifact_id`, `parser_name`,
`previous_parse_run_id` (NULL for a first publication), `new_parse_run_id`,
`kind` (`normal` | `activation` | `rollback` | `backfill` | `repair`),
`actor` (`pipeline`, `migration:0026`, or an operator id), `reason`,
`occurred_at`. A trigger requires the new run to be `ok`.

Views:

- `published_observation_parses`: the adopted run of every key with its
  `parse_runs` columns and the pointer fields, for readers that want one join.
- `publication_gate_mismatches`: keys where the projection and the legacy
  predicate disagree — `legacy_only` (an `ok`, unsuperseded run the pointer
  does not name) or `projection_only` (the pointer names a run the legacy
  rule no longer treats as current). Empty whenever every writer maintained
  the projection. Used by `/publication/consistency`, `scripts/status.ts` and
  the tests.

`current_identity_observations` (0018/0020/0022) is re-created with the
projection as its driver; its plan shape (materialised candidates and latest,
keyed lookups) is kept and asserted by `current-run-query-plan.test.ts`.

### Backfill

0026 materialises exactly the legacy current set with one idempotent
`INSERT ... SELECT ... WHERE NOT EXISTS` (highest id wins should two live runs
ever share a key, which the writer prevents; the mismatch view reports the
loser) and records one `backfill` event per row. Why one statement in the
migration rather than a separate script: the selection is an index-supported
scan of `parse_runs` (`idx_parse_runs_success`) producing at most one row per
`(artifact, parser)`, which is bounded by the number of artifacts, and the
same statement is what the repair route runs in bounded pages. If a
production `parse_runs` table is ever too large for one D1 statement, apply
the DDL, skip nothing, and run `POST /publication/repair` repeatedly with
`limit` until `remaining` is 0; the result is identical and the events carry
the operator id instead of `migration:0026`. Verify the count first:

```sql
SELECT count(*) FROM parse_runs WHERE status='ok' AND superseded_by_parse_run_id IS NULL;
```

## Writer

`services/observation-pipeline/src/publication-gate.ts` supplies two
statements that `publishBatch` in `worker.ts` appends to the existing publish
transaction, after the run is marked `ok` and older runs are superseded:
append the event (naming the run it replaces), then upsert the pointer. Both
select the run only if that same batch left it `ok` and unsuperseded, so:

- a run born superseded (a numerically older version completing late) is
  recorded and its rows are queryable as history, but the pointer stays on
  the newer run and no event is written;
- a lost lease (the fenced first statement changes nothing) leaves status
  `pending`, and therefore no pointer move and no event;
- after every publish the legacy predicate equals the projection, which is
  what a reader that predates the gate needs during a mixed deployment.

`superseded_by_parse_run_id` is still maintained exactly as before; it is the
lineage record of the compatibility period, not a publication decision.

The local PoC store has the same tables, triggers and views in `schema.sql`;
`publishParseRun` in `store.ts` reconciles lineage and moves the pointer in one
transaction, and `openStore` backfills an existing store once.

## Readers

Every normal read path now decides "current" by membership in
`published_parse_runs`. The predicate sites, and what each became:

| Site                                                                               | Before                                                     | After                                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/read-model/src/concepts.ts` `publishedParses`                            | `p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'` | `EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id)`              |
| same file, `legacyPublishedParses`                                                 | —                                                          | the old rule, exported only for comparison; no query composes it                                         |
| same file, `recordedParses` (new) used by `visibleEvidence.parseRuns/observations` | `p.status <> 'pending'`                                    | not pending AND (error OR superseded OR published): an unadopted `ok` run is not a visible result at all |
| `packages/read-model/src/sql.ts` `PARSING_HEALTH_SQL`                              | newer `ok` unsuperseded parse repairs a failed job         | newer published parse repairs it                                                                         |
| `poc/observation-pipeline/src/snapshot-query.ts` `complete_parse`                  | `status = 'ok' AND superseded_by_parse_run_id IS NULL`     | `EXISTS (... published_parse_runs ...)`; relation named by `SnapshotRelations.publishedParseRuns`        |
| `poc/observation-pipeline/src/queries.ts` `CURRENT`                                | legacy predicate                                           | projection membership                                                                                    |
| `services/evidence-browser/src/identity-api.ts` `eligible`                         | legacy predicate                                           | join `published_parse_runs`                                                                              |
| `services/evidence-browser/src/observation-organization.ts` `historical`           | `superseded_by_parse_run_id IS NOT NULL`                   | `pub.parse_run_id IS NULL` (LEFT JOIN projection); unadopted, unsuperseded runs are decorated for no one |
| `services/raw-evidence/migrations/0026` `current_identity_observations`            | legacy predicate (0022)                                    | projection-driven, same plan shape                                                                       |
| `services/observation-pipeline/src/identity-store.ts` `identitySweep` ordering     | current-first by `superseded IS NOT NULL`                  | published-first by projection membership (historical runs are still interpreted, as before)              |
| `services/observation-pipeline/src/identity-audit.ts` `eligible`, lineage          | legacy predicate; lineage by supersession                  | projection join; lineage by projection                                                                   |
| `services/observation-pipeline/scripts/status.ts` coverage                         | legacy predicate                                           | projection; plus a `publication` mismatch count                                                          |
| `services/observation-pipeline/scripts/replay-diagnostics.ts`                      | legacy predicate                                           | projection                                                                                               |
| `services/observation-pipeline/scripts/audit-identities.ts` (3 queries)            | legacy predicate                                           | projection                                                                                               |

Not changed on purpose: `services/evidence-browser/test/legacy-read-path.ts`
(the frozen adapter of the PR-04 parity test), the writer's supersession
statements, migrations 0018/0020/0022 (superseded by 0026's view), and the API
contract field `superseded_by_parse_run_id`, which remains the lineage marker
the UI shows.

`scripts/publication-gate-predicates.test.ts` (run by `bun test scripts/`)
fails CI when `superseded_by_parse_run_id IS NULL` appears in any tracked
`.ts`/`.tsx` outside tests and four allowed files: the read model's legacy
concept, `worker.ts` (supersession batch), `publication-gate.ts` (writer and
repair) and the PoC `store.ts` (writer and backfill).

## Candidate invisibility (step 4 preparation)

`services/evidence-browser/test/publication-gate.test.ts` seeds a published
parse, then an `ok` run of the same artifact and parser that is neither
published nor superseded (what a future candidate looks like), plus a later
capture of the same snapshot dataset whose only parse is such a run, plus a
sealed identity interpretation of the candidate. It asserts that the
transaction, balance, position, balance-history, overview, artifact,
artifact-list, observation-detail, filter-option, snapshot-selection, identity
coverage/accounts, `current_identity_observations` and organization paths all
leave it out, and that `publication_gate_mismatches` lists it. Adopting it
through the same pointer move the writer performs flips exactly those paths.

The consistency view treats such a run as `legacy_only`, and the repair route
would publish it. That is correct for the compatibility period, when every
`ok` unsuperseded run is a normal publication that an old writer may have
left without a pointer, and it is why step 4 must introduce a distinct
candidate publication state before any candidate is written.

## Operations

- `GET /publication/consistency` (observation-pipeline, private service
  binding like `/status`): `published`, `legacyOnly`, `projectionOnly`,
  `mismatches` and a bounded `sample` of keys and run ids. No values.
- `POST /publication/repair` `{ actor, reason, limit? }`: publishes at most
  `limit` (default 200, max 1000) legacy-current runs the pointer does not
  name, one `repair` event each with the operator id; returns `repaired` and
  `remaining`. Idempotent; `actor` must match `^[a-z0-9][a-z0-9._:@-]{0,99}$`
  and may not be `pipeline`.
- `scripts/status.ts` prints the mismatch counts next to coverage.

## Deploy order

1. `services/raw-evidence`: apply 0026 (additive; the previous Workers keep
   working, the backfill makes the projection equal to what they show).
2. `services/observation-pipeline`: the writer that maintains the projection.
   Until this is live, new successes are visible to the old reader only; run
   `POST /publication/repair` after deployment to close any gap.
3. `services/evidence-browser`: the reader of the projection.
4. `GET /publication/consistency` must report `mismatches: 0`. If not, repair,
   then look for a writer that predates step 2.

## Rollback

- Today (candidates not enabled): the previous evidence-browser and
  observation-pipeline builds still read and write the legacy rule, and the
  projection is kept consistent by the writer or by repair, so rolling either
  Worker back is safe. Rolling back the migration is not needed and not
  supported: the tables are additive and nothing depends on their absence.
- **Forbidden once candidates are enabled** (a later PR): rolling back to a
  build that does not know the gate, because its readers would show every
  `ok` unsuperseded run, candidates included. The release manifest must
  record this Worker version as the lowest acceptable rollback target from
  that point on; pointer rollback (`publication_kind = 'rollback'` events)
  and Worker rollback are separate runbooks.

## Invariants kept and how they were verified

- Normal reads return what they returned before: the PR-04 parity test
  (`read-model-parity.test.ts`) still compares the frozen legacy adapter with
  the reader on the same fixture, now with the projection maintained the way
  the writer maintains it, and every existing evidence-browser, PoC and
  pipeline test passes with its expectations unchanged.
- Legacy predicate = projection after every publish, late older version does
  not move the pointer, expired lease changes nothing, old writer gap is
  reported and repaired idempotently, 0026 on 0017-0035 with existing rows
  backfills exactly the legacy set and is idempotent:
  `services/observation-pipeline/test/publication-gate.test.ts`,
  `pipeline.test.ts`.
- Projection rows only name `ok` runs of their own key and are never deleted:
  same file (trigger assertions).
- The identity view keeps its query plan: `current-run-query-plan.test.ts`,
  `binding-query-plan.test.ts`.
- No new legacy predicate in production reads:
  `scripts/publication-gate-predicates.test.ts`.

Not verified: production data volumes and D1 statement limits for the
backfill (see the count query above).
