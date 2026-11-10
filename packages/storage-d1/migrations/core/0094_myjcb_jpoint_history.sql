-- Acquisition-month history is independent of the credit/debit statements.
-- A complete claim describes the three cross-checked provider-rendered tabs.
-- An empty/unavailable page never clears the last observed membership.
INSERT INTO dataset_snapshot_policies
 (source_id,dataset,parser_name,policy_id,policy_version,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,updated_at_ms,snapshot_selection)
VALUES
 ('myjcb','jpoint-history','myjcb-jpoint-history','coverage-v1',1,'1.0.1',0,'unit',1794268800000,1);
