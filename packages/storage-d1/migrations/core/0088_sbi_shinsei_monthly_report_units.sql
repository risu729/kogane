-- Monthly reports are independent evidence documents, never holdings snapshots.
INSERT INTO dataset_snapshot_policies (
  source_id,dataset,parser_name,policy_id,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,snapshot_selection
) VALUES (
  'sbi-shinsei-bank','monthly-report-pdf','sbi-shinsei-monthly-report-metadata',
  'coverage-v1','1.0.0',0,'unit',0
);
