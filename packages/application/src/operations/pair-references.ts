// Every reference an identity pair's decisions may be recorded under, pinned
// by the plan that decides the pair (ADR 0077's amendment of 2026-11-08,
// docs/change-lifecycle.md "Pair pins").
//
// A candidate read decides a pair from records under several references, but
// a command acts on one triple or one mapping. If the plan pinned only that
// one, a decision recorded under another of the pair's references between
// plan and commit would leave the plan fresh, and the commit would act on a
// pair the operator saw in another state. So the planner pins all of them,
// each with the subject reference the lifecycle's revision guard already
// answers (`relation:<kind>|<from>|<to>`: the triple's row count;
// `instrument_mapping:<id>`: the highest mapping revision). No new subject
// kind, no new table, no migration.
//
// Two families:
//
// - Account pairs (ADR 0077): a `connection_contains` triple from
//   `connection:<producer>/<key>` to `source_account:<id>`. The pair is
//   (identity value, direct source account), and its references are every
//   producer's review reference of that identity value and each reference
//   migration 0029 backfilled under a key migration 0063 later rewrote,
//   mapped through the review row its id names, exactly as the candidate read
//   maps it (`LEGACY_CONNECTION_RELATIONS_SQL`). The set can grow after
//   planning (another producer's first review of the identity value), so the
//   commit batch also carries `connectionPairGuard`: nothing is written when
//   the pair has a reference the plan did not pin.
// - Instrument pairs (ADR 0055): a candidate adoption (`identity.assign` with
//   candidate provenance) or a `listed_as` decision whose evidence names
//   exactly the two identifiers, as the candidate's keep-apart payload does.
//   The pair's references are both identifiers' mappings and `listed_as` in
//   both orientations (each identifier's current instrument to the other
//   identifier). Every one of them is a function of the two mappings, which
//   are pinned, so the set cannot grow while the plan is fresh. The forward
//   orientation pinned is the command's own target instrument: an adoption's
//   target must be the anchor's current instrument (targets.ts), while a
//   hand-built `listed_as` from another instrument pins its own triple, which
//   is then no reference of the pair and, the anchor's mapping being pinned,
//   cannot become one before the commit.
//
// Anything else names no pair, and its plan pins its own subject as before.
// That includes `same_account` (every reader takes a triple's status from its
// own rows, each orientation apart) and a `listed_as` decision whose evidence
// does not name exactly the subject and one other identifier (the candidate
// read applies it to whichever identifiers map to its instrument when the
// read runs, a set, not a pair). Nothing outside their own triple changes
// what such a plan showed or what its commit writes.
import type {
  ChangeKind,
  ChangePayload,
  ChangePlan,
  CommandStore,
  CommitGuard,
  ExpectedRevisions,
  IdentityAssignPayload,
  RelationPayload,
} from "../command/contract.ts";
import {
  CURRENT_REVISIONS_SQL,
  expectedRevisionsJson,
  identitySubjectRef,
  revisionsFrom,
  type RevisionRow,
} from "./sql.ts";

/**
 * ?1 the plan's `from_ref`, ?2 its `to_ref` (bound once each through `q`):
 * the subject reference of every `connection_contains` triple of the account
 * pair the triple belongs to, its own included; no row when no connection
 * review names the `from_ref` and no 0029 backfill maps it. The 0029 mapping
 * is `LEGACY_CONNECTION_RELATIONS_SQL`'s (packages/read-model), narrowed to
 * the one direct account: one pass over the small review table, each
 * backfilled relation by primary key. Plain `?` placeholders, so the text can
 * be spliced into the commit's reservation statement after its numbered ones.
 */
