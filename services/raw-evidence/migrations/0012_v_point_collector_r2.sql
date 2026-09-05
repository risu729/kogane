-- V Point receives a dedicated ingest credential and two reviewed storage
-- origins: the point collector outbox and its generated email reconciliation.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-v-point', 'V Point collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-v-point', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-v-point', 'collector-r2-importer', 'v-point');

INSERT INTO source_external_ids (producer_id, external_source_id, source_id) VALUES
  ('collector-r2-importer', 'v-point', 'v-point');

INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES
  (
    'v-point',
    'storage',
    'raw/v-point/{date}/{run-id}/{artifact}.json',
    'v1',
    'collector-r2-v1',
    'V Point private staging R2 response, summary, or manifest'
  ),
  (
    'v-point',
    'storage',
    'derived/v-point-pay-email-reconciliation/{date}/{run-id}.json',
    'v1',
    'collector-r2-v1',
    'V Point collector-generated summary over archived V Point Pay email evidence'
  );
