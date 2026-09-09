// These collector datasets are complete containers, not transaction windows.
// Every account, currency and market inside one container belongs to its
// snapshot; partitioning by an emitted row would resurrect disappeared rows.
// MyJCB, V Point and Vpass have separate multi-page/card contracts in queries.ts.
//
// Policy ownership (design review D01): the active selection policy of each
// dataset lives in the `dataset_snapshot_policies` table (migration 0025),
// not in this constant. The constant remains the registry of container
// datasets that a snapshot policy must cover; snapshot-policies.test.ts fails
// when the two disagree, so a new snapshot parser cannot ship without a
// policy row.
export const SNAPSHOT_DATASETS = [
  ["sbi-domestic-cash-positions", "domestic-cash-positions"],
  ["sbi-foreign-cash-positions", "foreign-cash-positions"],
  ["sbi-account-assets-current", "account-assets-current"],
  ["sbi-foreign-cash-balances", "foreign-cash-balances"],
  ["sbi-vc-position-summary", "position-summary"],
  ["sbi-vc-cash-balances", "cash-balances"],
  ["sbi-vc-account-margin", "account-margin"],
  ["sbi-shinsei-top-balances-and-activity", "top-accounts-balance-and-activity"],
  ["sbi-shinsei-yen-deposit-account", "yen-deposit-account"],
  ["sony-bank-gross-balance", "gross-balance"],
  ["smbc-direct-balance", "balance-normalized"],
] as const;

// Earlier foreign-position parsers did not validate pagination. Their stored
// success is not proof of completeness, even if a newer reparse fails.
export const FOREIGN_POSITION_SNAPSHOT_VERSION = "0.3.0";

/**
 * Selection policies a dataset row may name. `legacy-warning-compat-v1` is
 * the pre-A03 rule (warning-text matching for the two tolerant SBI parsers)
 * kept only as a migration adapter; `coverage-v1` reads the parse's stored
 * coverage claim and nothing else.
 */
export const SNAPSHOT_POLICY_IDS = ["legacy-warning-compat-v1", "coverage-v1"] as const;
export type SnapshotPolicyId = (typeof SNAPSHOT_POLICY_IDS)[number];
export const LEGACY_SNAPSHOT_POLICY: SnapshotPolicyId = "legacy-warning-compat-v1";
export const COVERAGE_SNAPSHOT_POLICY: SnapshotPolicyId = "coverage-v1";

/**
 * Relations the snapshot CTEs read. The local PoC reads the base tables; the
 * production reader passes the sealed `observation_*` views. Naming them here
 * keeps the read boundary in the SQL text instead of in a later substitution.
 * Coverage claims and the policy table are Layer B / operational tables with
 * no sealed view, so they default to their base names.
 */
export interface SnapshotRelations {
  fetchArtifacts: string;
  fetchRuns: string;
  parseRuns: string;
  /** The publication projection (docs/publication-gate.md); a parse completes a snapshot only when published. */
  publishedParseRuns: string;
  coverageClaims?: string;
  snapshotPolicies?: string;
  /** Per-artifact fetch-unit outcome (migration 0037); see `unitScopeSuccessSql`. */
  artifactUnits?: string;
}

export const LOCAL_SNAPSHOT_RELATIONS: SnapshotRelations = {
  fetchArtifacts: "fetch_artifacts",
  fetchRuns: "fetch_runs",
  parseRuns: "parse_runs",
  publishedParseRuns: "published_parse_runs",
};

export const COVERAGE_CLAIMS_TABLE = "parse_coverage_claims";
export const SNAPSHOT_POLICIES_TABLE = "dataset_snapshot_policies";
export const ARTIFACT_UNITS_RELATION = "observation_fetch_artifact_units";

/**
 * Eligibility scopes a policy row may name (`dataset_snapshot_policies.unit_scope`).
 * `run` is the default and the pre-PR-14 rule: the whole parent fetch run
 * succeeded with no failure evidence. `unit` is `unit-independent-v1`: the
 * artifact's own fetch unit succeeded, even when a sibling unit of the same
 * run failed and the run therefore projects as `partial`.
 */
