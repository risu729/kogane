-- Acquisition-month history is independent of the credit/debit statements.
-- A complete claim describes the three cross-checked provider-rendered tabs.
-- An empty/unavailable page never clears the last observed membership.
INSERT OR IGNORE INTO dataset_snapshot_policies
 (source_id,dataset,parser_name,policy_id,policy_version,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,updated_at_ms,snapshot_selection)
VALUES
 ('myjcb','jpoint-history','myjcb-jpoint-history','coverage-v1',1,'1.0.1',0,'unit',1794268800000,1),
 ('myjcb','credit-ledger','myjcb-credit-ledger','legacy-warning-compat-v1',1,NULL,1,'unit',1794268800000,0),
 ('myjcb','credit-detail','myjcb-credit-statement-total','legacy-warning-compat-v1',1,NULL,1,'unit',1794268800000,0),
 ('myjcb','credit-past-months','myjcb-credit-past-month-balances','legacy-warning-compat-v1',1,NULL,1,'unit',1794268800000,0),
 ('myjcb','credit-schedule','myjcb-skip-payment-schedule','legacy-warning-compat-v1',1,NULL,1,'unit',1794268800000,0);

-- The four credit datasets belong to the collector's complete connection unit.
-- A failed reward-history/sibling unit must not hide a separately complete
-- statement walk. These rows change eligibility only, never snapshot selection.
-- A partial/failed connection and a gap inside that connection remain ineligible.
