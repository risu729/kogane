SELECT
  (
    SELECT COUNT(*)
    FROM active_ingest_routes
    WHERE ingest_client_id = 'collector-r2-global-pass'
      AND producer_id = 'collector-r2-importer'
      AND source_id = 'global-pass'
  ) AS route_count,
  (
    SELECT COUNT(*)
    FROM origin_template_policies
    WHERE source_id = 'global-pass'
      AND origin_kind = 'storage'
      AND template = 'raw/prestia-globalpass/{date}/{run-id}/{artifact}'
      AND redaction_version = 'v1'
      AND fingerprint_key_version = 'collector-r2-v1'
      AND active = 1
  ) AS policy_count;
