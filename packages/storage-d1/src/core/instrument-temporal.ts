// ADR 0055 storage primitives. No route/planner registers a temporal command.
import { canonicalJson } from "../../../domain/src/context.ts";
import { validKnownAt } from "../../../domain/src/economic-contract.ts";
import { hasExactKeys, isRecord } from "../../../domain/src/guards.ts";
import {
  INSTRUMENT_TEMPORAL_BOUNDS,
  selectInstrumentTemporal,
  type InstrumentAcceptance,
  type InstrumentDecisionVersion,
  type InstrumentLegacyIdentity,
  type InstrumentTemporalInput,
  type InstrumentTemporalRequest,
} from "../../../domain/src/instrument-temporal.ts";
import type { CommandStore } from "./command-store.ts";
import type { SqlWrite } from "./operations.ts";
import { receiptExistsGuard } from "../atomic/decision-commit.ts";

type Reader = Pick<CommandStore, "first" | "all">;
export interface InstrumentJournalHead {
  coreEpoch: string;
  commitSeq: number;
  knownAt: string | null;
  sourceRevision: number;
}
type Failure = {
  ok: false;
  reason: "budget_exceeded" | "journal_inconsistent" | "stale_context" | "invalid_input";
};
const fail = (reason: Failure["reason"]): Failure => ({ ok: false, reason });
const HEAD_SQL = `SELECT r.core_epoch AS coreEpoch,r.source_revision AS sourceRevision,
 coalesce((SELECT max(commit_seq) FROM instrument_temporal_acceptances WHERE core_epoch=r.core_epoch),0) AS commitSeq,
 (SELECT known_at FROM instrument_temporal_acceptances WHERE core_epoch=r.core_epoch ORDER BY commit_seq DESC LIMIT 1) AS knownAt
 FROM core_source_revision r WHERE id=1`;

/** Capture a common cut, never pretend a sequential session is a SQL snapshot. */
export async function loadInstrumentTemporalSnapshot(
  sql: Reader,
  maxRows: number,
): Promise<Failure | { ok: true; head: InstrumentJournalHead; snapshot: InstrumentTemporalInput }> {
  if (!Number.isSafeInteger(maxRows) || maxRows < 0 || maxRows > 15_000)
    return fail("invalid_input");
  const head = await sql.first<InstrumentJournalHead>(HEAD_SQL);
  if (!head) return fail("journal_inconsistent");
  const binds = [head.coreEpoch, head.commitSeq];
  const counts = await sql.first<{ acceptances: number; versions: number; legacy: number }>(
    `SELECT
   (SELECT count(*) FROM instrument_temporal_acceptances WHERE core_epoch=?1 AND commit_seq<=?2) AS acceptances,
   (SELECT count(*) FROM instrument_temporal_versions WHERE core_epoch=?1 AND commit_seq<=?2) AS versions,
   (SELECT count(*) FROM instrument_mappings)+(SELECT count(*) FROM entity_relations WHERE kind='listed_as') AS legacy`,
    binds,
  );
  if (!counts || counts.acceptances !== head.commitSeq) return fail("journal_inconsistent");
  if (
    counts.acceptances > INSTRUMENT_TEMPORAL_BOUNDS.acceptances ||
    counts.versions > INSTRUMENT_TEMPORAL_BOUNDS.versions ||
    counts.legacy > INSTRUMENT_TEMPORAL_BOUNDS.legacy ||
    counts.acceptances + counts.versions + counts.legacy > maxRows
  )
    return fail("budget_exceeded");
  const acceptances = await sql.all<{ commit_seq: number; known_at: string; member_count: number }>(
    "SELECT commit_seq,known_at,member_count FROM instrument_temporal_acceptances WHERE core_epoch=?1 AND commit_seq<=?2 ORDER BY commit_seq LIMIT ?3",
    [...binds, maxRows + 1],
  );
  const rows = await sql.all<{ version_json: string }>(
    "SELECT version_json FROM instrument_temporal_versions WHERE core_epoch=?1 AND commit_seq<=?2 ORDER BY commit_seq,version_id LIMIT ?3",
    [...binds, maxRows + 1],
  );
  // No dates/targets are inferred for legacy assignments or relations. They
  // remain explicit blockers until a new logged version names them honestly.
  const legacyRows = await sql.all<{ id: string; series_json: string; evidence_json: string }>(
    `SELECT 'mapping:'||id AS id,
   json_object('kind','mapping','identifierId','identifier:'||identifier_id) AS series_json,
   json_array('mapping:'||id) AS evidence_json FROM instrument_mappings
   UNION ALL SELECT 'relation:'||id,json_object('kind','listed_as','fromRef',from_ref,'toRef',to_ref),evidence_refs_json
   FROM entity_relations WHERE kind='listed_as' LIMIT ?1`,
    [maxRows + 1],
  );
  const after = await sql.first<InstrumentJournalHead>(HEAD_SQL);
  if (
    !after ||
    after.coreEpoch !== head.coreEpoch ||
    after.sourceRevision !== head.sourceRevision ||
    after.commitSeq < head.commitSeq
  )
    return fail("stale_context");
  if (acceptances.length + rows.length + legacyRows.length > maxRows)
    return fail("budget_exceeded");
  if (
    acceptances.length !== counts.acceptances ||
    rows.length !== counts.versions ||
    legacyRows.length !== counts.legacy
  )
    return fail("journal_inconsistent");
  try {
    const versions = rows.map((row) => JSON.parse(row.version_json) as InstrumentDecisionVersion);
    const journal: InstrumentAcceptance[] = acceptances.map((a) => ({
      coreEpoch: head.coreEpoch,
      sequence: a.commit_seq,
      knownAt: a.known_at,
      members: versions
        .filter((v) => v.acceptanceSeq === a.commit_seq)
        .map((v) => ({ versionId: v.versionId, series: v.series, supersedes: v.supersedes })),
    }));
    if (
      journal.some(
        (a, i) => a.sequence !== i + 1 || a.members.length !== acceptances[i]!.member_count,
      )
    )
      return fail("journal_inconsistent");
    const legacy: InstrumentLegacyIdentity[] = legacyRows.map((row) => ({
      id: row.id,
      series: JSON.parse(row.series_json),
      evidenceRefs: JSON.parse(row.evidence_json),
    }));
    return {
      ok: true,
      head,
      snapshot: { coreEpoch: head.coreEpoch, acceptances: journal, versions, legacy },
    };
  } catch {
    return fail("journal_inconsistent");
  }
}

