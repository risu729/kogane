-- V Point Pay notification mail is a separate canonical source from both the
-- V Point account collector and its derived reconciliation artifact.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-v-point-pay-email', 'V Point Pay email R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-v-point-pay-email', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-v-point-pay-email', 'collector-r2-importer', 'v-point-pay');

INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'v-point-pay',
  'storage',
  'raw/v-point-pay-email/{date}/{message-sha256}.{extension}',
  'v1',
  'collector-r2-v1',
  'Source-unverified V Point Pay email capture and strict normalized event pair'
);
