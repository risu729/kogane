// These collector datasets are complete containers, not transaction windows.
// Every account, currency and market inside one container belongs to its
// snapshot; partitioning by an emitted row would resurrect disappeared rows.
// MyJCB, V Point and Vpass have separate multi-page/card contracts in queries.ts.
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

// Values are fixed code-owned parser/dataset names, never provider input.
const policies = SNAPSHOT_DATASETS.map(
  ([parser, dataset]) =>
    `('${parser}', '${dataset}', ${parser === "sbi-foreign-cash-positions" ? `'${FOREIGN_POSITION_SNAPSHOT_VERSION}'` : "NULL"})`,
).join(",\n");

/**
 * Relations the snapshot CTEs read. The local PoC reads the base tables; the
 * production reader passes the sealed `observation_*` views. Naming them here
 * keeps the read boundary in the SQL text instead of in a later substitution.
 */
export interface SnapshotRelations {
  fetchArtifacts: string;
  fetchRuns: string;
  parseRuns: string;
  /** The publication projection (docs/publication-gate.md); a parse completes a snapshot only when published. */
  publishedParseRuns: string;
}

export const LOCAL_SNAPSHOT_RELATIONS: SnapshotRelations = {
  fetchArtifacts: "fetch_artifacts",
  fetchRuns: "fetch_runs",
  parseRuns: "parse_runs",
  publishedParseRuns: "published_parse_runs",
};

export function snapshotCtes(relations: SnapshotRelations): string {
  return `snapshot_policies(parser_name, dataset, required_version) AS (
  VALUES ${policies}
), eligible_snapshots AS (
  SELECT fa.source_id, policy.parser_name, policy.required_version, fa.dataset, fa.fetch_unit_key,
         fa.fetch_run_id, MAX(fa.fetched_at) AS fetched_at, MAX(fa.id) AS artifact_id
  FROM ${relations.fetchArtifacts} fa
  JOIN ${relations.fetchRuns} f ON f.id = fa.fetch_run_id
  JOIN snapshot_policies policy ON policy.dataset = fa.dataset
  WHERE f.status = 'success' AND f.failure_count = 0
  GROUP BY fa.source_id, policy.parser_name, policy.required_version, fa.dataset,
           fa.fetch_unit_key, fa.fetch_run_id
  HAVING COUNT(*) = SUM(CASE WHEN EXISTS (
    SELECT 1 FROM ${relations.parseRuns} complete_parse
    WHERE complete_parse.fetch_artifact_id = fa.id
      AND complete_parse.parser_name = policy.parser_name
      AND (policy.required_version IS NULL OR complete_parse.parser_version = policy.required_version)
      AND EXISTS (SELECT 1 FROM ${relations.publishedParseRuns} published
                  WHERE published.parse_run_id = complete_parse.id)
      -- The two legacy tolerant SBI container parsers can skip unreadable
      -- containers. Only warnings that preserve the complete measurement
      -- as decimal text or preserve extra fields are harmless for membership.
      AND (policy.parser_name NOT IN (
        'sbi-foreign-cash-positions', 'sbi-foreign-cash-balances'
      ) OR NOT EXISTS (
        SELECT 1 FROM json_each(complete_parse.warnings_json) warning
        WHERE warning.type <> 'text' OR NOT (
          warning.value LIKE '% has no exact % minor-unit form; kept as text'
          OR instr(warning.value, ': fields not modelled as metrics were kept only in extra: ') > 0
        )
      ))
  ) THEN 1 ELSE 0 END)
), ranked_snapshots AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY source_id, parser_name, dataset, fetch_unit_key
    ORDER BY fetched_at DESC, artifact_id DESC
  ) AS snapshot_rank FROM eligible_snapshots
), current_snapshots AS (
  SELECT * FROM ranked_snapshots WHERE snapshot_rank = 1
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
