# Release adoption: versioned metadata, candidate results, comparison and rollback

Design-review findings D02 and D03 (PR-06 / PR-08, addendum A04), steps 4 and 5
of the migration order the review calls "the most dangerous trap". Migration
0026 separated "this parse succeeded" from "normal reads use this parse"
(`docs/publication-gate.md`). This change separates the third fact - **which
release** a normal read uses - and makes the metadata a parser sees a versioned
transform rather than a value stored once and never correctable.

Everything here is off by default: with `RELEASE_CANDIDATES_ENABLED` absent no
candidate run is written, the command routes are not routed, and the pipeline
behaves exactly as it did before. Verified locally with synthetic data only; no
production claim is made.

## Four concepts, and where each lives

| Concept               | Question                                           | Where it lives                                                                                        |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Execution attempt     | Did the parser run; where did it fail?             | `parse_runs`, `observation_parse_jobs`. Append-only once terminal.                                    |
| Transformation result | What did this input and this transform produce?    | The `parse_runs` row, its observations, issues and coverage claims, and its `parse_input_references`. |
| Adopted release       | Which transform do normal reads use for a dataset? | `active_releases` (mutable pointer) plus `published_parse_runs` per artifact; history in the events.  |
| Read snapshot         | Which evidence did one report actually use?        | Unchanged: the complete-snapshot CTEs over published runs.                                            |

A release is **not** `parser.version`. It is a `TransformManifest`
(`packages/domain/src/context.ts`): transformer id, semantic version, code
digest, input and output contract versions, metadata extractor release and the
digests of the modules the parser depends on. The release id is
`<parser>-<version>-<first 16 hex of the manifest digest>`, which is also a
valid `observation_parse_jobs.target_release` value.

## Transform manifest and input fingerprint

`packages/parsers/scripts/parser-digests.ts` hashes each parser's own
module plus every local module it transitively imports (shared helpers, the
parser types, the domain coverage contract) and writes
`src/parsers/digests.ts`, which the registry re-exports. The range is
deliberately narrower than a repository commit: a UI change must not invalidate
every historical parse, a change to `src/parsers/util.ts` must. Regenerate with
`bun run scripts/parser-digests.ts` from `packages/parsers` after a
deliberate parser change; the generator refuses to record a changed digest for
an unchanged version, and `test/parser-digests.test.ts` fails when the
checked-in file no longer matches the sources or a recorded version disagrees
with the registry.

The recorded source paths are the ones these modules had inside
`poc/observation-pipeline` before design review D07 moved them, because the
digest covers paths as well as contents and a stored `code_digest` must not
change when a file is only relocated. See
[package layout](package-layout.md).

`services/observation-pipeline/src/releases.ts` turns a deployed parser and a
metadata extractor release into that manifest, its digest and a release id, and
computes

```text
input_fingerprint = H(raw sha256, parser-visible metadata, transform manifest digest)
```

"Parser-visible metadata" is everything in `ArtifactMeta` a parser may read
except the row id and the raw digest (which is a fingerprint input of its own):
source, dataset, artifact and unit keys, fetch time, media type, statement state
and period, the run outcome and window, and `unitScopeEligibility` - the D13
policy that can admit an artifact whose parent run was not a clean success, and
which a parser's own precondition reads.

using the versioned canonical encoding `canonical-json-v1`. Every new parse run
(candidate or not, successful or not) gets one `parse_input_references` row with
its projection, its release and its fingerprint. That is what makes a later
comparison possible at all, which is why it is recorded even with the flag off.

Deployment guard: `parser_releases` has a trigger that refuses the same
`(parser_name, semantic_version)` with a different `code_digest`. Registration
happens during maintenance and before every parse, so a build that changed a
parser without changing its version fails loudly instead of writing results
nobody can identify.

**From the first deployment of 0028 onward, changing a parser or a shared
module it imports requires a version bump.** Before that point the rule is only
a CI one, which is why the digests recorded here were regenerated when PR-14
(unit-scoped eligibility) changed eleven parser modules and `util.ts` without
touching a version: no store had registered a release yet, so no history was
contradicted. Once a store has registered them, the same edit would abort every
parse of that parser with `parser_release_conflict` until the version changes -
which is the intended behaviour, not a regression.

## Metadata as a versioned transform (D02)

`observation_artifact_metadata` is keyed by artifact alone and is append-only,
so the first extraction of a statement state or period fixed the parser's input
forever. For MyJCB that is not merely misleading: the parser requires its
metadata to agree with the document, so a wrong stored value makes every later
parse of that artifact fail, and no version bump can fix it.

