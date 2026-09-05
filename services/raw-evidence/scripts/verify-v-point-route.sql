SELECT
  (
    SELECT COUNT(*)
    FROM active_ingest_routes
    WHERE ingest_client_id = 'collector-r2-v-point'
      AND producer_id = 'collector-r2-importer'
      AND source_id = 'v-point'
  ) AS route_count,
  (
    SELECT COUNT(*)
    FROM origin_template_policies
    WHERE source_id = 'v-point'
      AND origin_kind = 'storage'
      AND template IN (
        'raw/v-point/{date}/{run-id}/{artifact}.json',
        'derived/v-point-pay-email-reconciliation/{date}/{run-id}.json'
      )
      AND redaction_version = 'v1'
      AND fingerprint_key_version = 'collector-r2-v1'
      AND active = 1
  ) AS policy_count,
  (
    SELECT COUNT(*)
    FROM source_external_ids
    WHERE producer_id = 'collector-r2-importer'
      AND external_source_id = 'v-point'
      AND source_id = 'v-point'
  ) AS alias_count;
