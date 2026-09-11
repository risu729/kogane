-- Sony Bank has a dedicated credential and cannot ingest another collector's source.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-sony-bank', 'Sony Bank collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-sony-bank', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-sony-bank', 'collector-r2-importer', 'sony-bank');

INSERT INTO source_external_ids (producer_id, external_source_id, source_id) VALUES
  ('collector-r2-importer', 'sony-bank', 'sony-bank');

-- One extension-neutral template covers the collector's JSON, CSV, HTML, and manifest objects.
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'sony-bank',
  'storage',
  'raw/sony-bank/{date}/{run-id}/{artifact}',
  'v1',
  'collector-r2-v1',
  'Sony Bank private staging R2 artifact or manifest'
);
