SELECT
  (
    SELECT COUNT(*)
    FROM active_ingest_routes
    WHERE ingest_client_id = 'collector-r2-v-point-pay-email'
      AND producer_id = 'collector-r2-importer'
      AND source_id = 'v-point-pay'
  ) AS route_count,
  (
    SELECT COUNT(*)
    FROM origin_template_policies
    WHERE source_id = 'v-point-pay'
      AND origin_kind = 'storage'
      AND template = 'raw/v-point-pay-email/{date}/{message-sha256}.{extension}'
      AND redaction_version = 'v1'
      AND fingerprint_key_version = 'collector-r2-v1'
      AND active = 1
  ) AS policy_count,
  (
    SELECT COUNT(*)
    FROM source_external_ids
    WHERE producer_id = 'collector-r2-importer'
      AND external_source_id = 'v-point-pay-email'
      AND source_id = 'v-point-pay'
  ) AS alias_count;
