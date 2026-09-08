/** Aggregate-only audit: no identifiers, labels, references, amounts, or raw issues leave SQL. */
import { requiredIdentityPolicySql } from "./identity-store.ts";
const BASE = `WITH b AS (
 SELECT 'transaction' kind,id,parse_run_id FROM transaction_observations UNION ALL
 SELECT 'balance',id,parse_run_id FROM balance_observations UNION ALL
 SELECT 'position',id,parse_run_id FROM position_observations UNION ALL
 SELECT 'valuation',id,parse_run_id FROM valuation_observations
), eligible AS (
 SELECT b.*,a.source_id FROM b JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL AND f.status='success' AND f.failure_count=0
), c AS (SELECT * FROM current_identity_observations)`;
const ISSUES = [
  "missing-accountKind",
  "missing-specificAccountCode",
  "missing-accountLabel",
  "conflicting-depositTypeCode",
  "missing-monetary-unit",
  "missing-trade-currency",
  "conflicting-settlement-currency",
  "security-without-global-crosswalk",
  "missing-security-identifier",
  "unknown-sbi-account-scope",
  "unrecognized-source-account",
  "execution-quote-unit-conflict",
  "card-ordinal-needs-durable-provider-binding",
  "reward-bucket-semantic-evidence-missing-or-conflicting",
  "reward-bucket-index-not-durable-identity",
] as const;
export const IDENTITY_AUDIT_QUERIES = [
  {
    name: "coverage",
    sql: `${BASE} SELECT s.id source,k.kind,count(e.id) eligible,
    sum(CASE WHEN EXISTS(SELECT 1 FROM c WHERE c.kind=e.kind AND c.observation_id=e.id AND c.parse_run_id=e.parse_run_id) THEN 1 ELSE 0 END) organized
    FROM observation_sources s CROSS JOIN (SELECT 'transaction' kind UNION ALL SELECT 'balance' UNION ALL SELECT 'position' UNION ALL SELECT 'valuation') k
    LEFT JOIN eligible e ON e.source_id=s.id AND e.kind=k.kind GROUP BY s.id,k.kind ORDER BY 1,2 LIMIT 1001`,
  },
  {
    name: "integrity",
    sql: `${BASE} SELECT
    (SELECT count(*) FROM (SELECT kind,observation_id,parse_run_id FROM c GROUP BY 1,2,3 HAVING count(*)>1)) duplicate_current_observation,
    (SELECT count(*) FROM c WHERE NOT EXISTS(SELECT 1 FROM eligible e WHERE e.kind=c.kind AND e.id=c.observation_id AND e.parse_run_id=c.parse_run_id)) ineligible_current_observation,
    (SELECT count(*) FROM c WHERE NOT EXISTS(SELECT 1 FROM identity_run_seals s WHERE s.identity_run_id=c.identity_run_id)) unsealed_current_identity,
    (SELECT count(*) FROM identity_observations o LEFT JOIN identity_runs r ON r.id=o.identity_run_id LEFT JOIN parse_runs p ON p.id=r.parse_run_id LEFT JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id LEFT JOIN fetch_runs f ON f.id=a.fetch_run_id WHERE r.id IS NULL OR p.id IS NULL OR a.id IS NULL OR f.id IS NULL OR NOT EXISTS(SELECT 1 FROM b WHERE b.kind=o.kind AND b.id=o.observation_id AND b.parse_run_id=r.parse_run_id)) orphan_observation_evidence,
    (SELECT count(*) FROM identity_observations o LEFT JOIN source_accounts s ON s.id=o.source_account_id LEFT JOIN account_mappings m ON m.id=o.account_mapping_id LEFT JOIN accounts a ON a.id=m.account_id WHERE s.id IS NULL OR m.id IS NULL OR a.id IS NULL OR m.source_account_id<>o.source_account_id) orphan_account_mapping,
    (SELECT count(*) FROM identity_instrument_uses u LEFT JOIN identity_observations o ON o.id=u.identity_observation_id LEFT JOIN instrument_identifiers d ON d.id=u.identifier_id LEFT JOIN instrument_mappings m ON m.id=u.instrument_mapping_id LEFT JOIN instruments i ON i.id=m.instrument_id WHERE o.id IS NULL OR d.id IS NULL OR m.id IS NULL OR i.id IS NULL OR m.identifier_id<>u.identifier_id) orphan_instrument_mapping,
    (SELECT count(*) FROM identity_run_seals s WHERE s.observation_count<>(SELECT count(*) FROM identity_observations o WHERE o.identity_run_id=s.identity_run_id)) sealed_count_mismatch,
    (SELECT count(*) FROM identity_run_seals s JOIN identity_runs r ON r.id=s.identity_run_id WHERE s.observation_count<>(SELECT count(*) FROM b WHERE b.parse_run_id=r.parse_run_id)) sealed_evidence_count_mismatch`,
  },
  {
    name: "account_status",
    sql: `${BASE} SELECT e.source_id source,m.status,count(*) count FROM c JOIN eligible e ON e.kind=c.kind AND e.id=c.observation_id AND e.parse_run_id=c.parse_run_id JOIN current_account_mappings m ON m.source_account_id=c.source_account_id GROUP BY 1,2 ORDER BY 1,2 LIMIT 1001`,
  },
  {
    name: "instrument_status",
    sql: `${BASE} SELECT e.source_id source,m.status,i.kind,count(*) count FROM c JOIN eligible e ON e.kind=c.kind AND e.id=c.observation_id AND e.parse_run_id=c.parse_run_id JOIN identity_instrument_uses u ON u.identity_observation_id=c.id JOIN current_instrument_mappings m ON m.identifier_id=u.identifier_id JOIN instruments i ON i.id=m.instrument_id GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 1001`,
  },
  {
    name: "issues",
    sql: `${BASE} SELECT e.source_id source,CASE WHEN j.type='text' AND j.value IN (${ISSUES.map((v) => `'${v}'`).join(",")}) THEN j.value ELSE 'other' END issue,count(*) count FROM c JOIN eligible e ON e.kind=c.kind AND e.id=c.observation_id AND e.parse_run_id=c.parse_run_id JOIN json_each(c.issues_json) j GROUP BY 1,2 ORDER BY 1,2 LIMIT 1001`,
  },
  {
    name: "pending_parses",
    sql: `SELECT a.source_id source,CASE WHEN p.superseded_by_parse_run_id IS NULL THEN 'current' ELSE 'historical' END lineage,count(*) eligible_parses,
    sum(CASE WHEN EXISTS(SELECT 1 FROM identity_runs r JOIN identity_run_seals s ON s.identity_run_id=r.id WHERE r.parse_run_id=p.id AND r.policy_version>=(${requiredIdentityPolicySql("a")})) THEN 0 ELSE 1 END) pending_parses
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
    WHERE p.status='ok' AND f.status='success' AND f.failure_count=0 GROUP BY 1,2 ORDER BY 1,2 LIMIT 1001`,
  },
] as const;

