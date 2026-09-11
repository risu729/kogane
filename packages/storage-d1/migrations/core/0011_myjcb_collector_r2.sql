-- MyJCB uses a dedicated importer credential so it cannot ingest another
-- collector source through the shared internal Worker.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-myjcb', 'MyJCB collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-myjcb', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-myjcb', 'collector-r2-importer', 'myjcb');

-- Require the manifest source id to resolve through the reviewed registry.
INSERT INTO source_external_ids (producer_id, external_source_id, source_id) VALUES
  ('collector-r2-importer', 'myjcb', 'myjcb');

-- The extension-neutral artifact component covers sanitized HTML, strict
-- JSON derivatives, provider exports, and the generated manifest. Concrete
-- source keys never enter the central origin policy.
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'myjcb',
  'storage',
  'raw/myjcb/{date}/{run-id}/{artifact}',
  'v1',
  'collector-r2-v1',
  'MyJCB private staging R2 artifact or manifest; HTML is sanitized before source storage'
);
