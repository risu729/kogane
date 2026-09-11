# Parser coverage contract (issues, coverage claims, snapshot policies)

Design review findings D01 and D13 (root review `02_parser_and_coverage.md`,
PR-07; addendum A03, SC15, AT61/AT62/AT65). Before this change the current
snapshot of the SBI container datasets was chosen by matching the text of
parser warnings in SQL (`LIKE '% has no exact % minor-unit form; kept as
text'`, `instr(..., ': fields not modelled as metrics were kept only in
extra: ')`). Rewording or translating a warning would have changed which
balances and positions are current. This document describes the replacement:
a machine-readable parser contract, its persistence, the per-dataset policy
table that owns snapshot selection, the shadow comparison that gates the
switch, and the rollback.

Nothing changes on deploy. Every dataset is seeded on the legacy policy; the
new tables are written but not yet read for selection. The evidence-browser
parity test proves the served result set is unchanged.

## Contract v2 (`packages/parsers/src/types.ts`)

```ts
export interface ParseResult {
  observations: Observation[];
  warnings: string[]; // for people; no selection rule reads it
  issues?: ParseIssue[]; // typed: code, locator, severity, impact, message
  coverage?: CoverageClaim[]; // one claim per container scope the parse proves
}
```

`ParseIssue` and `CoverageClaim` are the `packages/domain` types
(`src/coverage.ts`): issue codes `container_unreadable`, `row_unreadable`,
`unknown_fields_preserved`, `exact_decimal_without_minor_units`; severity
`info | warning | error`; impact `none | field | membership | whole-artifact`.
A claim carries `scopeKey`, `mode`, `completeness`, `membershipComplete`,
`observedCount`, `expectedCount`, `evidenceRefs`, `policyVersion`
(`coverage-v1`), `failureCause` and `absenceMeaning`, and every claim a parser
emits satisfies `validCoverageClaim` and has no `coverageClaimViolations`.

Severity and impact are separate on purpose: an unmodelled field is `info`
with impact `none`; a decimal kept as text is `info`/`none`; an unreadable
account container is `error` with impact `membership`; a field of unexpected
type that was preserved verbatim is `warning` with impact `field`. Only
impact decides whether a container is still complete.

A parser that omits `issues` and `coverage` is a **legacy parser**. Its parse
runs store nothing beyond `warnings_json`, and its datasets stay on the legacy
policy. Nothing synthesizes a `complete` claim for a legacy parse, an old
parse, or a parse whose parser has since been converted.

### Helpers (`packages/parsers/src/parsers/coverage.ts`)

- `ParseDiagnostics` collects warnings and issues together. `report(issue)`
  records the typed issue and its message as the warning string;
  `note(issue)` records an issue that has no warning because nothing was lost.
  Locators and messages are cut to the domain validators' bounds in the typed
  record only; the warning keeps the full text.
- `containerScopeKey(artifact)` = `source_id/dataset[/unit=fetch_unit_key]`.
  `containerScopeKeySql(alias)` in `snapshot-query.ts` derives the same key
  from the artifact row, so a claim is matched by contract, not by text
  (`snapshot-policies.test.ts` proves the two agree).
- `containerClaim({ artifact, issues, observedCount, expectedCount?,
evidenceRefs })` builds the `complete-container` claim: complete with
  complete membership when no issue reaches `membership` impact, otherwise
  partial with the first membership-breaking issue code as `failureCause`.

### Converted parsers

The eleven parsers behind `SNAPSHOT_DATASETS` emit contract v2: the two
tolerant SBI parsers (`sbi-foreign-cash-balances`,
`sbi-foreign-cash-positions`), `sbi-domestic-cash-positions`,
`sbi-account-assets-current`, `sbi-vc-position-summary`,
`sbi-vc-cash-balances`, `sbi-vc-account-margin`,
`sbi-shinsei-top-balances-and-activity`, `sbi-shinsei-yen-deposit-account`,
`sony-bank-gross-balance` and `smbc-direct-balance`. The strict parsers
either throw or prove the whole container, so their claim is always complete;
the Sony contract fixes the container at 17 rows (`expectedCount: 17`) and an
empty Sony container is a schema drift, not a complete-empty snapshot.

