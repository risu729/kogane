// Publication gate writer (design review D03, PR-05 step 2) and its
// operational checks. `published_parse_runs` (migration 0026) is the adoption
// pointer per (artifact, parser) that every normal reader joins; this module
// is the only production code that moves it.
//
// Two rules keep the gate honest during the compatibility period:
//   * The projection mirrors the supersession decision exactly. A run is
//     published only when the same batch left it `ok` and unsuperseded; a
//     late-completing older version is born superseded and never touches
//     the pointer. The legacy predicate therefore stays equal to the
//     projection after every publish, which is what an old reader needs.
//   * Every pointer change appends a publication_events row. Nothing here
//     deletes or rewrites history; repair only adds what an old writer
//     (one that predates the gate) published without the projection.
//
// The legacy predicate `status='ok' AND superseded_by_parse_run_id IS NULL` (gate:comparison)
// appears in this file on purpose; tasks/_lib/publication-gate-predicates.test.ts
// allows it only on lines marked `gate:writer` or `gate:comparison`, and only
// in this file, the worker's supersession batch, the candidate writer, the PoC
// store writer and the read model's legacy comparison concept. Since migration
// 0028 the repair selection states none of it: it reads
// `publication_gate_gaps`, which already excludes candidate results and runs
// an adoption replaced.

import type { D1Like, D1StatementLike } from "../d1.ts";

/** Selection of a run the repair route must publish: a genuine gap left by a
 * writer that predates the gate, as `publication_gate_gaps` (migration 0028)
 * defines it - an `ok`, unsuperseded run the projection does not name, that is
 * neither a candidate result nor a run an adoption replaced. Repair must never
 * publish either of those. `?1` bounds the batch. */
const REPAIR_SELECTION = `SELECT g.parse_run_id AS id FROM publication_gate_gaps g
    WHERE g.mismatch='legacy_only'
      AND NOT EXISTS(SELECT 1 FROM publication_gate_gaps q WHERE q.mismatch='legacy_only'
        AND q.fetch_artifact_id=g.fetch_artifact_id AND q.parser_name=g.parser_name
        AND q.parse_run_id>g.parse_run_id)
    ORDER BY g.parse_run_id LIMIT ?1`;

/** The publish batch must be a no-op when it is replayed for a run that is
 * already the pointer of its key: without this, a second execution appends a
 * `normal` event whose previous and new run are the same and rewrites
 * `published_at`. Migration 0036 makes the event half of that a schema error;
 * this predicate keeps the writer from ever attempting it. */
const NOT_ALREADY_PUBLISHED = `NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id=p.id)`;

/** The lease fence of the publish batch's first statement, restated for the
 * publication statements: they must not depend only on the effect of that
 * statement, because a replay finds that effect already committed. */
const LIVE_LEASE = `EXISTS(SELECT 1 FROM observation_parse_jobs
          WHERE lease_token=?3 AND status='running' AND lease_until_ms>?4)`;

const UPSERT_PROJECTION = `ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET
    parse_run_id=excluded.parse_run_id,parser_version=excluded.parser_version,
    published_at=excluded.published_at,publication_kind='normal',release_id=NULL`;

/**
 * Statements appended to the publish batch after `status='ok'` is set and
 * older runs are superseded, inside the same D1 transaction. Each selects the
 * run only if that batch left it current, so a numerically older late arrival
 * (born superseded) changes nothing; each carries the same live-lease fence
 * as the batch's first statement and the "not already the pointer" guard, so
 * re-executing the batch for a run that is already published changes nothing
 * either — no second `normal` event, no rewritten `published_at`. The event
 * is recorded before the pointer moves so it can name the run it replaces.
 */
