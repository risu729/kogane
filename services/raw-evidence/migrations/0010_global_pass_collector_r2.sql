-- GLOBAL PASS has a dedicated credential and cannot ingest another
-- collector's source through the shared internal R2 importer.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-global-pass', 'GLOBAL PASS collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-global-pass', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-global-pass', 'collector-r2-importer', 'global-pass');

-- The external alias prestia-globalpass -> global-pass already exists in 0003.
-- Do not duplicate it here: this migration only enables the dedicated client
-- and reviewed storage origin.

INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'global-pass',
  'storage',
  'raw/prestia-globalpass/{date}/{run-id}/{artifact}',
  'v1',
  'collector-r2-v1',
  'GLOBAL PASS private staging R2 artifact or manifest; central HTML must be sanitized before catalogue'
);
