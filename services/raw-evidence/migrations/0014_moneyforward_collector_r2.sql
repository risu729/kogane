-- MoneyForward uses a dedicated importer credential and a single reviewed
-- private storage origin. The source and external id were registered by 0003.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-moneyforward', 'MoneyForward ME collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-moneyforward', 'collector-r2-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id) VALUES
  ('collector-r2-moneyforward', 'collector-r2-importer', 'moneyforward-me');

INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'moneyforward-me',
  'storage',
  'raw/moneyforward/{date}/{run-id}/{artifact}',
  'v1',
  'collector-r2-v1',
  'MoneyForward ME private staging R2 HTML response or generated manifest'
);
