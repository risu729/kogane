-- The normal Authori module transition is supported by reader 1.0.2.
-- Advance only the complete shipped default; retain every operator choice.
UPDATE dataset_snapshot_policies
SET required_parser_version='1.0.2', updated_at_ms=1794441600000
WHERE source_id='vpass' AND dataset='credit-snapshot'
  AND parser_name='vpass-credit-snapshot' AND policy_id='coverage-v1'
  AND policy_version=1 AND required_parser_version='1.0.1'
  AND replaces_previous_on_complete_empty=0 AND unit_scope='unit'
  AND snapshot_selection=1 AND updated_at_ms=1794268800000;
