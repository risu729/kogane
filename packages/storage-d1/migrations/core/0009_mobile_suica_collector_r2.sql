-- Mobile Suica has a dedicated credential and cannot ingest another
-- collector's source through the shared internal R2 importer.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-mobile-suica', 'Mobile Suica collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-mobile-suica', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-mobile-suica', 'collector-r2-importer', 'mobile-suica');

-- Require the collector manifest source id to resolve through the reviewed
-- registry rather than through an importer-local fallback.
INSERT INTO source_external_ids (producer_id, external_source_id, source_id) VALUES
  ('collector-r2-importer', 'mobile-suica', 'mobile-suica');

-- One extension-neutral template covers the collector's CP932 HTML, normalized
-- JSON, summary, and manifest objects without retaining a concrete object key.
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'mobile-suica',
  'storage',
  'raw/mobile-suica/{date}/{run-id}/{artifact}',
  'v1',
  'collector-r2-v1',
  'Mobile Suica private staging R2 artifact or manifest'
);
