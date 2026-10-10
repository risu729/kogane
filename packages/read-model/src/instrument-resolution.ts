// The reads behind cross-identifier instrument resolution (ADR 0055,
// docs/identity.md). Three bounded reads, none of which writes:
//
// - `INSTRUMENT_FACTS_SQL`: every identifier whose current mapping targets a
//   security, crypto or product instrument and that a currently published,
//   sealed identity observation uses (`current_identity_observations` is
//   driven by `published_parse_runs` since CORE 0026, so it is not checked
//   again here), one row per (identifier, source, stated currency,
//   unconfirmed). A use as `security` is denominated by the unit
//   the same identity observation names as its `trade-unit`; by its `unit`
//   only when it names no trade unit or the trade unit is a crypto asset
//   code (`provider-asset-code`, an exchange product's base). A denominating
//   unit that is a resolved currency (`iso4217`, `currency-variant`) is
//   stated; any other (an unresolved provider code, say), or none at all (a
//   provider row with no currency), makes the use's currency unconfirmed,
//   never dropped and never replaced by the other unit. A use in another
//   role states none.
// - `LISTED_AS_SQL`: the newest `listed_as` relation per (instrument,
//   identifier), ordered as the change lifecycle orders a relation's history.
// - `INSTRUMENT_HISTORY_SQL`: the mapping revisions, mapping decisions and
//   `listed_as` relations of up to `INSTRUMENT_HISTORY_BOUND` identifiers, in
//   the order they were written. The bound is on identifiers, not rows: every
//   entry of each named identifier is returned.
//
// The facts read walks every current identity observation once, as the
// identity catalogue's instrument list already does, and reaches each
// observation's uses by the primary key (identity_observation_id, role); no
// index on the use table's identifier column is needed and this change adds
// no migration. Its cost is measured on `bun:sqlite` and workerd, not remote
// D1, and the review service refuses before the walk above a count of current
// identity observations (`IDENTITY_OBSERVATION_COUNT_SQL`; ADR 0055
// amendment 2026-10-09, Cost).
import type { SqlExecutor } from "./reader";
import type { DecisionOrigin } from "../../domain/src/decision-origin.ts";
import { decisionOriginSql, mappingDecisionOriginSql } from "./decision-origin.ts";

/** Rows of `INSTRUMENT_FACTS_SQL` one read may return; more is refused, never cut. */
export const INSTRUMENT_FACTS_ROW_BOUND = 10_000;
/** `listed_as` relations one read may return; more is refused, never cut. */
export const LISTED_AS_ROW_BOUND = 10_000;
/** Identifiers one history read may name. A bound on identifiers, not on rows. */
export const INSTRUMENT_HISTORY_BOUND = 100;

export const INSTRUMENT_FACTS_SQL = `WITH eligible AS MATERIALIZED (
 SELECT m.identifier_id,m.instrument_id,m.method,m.status,m.revision,m.label,i.kind
 FROM current_instrument_mappings m JOIN instruments i ON i.id=m.instrument_id
 WHERE i.kind IN ('security','crypto','product')
), used AS MATERIALIZED (
 SELECT u.identifier_id,u.role,u.identity_observation_id,s.source_id
 FROM identity_instrument_uses u
 JOIN current_identity_observations o ON o.id=u.identity_observation_id
 JOIN source_accounts s ON s.id=o.source_account_id
 WHERE u.identifier_id IN (SELECT identifier_id FROM eligible)
), denominated AS (
 SELECT x.identifier_id,x.source_id,x.role,
  CASE WHEN x.role<>'security' THEN NULL
   WHEN t.identifier_id IS NOT NULL AND td.namespace<>'provider-asset-code' THEN t.identifier_id
   ELSE n.identifier_id END AS unit_id
 FROM used x
 LEFT JOIN identity_instrument_uses t ON t.identity_observation_id=x.identity_observation_id AND t.role='trade-unit'
 LEFT JOIN instrument_identifiers td ON td.id=t.identifier_id
 LEFT JOIN identity_instrument_uses n ON n.identity_observation_id=x.identity_observation_id AND n.role='unit'
), stated AS (
 SELECT DISTINCT y.identifier_id,y.source_id,
  CASE WHEN c.namespace IN ('iso4217','currency-variant') THEN c.value END AS currency,
  CASE WHEN y.role='security' AND (c.id IS NULL OR c.namespace NOT IN ('iso4217','currency-variant'))
   THEN 1 ELSE 0 END AS unconfirmed
 FROM denominated y LEFT JOIN instrument_identifiers c ON c.id=y.unit_id
)
SELECT e.identifier_id AS identifierId,e.instrument_id AS instrumentId,e.method,e.status,
 e.revision,e.kind,e.label,d.namespace,d.scope,d.value,d.details_json AS details,
 s.source_id AS sourceId,s.currency,s.unconfirmed AS currencyUnconfirmed
FROM stated s JOIN eligible e ON e.identifier_id=s.identifier_id
JOIN instrument_identifiers d ON d.id=s.identifier_id
ORDER BY e.identifier_id,s.source_id,s.currency,s.unconfirmed
LIMIT ${INSTRUMENT_FACTS_ROW_BOUND + 1}`;

/**
 * The number of identity observations `INSTRUMENT_FACTS_SQL` walks, read
 * without walking them: for every published parse, the observation count of
 * its sealed identity runs (`identity_seal_complete` makes that count equal
 * to the parse's observations, so every sealed run of one parse states the
 * same number). It reads one row per published parse, never an observation.
 * It is exact when every such run is eligible and an upper bound otherwise
 * (a failed fetch run or an unbound Vpass run is counted, not walked), so a
 * bound checked against it fails closed.
 */
