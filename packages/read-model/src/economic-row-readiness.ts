import type {
  EconomicRowEvidence,
  EconomicRowRef,
  ReadinessFamily,
} from "../../domain/src/economic-row-readiness.ts";
import { cardSettlementOwnershipCtes } from "./card-settlement-ownership.ts";
import { providerAliasClassSql } from "./card-settlement-readiness.ts";
import type { SqlExecutor } from "./reader.ts";

// No payload-bearing columns before the restriction gate. Current restrictions
// apply regardless of their recorded since (not an effective-time permission).
const ALIAS = providerAliasClassSql({
  sourceId: "s.source_id",
  parserName: "s.parser_name",
  sourceAccount: "s.source_account",
  extraJson: "s.extra_json",
  accountId: "m.account_id",
});

/** One statement owns ALL data/meta/holder reads; no two-statement epoch shortcut. */
export const ECONOMIC_ROW_READINESS_SQL = `WITH wanted AS MATERIALIZED (
 SELECT json_extract(value,'$.observationId') AS observation_id,json_extract(value,'$.parseRunId') AS parse_run_id FROM json_each(?1)
), refs AS MATERIALIZED (
 SELECT w.*,t.id IS NOT NULL AS found,p.fetch_artifact_id,p.parser_name,a.fetch_run_id,a.sha256,
 EXISTS(SELECT 1 FROM evidence_use_restrictions e WHERE e.evidence_ref IN (
 'transaction:'||w.observation_id,'parse_run:'||w.parse_run_id,'artifact:'||p.fetch_artifact_id,
 'fetch_run:'||a.fetch_run_id,'raw:'||a.sha256)) AS restricted
 FROM wanted w LEFT JOIN transaction_observations t ON t.id=w.observation_id AND t.parse_run_id=w.parse_run_id
 LEFT JOIN parse_runs p ON p.id=t.parse_run_id LEFT JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
), safe AS MATERIALIZED (
 SELECT r.observation_id,r.parse_run_id,t.source_account,t.external_id,t.extra_json,a.source_id,p.parser_name,
 json_array(a.source_id,f.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS key_text
 FROM refs r CROSS JOIN transaction_observations t ON t.id=r.observation_id AND t.parse_run_id=r.parse_run_id
 CROSS JOIN parse_runs p ON p.id=t.parse_run_id AND p.status='ok'
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN financial_fetch_runs f ON f.id=a.fetch_run_id
 CROSS JOIN observation_fetch_runs outcome ON outcome.id=f.id AND outcome.status='success' AND outcome.failure_count=0
 CROSS JOIN acquisition_sessions ses ON ses.id=f.acquisition_session_id
 WHERE r.found=1 AND r.restricted=0
), observed AS (SELECT observation_id FROM safe),
${cardSettlementOwnershipCtes("transaction")},
 mappings AS MATERIALIZED (
 SELECT DISTINCT o.observation_id,m.id,m.source_account_id,m.revision,m.account_id,m.status
 FROM owned_identity o CROSS JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
), mapping_summary AS MATERIALIZED (
 SELECT observation_id,count(*) AS mapping_count,
 CASE WHEN count(*)=1 THEN min(account_id) END AS account_id,
 CASE WHEN count(*)=1 THEN min(status) END AS status
 FROM mappings GROUP BY observation_id
), keyed AS MATERIALIZED (
 SELECT s.*,m.mapping_count,m.account_id,m.status AS mapping_status,o.owner_ref,${ALIAS} AS alias_text
 FROM safe s LEFT JOIN mapping_summary m ON m.observation_id=s.observation_id
 LEFT JOIN ownership o ON o.observation_id=s.observation_id
)
SELECT r.observation_id,r.parse_run_id,r.found,r.restricted,k.observation_id IS NOT NULL AS visible,
 pub.parse_run_id AS current_parse,k.source_id,k.parser_name,k.source_account,k.external_id,k.extra_json,k.key_text,k.alias_text,
 coalesce(k.mapping_count,0) AS mapping_count,k.mapping_status,k.account_id,k.owner_ref,
 (SELECT json_group_array(json_array(h.event_id,h.revision)) FROM (
  SELECT c.event_id,c.revision FROM economic_claims c
   JOIN economic_event_revisions v ON v.event_id=c.event_id AND v.revision=c.revision AND v.superseded_by IS NULL
   WHERE c.book=?2 AND c.consumption_key=k.key_text
  UNION
  SELECT d.event_id,d.revision FROM card_settlement_candidates c
   JOIN card_settlement_decisions d ON d.proposal_id=c.id AND d.status='accepted'
   JOIN economic_event_revisions v ON v.event_id=d.event_id AND v.revision=d.revision AND v.superseded_by IS NULL
   WHERE ?2='cash-movement' AND c.bank_key=k.key_text
  ORDER BY 1,2
 ) h) AS key_holders,
 (SELECT json_group_array(json_array(h.event_id,h.revision)) FROM (
  SELECT c.event_id,c.revision FROM economic_claims c
   JOIN economic_event_revisions v ON v.event_id=c.event_id AND v.revision=c.revision AND v.superseded_by IS NULL
   WHERE c.book=?2 AND c.alias_class=k.alias_text ORDER BY c.event_id,c.revision
 ) h) AS alias_holders,
 json_object('guardObjects',(SELECT count(*) FROM sqlite_schema WHERE
   (type='trigger' AND name IN ('economic_claims_guard','economic_claims_one_live_holder','economic_claims_alias_one_live_holder','economic_commit_log_guard'))
   OR (type='table' AND name IN ('economic_commit_log','economic_revision_seals'))),
 'core', (SELECT json_array(core_epoch,source_revision,visibility_revision) FROM core_source_revision WHERE id=1),
 'identityEpoch',(SELECT identity_epoch FROM economic_identity_epochs ORDER BY ordinal DESC LIMIT 1),
 'economicSequence',(SELECT coalesce(max(commit_seq),0) FROM economic_commit_log WHERE core_epoch=(SELECT core_epoch FROM core_source_revision WHERE id=1)),
 'publication',json_array(pub.parse_run_id,pub.parser_version,pub.published_at,pub.publication_kind,pub.release_id),
 'mappings',(SELECT json_group_array(json_array(m.id,m.source_account_id,m.revision,m.account_id,m.status)) FROM
   (SELECT * FROM mappings m WHERE m.observation_id=r.observation_id ORDER BY m.id) m),
 'ownership',(SELECT json_group_array(json_array(x.id,x.kind,x.from_ref,x.to_ref,x.status,x.valid_from,x.valid_to,x.decision_revision_id,x.superseded_by,x.revision)) FROM (
   SELECT e.*,d.superseded_by,d.revision FROM mapping_summary m
   CROSS JOIN entity_relations e ON e.from_ref IN(m.account_id,'account:'||m.account_id) AND e.kind='beneficial_owner'
   JOIN decision_revisions d ON d.id=e.decision_revision_id WHERE m.observation_id=r.observation_id ORDER BY e.id
 ) x),
 'restrictions',(SELECT json_group_array(json_array(e.id,e.restriction)) FROM (SELECT e.id,e.restriction FROM evidence_use_restrictions e
 WHERE e.evidence_ref IN ('transaction:'||r.observation_id,'parse_run:'||r.parse_run_id,'artifact:'||r.fetch_artifact_id,
 'fetch_run:'||r.fetch_run_id,'raw:'||r.sha256) ORDER BY e.id) e)) AS pins
FROM refs r LEFT JOIN keyed k ON k.observation_id=r.observation_id
LEFT JOIN published_parse_runs pub ON pub.fetch_artifact_id=r.fetch_artifact_id AND pub.parser_name=r.parser_name
ORDER BY r.observation_id,r.parse_run_id`;

export async function loadEconomicRowReadiness(
  sql: SqlExecutor,
  rows: EconomicRowRef[],
  family: ReadinessFamily,
): Promise<EconomicRowEvidence[]> {
  return sql.all<EconomicRowEvidence>(ECONOMIC_ROW_READINESS_SQL, [
    JSON.stringify(rows),
    family === "bank-movement" ? "cash-movement" : "security-quantity",
  ]);
}
