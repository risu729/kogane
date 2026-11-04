// Frozen shipped candidate query and binding construction from f6fb5bdd0294140a88b064794653290ec8b34692.
// Never derive this fixture from the current mapping or query.
import type { BucketKind } from "../../../packages/domain/src/rewards.ts";

/** One promotion rule: which published measure becomes which kind of bucket. */
interface PromotionRule {
  sourceId: string;
  parserName: string;
  metric: string;
  /** Matched against `source_account` when present; the first match wins. */
  sourceAccountPrefix?: string;
  sourceAccountEquals?: string;
  programId: string;
  /**
   * The member holding every bucket of this rule belongs to. It is the
   * programme's account, not the provider's per-bucket display slot: those
   * become bucket references below.
   */
  holdingRef: string;
  unitRef: string;
  bucketKind: BucketKind;
  restrictionRefs: string[];
}

/**
 * Only the three sources whose unit is documented in `docs/sources` are
 * promoted. The order matters: the store-limited prefix must be tried before
 * the general V Point bucket rule, exactly as `classifyBalance` does today.
 */
export const PROMOTION_RULES: readonly PromotionRule[] = [
  {
    sourceId: "v-point",
    parserName: "v-point-balance-info",
    metric: "available_point_bucket",
    sourceAccountPrefix: "v-point:store-limited:",
    programId: "program:v-point",
    holdingRef: "program:v-point:member",
    unitRef: "points:v-point",
    bucketKind: "restricted",
    restrictionRefs: ["restriction:v-point:store-limited"],
  },
  {
    sourceId: "v-point",
    parserName: "v-point-balance-info",
    metric: "available_point_bucket",
    // Expiry dates do not establish bucket semantics. The provider enum stays
    // unmapped; classification evidence remains in the original balance row
    // referenced by source_fact_id (including its raw locator and extra_json).
    programId: "program:v-point",
    holdingRef: "program:v-point:member",
    unitRef: "points:v-point",
    bucketKind: "unclassified",
    restrictionRefs: [],
  },
  {
    sourceId: "v-point",
    parserName: "v-point-smfg-point",
    metric: "displayed_point_balance",
    programId: "program:v-point",
    holdingRef: "program:v-point:member",
    unitRef: "points:v-point",
    // Last month's earnings: a period total, never part of the holding.
    bucketKind: "qualification",
    restrictionRefs: ["measure:v-point:previous-month-earned"],
  },
  {
    sourceId: "v-point-pay",
    parserName: "v-point-pay-notification-event",
    metric: "prepaid_balance_after_event",
    programId: "program:v-point-pay",
    holdingRef: "program:v-point-pay:prepaid-yen",
    unitRef: "JPY",
    bucketKind: "regular",
    restrictionRefs: ["restriction:v-point-pay:prepaid-usage"],
  },
  {
    sourceId: "mobile-suica",
    parserName: "mobile-suica-sf-history",
    metric: "sf_balance_after_transaction",
    sourceAccountEquals: "mobile-suica:sf",
    programId: "program:mobile-suica-sf",
    holdingRef: "program:mobile-suica-sf:sf",
    unitRef: "JPY",
    bucketKind: "regular",
    restrictionRefs: ["restriction:mobile-suica:sf-usage"],
  },
];

// `parser_name` on a parse run carries no version suffix; the eligibility
// filter is the publication projection plus the same successful-run predicate
// every other reader uses (docs/publication-gate.md).
// Apply the same source/parser/measure/account/unit eligibility before LIMIT.
// Otherwise an all-ineligible page never writes a claim and the derived cursor
// cannot advance. Values come from the mapping rules and remain SQL bindings.
const candidateBindings: string[] = [];
const candidateScope = PROMOTION_RULES.map((rule) => {
  const parameter = (value: string) => {
    candidateBindings.push(value);
    return `?${candidateBindings.length + 2}`;
  };
  const clauses = [
    `a.source_id=${parameter(rule.sourceId)}`,
    `p.parser_name=${parameter(rule.parserName)}`,
    `b.metric=${parameter(rule.metric)}`,
  ];
  if (rule.sourceAccountPrefix) {
    const prefix = parameter(rule.sourceAccountPrefix);
    clauses.push(`substr(b.source_account,1,length(${prefix}))=${prefix}`);
  }
  if (rule.sourceAccountEquals)
    clauses.push(`b.source_account=${parameter(rule.sourceAccountEquals)}`);
  if (rule.unitRef === "JPY") clauses.push(`b.instrument=${parameter("JPY")}`);
  return `(${clauses.join(" AND ")})`;
}).join(" OR ");

const CANDIDATE_SQL = `SELECT b.id,b.parse_run_id,a.source_id,p.parser_name,b.source_account,b.metric,
 b.instrument,b.observed_at,b.as_of,b.extra_json,
 d.status AS decimal_status,d.coefficient,d.scale
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 LEFT JOIN observation_decimal_values d
   ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
 WHERE f.status='success' AND f.failure_count=0 AND (${candidateScope})
 AND NOT EXISTS (
   SELECT 1 FROM reward_bucket_claims_v2 claimed
   WHERE claimed.source_fact_kind='balance' AND claimed.source_fact_id=b.id
     AND claimed.promotion_release=?1
 )
 ORDER BY b.id LIMIT ?2`;

export const FROZEN_REWARD_CANDIDATE_QUERY = Object.freeze({
  sql: CANDIDATE_SQL,
  scopeBindings: Object.freeze([...candidateBindings]),
});