**Parser versions are unchanged.** The output contract gained fields, but
`fixtures/coverage-contract/expected.json` freezes the observations and
warning strings every synthetic case produced before the change, and
`test/coverage-contract.test.ts` asserts the converted parsers produce them
byte for byte (`JSON.stringify` equality) plus the expected issues and claim.
No warning text was changed. `sbi-vc-cashflows` and `sbi-vc-executions` share
the SBI VC helpers and now collect issues internally, but they are event
feeds, not snapshot datasets, and still return the v1 shape.

## What absence means

| Claim                                                                                 | Rows | Replaces the previous snapshot | Reason (`snapshotEligibility`)              |
| ------------------------------------------------------------------------------------- | ---: | ------------------------------ | ------------------------------------------- |
| `complete-container`, complete, membership complete, `absenceMeaning: complete-empty` |    0 | yes                            | `complete_empty_container`                  |
| `complete-container`, complete, membership complete, rows present                     |  n>0 | yes                            | `complete_container`                        |
| partial (a container or row was unreadable), `not-observed` / `unknown`               |  any | no                             | `partial_membership` / `no_new_observation` |
| completeness `unknown`                                                                |  any | no                             | `coverage_unknown`                          |
| complete but `membershipComplete: false` (numerically exact, page short)              |  any | no                             | `partial_membership`                        |
| claim for another scope, or no claim at all (legacy parser)                           |  any | no                             | not a candidate                             |
| `window` complete with 0 events                                                       |    0 | no (window absence only)       | `window_absence_only`                       |
| a decimal kept as text, an unmodelled field preserved                                 |  n>0 | yes (impact `none`)            | `complete_container`                        |

The two SC15 cases that must never be confused are the first and third rows:
a complete container observed to be empty removes the previous holdings; a
fetch that read zero rows because a page or container was unreadable keeps
them (and shows staleness, which is a display concern outside this PR).

## Persistence (migration `0025_parse_coverage.sql`)

| Table                       | Rows                                                                                                                                                                                  | Mutability                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `parse_issues`              | one per issue: `parse_run_id, code, locator, severity, impact, message`                                                                                                               | append-only (triggers)      |
| `parse_coverage_claims`     | one per claim: the claim fields, `evidence_refs_json`, plus `parent_run_status` and `parent_run_failure_count` recorded from the parent fetch run at parse time                       | append-only (triggers)      |
| `dataset_snapshot_policies` | one per `(parser_name, dataset)`: `source_id, policy_id, policy_version, required_parser_version, replaces_previous_on_complete_empty, unit_scope, snapshot_selection, updated_at_ms` | operational state (mutable) |

The Worker (`services/observation-pipeline/src/worker.ts`) validates the
contract right after `parse` (`contractRows`): an invalid issue or claim, a
duplicate claim id, more than 10,000 issues or 100 claims is
`parse_contract_invalid`, a terminal job failure like `parser_rejected`, and
nothing is written. Valid rows are inserted in the same pending-parse phase as
observations, before the publish batch, so they become visible exactly when
`parse_runs.status` becomes `ok` and stay attached to an `error` run if
publication fails. The raw payload budgets are unchanged. For a legacy parser
nothing is inserted.

The local PoC store applies 0025 like 0024 and `runParsers` persists the same
rows in its parse transaction.

## Snapshot policies

`dataset_snapshot_policies` is joined on `(parser_name, dataset)`, exactly as
the former `SNAPSHOT_DATASETS` VALUES list was; `source_id` records the
source whose parser accepts the dataset and is not a join key (the parser's
`accepts` already binds the source, and synthetic fixtures use other source
ids). The TypeScript constant `SNAPSHOT_DATASETS` remains the registry of
container datasets; `snapshot-policies.test.ts` fails when the table seed and
the constant disagree, so a new snapshot parser cannot ship without a policy
row, and `coverage-contract.test.ts` fails when a `SNAPSHOT_DATASETS` parser
has no contract cases.

