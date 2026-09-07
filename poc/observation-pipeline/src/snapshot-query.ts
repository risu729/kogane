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

// Values are fixed code-owned parser/dataset names, never provider input.
const policies = SNAPSHOT_DATASETS.map(([parser, dataset]) => `('${parser}', '${dataset}')`).join(
  ",\n",
);

export const SNAPSHOT_CTES = `snapshot_policies(parser_name, dataset) AS (
  VALUES ${policies}
), eligible_snapshots AS (
  SELECT fa.source_id, policy.parser_name, fa.dataset, fa.fetch_unit_key,
         fa.fetch_run_id, MAX(fa.fetched_at) AS fetched_at, MAX(fa.id) AS artifact_id
  FROM fetch_artifacts fa
  JOIN fetch_runs f ON f.id = fa.fetch_run_id
  JOIN snapshot_policies policy ON policy.dataset = fa.dataset
  WHERE f.status = 'success' AND f.failure_count = 0
  GROUP BY fa.source_id, policy.parser_name, fa.dataset,
           fa.fetch_unit_key, fa.fetch_run_id
  HAVING COUNT(*) = SUM(CASE WHEN EXISTS (
    SELECT 1 FROM parse_runs complete_parse
    WHERE complete_parse.fetch_artifact_id = fa.id
      AND complete_parse.parser_name = policy.parser_name
      AND complete_parse.status = 'ok'
      AND complete_parse.superseded_by_parse_run_id IS NULL
      -- The two legacy tolerant SBI container parsers can skip unreadable
      -- containers. A warned parse is evidence, not proof of completeness.
      AND (policy.parser_name NOT IN (
        'sbi-foreign-cash-positions', 'sbi-foreign-cash-balances'
      ) OR complete_parse.warnings_json = '[]')
  ) THEN 1 ELSE 0 END)
), ranked_snapshots AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY source_id, parser_name, dataset, fetch_unit_key
    ORDER BY fetched_at DESC, artifact_id DESC
  ) AS snapshot_rank FROM eligible_snapshots
), current_snapshots AS (
  SELECT * FROM ranked_snapshots WHERE snapshot_rank = 1
)`;

// The enclosing query binds p=parser and fa=artifact. Empty successful parses
// participate above even though there is no observation to join below.
export const CURRENT_SNAPSHOT = `(
  NOT EXISTS (SELECT 1 FROM snapshot_policies policy
              WHERE policy.parser_name = p.parser_name)
  OR EXISTS (
    SELECT 1 FROM current_snapshots snapshot
    WHERE snapshot.source_id = fa.source_id
      AND snapshot.parser_name = p.parser_name
      AND snapshot.dataset = fa.dataset
      AND snapshot.fetch_unit_key IS fa.fetch_unit_key
      AND snapshot.fetch_run_id = fa.fetch_run_id
  )
)`;