export const CONNECTION_PAIR_REFS_SQL = `WITH q(from_ref,to_ref) AS (SELECT ?,?),
legacy(from_ref,connection_key) AS (
 SELECT r.from_ref,c.connection_key
 FROM q CROSS JOIN account_connection_reviews c CROSS JOIN json_each(c.direct_reference_ids_json) j
 CROSS JOIN entity_relations r ON r.id='rel_legacy_connection_'||c.id||'_'||j.key
 WHERE c.status='confirmed' AND j.type='text' AND q.to_ref='source_account:'||j.value
  AND r.kind='connection_contains'
  AND r.decision_revision_id='dr_legacy_connection_'||c.id||'_'||j.key
  AND r.to_ref=q.to_ref
  AND substr(r.from_ref,1,length(c.producer_id)+12)='connection:'||c.producer_id||'/'
  AND r.from_ref<>'connection:'||c.producer_id||'/'||c.connection_key),
pair_keys(connection_key) AS (
 SELECT c.connection_key FROM q CROSS JOIN account_connection_reviews c
 WHERE q.from_ref='connection:'||c.producer_id||'/'||c.connection_key
 UNION SELECT l.connection_key FROM q CROSS JOIN legacy l WHERE l.from_ref=q.from_ref)
SELECT DISTINCT 'relation:connection_contains|'||p.ref||'|'||q.to_ref AS subject_ref
FROM q CROSS JOIN (
 SELECT 'connection:'||c.producer_id||'/'||c.connection_key AS ref FROM account_connection_reviews c
 WHERE c.connection_key IN (SELECT connection_key FROM pair_keys)
 UNION SELECT l.from_ref FROM legacy l WHERE l.connection_key IN (SELECT connection_key FROM pair_keys)
) p
ORDER BY 1`;

/** ?1 an identifier id: the instrument its highest mapping revision names, by key. */
const CURRENT_INSTRUMENT_SQL = `SELECT m.instrument_id AS instrumentId FROM instrument_mappings m
 WHERE m.identifier_id=?1 AND m.revision=(SELECT max(n.revision) FROM instrument_mappings n WHERE n.identifier_id=?1)`;

const CONNECTION_FROM = "connection:";
const SOURCE_ACCOUNT_TO = "source_account:";
const INSTRUMENT_FROM = "instrument:";
const IDENTIFIER_TO = "identifier:";

function connectionPair(kind: ChangeKind, payload: ChangePayload): RelationPayload | null {
  if (kind !== "relation.accept" && kind !== "relation.reject") return null;
  const relation = payload as RelationPayload;
  return relation.relationKind === "connection_contains" &&
    relation.fromRef.startsWith(CONNECTION_FROM) &&
    relation.toRef.startsWith(SOURCE_ACCOUNT_TO)
    ? relation
    : null;
}

const listedAsRef = (instrumentId: string, identifierId: string): string =>
  `relation:listed_as|${INSTRUMENT_FROM}${instrumentId}|${IDENTIFIER_TO}${identifierId}`;

/** The two identifiers and the instrument an instrument-pair command names, or null. */
function instrumentPair(
  kind: ChangeKind,
  payload: ChangePayload,
): { subject: string; anchor: string; anchorInstrument: string } | null {
  if (kind === "identity.assign") {
    const assign = payload as IdentityAssignPayload;
    if (assign.subject !== "instrument" || assign.candidate === undefined) return null;
    return {
      subject: assign.referenceId,
      anchor: assign.candidate.anchorIdentifierId,
      anchorInstrument: assign.targetId,
    };
  }
  if (kind !== "relation.accept" && kind !== "relation.reject") return null;
  const relation = payload as RelationPayload;
  if (
    relation.relationKind !== "listed_as" ||
    !relation.fromRef.startsWith(INSTRUMENT_FROM) ||
    !relation.toRef.startsWith(IDENTIFIER_TO)
  )
    return null;
  const subject = relation.toRef.slice(IDENTIFIER_TO.length);
  const named = [
    ...new Set(
      relation.evidenceRefs
        .filter((ref) => ref.startsWith(IDENTIFIER_TO))
        .map((ref) => ref.slice(IDENTIFIER_TO.length)),
    ),
  ];
  const others = named.filter((id) => id !== subject);
  if (named.length !== 2 || others.length !== 1) return null;
  return {
    subject,
    anchor: others[0]!,
    anchorInstrument: relation.fromRef.slice(INSTRUMENT_FROM.length),
  };
}