export function publicationStatements(
  db: D1Like,
  parseId: number,
  publishedAt: string,
  /** The lease this attempt holds; both statements are fenced on it. */
  token: string,
  now: number,
): D1StatementLike[] {
  return [
    db
      .prepare(
        `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
        SELECT p.fetch_artifact_id,p.parser_name,
          (SELECT x.parse_run_id FROM published_parse_runs x WHERE x.fetch_artifact_id=p.fetch_artifact_id AND x.parser_name=p.parser_name),
          p.id,'normal','pipeline','parse_ok',?2
        FROM parse_runs p WHERE p.id=?1 AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL -- gate:writer
          AND ${NOT_ALREADY_PUBLISHED} AND ${LIVE_LEASE}`,
      )
      .bind(parseId, publishedAt, token, now),
    db
      .prepare(
        `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
        SELECT p.fetch_artifact_id,p.parser_name,p.id,p.parser_version,?2,'normal'
        FROM parse_runs p WHERE p.id=?1 AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL -- gate:writer
          AND ${NOT_ALREADY_PUBLISHED} AND ${LIVE_LEASE}
        ${UPSERT_PROJECTION}`,
      )
      .bind(parseId, publishedAt, token, now),
  ];
}

export interface PublicationMismatch {
  fetch_artifact_id: number;
  parser_name: string;
  parse_run_id: number;
  mismatch: "legacy_only" | "projection_only";
}

export interface PublicationConsistency {
  published: number;
  legacyOnly: number;
  projectionOnly: number;
  mismatches: number;
  /** Bounded sample of mismatching keys; ids only, never observation values. */
  sample: PublicationMismatch[];
}

/**
 * Publication gaps: keys the projection and the writers disagree about
 * (`publication_gate_gaps`, migration 0028). Candidate results and runs an
 * activation replaced are excluded on purpose - they are expected `ok`,
 * unsuperseded runs, not gaps. The raw legacy comparison stays available as
 * `publication_gate_mismatches` for the audit path.
 */
export async function publicationConsistency(
  db: D1Like,
  sampleLimit = 100,
): Promise<PublicationConsistency> {
  const counts = await db
    .prepare(
      `SELECT (SELECT count(*) FROM published_parse_runs) AS published,
        (SELECT count(*) FROM publication_gate_gaps WHERE mismatch='legacy_only') AS legacy_only,
        (SELECT count(*) FROM publication_gate_gaps WHERE mismatch='projection_only') AS projection_only`,
    )
    .first<{ published: number; legacy_only: number; projection_only: number }>();
  const sample = await db
    .prepare(
      "SELECT fetch_artifact_id,parser_name,parse_run_id,mismatch FROM publication_gate_gaps ORDER BY parse_run_id LIMIT ?1",
    )
    .bind(sampleLimit)
    .all<PublicationMismatch>();
  const legacyOnly = counts?.legacy_only ?? 0;
  const projectionOnly = counts?.projection_only ?? 0;
  return {
    published: counts?.published ?? 0,
    legacyOnly,
    projectionOnly,
    mismatches: legacyOnly + projectionOnly,
    sample: sample.results,
  };
}

export const REPAIR_LIMIT_DEFAULT = 200;
export const REPAIR_LIMIT_MAX = 1000;
export const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._:@-]{0,99}$/;

export interface RepairRequest {
  /** Operator id recorded on every event; 'pipeline' is reserved for the writer. */
  actor: string;
  reason: string;
  limit: number;
}

export interface RepairResult {
  repaired: number;
  remaining: number;
}

/**
 * Bounded, idempotent repair: publishes at most `limit` legacy-current runs
 * that the projection does not name, appending one 'repair' event each.
 * Re-running with no gap changes nothing. Both statements evaluate the same
 * selection inside one transaction, so the events name exactly the runs the
 * upsert publishes.
 */
