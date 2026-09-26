// Reported state on a date (docs/reported-state.md, ADR 0019): the rows of
// the latest complete container snapshot captured before a cutoff, and the
// provider statements as they stood then. Read-only and computed per request.
//
// Every CTE name here starts `dated_`, so these texts compose with the
// current-state CTEs in one statement without shadowing them. The snapshot is
// chosen by the same rules as the current one (`snapshotCtes`: the policy
// table, coverage claims, published parses), with `cutoffParam` bounding the
// capture time; the view `card_statement_facts` is restated with the same
// bound, and the view itself is unchanged. Nothing is summed in SQL: amounts
// leave as stored provider values and decimal-v1 coefficients.
//
// Parameters: `?1` is the cutoff, an instant in the stored `fetched_at`
// form (`reportedStateCutoff` in packages/domain/src/reported-state.ts).
import { ARTIFACT_SNAPSHOT_CONTAINERS, snapshotCtes } from "../../parsers/src/snapshot-query";
import { cardSettlementOwnershipCtes } from "./card-settlement-ownership";
import { SNAPSHOT_RELATIONS, unitParseable } from "./concepts";
import { POSITION_VALUATION_LOCATOR } from "./sql";

/**
 * Container datasets in the snapshot registry that a reported state does not
 * list: both are provider aggregates over accounts the other containers list
 * one by one (ADR 0019, decision 2), so listing them would state one holding
 * twice.
 */
export const DATED_STATE_EXCLUDED_PARSERS = [
  "sbi-account-assets-current",
  "sony-bank-gross-balance",
] as const;

/** More rows than this in one read is refused, never cut. */
export const DATED_STATE_ROW_BOUND = 5000;

const EXCLUDED = DATED_STATE_EXCLUDED_PARSERS.map((name) => `'${name}'`).join(",");

/**
 * `dated_parses`: one row per published parse of a chosen snapshot, with the
 * snapshot it belongs to (`snapshot_artifact_id`, its newest artifact, and
 * `captured_at`). A dataset snapshot is every artifact of the chosen fetch run
 * and unit, as `CURRENT_SNAPSHOT` admits them; an artifact container is its one
 * artifact. `identity_eligible` is the run and parse condition
 * `current_identity_observations` puts on a parse.
 */
export const DATED_SNAPSHOT_CTES = `${snapshotCtes(SNAPSHOT_RELATIONS, { prefix: "dated_", cutoffParam: "?1" })}, dated_parses AS MATERIALIZED (
 SELECT s.source_id,s.parser_name,s.dataset,s.artifact_id AS snapshot_artifact_id,s.fetched_at AS captured_at,
  p.id AS parse_run_id,
  CASE WHEN p.status='ok' AND f.status='success' AND f.failure_count=0 THEN 1 ELSE 0 END AS identity_eligible
 FROM dated_current_snapshots s
 CROSS JOIN observation_fetch_artifacts fa ON fa.fetch_run_id=s.fetch_run_id AND fa.source_id=s.source_id
  AND fa.dataset=s.dataset AND fa.fetch_unit_key IS s.fetch_unit_key
 CROSS JOIN observation_fetch_runs f ON f.id=fa.fetch_run_id
 CROSS JOIN published_parse_runs pub ON pub.fetch_artifact_id=fa.id AND pub.parser_name=s.parser_name
 CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
 WHERE s.parser_name NOT IN (${EXCLUDED})
  AND (s.required_version IS NULL OR p.parser_version=s.required_version)
  AND ${unitParseable.policyPredicate("f", "fa")}
 UNION ALL
 SELECT c.source_id,c.parser_name,policy.dataset,c.artifact_id,c.fetched_at,
  p.id,
  CASE WHEN p.status='ok' AND f.status='success' AND f.failure_count=0 THEN 1 ELSE 0 END
 FROM dated_current_artifact_containers c
 CROSS JOIN dated_artifact_container_policies policy ON policy.source_id=c.source_id
  AND policy.parser_name=c.parser_name AND policy.artifact_key=c.artifact_key
  AND policy.fetch_unit_key IS c.fetch_unit_key
 CROSS JOIN observation_fetch_artifacts fa ON fa.id=c.artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=fa.fetch_run_id
 CROSS JOIN published_parse_runs pub ON pub.fetch_artifact_id=fa.id AND pub.parser_name=c.parser_name
 CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
 WHERE ${unitParseable.policyPredicate("f", "fa")}
)`;

