-- Independently validated private documents are evidence only. A failed
-- sibling report, index or CSV comparison never invalidates a stored PDF/ZIP.
-- These rows enable unit eligibility, never container snapshot selection.
INSERT OR IGNORE INTO dataset_snapshot_policies (
  source_id,dataset,parser_name,policy_id,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,snapshot_selection
) VALUES
  ('sbi-vc-trade','monthly-report-pdf','sbi-vc-document-metadata','coverage-v1','1.0.0',0,'unit',0),
  ('sbi-vc-trade','pnl-data-zip','sbi-vc-document-metadata','coverage-v1','1.0.0',0,'unit',0);