/** Reuse the reviewed selector, with a coherent database-supplied snapshot. */
export async function readInstrumentTemporalSelection(
  sql: Reader,
  request: unknown,
  maxRows: number,
) {
  const loaded = await loadInstrumentTemporalSnapshot(sql, maxRows);
  if (!loaded.ok) return loaded;
  return {
    ok: true as const,
    head: loaded.head,
    selection: await selectInstrumentTemporal(loaded.snapshot, request),
  };
}

export type InstrumentTemporalDraft = Omit<
  InstrumentDecisionVersion,
  "coreEpoch" | "acceptanceSeq"
>;
function denseJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return false;
    return value.every((v) => denseJson(v, depth + 1));
  }
  return (
    value === null ||
    typeof value !== "object" ||
    Object.values(value).every((v) => denseJson(v, depth + 1))
  );
}
/**
 * Internal mutation builder only. The future common command planner must
 * verify authorization and immutable payload provenance before calling it.
 * It does not execute, reserve an operation, grant authority or make a decision.
 */
export async function prepareInstrumentTemporalAppend(
  sql: Reader,
  input: {
    expectedHead: InstrumentJournalHead;
    versions: unknown;
    request: InstrumentTemporalRequest;
    operationId: string;
    principal: string;
    decisionRevisionId: string;
    /** Trusted server clock, never a temporal command payload field. */
    now: string;
    maxRows: number;
  },
): Promise<
  | Failure
  | { ok: true; precondition: SqlWrite; writes: SqlWrite[]; acceptance: InstrumentAcceptance }