/**
 * `current_identity_observations` for the parses of `dated_parses` only: the
 * candidate identity runs of each parse, its latest policy, and that run's
 * identities of `kind`. A candidate run and a parse's latest policy depend on
 * that parse alone, so restricting both to these parses leaves each of their
 * rows as the view gives it (the reasoning of card-settlement-ownership.ts).
 */
function datedIdentityCtes(kind: "balance" | "position"): string {
  return `dated_identity_runs AS MATERIALIZED (
 SELECT r.id,r.parse_run_id,r.policy_version FROM dated_parses dp
 CROSS JOIN eligible_identity_runs r ON r.parse_run_id=dp.parse_run_id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 WHERE dp.identity_eligible=1
), dated_identity_latest AS MATERIALIZED (
 SELECT parse_run_id,max(policy_version) AS policy_version FROM dated_identity_runs GROUP BY parse_run_id
), dated_identity AS MATERIALIZED (
 SELECT o.id,o.observation_id,o.source_account_id FROM dated_identity_latest l
 CROSS JOIN dated_identity_runs r ON r.parse_run_id=l.parse_run_id AND r.policy_version=l.policy_version
 CROSS JOIN identity_observations o ON o.identity_run_id=r.id AND o.kind='${kind}'
)`;
}

/** Identity columns: the current account mapping and instrument mapping of an observation. */
function identityJoins(observation: string, role: "unit" | "security"): string {
  return `LEFT JOIN dated_identity io ON io.observation_id=${observation}.id
LEFT JOIN current_account_mappings am ON am.source_account_id=io.source_account_id
LEFT JOIN identity_instrument_uses u ON u.identity_observation_id=io.id AND u.role='${role}'
LEFT JOIN current_instrument_mappings im ON im.identifier_id=u.identifier_id`;
}

const SNAPSHOT_COLUMNS = `dp.source_id,dp.parser_name,dp.dataset,dp.snapshot_artifact_id,dp.captured_at`;
const IDENTITY_COLUMNS = `CASE WHEN io.id IS NULL THEN 0 ELSE 1 END AS identity_recorded,
 am.account_id,am.status AS account_status,im.instrument_id,im.status AS instrument_status`;

export interface DatedSnapshotColumns {
  source_id: string;
  parser_name: string;
  dataset: string;
  snapshot_artifact_id: number;
  captured_at: string;
}
interface DatedIdentityColumns {
  identity_recorded: number;
  account_id: string | null;
  account_status: string | null;
  instrument_id: string | null;
  instrument_status: string | null;
}

/** One position of a chosen snapshot, once per matched provider valuation (or once without). */
export interface DatedPositionRow extends DatedSnapshotColumns, DatedIdentityColumns {
  id: number;
  source_account: string;
  security_code: string;
  security_name: string | null;
  market: string | null;
  quantity_text: string;
  currency: string | null;
  as_of: string | null;
  valuation_id: number | null;
  valuation_metric: string | null;
  valuation_amount_text: string | null;
  valuation_currency: string | null;
  valuation_as_of: string | null;
  valuation_value_status: string | null;
  valuation_coefficient: string | null;
  valuation_scale: number | null;
}

/**
 * Positions of the snapshots current at the cutoff, each with the provider
 * valuations matched as `POSITION_VALUATIONS_SQL` matches them (same parse
 * run, source account and code, and the locator guard). A position absent
 * from the chosen snapshot is not held, whatever an older snapshot said.
 */