Extraction is now a release (`src/metadata-extractors/`):

| Release                | Behaviour                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy-metadata-v1`   | Exactly the pre-A04 `hydrateMeta`: a stored MyJCB value wins over the manifest, the Sony Bank wallet-history media type is verified on every run, `observation_artifact_metadata` still receives the same `INSERT OR IGNORE`. Records its projection with `input_digest = 'unknown'`. The default for every dataset without an `active_releases` row. |
| `manifest-metadata-v2` | Re-reads the collector manifest every time, records the exact input evidence and a real input digest, and never writes `observation_artifact_metadata`.                                                                                                                                                                                               |

`metadata_projections` (migration 0027) is append-only and keyed by
`(fetch_artifact_id, extractor_release, input_digest)`: reading the same
evidence with a new extractor adds a row and leaves the old one, and the parse
runs that used the old one keep pointing at it through
`parse_input_references.metadata_projection_id`. `status` distinguishes `ok`
(a value was produced), `absent` (the inputs say there is none) and `error`
(the extraction could not complete) - the presence of the row is what separates
"there is no value" from "no extraction was attempted".

`input_digest` and `output_digest` are the literal string `unknown` for the
rows migration 0027 backfills: the inputs and code digest of the historical
extraction are not recorded anywhere, SQLite cannot compute SHA-256, and
today's digest is never substituted as evidence of a past run. A projection the
Worker writes later for the same artifact under the same release is
byte-identical to the backfilled one, because `legacy-metadata-v1` records
exactly the two fields the legacy table holds (`period`, `statementState`).

Operations:

| Route                                       | Effect                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /metadata/reextract`                  | `{ source, dataset?, extractorRelease, artifactIdFrom?, limit? }` (default 100, max 500). Runs the extractor over a bounded page and appends projections. It never skips because a value already exists. Returns `examined/ok/absent/errors/cursor/complete`. Flag-gated. |
| `GET /metadata/differences?release=&limit=` | Artifacts whose newest projection under `release` disagrees with the legacy one: `artifactId` and **changed field names only**. No statement state, period or any other provider value leaves this route. Always available.                                               |

## Candidate lane

A replay plan may aim its jobs at a registered release
(`observation_replay_plans.target_release`, migration 0035). A parse is a
candidate when the flag is on, the job carries a `target_release` that names a
registered release of this parser and version, and that release is not the
dataset's active one. Then:

- the run is written exactly like any other parse - observations, issues,
  coverage claims, decimal projections and `parse_input_references` all as
  usual;
- it is closed by `candidateBatch` instead of `publishBatch`: mark the run
  `ok` fenced on the live lease, insert `parse_run_candidates` (state
  `candidate`), close the job. No supersession, no publication event, no
  pointer;
- `publishBatch` excludes candidates from supersession in both directions, so a
  later normal publish cannot turn a candidate into replaced history, and a
  candidate at a higher version cannot supersede the run readers use.

Step 4 of `docs/publication-gate.md` therefore holds: every normal reader
decides "current" by membership in `published_parse_runs`, and a candidate is
never in it. Migration 0028 adds `publication_gate_gaps`, the operational half
of 0026's consistency view: a candidate result, and a run an adoption replaced,
are expected `ok` unsuperseded runs and are not gaps, so `/publication/repair`
can never publish one. `publication_gate_mismatches` keeps its original meaning
and is the audit path where a candidate does show. The gaps view is defined
_over_ the mismatch view rather than restating the legacy rule, so the two can
never drift and the predicate guard's "no migration after 0026 embeds the
legacy rule" test keeps holding.

Migration 0036 (`publication_events_no_self_reference`) admits activation and
rollback events as they are written and needs no companion: an activation
inserts an event only where the currently published run differs from the
candidate, and a rollback restores the run an activation event named as
`previous_parse_run_id`, which 0036 itself guarantees is not that event's own
new run. No `0038` guard was required.

### Unique-key decision, and its limit

The review's final form moves success uniqueness from
`(artifact, parser, version)` to `(input_fingerprint, release)`. That rewrites
`idx_parse_runs_success`, the `already` check and every writer at once, which is
exactly the migration the review warns against combining with the adoption
switch. This change does not take it. Instead:

- a candidate release always carries a **new semantic version**, so its runs
  have a different `(artifact, parser, version)` key and coexist with the
  published run under the existing unique index;
- a re-parse of the same version with different metadata is expressed as a new
  release with a **patch bump**, whose manifest records the metadata extractor
  release it used;
