// The reads behind cross-identifier instrument resolution (ADR 0046,
// docs/identity.md). Three bounded reads, none of which writes:
//
// - `INSTRUMENT_FACTS_SQL`: every identifier whose current mapping targets a
//   security, crypto or product instrument and that a currently published,
//   sealed identity observation uses, one row per (identifier, source, stated
//   currency). The stated currency of a use as `security` is the money unit
//   the same identity observation names as its `trade-unit`, else as its
//   `unit`; a use in another role states none.
// - `LISTED_AS_SQL`: the newest `listed_as` relation per (instrument,
//   identifier), ordered as the change lifecycle orders a relation's history.
// - `INSTRUMENT_HISTORY_SQL`: the mapping revisions, mapping decisions and
//   `listed_as` relations of up to `INSTRUMENT_HISTORY_BOUND` identifiers, in
//   the order they were written.
//
// The facts read scans `identity_instrument_uses` once, as the identity
// catalogue's instrument list already does; there is no index on its
// identifier column and this change adds no migration.
import type { SqlExecutor } from "./reader";

/** Rows of `INSTRUMENT_FACTS_SQL` one read may return; more is refused, never cut. */
export const INSTRUMENT_FACTS_ROW_BOUND = 10_000;
/** `listed_as` relations one read may return; more is refused, never cut. */
export const LISTED_AS_ROW_BOUND = 10_000;
/** Identifiers one history read may name. */
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
  AND EXISTS(SELECT 1 FROM published_parse_runs p WHERE p.parse_run_id=o.parse_run_id)
), stated AS (
 SELECT DISTINCT x.identifier_id,x.source_id,
  CASE WHEN x.role='security' THEN coalesce(
   (SELECT d.value FROM identity_instrument_uses t JOIN instrument_identifiers d ON d.id=t.identifier_id
    WHERE t.identity_observation_id=x.identity_observation_id AND t.role='trade-unit'
    AND d.namespace IN ('iso4217','currency-variant')),
   (SELECT d.value FROM identity_instrument_uses t JOIN instrument_identifiers d ON d.id=t.identifier_id
    WHERE t.identity_observation_id=x.identity_observation_id AND t.role='unit'
    AND d.namespace IN ('iso4217','currency-variant'))) END AS currency
 FROM used x
)
SELECT e.identifier_id AS identifierId,e.instrument_id AS instrumentId,e.method,e.status,
 e.revision,e.kind,e.label,d.namespace,d.scope,d.value,d.details_json AS details,
 s.source_id AS sourceId,s.currency
FROM stated s JOIN eligible e ON e.identifier_id=s.identifier_id
JOIN instrument_identifiers d ON d.id=s.identifier_id
ORDER BY e.identifier_id,s.source_id,s.currency
LIMIT ${INSTRUMENT_FACTS_ROW_BOUND + 1}`;

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
  currency: string | null;
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
 NULL AS fromRef
FROM wanted w CROSS JOIN instrument_mappings m ON m.identifier_id=w.identifier_id
UNION ALL
SELECT 'decision',d.subject_ref,d.revision,d.created_at,d.method,d.decision_kind,d.reason,NULL,NULL,
 NULL,NULL,d.id,d.superseded_by,NULL,NULL
FROM wanted w CROSS JOIN decision_revisions d
 ON d.subject_kind='instrument_mapping' AND d.subject_ref=w.identifier_id
UNION ALL
SELECT 'relation',substr(r.to_ref,12),d.revision,r.created_at,d.method,d.decision_kind,d.reason,NULL,
 NULL,NULL,NULL,r.id,NULL,r.status,r.from_ref
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

export async function readListedAs(sql: SqlExecutor): Promise<ListedAsRow[]> {
  return sql.all<ListedAsRow>(LISTED_AS_SQL, []);
}

export async function readInstrumentHistory(
  sql: SqlExecutor,
  identifierIds: readonly string[],
): Promise<InstrumentHistoryRow[]> {
  return sql.all<InstrumentHistoryRow>(INSTRUMENT_HISTORY_SQL, [JSON.stringify(identifierIds)]);
}
