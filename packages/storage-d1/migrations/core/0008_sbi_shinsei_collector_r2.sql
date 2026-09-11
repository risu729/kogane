-- SBI Shinsei Bank has a dedicated credential and cannot ingest another
-- collector's source through the shared internal R2 importer.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-sbi-shinsei', 'SBI Shinsei Bank collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-sbi-shinsei', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-sbi-shinsei', 'collector-r2-importer', 'sbi-shinsei-bank');

-- The manifest external source id was already registered in migration 0003.
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'sbi-shinsei-bank',
  'storage',
  'raw/sbi-shinsei/{date}/{run-id}/{artifact}',
  'v1',
  'collector-r2-v1',
  'SBI Shinsei Bank private staging R2 artifact or manifest'
);