| `policy_id`                | Membership rule (`snapshot-query.ts`)                                                                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy-warning-compat-v1` | `legacyWarningCompatMembership`: the pre-A03 rule, unchanged and confined to one function. The two tolerant SBI parsers are excluded when any warning is outside the two allow-listed texts; other parsers' warnings are ignored. Seeded for every dataset.                                          |
| `coverage-v1`              | `coverageV1Membership`: the parse has a `complete-container` claim whose `scope_key` equals the artifact's container scope, `completeness = 'complete'`, `membership_complete = 1`, no `failure_cause`; a zero-row claim participates unless the row sets `replaces_previous_on_complete_empty = 0`. |

Both variants keep the existing rules: the parent run must be `success` with
`failure_count = 0`, the parse must be named by the publication projection
`published_parse_runs` (migration 0026, `docs/publication-gate.md`; before that
gate the rule was `ok` and not superseded), every artifact
of the run's dataset/unit must have such a parse, `required_parser_version`
applies (`0.3.0` for foreign positions), and the newest complete run wins by
`fetched_at`, then artifact id. `unit_scope` is `run` for every seeded row;
`unit` names `unit-independent-v1` and is described under "Unit-scoped
eligibility" below.

### D13 predicates (`packages/read-model/src/concepts.ts`)

| Predicate              | Meaning                                                                                       | Today                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidenceExists`       | a visible artifact whose raw object is reachable                                              | `EXISTS (SELECT 1 FROM observation_raw_objects o WHERE o.sha256 = a.sha256)`                                                                                                                    |
| `unitParseable`        | the artifact may become observations, at the scope its dataset's policy row names             | `run`: `r.status = 'success' AND r.failure_count = 0`; `unit`: that, OR the artifact's own fetch unit succeeded. Used by the Worker's `artifactSql` and by the reader's `activeStateProjection` |
| `snapshotAdoptable`    | the parse is the current complete snapshot of its container under the dataset's active policy | the snapshot CTEs and `CURRENT_SNAPSHOT`                                                                                                                                                        |
| `economicallySummable` | the measure may enter an economic total                                                       | `0` for every row: no aggregation policy is published; nothing sums observations                                                                                                                |

## Switching a dataset to coverage-v1

1. Deploy in order: migrations 0025 and 0026 →
   `services/observation-pipeline` Worker → `services/evidence-browser`. The
   reader's SQL names `dataset_snapshot_policies`, `parse_coverage_claims` and
   `published_parse_runs`, so the migrations must exist before the reader; the
   Worker must run before any claim exists. The snapshot CTEs sit on top of the
   publication gate: a parse completes a container only when the projection
   names it, so `docs/publication-gate.md` step 2 applies here unchanged.
2. Let the converted parsers publish claims for the dataset (new sealed runs,
   or a replay plan for the current parser version; a replay creates new parse
   runs and never rewrites old ones).
3. Read `GET /snapshot-policy/compare` on the observation-pipeline Worker
   (internal service-binding route). It evaluates every container dataset
   under both policies and lists, per `(source, parser, dataset)`, the
   snapshot counts and the partitions whose current artifact id differs.
   Identifiers only; never amounts, warnings or raw bodies.
4. Every difference must be an intended correction. The two kinds the
   synthetic test constructs (`snapshot-policies.test.ts`) are: a complete
   container whose warning was reworded (legacy falls back to the older
   snapshot; coverage-v1 adopts the newer one), and an allow-listed warning on
   a parse whose claim is partial (legacy adopts it; coverage-v1 refuses).
   Both are corrections, not regressions. Any other difference is a parser or
   policy bug to fix first.
5. `UPDATE dataset_snapshot_policies SET policy_id = 'coverage-v1',
updated_at_ms = ? WHERE parser_name = ? AND dataset = ?`. Old parse runs
   without claims stop being candidates for that dataset from that moment,
   which is the intended meaning of "no unfounded complete".

**Rollback**: set `policy_id` back to `legacy-warning-compat-v1` for the
dataset. Claims and issues stay as evidence; no migration is edited and no
row is deleted. Rolling the Worker back to a version that predates this
change also works: it inserts parse runs without claims, which the legacy
policy reads as before.

## Unit-scoped eligibility (`unit-independent-v1`, D13 / PR-14)

Migration `0037_unit_scope_eligibility.sql`. Additive and inert on deploy: no
policy row is switched, so every dataset keeps the run-scoped rule and the
served result set is unchanged (`read-model-parity.test.ts`,
`unit-scope-api.test.ts` first case).