- state is never encoded in `parser_version`; `parse_run_candidates` carries it.

**Limit.** A release that shares its parser version with the published run can
be registered (the same code under a different metadata extractor release is a
different release id) but cannot produce a second successful run for an
artifact that already has one: `executeParseJob`'s `already` check skips it and
the unique index would refuse it. Such a candidate compares as empty. Bump the
patch version to re-parse.

## Comparison

`POST /release/compare { source, dataset, parser, releaseId }` computes and
appends one `release_comparisons` row. Fields of the summary:

| Field             | Meaning                                                                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts`       | How many artifacts of the dataset have a published run, a candidate run, both, or only a candidate.                                                                                                                                                                                                                                    |
| `countsByKind`    | Observation counts per kind on each side.                                                                                                                                                                                                                                                                                              |
| `locators`        | Correspondence on the output contract's comparison key `artifact + kind + raw locator + metric/role`: `matched`, `baseOnly`, `candidateOnly`, `ambiguous`. A key that resolves to more than one observation on either side is **ambiguous**, never silently matched - the review is explicit that a locator alone is not a unique key. |
| `values`          | Exact normalized-value differences over `observation_decimal_values` (`decimal-v1`): how many matched keys were compared, how many differ in status, coefficient or scale, and how many have a value on only one side.                                                                                                                 |
| `coverage`        | Coverage claims per `scope_key` compared on mode, completeness, membership, observed and expected counts, and absence meaning.                                                                                                                                                                                                         |
| `emptyContainers` | Artifacts where one side produced no observation and the other did.                                                                                                                                                                                                                                                                    |
| `sample`          | At most 50 differing keys: artifact id, kind, raw locator, role and the kind of difference.                                                                                                                                                                                                                                            |

The response and the stored summary carry counts, ids and raw locators only. No
amount, description, account label or raw body is ever returned. A comparison is
append-only, so an interrupted comparison leaves either nothing or one complete
summary; re-running it once more candidates exist records a second row.
Comparing marks the candidates `compared`; that changes nothing a reader sees.

## Activate and roll back

```text
register a candidate release
    -> targeted replay writes candidate results (invisible)
    -> compare against what the dataset publishes
    -> POST /release/activate with expectedActiveReleaseId
    -> if wrong: POST /release/rollback with expectedActiveReleaseId
