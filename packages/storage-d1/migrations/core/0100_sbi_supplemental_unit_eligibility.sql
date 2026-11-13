-- Complete SBI units remain publishable when an independent supplement refuses.
-- Preserve every nondefault operator field, including the shipped timestamps.
-- A choice identical to every shipped default has no separate provenance.
UPDATE dataset_snapshot_policies SET unit_scope='unit'
WHERE source_id='sbi-securities' AND policy_id='legacy-warning-compat-v1'
  AND policy_version=1 AND required_parser_version IS NULL
  AND replaces_previous_on_complete_empty=1 AND unit_scope='run'
  AND snapshot_selection=1 AND updated_at_ms=0
  AND (parser_name,dataset) IN (
    ('sbi-domestic-cash-positions','domestic-cash-positions'),
    ('sbi-account-assets-current','account-assets-current'),
    ('sbi-foreign-cash-balances','foreign-cash-balances')
  );

UPDATE dataset_snapshot_policies SET unit_scope='unit'
WHERE source_id='sbi-securities' AND parser_name='sbi-foreign-cash-positions'
  AND dataset='foreign-cash-positions' AND policy_id='legacy-warning-compat-v1'
  AND policy_version=1 AND required_parser_version='0.3.1'
  AND replaces_previous_on_complete_empty=1 AND unit_scope='run'
  AND snapshot_selection=1 AND updated_at_ms=1794096000000;

UPDATE dataset_snapshot_policies SET unit_scope='unit'
WHERE source_id='sbi-securities' AND policy_id='coverage-v1'
  AND policy_version=1 AND required_parser_version='0.1.2'
  AND replaces_previous_on_complete_empty=1 AND unit_scope='run'
  AND snapshot_selection=1 AND updated_at_ms=1794268800000
  AND (parser_name,dataset) IN (
    ('sbi-income-payments','income-payments'),
    ('sbi-realised-gains','realised-gains')
  );

-- These histories keep their existing event/window semantics. An eligibility
-- row never enrolls a history or a retained provider response in snapshots.
INSERT OR IGNORE INTO dataset_snapshot_policies (
  source_id,dataset,parser_name,policy_id,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,snapshot_selection
) VALUES
  ('sbi-securities','domestic-trade-records','sbi-domestic-trade-records','coverage-v1',NULL,0,'unit',0),
  ('sbi-securities','foreign-trade-records','sbi-foreign-trade-records','coverage-v1',NULL,0,'unit',0),
  ('sbi-securities','yen-detail-history','sbi-yen-detail-history','coverage-v1',NULL,0,'unit',0),
  ('sbi-securities','foreign-cash-history','sbi-foreign-cash-history','coverage-v1',NULL,0,'unit',0),
  ('sbi-securities','account-assets-history','sbi-account-assets-history','coverage-v1',NULL,0,'unit',0);
