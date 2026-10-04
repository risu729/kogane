import { IDENTITY_POLICY_VERSION, requiredIdentityPolicySql } from "./identity-policies/index.ts";

export const EMPTY_IDENTITY_PARSE_SQL = ["transaction", "balance", "position", "valuation"]
  .map(
    (kind) =>
      `NOT EXISTS(SELECT 1 FROM ${kind}_observations empty_row WHERE empty_row.parse_run_id=p.id)`,
  )
  .join(" AND ");

/**
 * One acquisition eligibility join, with emptiness checked only for the page.
 * IDENTITY_POLICY_VERSION is the highest policy this build can require:
 * a sealed version at least that high never needs the trusted-binding lookup.
 * The aggregate includes sealed runs only, so unfinished upgrades cannot hide
 * candidates. CASE keeps auxiliary evidence reads out of the completed path.
 */
export function identitySweepCandidatesSql(sourceScoped: boolean): string {
  return `WITH identity_page AS MATERIALIZED (
    SELECT p.id,a.id AS artifact_id,a.source_id,f.tool AS producer_id,a.fetch_run_id,
      ${requiredIdentityPolicySql("a")} AS required_policy
    FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
    WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
      ${sourceScoped ? "AND a.source_id=?1" : ""}
      AND (SELECT CASE
          WHEN max(i.policy_version)>=${IDENTITY_POLICY_VERSION} THEN 0
          WHEN max(i.policy_version) IS NULL THEN 1
          ELSE max(i.policy_version)<${requiredIdentityPolicySql("a")} END
        FROM identity_runs i JOIN identity_run_seals s ON s.identity_run_id=i.id
        WHERE i.parse_run_id=p.id)
    ORDER BY NOT EXISTS(SELECT 1 FROM published_parse_runs pub WHERE pub.parse_run_id=p.id),p.id
    LIMIT ?2
  )
  SELECT p.id,p.artifact_id,p.source_id,p.producer_id,p.fetch_run_id,p.required_policy,
    (${EMPTY_IDENTITY_PARSE_SQL}) AS is_empty
  FROM identity_page p
  ORDER BY NOT EXISTS(SELECT 1 FROM published_parse_runs pub WHERE pub.parse_run_id=p.id),p.id`;
}