```

`POST /release/activate { source, dataset, parser, releaseId, expectedActiveReleaseId, actor, reason }`
is one D1 batch, atomic per dataset:

1. `active_releases` is upserted, fenced on `expectedActiveReleaseId`;
2. one `publication_events` row of kind `activation` per artifact that has a
   candidate result of that release, naming the run it replaces;
3. `published_parse_runs` is upserted onto the candidate run with
   `publication_kind = 'activation'` and `release_id`;
4. the candidates become `adopted`;
5. one `release_activation_events` row records actor, reason, previous release,
   expected previous and how many pointers the release now holds.

Every statement after the first is fenced on `active_releases` naming the new
release, so a lost race changes nothing. A mismatch on
`expectedActiveReleaseId` returns `409 release_activation_conflict` and writes
nothing. Repeating the call once the release is active returns
`changed: false` and writes nothing.

`POST /release/rollback` takes the same body and restores, for every key in the
dataset, the run its last `activation` event named as `previous_parse_run_id`,
with a `rollback` publication event and a `rollback` activation event. It never
rewrites `superseded_by_parse_run_id`, never updates or deletes a parse run or
an observation, and never removes a projection row.

**Limit.** A key whose activation was its _first_ publication has no previous
run to restore. The pointer cannot be removed (`published_parse_runs` is never
deleted), so it stays and is reported as `retained` in the response. Plan
activations over datasets whose artifacts already have published parses, or
accept that those keys stay on the new release until another release is
activated.

`GET /release/status` (always available) lists registered releases, active
pointers, candidate counts by state, the last 20 comparisons and the last 20
activation events - identifiers and counts only.

## Normal lane after activation

Job creation consults `active_releases`: for an artifact whose
`(source, dataset, parser)` has a pointer, the incremental and repair lanes
create jobs only for the active release's semantic version. If that version is
not in the deployed registry - after a Worker rollback, say - the deployed
registry decides, exactly as before, so a stale pointer never strands the lane
on a version nothing can execute. A dataset with no pointer, and an artifact
whose `dataset` is NULL, are unchanged.

`active_releases.metadata_extractor_release` decides which metadata projection a
normal parse of that dataset reads; a candidate parse uses the extractor release
its own registered release names.

## Deploy order

1. `services/raw-evidence`: apply `0027_metadata_projections.sql`, then
   `0028_parse_releases.sql`. Both are additive; 0028 builds on 0026's tables,
   so it must not be applied before it. The previous Workers keep working.
2. `services/observation-pipeline`: deploy the Worker **with the flag absent**.
   It now registers releases, records metadata projections and input
   fingerprints, and publishes exactly as before.
3. Verify: `GET /publication/consistency` reports `mismatches: 0`, and
   `GET /release/status` lists one release per deployed parser.
4. Only then set `RELEASE_CANDIDATES_ENABLED = "true"` (a `vars` entry in
   `services/observation-pipeline/wrangler.jsonc`, or the dashboard) to enable
   the candidate lane and the command routes.

## Rollback

Two separate runbooks, as the review requires.

- **Pointer rollback** is `POST /release/rollback`: a new adoption event, never
  a database restore and never an edit of Layer A or Layer B.
- **Worker rollback** must target a build that understands the publication
  gate. Once any candidate has been written, rolling back to a build that
  predates migration 0026 is forbidden: its readers use
  `status='ok' AND superseded_by_parse_run_id IS NULL` and would show every
  candidate. A build between 0026 and this change is also unsafe once
  candidates exist, because its publish batch supersedes candidates - which
  turns them into replaced history that the browser's history views do show.
  `services/observation-pipeline/test/release-adoption.test.ts` asserts that
  behaviour rather than assuming it. **Minimum rollback build once
  `RELEASE_CANDIDATES_ENABLED` has ever been "true": this change.** Turning the
  flag back off is safe and is the first step of any incident response; it
  stops new candidates without touching the ones already written.
- Rolling back the migrations is neither needed nor supported: both are
  additive and nothing depends on their absence.

## Invariants kept and how they were verified

| Invariant                                                                                                        | Test                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A candidate never reaches the publication pointer, any reader, or the repair route                               | `observation-pipeline/test/release-adoption.test.ts`, `evidence-browser/test/release-candidates.test.ts` |
| Candidate and adopted run never supersede each other; a late older version is superseded by the adopted run      | `release-adoption.test.ts`                                                                               |
| An expired lease during a candidate write records nothing                                                        | `release-adoption.test.ts`                                                                               |
| An activation conflict changes nothing; a repeat is idempotent                                                   | `release-adoption.test.ts`                                                                               |
| Rollback restores the previous visible row set exactly, with no update to any parse run                          | `release-adoption.test.ts` (full row-set comparison)                                                     |
| Comparison responses carry no financial value                                                                    | `release-adoption.test.ts`                                                                               |
| An empty candidate result and an empty candidate set are results, not errors                                     | `release-adoption.test.ts`                                                                               |
| Same manifest and evidence give the same fingerprint; a different extractor gives another                        | `release-adoption.test.ts`, `metadata-projections.test.ts`                                               |
| An old parse keeps its projection when a re-extraction disagrees; the difference list names fields, never values | `metadata-projections.test.ts`                                                                           |
| With the flag off a targeted job publishes normally, writes no candidate, and the routes 404                     | `metadata-projections.test.ts`                                                                           |
| 0027/0028 apply to a store with existing metadata rows and backfill exactly, idempotently                        | `metadata-projections.test.ts`                                                                           |
| Registering the same parser name and version with a different code digest is refused                             | `release-adoption.test.ts`, `packages/parsers/test/parser-digests.test.ts`                               |
| The digests describe the sources on disk                                                                         | `packages/parsers/test/parser-digests.test.ts`                                                           |
| Normal reads are unchanged                                                                                       | every existing observation-pipeline, evidence-browser and PoC test, unchanged expectations               |

Not verified: production data volumes (the comparison scans the observation
tables of the runs in scope, which is bounded by the dataset, not by the
catalogue), D1 statement limits for an activation over a very large dataset, and
throughput of the candidate lane under the real per-lane budgets.

## Open items

- Success uniqueness on `(input_fingerprint, release)` and the removal of the
  `already` check, which would let one parser version produce several results
  from different metadata projections.
- A candidate lane budget of its own; today candidates run in the replay lane's
  budget.
- Activation across several datasets that form one snapshot: today the unit is
  one `(source, dataset, parser)`, and pages of one snapshot must be activated
  together by the operator.
- Exposing `release_comparisons` in the evidence browser instead of the private
  service-binding route.