export const DATED_POSITIONS_SQL = `WITH ${DATED_SNAPSHOT_CTES}, ${datedIdentityCtes("position")}
SELECT ${SNAPSHOT_COLUMNS},
 po.id,po.source_account,po.security_code,po.security_name,po.market,po.quantity_text,po.currency,po.as_of,
 ${IDENTITY_COLUMNS},
 v.id AS valuation_id,v.metric AS valuation_metric,v.amount_text AS valuation_amount_text,
 v.currency AS valuation_currency,v.as_of AS valuation_as_of,
 vd.status AS valuation_value_status,vd.coefficient AS valuation_coefficient,vd.scale AS valuation_scale
FROM dated_parses dp
CROSS JOIN position_observations po ON po.parse_run_id=dp.parse_run_id
CROSS JOIN parse_runs p ON p.id=dp.parse_run_id
${identityJoins("po", "security")}
LEFT JOIN valuation_observations v ON v.parse_run_id=po.parse_run_id
 AND v.source_account=po.source_account AND v.subject=po.security_code
 AND ${POSITION_VALUATION_LOCATOR}
LEFT JOIN observation_decimal_values vd ON vd.kind='valuation' AND vd.observation_id=v.id AND vd.policy_version='decimal-v1'
ORDER BY dp.source_id,po.source_account,po.id,v.id
LIMIT ${DATED_STATE_ROW_BOUND + 1}`;

/** One balance of a chosen snapshot with its stored decimal and identity. */
export interface DatedBalanceRow extends DatedSnapshotColumns, DatedIdentityColumns {
  id: number;
  source_account: string;
  metric: string;
  instrument: string;
  amount_text: string | null;
  as_of: string | null;
  value_status: string | null;
  coefficient: string | null;
  scale: number | null;
}

/**
 * Balances of the snapshots current at the cutoff. The metric registry,
 * additivity and the perimeter's metric exclusions are applied by the caller
 * (`resolveMetric` is code, not SQL).
 */
export const DATED_BALANCES_SQL = `WITH ${DATED_SNAPSHOT_CTES}, ${datedIdentityCtes("balance")}
SELECT ${SNAPSHOT_COLUMNS},
 b.id,b.source_account,b.metric,b.instrument,b.amount_text,b.as_of,
 d.status AS value_status,d.coefficient,d.scale,
 ${IDENTITY_COLUMNS}
FROM dated_parses dp
CROSS JOIN balance_observations b ON b.parse_run_id=dp.parse_run_id
LEFT JOIN observation_decimal_values d ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
${identityJoins("b", "unit")}
ORDER BY dp.source_id,b.source_account,b.id
LIMIT ${DATED_STATE_ROW_BOUND + 1}`;

/**
 * The container datasets a reported state expects a snapshot of (every
 * selecting policy row outside the excluded aggregates, and the artifact
 * containers), each with the snapshots chosen for it at the cutoff: one row
 * per chosen snapshot, or one row with no snapshot. A complete-empty snapshot
 * is chosen and holds nothing, so it is listed here although no position or
 * balance names it; a container with no row of its own is named in the
 * coverage. The join is on (parser, dataset), as the policy table's key is:
 * its `source_id` records the source and is reported, not joined.
 */
export const DATED_SNAPSHOTS_SQL = `WITH ${DATED_SNAPSHOT_CTES}, dated_perimeter(source_id,parser_name,dataset) AS (
 SELECT source_id,parser_name,dataset FROM dataset_snapshot_policies
 WHERE snapshot_selection=1 AND parser_name NOT IN (${EXCLUDED})
 UNION
 SELECT column1,column2,column3 FROM (VALUES ${ARTIFACT_SNAPSHOT_CONTAINERS.map(
   (container) => `('${container.sourceId}','${container.parserName}','${container.dataset}')`,
 ).join(",")})
), dated_chosen AS (
 SELECT DISTINCT source_id,parser_name,dataset,snapshot_artifact_id,captured_at FROM dated_parses
)
SELECT per.source_id AS perimeter_source_id,per.parser_name,per.dataset,
 chosen.source_id,chosen.snapshot_artifact_id,chosen.captured_at
FROM dated_perimeter per
LEFT JOIN dated_chosen chosen ON chosen.parser_name=per.parser_name AND chosen.dataset=per.dataset
ORDER BY per.source_id,per.parser_name,per.dataset,chosen.snapshot_artifact_id`;

