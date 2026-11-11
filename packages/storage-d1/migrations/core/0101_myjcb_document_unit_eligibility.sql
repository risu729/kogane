-- Independently validated original exports carry evidence-only claims. Failed
-- siblings cannot hide a healthy file, page or ledger. Preserve operator rows.
INSERT OR IGNORE INTO dataset_snapshot_policies (
  source_id,dataset,parser_name,policy_id,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,snapshot_selection
) VALUES
  ('myjcb','credit-csv','myjcb-statement-document-metadata','coverage-v1','1.0.1',0,'unit',0),
  ('myjcb','credit-pdf','myjcb-statement-document-metadata','coverage-v1','1.0.1',0,'unit',0),
  ('myjcb','credit-ofx','myjcb-statement-document-metadata','coverage-v1','1.0.1',0,'unit',0);