export const UNIT_SCOPES = ["run", "unit"] as const;
export type UnitScope = (typeof UNIT_SCOPES)[number];
export const UNIT_INDEPENDENT_POLICY = "unit-independent-v1";

/**
 * The unit half of `unit-independent-v1`: this artifact's own fetch unit
 * reported terminal success on a sealed run (migration 0037's
 * `observation_fetch_artifact_units`, which also refuses a unit implicated by
 * a collector error). An artifact with no fetch unit has no row and is never
 * rescued by this clause, so it falls back to the run scope.
 *
 * Page dependence is deliberately not relaxed: this says nothing about how
 * many artifacts the unit owns. Within a unit, completeness stays the job of
 * the seal-time `declared_artifact_count` check in Layer A and of the
 * per-unit `HAVING COUNT(*) = SUM(...)` in `eligible_snapshots` below.
 */
export function unitScopeSuccessSql(artifact: string, relations: string = ARTIFACT_UNITS_RELATION) {
  return `EXISTS (SELECT 1 FROM ${relations} artifact_unit
        WHERE artifact_unit.fetch_artifact_id = ${artifact}.id
          AND artifact_unit.unit_status = 'success')`;
}

/**
 * The dataset opted into unit-scoped eligibility. The join is
 * `(source_id, dataset)` rather than the snapshot table's `(parser_name,
 * dataset)` primary key, because eligibility is decided per artifact before
 * any parser is chosen; one row therefore opts the whole dataset in, whichever
 * parser later accepts it. `source_id` is a join key here and only here.
 */
export function unitScopePolicySql(
  artifact: string,
  relations: string = SNAPSHOT_POLICIES_TABLE,
): string {
  return `EXISTS (SELECT 1 FROM ${relations} unit_policy
        WHERE unit_policy.source_id = ${artifact}.source_id
          AND unit_policy.dataset = ${artifact}.dataset
          AND unit_policy.unit_scope = 'unit')`;
}

/** The pre-PR-14 rule and the default: the whole parent fetch run succeeded. */
export function runScopeSuccessSql(fetchRun: string): string {
  return `${fetchRun}.status = 'success' AND ${fetchRun}.failure_count = 0`;
}

/**
 * The D13 `unitParseable` predicate at whichever scope the artifact's dataset
 * names: run scope, or `unit-independent-v1` for a dataset with an opted-in
 * policy row. One definition, used by the production Worker's job creation and
 * parse gate, by the production reader's active-state projection, and by the
 * PoC's `CURRENT`, so evidence can never be parsed and then hidden (or shown
 * and never parsed) because two places disagree.
 */
export function unitScopedEligibilitySql(
  fetchRun: string,
  artifact: string,
  relations: { policies?: string; artifactUnits?: string } = {},
): string {
  return `(${runScopeSuccessSql(fetchRun)} OR (${unitScopePolicySql(artifact, relations.policies ?? SNAPSHOT_POLICIES_TABLE)}
      AND ${unitScopeSuccessSql(artifact, relations.artifactUnits ?? ARTIFACT_UNITS_RELATION)}))`;
}

/**
 * legacy-warning-compat-v1, confined to this function. The two legacy
 * tolerant SBI container parsers can skip unreadable containers; only
 * warnings that preserve the complete measurement as decimal text or preserve
 * extra fields are harmless for membership. Every other parser's warnings are
 * ignored. This is the rule the review found (warning text as a machine
 * contract); it stays byte-for-byte until every dataset has moved to
 * coverage-v1, and it must not gain new clauses.
 */
export function legacyWarningCompatMembership(parse: string, policy: string): string {
  return `(${policy}.parser_name NOT IN (
        'sbi-foreign-cash-positions', 'sbi-foreign-cash-balances'
      ) OR NOT EXISTS (
        SELECT 1 FROM json_each(${parse}.warnings_json) warning
        WHERE warning.type <> 'text' OR NOT (
          warning.value LIKE '% has no exact % minor-unit form; kept as text'
          OR instr(warning.value, ': fields not modelled as metrics were kept only in extra: ') > 0
        )
      ))`;
}

