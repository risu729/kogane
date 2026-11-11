-- Each independently verified PDF remains evidence when a sibling document or
-- the mailbox index fails. Documents never replace financial snapshots.
CREATE TABLE sbi_mailbox_progress (
  source TEXT PRIMARY KEY CHECK (source='sbi-securities'),
  next_identity TEXT CHECK (next_identity IS NULL OR (length(next_identity)=64 AND next_identity NOT GLOB '*[^a-f0-9]*')),
  persisted_run_id TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO dataset_snapshot_policies (
  source_id,dataset,parser_name,policy_id,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,snapshot_selection
) VALUES (
  'sbi-securities','delivered-document-pdf','sbi-delivered-document-metadata',
  'coverage-v1','1.0.0',0,'unit',0
);