Before this change one failed range inside a collector run made the whole run
ineligible: the Worker parsed only artifacts of runs with
`observation_fetch_runs.status = 'success' AND failure_count = 0`, and the
reader showed only those. When a run collects several independent accounts or
cards, one card's failure therefore also froze the freshness of every card that
succeeded. `unit-independent-v1` separates "this run succeeded" from "this
range succeeded", for datasets where the second is provable.

### What the `unit` scope changes, and what it must not

| Question                                            | `run` scope                                                                     | `unit` scope                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| May this artifact be parsed at all?                 | the whole run succeeded                                                         | that, or its own fetch unit reported terminal success on a sealed run                                            |
| May its parse complete the container of its unit?   | every artifact of the (dataset, unit, run) group has a published complete parse | **unchanged**                                                                                                    |
| May a proven unit replace the whole dataset?        | n/a                                                                             | **no**: `ranked_snapshots` partitions by `fetch_unit_key`, so a rescued unit replaces only its own partition     |
| May a page missing inside one unit still adopt?     | no                                                                              | **no**: the `HAVING COUNT(*) = SUM(...)` group is per unit and counts every artifact of that unit, parsed or not |
| Does the reader present a partial run as a refresh? | n/a                                                                             | **no**: `/api/overview` gains `unitUpdates` with per-run `updated_units` / `stale_units`                         |

The last two rows are the review's constraint that page dependence and unit
independence must not be mixed. Nothing in this change relaxes completeness
inside a unit; the only relaxed predicate is `unitParseable`.

### The predicate

One definition, `unitScopedEligibilitySql` in
`packages/parsers/src/snapshot-query.ts`, composed by:

- the Worker's `artifactSql` (`services/observation-pipeline/src/worker.ts`),
  which every lane — incremental, repair, replay — uses to create jobs and
  which `parseJob` re-checks before parsing, so a partial run produces jobs
  only for its eligible units;
- the reader's `activeStateProjection` (`packages/read-model/src/concepts.ts`)
  and the PoC's `CURRENT` (`poc/observation-pipeline/src/queries.ts`), so a
  rescued parse is not written and then hidden;
- `eligible_snapshots` in the snapshot CTEs, so the rescued unit can become the
  current snapshot of _its own_ partition.

```sql
f.status = 'success' AND f.failure_count = 0            -- run scope, unchanged
OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
             WHERE unit_policy.source_id = fa.source_id
               AND unit_policy.dataset   = fa.dataset
               AND unit_policy.unit_scope = 'unit')
    AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
                 WHERE artifact_unit.fetch_artifact_id = fa.id
                   AND artifact_unit.unit_status = 'success'))
```

`observation_fetch_artifact_units` (0037) is the projection of Layer A's unit
evidence onto one artifact: it exists only for an artifact with a
`fetch_unit_id` whose unit has a terminal report on a **sealed** run, and its
`unit_status` is `success` only when that report says `success` with no
`safe_failure_code` **and** no `collector_error` artifact is attributable to
that unit or to the run as a whole. An artifact with no fetch unit has no row
and is never rescued.

The eligibility join is on `(source_id, dataset)`, not on the policy table's
`(parser_name, dataset)` key, because eligibility is decided per artifact
before any parser is chosen. `source_id` is a join key here and only here;
snapshot selection still joins on dataset alone, as before.

Parsers state their own precondition ("the capture succeeded") and therefore
also had to learn the difference: `unitScopeAdmitted` in
`packages/parsers/src/parsers/util.ts` reads
`ArtifactMeta.unitScopeEligibility`, which the **caller** sets (the Worker from
`artifactSql`, the PoC store from `listArtifacts`) after evaluating the policy.
A parser never decides the policy, and the field is null for every artifact
while every dataset is on the `run` scope, so every parser precondition is the
pre-PR-14 rule verbatim and no parser version changed.

### Which dataset is provably unit-independent: MyJCB

The criteria are (a) each unit has its own terminal unit report, (b) artifacts
carry `fetch_unit_id`, and (c) every artifact of a unit is attributed to that
unit, so a missing page inside a unit is detectable.

**MyJCB** (`services/collector-r2-importer/src/myjcb.ts`,
`docs/sources/myjcb.md`) is the only current source with several sibling units
in one run:

