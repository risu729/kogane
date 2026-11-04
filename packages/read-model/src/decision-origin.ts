/**
 * Classify inside the read: raw actor ids never enter presentation contracts.
 * A prefix alone is not evidence: the immutable operation must verify the same
 * actor on the server. Unknown/legacy provenance never becomes an operator.
 */
export function decisionOriginSql(decision: string): string {
  return `CASE WHEN ${decision}.method IN ('rule','ai') THEN 'automatic'
 WHEN ${decision}.method='legacy-migration' THEN 'legacy'
 WHEN EXISTS(SELECT 1 FROM decision_operations origin_op
  WHERE origin_op.operation_id=${decision}.operation_id
   AND origin_op.actor_id=${decision}.actor_id AND origin_op.actor_verification='server')
 THEN CASE WHEN substr(${decision}.actor_id,1,11)='mcp-client:'
  AND length(${decision}.actor_id)>11 THEN 'delegated'
  WHEN substr(${decision}.actor_id,1,11)<>'mcp-client:' THEN 'operator'
  ELSE 'unknown' END
 WHEN EXISTS(SELECT 1 FROM decision_operations origin_op
  WHERE origin_op.operation_id=${decision}.operation_id
   AND origin_op.actor_verification='legacy-unknown') THEN 'legacy'
 ELSE 'unknown' END`;
}

/** Exact assignment revision, not its later release or the caller's identity. */
export function mappingDecisionOriginSql(
  kind: "account_mapping" | "instrument_mapping",
  reference: string,
  revision: string,
  method: string,
): string {
  return `CASE WHEN ${method}='rule' THEN 'automatic'
 ELSE coalesce((SELECT CASE WHEN count(*)=1 THEN ${decisionOriginSql("origin_d")}
  ELSE 'unknown' END FROM decision_revisions origin_d
  WHERE origin_d.subject_kind='${kind}' AND origin_d.subject_ref=${reference}
   AND origin_d.revision=${revision} AND origin_d.decision_kind='assign'), 'unknown') END`;
}