export async function repairPublication(db: D1Like, request: RepairRequest): Promise<RepairResult> {
  if (!ACTOR_PATTERN.test(request.actor) || request.actor === "pipeline")
    throw new Error("publication_actor_invalid");
  if (request.reason.length < 1 || request.reason.length > 200)
    throw new Error("publication_reason_invalid");
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > REPAIR_LIMIT_MAX)
    throw new Error("publication_limit_invalid");
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
        SELECT p.fetch_artifact_id,p.parser_name,
          (SELECT x.parse_run_id FROM published_parse_runs x WHERE x.fetch_artifact_id=p.fetch_artifact_id AND x.parser_name=p.parser_name),
          p.id,'repair',?2,?3,?4
        FROM parse_runs p WHERE p.id IN (${REPAIR_SELECTION})`,
      )
      .bind(request.limit, request.actor, request.reason, now),
    db
      .prepare(
        `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
        SELECT p.fetch_artifact_id,p.parser_name,p.id,p.parser_version,?2,'normal'
        FROM parse_runs p WHERE p.id IN (${REPAIR_SELECTION})
        ${UPSERT_PROJECTION}`,
      )
      .bind(request.limit, now),
  ]);
  // Same query as before the move; the column is read off the row rather than
  // through D1's `first(colName)` overload, which the structural interface of
  // this package does not carry.
  const remaining = await db
    .prepare("SELECT count(*) AS n FROM publication_gate_gaps")
    .first<{ n: number }>();
  return { repaired: results[1]?.meta.changes ?? 0, remaining: remaining?.n ?? 0 };
}

export interface PublishInput {
  parseId: number;
  /** The lease this attempt holds; nothing publishes once it has expired. */
  token: string;
  version: number[];
  artifactId: number;
  parserName: string;
  publishedAt: string;
  now: number;
}

/**
 * The publish transaction of a successful *adopted* parse, in order: mark the
 * run ok (born superseded when a numerically newer success is already current),
 * supersede older successes if this run is current, move the publication
 * projection and record its event (0026, same decision), then close the job.
 * Every statement that writes is fenced on the live lease, not only the
 * first: an expired lease changes nothing, and replaying the whole batch for
 * a run that is already published changes nothing either, because the effect
 * the later statements would otherwise key on is already committed.
 * Candidate results (`parse_run_candidates`, migration 0028) are excluded from
 * supersession in both directions: a candidate must not be turned into
 * replaced history by a later normal publish, and a candidate at a higher
 * version must not supersede the run readers actually use. With the release
 * flag off that table is empty and this batch behaves exactly as before.
 */
export function publishBatch(db: D1Like, input: PublishInput): D1StatementLike[] {
  const { parseId, token, version, artifactId, parserName, publishedAt, now } = input;
  return [
    db
      .prepare(
        `UPDATE parse_runs SET status='ok',superseded_by_parse_run_id=(
          SELECT newer.id FROM parse_runs newer
          WHERE newer.fetch_artifact_id=parse_runs.fetch_artifact_id
            AND newer.parser_name=parse_runs.parser_name AND newer.status='ok'
            AND newer.superseded_by_parse_run_id IS NULL -- gate:writer
            AND NOT EXISTS(SELECT 1 FROM parse_run_candidates c WHERE c.parse_run_id=newer.id)
            AND (
              json_extract('['||replace(newer.parser_version,'.',',')||']','$[0]'),
              json_extract('['||replace(newer.parser_version,'.',',')||']','$[1]'),
              json_extract('['||replace(newer.parser_version,'.',',')||']','$[2]')
            ) > (?,?,?)
          ORDER BY
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[0]') DESC,
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[1]') DESC,
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[2]') DESC LIMIT 1
        ) WHERE id=? AND EXISTS(SELECT 1 FROM observation_parse_jobs WHERE lease_token=? AND status='running' AND lease_until_ms>?)`,
      )
      .bind(version[0]!, version[1]!, version[2]!, parseId, token, now),
    db
      .prepare(
        `UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE fetch_artifact_id=? AND parser_name=? AND id<>? AND status='ok' AND superseded_by_parse_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM parse_run_candidates c WHERE c.parse_run_id=parse_runs.id) AND EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=? AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL)`, // gate:writer
      )
      .bind(parseId, artifactId, parserName, parseId, parseId),
    ...publicationStatements(db, parseId, publishedAt, token, now),
    // Fenced on the live lease like the first statement: a replayed batch
    // must not touch a job another attempt has already closed.
    db
      .prepare(
        `UPDATE observation_parse_jobs SET status='done',last_error_code=NULL WHERE lease_token=? AND status='running' AND EXISTS(SELECT 1 FROM parse_runs WHERE id=? AND status='ok')`,
      )
      .bind(token, parseId),
  ];
}
