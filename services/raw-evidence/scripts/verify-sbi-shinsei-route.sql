SELECT
  (
    SELECT COUNT(*)
    FROM active_ingest_routes
    WHERE ingest_client_id = 'collector-r2-sbi-shinsei'
      AND producer_id = 'collector-r2-importer'
      AND source_id = 'sbi-shinsei-bank'
  ) AS route_count,
  (
    SELECT COUNT(*)
    FROM origin_template_policies
    WHERE source_id = 'sbi-shinsei-bank'
      AND origin_kind = 'storage'
      AND template = 'raw/sbi-shinsei/{date}/{run-id}/{artifact}'
      AND redaction_version = 'v1'
      AND fingerprint_key_version = 'collector-r2-v1'
      AND active = 1
  ) AS policy_count;
