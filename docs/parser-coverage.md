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

## Contract v2 (`poc/observation-pipeline/src/types.ts`)

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

### Helpers (`poc/observation-pipeline/src/parsers/coverage.ts`)

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

| Table                       | Rows                                                                                                                                                              | Mutability                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `parse_issues`              | one per issue: `parse_run_id, code, locator, severity, impact, message`                                                                                           | append-only (triggers)      |
| `parse_coverage_claims`     | one per claim: the claim fields, `evidence_refs_json`, plus `parent_run_status` and `parent_run_failure_count` recorded from the parent fetch run at parse time   | append-only (triggers)      |
| `dataset_snapshot_policies` | one per `(parser_name, dataset)`: `source_id, policy_id, policy_version, required_parser_version, replaces_previous_on_complete_empty, unit_scope, updated_at_ms` | operational state (mutable) |

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
`failure_count = 0`, the parse must be `ok` and not superseded, every artifact
of the run's dataset/unit must have such a parse, `required_parser_version`
applies (`0.3.0` for foreign positions), and the newest complete run wins by
`fetched_at`, then artifact id. `unit_scope` is `run` for every row and is not
read yet; `unit-independent-v1` (PR-14) will add the `unit` scope.

### D13 predicates (`packages/read-model/src/concepts.ts`)

| Predicate              | Meaning                                                                                       | Today                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `evidenceExists`       | a visible artifact whose raw object is reachable                                              | `EXISTS (SELECT 1 FROM observation_raw_objects o WHERE o.sha256 = a.sha256)`       |
| `unitParseable`        | the artifact may become observations; scope `run` = the whole parent run succeeded            | `r.status = 'success' AND r.failure_count = 0`, used by the Worker's `artifactSql` |
| `snapshotAdoptable`    | the parse is the current complete snapshot of its container under the dataset's active policy | the snapshot CTEs and `CURRENT_SNAPSHOT`                                           |
| `economicallySummable` | the measure may enter an economic total                                                       | `0` for every row: no aggregation policy is published; nothing sums observations   |

## Switching a dataset to coverage-v1

1. Deploy in order: migration 0025 → `services/observation-pipeline` Worker →
   `services/evidence-browser`. The reader's SQL names
   `dataset_snapshot_policies` and `parse_coverage_claims`, so the migration
   must exist before the reader; the Worker must run before any claim exists.
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

## Flags and invariants

- No feature flag: the policy table is the switch and it is seeded off
  (legacy) for every dataset.
- INV: stored A/B rows, parser versions and warning texts are unchanged;
  observations of converted parsers are byte-identical to the frozen
  fixtures.
- INV: a pending or error parse run's claim is never read for selection
  (`coverage.test.ts`); claim rows publish atomically with `status = 'ok'`.
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