const COUNTS = new Set([
  "count",
  "eligible",
  "organized",
  "eligible_parses",
  "pending_parses",
  "duplicate_current_observation",
  "ineligible_current_observation",
  "unsealed_current_identity",
  "orphan_observation_evidence",
  "orphan_account_mapping",
  "orphan_instrument_mapping",
  "sealed_count_mismatch",
  "sealed_evidence_count_mismatch",
]);
const DIMENSIONS = new Set(["source", "kind", "status", "issue", "lineage", "check_name"]);
export function validateIdentityAudit(rows: unknown[][]) {
  if (rows.length !== IDENTITY_AUDIT_QUERIES.length) throw new Error("identity_audit_shape");
  return rows.map((entries, index) => {
    if (entries.length > 1000) throw new Error("identity_audit_cardinality");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("identity_audit_shape");
      for (const [key, value] of Object.entries(entry)) {
        if (COUNTS.has(key)) {
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
            throw new Error("identity_audit_count");
        } else if (
          !DIMENSIONS.has(key) ||
          typeof value !== "string" ||
          value.length > 128 ||
          !/^[a-zA-Z0-9_-]+$/u.test(value)
        )
          throw new Error("identity_audit_dimension");
      }
    }
    return { name: IDENTITY_AUDIT_QUERIES[index]!.name, rows: entries };
  });
}
