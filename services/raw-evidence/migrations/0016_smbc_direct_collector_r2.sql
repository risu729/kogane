-- SMBC Direct has a dedicated credential and cannot ingest another
-- collector's source through the shared internal R2 importer.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-smbc-direct', 'SMBC Direct collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-smbc-direct', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-smbc-direct', 'collector-r2-importer', 'smbc-bank');

-- The manifest external source id smbc-direct -> smbc-bank is registered in 0003.
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'smbc-bank',
  'storage',
  'raw/smbc-direct/{date}/{run-id}/{artifact}',
  'v1',
  'collector-r2-v1',
  'SMBC Direct private staging R2 artifact or manifest'
);