/**
 * The scope key a container parser writes on its claim
 * (`containerScopeKey` in parsers/coverage.ts), derived from the artifact
 * row so that the claim is matched by contract, not by free text.
 */
export function containerScopeKeySql(artifact: string): string {
  return `${artifact}.source_id || '/' || ${artifact}.dataset || CASE WHEN ${artifact}.fetch_unit_key IS NULL THEN '' ELSE '/unit=' || ${artifact}.fetch_unit_key END`;
}

/**
 * coverage-v1: a parse participates only through a `complete-container`
 * claim for the artifact's dataset scope that is complete with complete
 * membership and no failure cause. A complete-empty claim (zero rows)
 * participates and supersedes, unless the policy row says an empty container
 * must not replace the previous snapshot. Partial and unknown claims, and
 * parses without a claim (legacy parsers), never participate. Warning text
 * and issue messages are not read.
 */
export function coverageV1Membership(
  parse: string,
  artifact: string,
  policy: string,
  claims: string = COVERAGE_CLAIMS_TABLE,
): string {
  return `EXISTS (
        SELECT 1 FROM ${claims} claim
        WHERE claim.parse_run_id = ${parse}.id
          AND claim.mode = 'complete-container'
          AND claim.scope_key = ${containerScopeKeySql(artifact)}
          AND claim.completeness = 'complete'
          AND claim.membership_complete = 1
          AND claim.failure_cause IS NULL
          AND (claim.observed_count > 0 OR ${policy}.replaces_previous_on_complete_empty = 1)
      )`;
}

export interface SnapshotCteOptions {
  /** Evaluate every dataset under this policy instead of its table row (shadow comparison). */
  policy?: SnapshotPolicyId;
  /** Prefix for the CTE names, so two policy variants can share one query. */
  prefix?: string;
}

export function snapshotCtes(
  relations: SnapshotRelations,
  options: SnapshotCteOptions = {},
): string {
  const claims = relations.coverageClaims ?? COVERAGE_CLAIMS_TABLE;
  const policies = relations.snapshotPolicies ?? SNAPSHOT_POLICIES_TABLE;
  const units = relations.artifactUnits ?? ARTIFACT_UNITS_RELATION;
  const p = options.prefix ?? "";
  // The policy id is a fixed code-owned identifier, never provider input.
  const activePolicy = options.policy === undefined ? "policy.policy_id" : `'${options.policy}'`;
  // `snapshot_selection = 0` rows carry an eligibility policy only (D13/PR-14);
  // they must not make their dataset a container-snapshot dataset.
  return `${p}snapshot_policies(parser_name, dataset, required_version, policy_id, replaces_previous_on_complete_empty, unit_scope) AS (
  SELECT parser_name, dataset, required_parser_version, policy_id, replaces_previous_on_complete_empty, unit_scope
  FROM ${policies} WHERE snapshot_selection = 1
), ${p}eligible_snapshots AS (
  SELECT fa.source_id, policy.parser_name, policy.required_version, fa.dataset, fa.fetch_unit_key,
         fa.fetch_run_id, MAX(fa.fetched_at) AS fetched_at, MAX(fa.id) AS artifact_id
  FROM ${relations.fetchArtifacts} fa
  JOIN ${relations.fetchRuns} f ON f.id = fa.fetch_run_id
  JOIN ${p}snapshot_policies policy ON policy.dataset = fa.dataset
  -- Run scope (default, unchanged) or, for a dataset whose policy row names
  -- unit-independent-v1, this artifact's own unit. The grouping below is
  -- already per fetch_unit_key, so a rescued unit can only ever replace its
  -- own partition; a failed sibling unit contributes no row and keeps its
  -- previous snapshot.
  WHERE (f.status = 'success' AND f.failure_count = 0)
     OR (policy.unit_scope = 'unit' AND ${unitScopeSuccessSql("fa", units)})
  GROUP BY fa.source_id, policy.parser_name, policy.required_version, fa.dataset,
           fa.fetch_unit_key, fa.fetch_run_id
  HAVING COUNT(*) = SUM(CASE WHEN EXISTS (
    SELECT 1 FROM ${relations.parseRuns} complete_parse
    WHERE complete_parse.fetch_artifact_id = fa.id
      AND complete_parse.parser_name = policy.parser_name
      AND (policy.required_version IS NULL OR complete_parse.parser_version = policy.required_version)
      AND EXISTS (SELECT 1 FROM ${relations.publishedParseRuns} published
                  WHERE published.parse_run_id = complete_parse.id)
      -- Membership is decided by the dataset's active policy: the stored
      -- coverage claim under coverage-v1, the confined warning-text adapter
      -- under legacy-warning-compat-v1.
      AND CASE ${activePolicy}
        WHEN 'coverage-v1' THEN ${coverageV1Membership("complete_parse", "fa", "policy", claims)}
        ELSE ${legacyWarningCompatMembership("complete_parse", "policy")}
      END
  ) THEN 1 ELSE 0 END)
), ${p}ranked_snapshots AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY source_id, parser_name, dataset, fetch_unit_key
    ORDER BY fetched_at DESC, artifact_id DESC
  ) AS snapshot_rank FROM ${p}eligible_snapshots
), ${p}current_snapshots AS (
  SELECT * FROM ${p}ranked_snapshots WHERE snapshot_rank = 1
)`;
}

