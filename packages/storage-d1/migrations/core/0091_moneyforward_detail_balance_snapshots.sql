-- Only the explicitly observed MoneyForward detail measures form this
-- container. Product rows without stable identities, premium-gated debt and
-- unobserved securities are not claimed by its complete membership.
-- An unavailable parse never erases the last observed quantities.
INSERT INTO dataset_snapshot_policies
  (source_id, dataset, parser_name, policy_id, required_parser_version,
   replaces_previous_on_complete_empty, updated_at_ms)
VALUES
  ('moneyforward-me', 'account-detail', 'moneyforward-detail-balances',
   'coverage-v1', '1.0.1', 0, 1794268800000);