export const IDENTITY_OBSERVATION_COUNT_SQL = `SELECT coalesce(sum(n),0) AS n FROM (
 SELECT max(s.observation_count) AS n
 FROM published_parse_runs pub
 JOIN identity_runs r ON r.parse_run_id=pub.parse_run_id
 JOIN identity_run_seals s ON s.identity_run_id=r.id
 GROUP BY pub.parse_run_id
)`;

export interface InstrumentFactsRow {
  identifierId: string;
  instrumentId: string;
  method: "rule" | "manual";
  status: "identified" | "provider-local" | "aggregate" | "unresolved";
  revision: number;
  kind: string;
  label: string;
  namespace: string;
  scope: string;
  value: string;
  /** `instrument_identifiers.details_json`, as the identity rule stored it. */
  details: string;
  sourceId: string;
  /** A resolved currency the use is denominated in, or null. */
  currency: string | null;
  /** 1 when a use as `security` has no denominating unit, or one that is not a resolved currency. */
  currencyUnconfirmed: 0 | 1;
}

/**
 * The newest `listed_as` row per (instrument, identifier). Read through
 * `entity_relations_to` by a range on the `identifier:` prefix.
 */
export const LISTED_AS_SQL = `SELECT fromRef,toRef,status FROM (
 SELECT r.from_ref AS fromRef,r.to_ref AS toRef,r.status,
  row_number() OVER (PARTITION BY r.from_ref,r.to_ref ORDER BY r.created_at DESC,r.id DESC) AS rank
 FROM entity_relations r
 WHERE r.kind='listed_as' AND r.to_ref>='identifier:' AND r.to_ref<'identifier;'
  AND r.from_ref>='instrument:' AND r.from_ref<'instrument;'
) WHERE rank=1 ORDER BY fromRef,toRef LIMIT ${LISTED_AS_ROW_BOUND + 1}`;

export interface ListedAsRow {
  fromRef: string;
  toRef: string;
  status: "proposed" | "accepted" | "rejected" | "released";
}

/**
 * ?1 a JSON array of identifier ids. Mapping revisions, mapping decisions and
 * `listed_as` relations naming them, each through its own index: `CROSS JOIN`
 * keeps the requested ids the outer loop, so each branch is a keyed lookup.
 */
export const INSTRUMENT_HISTORY_SQL = `WITH wanted AS (SELECT DISTINCT value AS identifier_id FROM json_each(?1))
SELECT 'mapping' AS entry,m.identifier_id AS identifierId,m.revision,m.created_at AS createdAt,
 m.method,NULL AS decisionKind,m.reason,m.instrument_id AS instrumentId,m.status,m.label,
 m.policy_version AS policyVersion,m.id AS recordId,NULL AS supersededBy,NULL AS relationStatus,
 NULL AS fromRef,
 ${mappingDecisionOriginSql("instrument_mapping", "m.identifier_id", "m.revision", "m.method")} AS decisionOrigin
FROM wanted w CROSS JOIN instrument_mappings m ON m.identifier_id=w.identifier_id
UNION ALL
SELECT 'decision',d.subject_ref,d.revision,d.created_at,d.method,d.decision_kind,d.reason,NULL,NULL,
 NULL,NULL,d.id,d.superseded_by,NULL,NULL,${decisionOriginSql("d")}
FROM wanted w CROSS JOIN decision_revisions d
 ON d.subject_kind='instrument_mapping' AND d.subject_ref=w.identifier_id
UNION ALL
SELECT 'relation',substr(r.to_ref,12),d.revision,r.created_at,d.method,d.decision_kind,d.reason,NULL,
 NULL,NULL,NULL,r.id,NULL,r.status,r.from_ref,${decisionOriginSql("d")}
FROM wanted w CROSS JOIN entity_relations r
 ON r.kind='listed_as' AND r.to_ref='identifier:'||w.identifier_id
JOIN decision_revisions d ON d.id=r.decision_revision_id
ORDER BY identifierId,createdAt,entry,revision,recordId`;

export interface InstrumentHistoryRow {
  entry: "mapping" | "decision" | "relation";
  identifierId: string;
  revision: number;
  createdAt: string;
  method: string;
  decisionOrigin: DecisionOrigin;
  decisionKind: string | null;
  reason: string;
  instrumentId: string | null;
  status: string | null;
  label: string | null;
  policyVersion: number | null;
  recordId: string;
  supersededBy: string | null;
  relationStatus: string | null;
  fromRef: string | null;
}

export async function readInstrumentFacts(sql: SqlExecutor): Promise<InstrumentFactsRow[]> {
  return sql.all<InstrumentFactsRow>(INSTRUMENT_FACTS_SQL, []);
}

export async function readIdentityObservationCount(sql: SqlExecutor): Promise<number> {
  return (await sql.first<{ n: number }>(IDENTITY_OBSERVATION_COUNT_SQL, []))?.n ?? 0;
}

export async function readListedAs(sql: SqlExecutor): Promise<ListedAsRow[]> {
  return sql.all<ListedAsRow>(LISTED_AS_SQL, []);
}

export async function readInstrumentHistory(
  sql: SqlExecutor,
  identifierIds: readonly string[],
): Promise<InstrumentHistoryRow[]> {
  return sql.all<InstrumentHistoryRow>(INSTRUMENT_HISTORY_SQL, [JSON.stringify(identifierIds)]);
}
