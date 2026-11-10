-- AUD history is an independent unit of a manual SMBC run. Its unreviewed
-- nonempty response must not stop complete new yen observations publishing.
-- Opt only the shipped default balance policy into unit eligibility; preserve
-- every operator-selected version, policy or timestamp. No evidence is edited.
UPDATE dataset_snapshot_policies
SET unit_scope = 'unit', updated_at_ms = 1794268800000
WHERE source_id = 'smbc-bank' AND dataset = 'balance-normalized'
  AND parser_name = 'smbc-direct-balance'
  AND policy_id = 'legacy-warning-compat-v1' AND policy_version = 1
  AND required_parser_version IS NULL
  AND replaces_previous_on_complete_empty = 1
  AND unit_scope = 'run' AND snapshot_selection = 1 AND updated_at_ms = 0;

-- Transaction windows are never replacement snapshots. An existing operator
-- row wins over this new default eligibility-only row.
INSERT OR IGNORE INTO dataset_snapshot_policies (
  source_id, dataset, parser_name, policy_id, required_parser_version,
  replaces_previous_on_complete_empty, unit_scope, snapshot_selection,
  updated_at_ms
) VALUES (
  'smbc-bank', 'transactions-normalized', 'smbc-direct-transactions',
  'coverage-v1', NULL, 0, 'unit', 0, 1794268800000
);

-- AUD balances are independent of their history's unreviewed nonempty shape
-- and of yen acquisition. Only complete balance units form snapshots.
INSERT OR IGNORE INTO dataset_snapshot_policies (
  source_id, dataset, parser_name, policy_id, required_parser_version,
  replaces_previous_on_complete_empty, unit_scope, snapshot_selection,
  updated_at_ms
) VALUES
  ('smbc-bank', 'foreign-ordinary-aud-balance', 'smbc-foreign-ordinary-balance',
   'coverage-v1', '0.1.2', 0, 'unit', 1, 1794268800000),
  ('smbc-bank', 'foreign-ordinary-aud-history', 'smbc-foreign-ordinary-history',
   'coverage-v1', NULL, 0, 'unit', 0, 1794268800000);
