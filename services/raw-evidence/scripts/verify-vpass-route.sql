SELECT
  (
    SELECT COUNT(*) FROM active_ingest_routes
    WHERE ingest_client_id = 'collector-r2-vpass'
      AND producer_id = 'collector-r2-importer'
      AND source_id = 'vpass'
  ) AS route_count,
  (
    SELECT COUNT(*) FROM origin_template_policies
    WHERE source_id = 'vpass'
      AND origin_kind = 'storage'
      AND template = 'vpass/{date}/{run-id}/{artifact}'
      AND redaction_version = 'v1'
      AND fingerprint_key_version = 'collector-r2-v1'
      AND active = 1
  ) AS policy_count,
  (
    SELECT COUNT(*) FROM source_external_ids
    WHERE producer_id = 'collector-r2-importer'
      AND external_source_id = 'vpass'
      AND source_id = 'vpass'
  ) AS alias_count;
