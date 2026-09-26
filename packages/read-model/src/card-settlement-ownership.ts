// `card_settlement_fact_ownership` (migration 0044) for named observations only.
//
// The view groups every current identity observation of a kind, and its
// `current_identity_observations` source materializes the candidate identity
// runs of every published parse run in the store before anything filters it.
// A statement or a bank debit that needs its owner therefore paid for the
// whole history: on D1, which never runs `ANALYZE`, one lookup read every
// published parse (`SCAN pub`) and every identity observation of the kind.
//
// These CTEs compute the same rows for the observations a caller names. The
// caller defines `observed(observation_id)` before them; they add
//
//   owned_runs        the parse runs of the identity runs naming those observations;
//   owned_candidates  `current_identity_observations`' `candidates`, for those parse runs;
//   owned_latest      its `latest`, for those parse runs;
//   owned_identity    its rows, for the named observations;
//   ownership         the view's own select over them: kind, observation_id,
//                     account_id, owner_ref, evidence_refs_json.
//
// They are exact, not an approximation: a candidate identity run and the
// latest policy of a parse depend on that parse alone, so restricting both to
// the parses that can hold an identity of a named observation leaves every row
// the view would give it unchanged. The aggregate is the view's text with its
// source swapped for `owned_identity`, aliased `owned` (a name no plan confuses
// with a table) and read first, so each mapping is found by key. Eligibility,
// publication, run status, mappings and ownership claims are still read
// through the same views and tables. card-settlement-ownership.test.ts compares
// these CTEs with the view on random stores, and every caller's differential
// test compares its read with the shipped text.
export type OwnershipKind = "balance" | "transaction";

/**
 * Names for another set of these CTEs in the same statement (the readiness
 * CTEs own statements and debits together): `prefix` goes before every CTE
 * name (`owned_runs` ... `ownership`), and `observed` names the caller's CTE
 * of observation ids. Without them the text is the one above.
 */
export interface OwnershipCteNames {
  prefix?: string;
  observed?: string;
}

export function cardSettlementOwnershipCtes(
  kind: OwnershipKind,
  names: OwnershipCteNames = {},
): string {
  const at = names.prefix ?? "";
  const observed = names.observed ?? "observed";
  return `${at}owned_runs AS MATERIALIZED (
 SELECT DISTINCT r.parse_run_id FROM ${observed}
 CROSS JOIN identity_observations o ON o.kind='${kind}' AND o.observation_id=${observed}.observation_id
 CROSS JOIN identity_runs r ON r.id=o.identity_run_id
), ${at}owned_candidates AS MATERIALIZED (
 SELECT r.id,r.parse_run_id,r.policy_version
 FROM ${at}owned_runs
 CROSS JOIN published_parse_runs pub ON pub.parse_run_id=${at}owned_runs.parse_run_id
 CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
 CROSS JOIN eligible_identity_runs r ON r.parse_run_id=p.id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
), ${at}owned_latest AS MATERIALIZED (
 SELECT parse_run_id,max(policy_version) AS policy_version
 FROM ${at}owned_candidates GROUP BY parse_run_id
), ${at}owned_identity AS MATERIALIZED (
 SELECT o.* FROM (SELECT DISTINCT observation_id FROM ${observed}) observed_ids
 CROSS JOIN identity_observations o ON o.kind='${kind}' AND o.observation_id=observed_ids.observation_id
 CROSS JOIN ${at}owned_candidates r ON r.id=o.identity_run_id
 CROSS JOIN ${at}owned_latest l ON l.parse_run_id=r.parse_run_id AND l.policy_version=r.policy_version
), ${at}ownership AS (
SELECT owned.kind,owned.observation_id,
 CASE WHEN count(DISTINCT m.account_id)=1 THEN min(m.account_id) END AS account_id,
 CASE WHEN count(DISTINCT m.account_id)=1 AND count(DISTINCT r.to_ref)=1 THEN min(r.to_ref) END AS owner_ref,
 json_array('account_mapping:'||min(m.id),'relation:'||min(r.id),'decision:'||min(d.id)) AS evidence_refs_json
FROM ${at}owned_identity owned
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
GROUP BY owned.kind,owned.observation_id)`;
}
