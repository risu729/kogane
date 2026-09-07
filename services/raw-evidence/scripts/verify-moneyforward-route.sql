SELECT
  (
    SELECT COUNT(*) FROM active_ingest_routes
    WHERE ingest_client_id = 'collector-r2-moneyforward'
      AND producer_id = 'collector-r2-importer'
      AND source_id = 'moneyforward-me'
  ) AS route_count,
  (
    SELECT COUNT(*) FROM origin_template_policies
    WHERE source_id = 'moneyforward-me'
      AND origin_kind = 'storage'
      AND template = 'raw/moneyforward/{date}/{run-id}/{artifact}'
      AND redaction_version = 'v1'
      AND fingerprint_key_version = 'collector-r2-v1'
      AND active = 1
  ) AS policy_count,
  (
    SELECT COUNT(*) FROM source_external_ids
    WHERE producer_id = 'collector-r2-importer'
      AND external_source_id = 'moneyforward-me'
      AND source_id = 'moneyforward-me'
  ) AS alias_count;