export const SNAPSHOT_CTES = snapshotCtes(LOCAL_SNAPSHOT_RELATIONS);

// The enclosing query binds p=parser and fa=artifact. Empty successful parses
// participate above even though there is no observation to join below.
export const CURRENT_SNAPSHOT = `(
  NOT EXISTS (SELECT 1 FROM snapshot_policies policy
              WHERE policy.parser_name = p.parser_name)
  OR EXISTS (
    SELECT 1 FROM current_snapshots snapshot
    WHERE snapshot.source_id = fa.source_id
      AND snapshot.parser_name = p.parser_name
      AND (snapshot.required_version IS NULL OR p.parser_version = snapshot.required_version)
      AND snapshot.dataset = fa.dataset
      AND snapshot.fetch_unit_key IS fa.fetch_unit_key
      AND snapshot.fetch_run_id = fa.fetch_run_id
  )
)`;

/** One partition of the shadow comparison: the current snapshot artifact under each policy. */
export interface SnapshotPolicyComparisonRow {
  source_id: string;
  parser_name: string;
  dataset: string;
  fetch_unit_key: string | null;
  legacy_artifact_id: number | null;
  coverage_artifact_id: number | null;
}

/**
 * Shadow comparison (A03 migration): every (source, parser, dataset, unit)
 * partition with the artifact id of its current snapshot under
 * legacy-warning-compat-v1 and under coverage-v1, regardless of which policy
 * the table activates. Only identifiers are selected; no amounts, warnings or
 * raw bodies. Rows where the two ids differ are the datasets that would change
 * on a policy switch and must be explained before switching.
 */
export function snapshotPolicyComparisonSql(relations: SnapshotRelations): string {
  const partition = (alias: string) =>
    `${alias}.source_id = keys.source_id AND ${alias}.parser_name = keys.parser_name
       AND ${alias}.dataset = keys.dataset AND ${alias}.fetch_unit_key IS keys.fetch_unit_key`;
  return `WITH ${snapshotCtes(relations, { policy: LEGACY_SNAPSHOT_POLICY, prefix: "legacy_" })},
${snapshotCtes(relations, { policy: COVERAGE_SNAPSHOT_POLICY, prefix: "coverage_" })},
keys AS (
  SELECT source_id, parser_name, dataset, fetch_unit_key FROM legacy_current_snapshots
  UNION
  SELECT source_id, parser_name, dataset, fetch_unit_key FROM coverage_current_snapshots
)
SELECT keys.source_id, keys.parser_name, keys.dataset, keys.fetch_unit_key,
  (SELECT l.artifact_id FROM legacy_current_snapshots l WHERE ${partition("l")}) AS legacy_artifact_id,
  (SELECT c.artifact_id FROM coverage_current_snapshots c WHERE ${partition("c")}) AS coverage_artifact_id
FROM keys
ORDER BY keys.source_id, keys.parser_name, keys.dataset, keys.fetch_unit_key`;
}
