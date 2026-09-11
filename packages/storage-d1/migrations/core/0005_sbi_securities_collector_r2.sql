-- Enable the SBI Securities collector-R2 transfer path with one narrowly
-- scoped client identity. The same client is used for immediate catch-up
-- after a collector run and for the bounded historical backfill.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-sbi', 'SBI Securities collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-sbi', 'collector-r2-importer');

INSERT INTO ingest_client_routes (
  ingest_client_id, producer_id, source_id
) VALUES (
  'collector-r2-sbi', 'collector-r2-importer', 'sbi-securities'
);

-- Require the checked-in collector source id to resolve through the reviewed
-- alias registry rather than through an importer-local fallback.
INSERT INTO source_external_ids (
  producer_id, external_source_id, source_id
) VALUES (
  'collector-r2-importer', 'sbi-securities', 'sbi-securities'
);

-- The original UUID-bearing staging key is represented only by this template
-- and a separately keyed HMAC fingerprint. The source bucket itself contains
-- both dataset JSON files and the generated manifest under this one shape.
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'sbi-securities',
  'storage',
  'raw/sbi-securities/{date}/{run-id}/{artifact}.json',
  'v1',
  'collector-r2-v1',
  'SBI Securities private staging R2 artifact or manifest'
);