- (a) The importer catalogues one `fetch_unit` per manifest connection
  (`unitKind: "connection"`, `unitKey: connection.connectionId`,
  `terminalReportRequired: true`) and, in its `unit_reports` phase, posts one
  terminal report per connection carrying that connection's own status
  (`success` / `failed` / `human-required` → `human_required`) and, when it is
  not a success, a `safeFailureCode`. Cards therefore fail one at a time and
  say so individually.
- (b) Every data artifact's descriptor sets `fetchUnitId: unit.unitId` for the
  connection it belongs to (`artifactPlans` → `dataDescriptor`). Only the
  run-level `manifest.json` (role `collector_manifest`) has no unit, and no
  parser turns it into observations.
- (c) The connection's terminal report declares
  `declaredArtifactCount: connection.artifactCount` with
  `artifactCountScope: "direct"`. Layer A's seal trigger (migration
  `0001_initial.sql`, `run_inventory_*`) refuses to seal a run whose unit owns
  a different number of artifacts than its terminal report declared, so on a
  sealed run a unit's artifact set is exactly what the collector said it was —
  and the snapshot CTE's per-unit `HAVING` then requires a published complete
  parse for every one of them.

By contrast Vpass creates exactly one `card` unit per run (the run _is_ the
card) and V Point one `collection` unit, so for them the unit scope and the run
scope coincide and there is nothing to gain. Every other collector is
single-unit or unit-less.

MyJCB's credit datasets are not container-snapshot datasets: their
current-statement selection is the per-source multi-page contract in
`poc/observation-pipeline/src/queries.ts` (`ranked_myjcb_snapshots`), not
`SNAPSHOT_DATASETS`. That is why `dataset_snapshot_policies` gained
`snapshot_selection`: a row with `snapshot_selection = 0` carries the
eligibility policy for a dataset without enrolling it into container-snapshot
selection (`snapshot-policies.test.ts`, "eligibility-only policy rows").

MyJCB's current-statement selection already partitions by connection: the
`ranked_myjcb_snapshots` CTE partitions on the connection id it takes from the
artifact key prefix, plus statement state and period. Unit-scoped eligibility
therefore lines up with the selection that is already per card.

**Not enabled, and not observed.** No MyJCB row is seeded. The structural
argument above is read off the importer and the Layer A triggers, but
`docs/sources/myjcb.md` records that the checked-in audit of the private R2
never saw a run with more than one connection ("multiple connectionsは未観測"),
so the multi-unit case has never occurred in real evidence. Every test here
uses synthetic datasets and synthetic units; nothing was run against real
MyJCB data. Step 2 of the enabling procedure below is what must be satisfied
on live data before a MyJCB row is written.

### Coverage claims of a rescued parse

`parse_coverage_claims` gains `unit_scope` (`run` | `unit`) and
`unit_report_outcome`. The Worker writes `unit` whenever the parent run was not
a clean success — which, because `artifactSql` already refused every ineligible
artifact, can only mean the artifact was admitted by `unit-independent-v1` —
together with A03's `parent_run_status` (`partial`) and
`parent_run_failure_count`. A claim therefore records both that its parent run
was partial and which unit report allowed it.

### Enabling one dataset (operator step)

1. Deploy in order: migration `0037` (on top of `0025`, `0026`, `0029`, `0035`
   and `0036`) → `services/observation-pipeline` Worker →
   `services/evidence-browser`. Both the Worker and the reader name
   `observation_fetch_artifact_units` and
   `dataset_snapshot_policies.snapshot_selection`, so the migration must exist
   before either. Nothing changes at any of the three steps.
2. Verify the dataset against (a)–(c) above in the collector's code, and check
   on the deployed data that every unit of the candidate source has a terminal
   unit report and that its artifacts carry `fetch_unit_id`:

   ```sql
   SELECT u.unit_key, count(a.id) AS artifacts,
          (SELECT r.normalized_outcome FROM fetch_unit_reports r
            WHERE r.fetch_unit_id = u.id AND r.report_kind = 'terminal') AS terminal
     FROM fetch_units u LEFT JOIN fetch_artifacts a ON a.fetch_unit_id = u.id
    WHERE u.fetch_run_id = ? GROUP BY u.id;
   ```

   A unit with no terminal row, or artifacts with a NULL `fetch_unit_id`, means
   the dataset is not ready; the predicate would silently keep it on the run
   scope.

