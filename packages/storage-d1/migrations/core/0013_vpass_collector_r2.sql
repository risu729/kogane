-- Vpass has a dedicated credential and can only ingest the reviewed Vpass route.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-vpass', 'Vpass collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-vpass', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-vpass', 'collector-r2-importer', 'vpass');

INSERT INTO source_external_ids (producer_id, external_source_id, source_id) VALUES
  ('collector-r2-importer', 'vpass', 'vpass');

-- Only a keyed fingerprint of the concrete private object key is retained.
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'vpass',
  'storage',
  'vpass/{date}/{run-id}/{artifact}',
  'v1',
  'collector-r2-v1',
  'Vpass private staging R2 evidence; authentication, session, and card references are deterministically redacted before central ingestion'
);
