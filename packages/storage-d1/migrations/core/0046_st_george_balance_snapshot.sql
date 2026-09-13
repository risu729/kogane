-- Balance membership is complete for the bounded, fully collected portfolio.
-- Transaction history from the same capture remains evidence-only and has no
-- snapshot replacement policy: its pagination/window and pending rows are unknown.
INSERT INTO dataset_snapshot_policies (
  source_id, dataset, parser_name, policy_id, required_parser_version,
  replaces_previous_on_complete_empty, unit_scope
) VALUES (
  'st-george', 'account-snapshot', 'st-george-balances', 'coverage-v1', '1.0.0',
  0, 'run'
);