3. Write the row. For a container-snapshot dataset, update the existing row:

   ```sql
   UPDATE dataset_snapshot_policies SET unit_scope = 'unit', updated_at_ms = ?
    WHERE parser_name = ? AND dataset = ?;
   ```

   For a dataset that is not a container snapshot (MyJCB):

   ```sql
   INSERT INTO dataset_snapshot_policies
     (source_id, dataset, parser_name, policy_id, unit_scope, snapshot_selection, updated_at_ms)
   VALUES ('myjcb', 'credit-ledger', 'myjcb-credit-ledger',
           'legacy-warning-compat-v1', 'unit', 0, ?);
   ```

4. Read `/api/overview`. A partial run that rescued units appears in
   `unitUpdates` with `updated_units` and `stale_units`; that key is the
   reader's statement that the dataset was refreshed in part. It is absent
   while no dataset is on the `unit` scope. `GET /snapshot-policy/compare` on
   the observation-pipeline Worker lists `unit_scope` and `snapshot_selection`
   for every policy row, so the active scope of each dataset is inspectable
   without reading the table directly.

**Rollback**: set `unit_scope` back to `'run'` (or delete an
eligibility-only row). Selection returns to the strict rule immediately and
identically — `current-snapshots.test.ts` flips a store back and asserts the
result set equals the pre-flip set. Parses already produced from partial runs
stay as history: their claims record `unit_scope = 'unit'` and a partial
parent, they are simply no longer eligible for adoption, and nothing is
deleted. Rolling the Worker or the reader back to a build that predates 0037
also works, because both then apply the run scope unconditionally.

### Invariants

- INV: no dataset is seeded on the `unit` scope, and `snapshot_selection` is 1
  for every seeded row (`read-model.test.ts`, `snapshot-policies.test.ts`,
  `unit-scope.test.ts` first case).
- INV: with every row on the `run` scope, the Worker creates the same jobs,
  parses the same artifacts and the reader serves the same rows as before
  (`read-model-parity.test.ts`, `unit-scope.test.ts` "restores the strict
  rule", `unit-scope-api.test.ts`).
- INV: a rescued unit replaces only its own `fetch_unit_key` partition; a
  failed sibling keeps its previous snapshot (`unit-scope.test.ts`,
  `current-snapshots.test.ts`).
- INV: a unit with an artifact that has no published complete parse adopts
  nothing, whatever its unit report said (`unit-scope.test.ts` "one page of a
  two-page unit", `current-snapshots.test.ts` "a page missing inside one card").
- INV: parser versions, warning texts and stored A/B rows are unchanged; the
  contract fixtures still match byte for byte (`coverage-contract.test.ts`).

### Verified locally

Synthetic data only: `mise run ci:root` (which
runs the publication-gate predicate guard; the unit-scope predicate adds no
`superseded_by_parse_run_id IS NULL` and no `status = 'ok'` read, and every
adoption test still goes through `published_parse_runs`),
`poc/observation-pipeline`, `services/observation-pipeline`,
`services/raw-evidence`, `services/evidence-browser`, `packages/read-model`;
`hk check --all`. Not verified: production data, a real D1 or R2, real MyJCB
evidence, and the effect of switching any production dataset to the `unit`
scope (no dataset is switched by this change).

## Flags and invariants

- No feature flag: the policy table is the switch and it is seeded off
  (legacy) for every dataset.
- INV: stored A/B rows, parser versions and warning texts are unchanged;
  observations of converted parsers are byte-identical to the frozen
  fixtures.
- INV: a pending, error or unpublished parse run's claim is never read for
  selection (`coverage.test.ts`); claim rows are written in the pending phase
  and become readable only when the publish batch marks the run `ok` and moves
  the publication pointer.
- INV: an empty complete container replaces the previous snapshot under both
  policies; a partial-empty or unknown claim never does.
- INV: the served evidence-browser result set is unchanged under the seeded
  policy (`read-model-parity.test.ts`).

## Verified locally

Synthetic data only: `bun run scripts/ci-package.ts` for
`poc/observation-pipeline`, `services/observation-pipeline`,
`services/raw-evidence`, `services/evidence-browser`, `packages/read-model`,
`packages/domain`; `bun test scripts/`; `hk check --all`. Not verified:
production data, a real D1 or R2, and the effect of switching any production
dataset to `coverage-v1` (no dataset is switched by this change).