> {
  if (
    !validKnownAt(input.now) ||
    !Array.isArray(input.versions) ||
    input.versions.length < 1 ||
    input.versions.length > INSTRUMENT_TEMPORAL_BOUNDS.members
  )
    return fail("invalid_input");
  // Validate density before canonical copying (JSON drops array holes). Freeze
  // all supplied fields before the first SQL await; later caller edits cannot
  // change validated intervals, series, guards or the trusted write metadata.
  try {
    if (!denseJson(input)) return fail("invalid_input");
    const json = canonicalJson(input);
    if (json.length > 1_048_576) return fail("budget_exceeded");
    input = JSON.parse(json) as typeof input;
  } catch {
    return fail("invalid_input");
  }
  if (!isRecord(input.request) || !Array.isArray(input.request.identifierIds))
    return fail("invalid_input");
  if (!Array.isArray(input.versions)) return fail("invalid_input");
  for (let i = 0; i < input.versions.length; i++) {
    const v: unknown = input.versions[i];
    if (
      !Object.hasOwn(input.versions, i) ||
      !isRecord(v) ||
      !hasExactKeys(v, [
        "versionId",
        "series",
        "supersedes",
        "supersedesLegacy",
        "contractVersion",
        "zone",
        "validity",
        "evidenceRefs",
        "reasonCode",
      ])
    )
      return fail("invalid_input");
  }
  const loaded = await loadInstrumentTemporalSnapshot(sql, input.maxRows);
  if (!loaded.ok) return loaded;
  if (canonicalJson(loaded.head) !== canonicalJson(input.expectedHead))
    return fail("stale_context");
  const head = loaded.head;
  const sequence = head.commitSeq + 1;
  const knownAt = head.knownAt !== null && head.knownAt > input.now ? head.knownAt : input.now;
  const versions = (input.versions as InstrumentTemporalDraft[]).map((v) => ({
    ...v,
    coreEpoch: head.coreEpoch,
    acceptanceSeq: sequence,
  }));
  const acceptance: InstrumentAcceptance = {
    coreEpoch: head.coreEpoch,
    sequence,
    knownAt,
    members: versions.map((v) => ({
      versionId: v.versionId,
      series: v.series,
      supersedes: v.supersedes,
    })),
  };
  // Every new series must be in the explicit request closure, otherwise the
  // selector would not validate that new version's interval contract.
  for (const v of versions) {
    if (!isRecord(v.series)) return fail("invalid_input");
    const ref = v.series.kind === "mapping" ? v.series.identifierId : v.series.toRef;
    if (!input.request.identifierIds.includes(ref)) return fail("invalid_input");
  }
  const selected = await selectInstrumentTemporal(
    {
      ...loaded.snapshot,
      acceptances: [...loaded.snapshot.acceptances, acceptance],
      versions: [...loaded.snapshot.versions, ...versions],
    },
    input.request,
  );
  if (selected.status !== "selected" || input.request.knowledge.mode !== "current")
    return fail("invalid_input");
  // Copy validated immutable content now; the caller cannot mutate a deferred write.
  const encoded = versions.map((v) => ({
    version: JSON.parse(canonicalJson(v)) as InstrumentDecisionVersion,
    json: canonicalJson(v),
    series: canonicalJson(v.series),
  }));
  const precondition: SqlWrite = {
    sql: `EXISTS(SELECT 1 FROM core_source_revision WHERE id=1 AND core_epoch=? AND source_revision=?)
     AND coalesce((SELECT max(commit_seq) FROM instrument_temporal_acceptances WHERE core_epoch=?),0)=?`,
    binds: [head.coreEpoch, head.sourceRevision, head.coreEpoch, head.commitSeq],
  };
  const receipt = receiptExistsGuard(input.operationId, input.principal);
  const guard = `${receipt.sql} AND NOT EXISTS(SELECT 1 FROM instrument_temporal_acceptances WHERE operation_id=?)`;
  const guards = [...receipt.binds, input.operationId];
  const writes: SqlWrite[] = encoded.map(({ version: v, json, series }) => ({
    sql: `INSERT INTO instrument_temporal_versions(version_id,core_epoch,commit_seq,series_key,supersedes,version_json)
     SELECT ?,?,?,?,?,? WHERE ${guard}`,
    binds: [v.versionId, head.coreEpoch, sequence, series, v.supersedes, json, ...guards],
  }));
  writes.push({
    sql: `INSERT INTO instrument_temporal_acceptances(core_epoch,commit_seq,known_at,operation_id,decision_revision_id,member_count)
     SELECT ?,?,?,?,?,? WHERE ${guard}
      AND EXISTS(SELECT 1 FROM decision_revisions WHERE id=? AND operation_id=? AND actor_id=?)`,
    binds: [
      head.coreEpoch,
      sequence,
      knownAt,
      input.operationId,
      input.decisionRevisionId,
      versions.length,
      ...guards,
      input.decisionRevisionId,
      input.operationId,
      input.principal,
    ],
  });
  return { ok: true, precondition, writes, acceptance };
}
