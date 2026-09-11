-- Give the SBI VC Trade outbox its own credential and route. It cannot ingest
-- another collector's source even though the internal importer hosts both.
INSERT INTO ingest_clients (id, display_name) VALUES
  ('collector-r2-sbi-vc', 'SBI VC Trade collector R2 importer');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES
  ('collector-r2-sbi-vc', 'collector-r2-importer');

INSERT INTO ingest_client_routes (
  ingest_client_id, producer_id, source_id
) VALUES (
  'collector-r2-sbi-vc', 'collector-r2-importer', 'sbi-vc-trade'
);

INSERT INTO source_external_ids (
  producer_id, external_source_id, source_id
) VALUES (
  'collector-r2-importer', 'sbi-vc-trade', 'sbi-vc-trade'
);

INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version,
  fingerprint_key_version, note
) VALUES (
  'sbi-vc-trade',
  'storage',
  'raw/sbi-vc-trade/{date}/{run-id}/{artifact}.json',
  'v1',
  'collector-r2-v1',
  'SBI VC Trade private staging R2 artifact or manifest'
);