/**
 * Every subject reference of the pair this command decides, its own subject
 * included, sorted; empty when the command names no pair.
 */
export async function pairReferences(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
): Promise<string[]> {
  const connection = connectionPair(kind, payload);
  if (connection !== null) {
    const rows = await store.all<{ subject_ref: string }>(CONNECTION_PAIR_REFS_SQL, [
      connection.fromRef,
      connection.toRef,
    ]);
    return rows.map((row) => row.subject_ref);
  }
  const instrument = instrumentPair(kind, payload);
  if (instrument === null) return [];
  const refs = new Set([
    identitySubjectRef("instrument", instrument.subject),
    identitySubjectRef("instrument", instrument.anchor),
    listedAsRef(instrument.anchorInstrument, instrument.subject),
  ]);
  const current = await store.first<{ instrumentId: string }>(CURRENT_INSTRUMENT_SQL, [
    instrument.subject,
  ]);
  if (current !== null) refs.add(listedAsRef(current.instrumentId, instrument.anchor));
  return [...refs].sort();
}

/**
 * `pinned` plus the current revision of every other reference of the pair:
 * what the plan records as its expected revisions.
 */
export async function withPairPins(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
  pinned: ExpectedRevisions,
): Promise<ExpectedRevisions> {
  const others = (await pairReferences(store, kind, payload)).filter((ref) => !(ref in pinned));
  if (others.length === 0) return pinned;
  const revisions: ExpectedRevisions = {};
  for (const ref of others) revisions[ref] = 0;
  const rows = await store.all<RevisionRow>(CURRENT_REVISIONS_SQL, [
    expectedRevisionsJson(revisions),
  ]);
  return { ...pinned, ...revisionsFrom(rows) };
}

/**
 * Why a stored plan no longer pins its pair, as `stale_context` refs: each
 * pinned reference that moved, then each reference of the pair the plan does
 * not pin (one that appeared after planning, or a plan made before pair
 * pins). Empty when the plan names no pair or pins all of it unmoved.
 */
export async function pairStaleRefs(store: CommandStore, plan: ChangePlan): Promise<string[]> {
  const refs = await pairReferences(store, plan.kind, plan.payload);
  const unpinned = refs.filter((ref) => !(ref in plan.expectedRevisions));
  if (unpinned.length === 0) return [];
  const rows = await store.all<RevisionRow>(CURRENT_REVISIONS_SQL, [
    expectedRevisionsJson(plan.expectedRevisions),
  ]);
  const current = revisionsFrom(rows);
  const moved = Object.entries(plan.expectedRevisions)
    .filter(([ref, revision]) => current[ref] !== revision)
    .map(([ref]) => ref);
  return [...moved, ...unpinned];
}

/**
 * The commit batch's own check that an account pair has no reference the
 * plan did not pin, as a precondition of the receipt reservation: a review
 * recorded between the commit's reads and its batch writes nothing. Null for
 * any other command (an instrument pair's set is fixed by its pinned
 * mappings).
 */
export function connectionPairGuard(
  kind: ChangeKind,
  payload: ChangePayload,
  pinned: ExpectedRevisions,
): CommitGuard | null {
  const connection = connectionPair(kind, payload);
  if (connection === null) return null;
  return {
    sql: `NOT EXISTS(SELECT 1 FROM (${CONNECTION_PAIR_REFS_SQL}) pair
      WHERE pair.subject_ref NOT IN (SELECT pinned.key FROM json_each(?) pinned))`,
    binds: [connection.fromRef, connection.toRef, expectedRevisionsJson(pinned)],
  };
}