export interface DatedSnapshotRow {
  perimeter_source_id: string;
  parser_name: string;
  dataset: string;
  source_id: string | null;
  snapshot_artifact_id: number | null;
  captured_at: string | null;
}

/**
 * `card_statement_facts` (migration 0044) restated with the capture-time
 * bound: the newest published provider statement total of each statement key
 * captured before `?1`. With a bound past every capture it returns the view's
 * rows exactly (dated-state.test.ts).
 */
export const DATED_STATEMENT_FACTS_CTE = `dated_statement_ranked AS (
 SELECT b.id,b.parse_run_id,b.source_account,b.instrument AS unit_ref,a.source_id,a.fetched_at,
 d.status AS value_status,d.coefficient,d.scale,
 json_extract(b.extra_json,'$._kogane.paymentDate') AS payment_date,
 coalesce(json_extract(b.extra_json,'$._kogane.period'),
  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2)) AS period,
 json_array(a.source_id,fr.producer_id,ses.external_id_namespace,b.source_account,
  coalesce(json_extract(b.extra_json,'$._kogane.period'),
   substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2))) AS statement_key,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,b.source_account,
  coalesce(json_extract(b.extra_json,'$._kogane.period'),
   substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2))
  ORDER BY a.fetched_at DESC,json_extract(b.extra_json,'$._kogane.paymentDate') IS NOT NULL DESC,b.id DESC) AS position
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
 WHERE ((a.source_id='vpass' AND p.parser_name='vpass-statement-page') OR (a.source_id='myjcb' AND p.parser_name='myjcb-credit-statement-total'))
 AND b.metric='credit_statement_payment_amount' AND json_valid(b.extra_json)
 AND json_extract(b.extra_json,'$._kogane.snapshotSemantics')='provider-reported-monthly-payment-amount'
 AND a.fetched_at<?1
), dated_statement_facts AS (
 SELECT * FROM dated_statement_ranked WHERE position=1
)`;

export interface DatedStatementRow {
  id: number;
  parse_run_id: number;
  source_account: string;
  unit_ref: string;
  source_id: string;
  fetched_at: string;
  value_status: string | null;
  coefficient: string | null;
  scale: number | null;
  payment_date: string | null;
  period: string | null;
  account_id: string | null;
}

/**
 * The statements a reported state lists as payables: of the statements as of
 * the cutoff (`?1`), those due on or after `?2`, and those without a readable
 * due date captured on or after `?3`, each with the account its identity
 * resolves to through the keyed ownership CTEs (the view
 * `card_settlement_fact_ownership`, for these statements only).
 */
export const DATED_STATEMENTS_SQL = `WITH ${DATED_STATEMENT_FACTS_CTE}, dated_statements AS MATERIALIZED (
 SELECT * FROM dated_statement_facts
 WHERE CASE WHEN payment_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  THEN payment_date>=?2 ELSE fetched_at>=?3 END
), observed AS (SELECT id AS observation_id FROM dated_statements),
${cardSettlementOwnershipCtes("balance")}
SELECT s.id,s.parse_run_id,s.source_account,s.unit_ref,s.source_id,s.fetched_at,s.value_status,s.coefficient,s.scale,
 s.payment_date,s.period,ownership.account_id
FROM dated_statements s LEFT JOIN ownership ON ownership.observation_id=s.id
ORDER BY s.source_id,s.source_account,s.period,s.id
LIMIT ${DATED_STATE_ROW_BOUND + 1}`;
