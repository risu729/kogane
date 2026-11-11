-- Each complete annual summary replaces only the previous summary for that year.
-- Evidence and historical publications remain append-only.
INSERT INTO dataset_snapshot_policies
  (source_id,dataset,parser_name,policy_id,required_parser_version)
VALUES ('sony-bank','realised-gains','sony-bank-realised-gains','coverage-v1','1.0.0');

-- Each offered PDF has its own successful byte-validated unit even when the
-- document-list run cannot prove whole retention. Eligibility only, no snapshot.
INSERT INTO dataset_snapshot_policies
  (source_id,dataset,parser_name,policy_id,required_parser_version,unit_scope,snapshot_selection)
VALUES ('sony-bank','delivered-document-pdf','sony-bank-document-metadata','coverage-v1','1.0.0','unit',0);
