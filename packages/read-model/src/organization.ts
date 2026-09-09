// The organization read: for a bounded set of already-authorized observation
// keys, the sealed identity run that organizes each one and the mapping
// revision the requested read mode reports for it. Moved here from the
// evidence browser so the read mode is a named input of the query rather than
// a rewrite of its text.
import { type IdentityReadMode, MAPPING_RELATIONS } from "./identity";

// Do not widen a 500-row list into a bulk download of every provider body.
// These fixed paths retain JSON types and missing fields (not synthetic nulls).
// Unsupported sources need no body; oversized supported metadata fails closed.
const PRODUCT_EXTRA = "coalesce(b.extra_json,v.extra_json,t.extra_json,h.extra_json,'{}')";
export const PRODUCT_METADATA_LIMIT = 8192;
function productProjection(path: string, keys: readonly string[]): string {
  return `(SELECT json_group_object(j.key,CASE j.type
    WHEN 'object' THEN json(j.value) WHEN 'array' THEN json(j.value)
    WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') ELSE j.value END)
    FROM json_each(${PRODUCT_EXTRA},'${path}') j WHERE j.key IN (${keys.map((key) => `'${key}'`).join(",")}))`;
}
const PRODUCT_PROJECTED = `json_set(
  ${productProjection("$", ["productCode", "currency", "accountNo", "currencyCd", "通貨"])},
  '$._kogane',json(${productProjection("$._kogane", ["sourceView", "productCode", "subjectCurrency"])}),
  '$.transaction',json(${productProjection("$.transaction", ["currencyCd"])}))`;
const PRODUCT_SUPPORTED = "sa.source_id IN ('sbi-shinsei-bank','sony-bank')";
const PRODUCT_METADATA = `CASE WHEN ${PRODUCT_SUPPORTED} THEN
  CASE WHEN length(${PRODUCT_PROJECTED})<=${PRODUCT_METADATA_LIMIT} THEN ${PRODUCT_PROJECTED} ELSE '{}' END
  ELSE '{}' END`;

/**
 * Start with the already-authorized bounded page (`?1` is a JSON array of
 * `{kind,id}`). Keyed observation lookup avoids rescanning the current
 * catalogue per row. Historical B rows can display their latest eligible
 * sealed interpretation, explicitly marked historical. The run's policy
 * release is reported for every row so a response can say what it read.
 */
export function organizationSql(mode: IdentityReadMode): string {
  const mapping = MAPPING_RELATIONS[mode];
  return `WITH wanted AS MATERIALIZED (
 SELECT json_extract(value,'$.kind') kind,json_extract(value,'$.id') id FROM json_each(?1)
), ranked AS MATERIALIZED (
 SELECT o.*,p.id parse_run_id,p.parser_name,a.id artifact_id,a.dataset,
 p.superseded_by_parse_run_id IS NOT NULL historical,
 row_number() OVER(PARTITION BY o.kind,o.observation_id ORDER BY r.policy_version DESC) choice
 FROM wanted w
 CROSS JOIN identity_observations o ON o.kind=w.kind AND o.observation_id=w.id
 CROSS JOIN eligible_identity_runs r ON r.id=o.identity_run_id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 CROSS JOIN parse_runs p ON p.id=r.parse_run_id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
)
SELECT o.kind,o.observation_id,o.historical,o.parse_run_id,o.parser_name,o.artifact_id,o.dataset,
 coalesce(b.raw_locator,v.raw_locator,t.raw_locator,h.raw_locator) raw_locator,
 coalesce(b.instrument,v.currency,t.currency,h.currency) product_currency,
 v.subject product_subject,
 coalesce(b.as_of,v.as_of,t.as_of,h.as_of) product_as_of,
 coalesce(b.observed_at,v.observed_at,t.observed_at,h.observed_at) product_observed_at,
 ${PRODUCT_METADATA} product_extra,
 CASE WHEN ${PRODUCT_SUPPORTED} THEN length(${PRODUCT_PROJECTED})>${PRODUCT_METADATA_LIMIT} ELSE 0 END product_metadata_oversized,
 sa.source_id source,sa.producer_id producer,json_extract(sa.reference_json,'$[0]') source_account,
 ctx.policy_release identity_release,
 am.source_account_id account_reference,am.account_id account_target,
 am.label account_label,am.status account_status,am.revision account_revision,
 am.method account_method,am.reason account_reason,
 u.role,d.id instrument_reference,im.instrument_id instrument_target,
 im.label instrument_label,im.status instrument_status,im.revision instrument_revision,
 im.method instrument_method,im.reason instrument_reason,d.namespace,d.scope,d.value
FROM ranked o ${mapping.account}
JOIN source_accounts sa ON sa.id=o.source_account_id
JOIN identity_run_contexts ctx ON ctx.identity_run_id=o.identity_run_id
LEFT JOIN balance_observations b ON o.kind='balance' AND b.id=o.observation_id AND b.parse_run_id=o.parse_run_id
LEFT JOIN valuation_observations v ON o.kind='valuation' AND v.id=o.observation_id AND v.parse_run_id=o.parse_run_id
LEFT JOIN transaction_observations t ON o.kind='transaction' AND t.id=o.observation_id AND t.parse_run_id=o.parse_run_id
LEFT JOIN position_observations h ON o.kind='position' AND h.id=o.observation_id AND h.parse_run_id=o.parse_run_id
LEFT JOIN identity_instrument_uses u ON u.identity_observation_id=o.id
LEFT JOIN instrument_identifiers d ON d.id=u.identifier_id
${mapping.instrument}
WHERE o.choice=1 ORDER BY o.kind,o.observation_id,u.role`;
}
