-- Frozen from d6753e38 before the identity sweep cost rewrite.
SELECT p.id,a.id AS artifact_id,a.source_id,r.producer_id,a.fetch_run_id,
      CASE WHEN a.source_id='vpass' AND EXISTS(
    SELECT 1 FROM trusted_vpass_card_bindings binding WHERE binding.financial_artifact_id=a.id)
    THEN 2 WHEN a.source_id='mizuho-bank'
    THEN 2 ELSE 1 END AS required_policy,
      (NOT EXISTS(SELECT 1 FROM transaction_observations empty_row WHERE empty_row.parse_run_id=p.id) AND NOT EXISTS(SELECT 1 FROM balance_observations empty_row WHERE empty_row.parse_run_id=p.id) AND NOT EXISTS(SELECT 1 FROM position_observations empty_row WHERE empty_row.parse_run_id=p.id) AND NOT EXISTS(SELECT 1 FROM valuation_observations empty_row WHERE empty_row.parse_run_id=p.id)) AS is_empty
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN financial_fetch_runs r ON r.id=a.fetch_run_id
    JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
    WHERE p.status='ok' AND f.status='success' AND f.failure_count=0 AND (?1 IS NULL OR a.source_id=?1) AND NOT EXISTS(
      SELECT 1 FROM identity_runs i JOIN identity_run_seals s ON s.identity_run_id=i.id
      WHERE i.parse_run_id=p.id AND i.policy_version>=CASE WHEN a.source_id='vpass' AND EXISTS(
    SELECT 1 FROM trusted_vpass_card_bindings binding WHERE binding.financial_artifact_id=a.id)
    THEN 2 WHEN a.source_id='mizuho-bank'
    THEN 2 ELSE 1 END)
    ORDER BY NOT EXISTS(SELECT 1 FROM published_parse_runs pub WHERE pub.parse_run_id=p.id),p.id LIMIT ?2;
