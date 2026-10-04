WITH debits AS MATERIALIZED (
 SELECT * FROM card_bank_debit_facts
 WHERE debit_date BETWEEN date(?1,'-3 days') AND date(?2,'+3 days') ORDER BY id LIMIT ?3
), observed AS (SELECT id AS observation_id FROM debits),
owned_runs AS MATERIALIZED (
 SELECT DISTINCT r.parse_run_id FROM observed
 CROSS JOIN identity_observations o ON o.kind='transaction' AND o.observation_id=observed.observation_id
 CROSS JOIN identity_runs r ON r.id=o.identity_run_id
), owned_candidates AS MATERIALIZED (
 SELECT r.id,r.parse_run_id,r.policy_version
 FROM owned_runs
 CROSS JOIN published_parse_runs pub ON pub.parse_run_id=owned_runs.parse_run_id
 CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
 CROSS JOIN eligible_identity_runs r ON r.parse_run_id=p.id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
), owned_latest AS MATERIALIZED (
 SELECT parse_run_id,max(policy_version) AS policy_version
 FROM owned_candidates GROUP BY parse_run_id
), owned_identity AS MATERIALIZED (
 SELECT o.* FROM (SELECT DISTINCT observation_id FROM observed) observed_ids
 CROSS JOIN identity_observations o ON o.kind='transaction' AND o.observation_id=observed_ids.observation_id
 CROSS JOIN owned_candidates r ON r.id=o.identity_run_id
 CROSS JOIN owned_latest l ON l.parse_run_id=r.parse_run_id AND l.policy_version=r.policy_version
), ownership AS (
SELECT owned.kind,owned.observation_id,
 CASE WHEN count(DISTINCT m.account_id)=1 THEN min(m.account_id) END AS account_id,
 CASE WHEN count(DISTINCT m.account_id)=1 AND count(DISTINCT r.to_ref)=1 THEN min(r.to_ref) END AS owner_ref,
 json_array('account_mapping:'||min(m.id),'relation:'||min(r.id),'decision:'||min(d.id)) AS evidence_refs_json
FROM owned_identity owned
CROSS JOIN current_account_mappings m ON m.source_account_id=owned.source_account_id
LEFT JOIN entity_relations r ON r.from_ref IN(m.account_id,'account:'||m.account_id)
 AND r.kind=CASE WHEN owned.kind='balance' THEN 'liable_party' ELSE 'beneficial_owner' END AND r.status='accepted'
 AND r.valid_from IS NULL AND r.valid_to IS NULL
 AND NOT EXISTS(SELECT 1 FROM entity_relations dated
  JOIN decision_revisions dated_decision ON dated_decision.id=dated.decision_revision_id AND dated_decision.superseded_by IS NULL
  WHERE dated.from_ref IN(m.account_id,'account:'||m.account_id)
   AND dated.kind=CASE WHEN owned.kind='balance' THEN 'liable_party' ELSE 'beneficial_owner' END
   AND dated.status='accepted' AND (dated.valid_from IS NOT NULL OR dated.valid_to IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM entity_relations latest WHERE latest.kind=dated.kind
    AND latest.from_ref IN(m.account_id,'account:'||m.account_id) AND latest.to_ref=dated.to_ref AND latest.rowid>dated.rowid))
 AND NOT EXISTS(SELECT 1 FROM entity_relations newer WHERE newer.kind=r.kind
  AND newer.from_ref IN(m.account_id,'account:'||m.account_id) AND newer.to_ref=r.to_ref AND newer.rowid>r.rowid)
LEFT JOIN decision_revisions d ON d.id=r.decision_revision_id AND d.superseded_by IS NULL
WHERE owned.kind IN ('balance','transaction') AND (r.id IS NULL OR d.id IS NOT NULL)
GROUP BY owned.kind,owned.observation_id)
SELECT debits.*,ownership.account_id,ownership.owner_ref,ownership.evidence_refs_json FROM debits
 LEFT JOIN ownership ON ownership.observation_id=debits.id ORDER BY debits.id