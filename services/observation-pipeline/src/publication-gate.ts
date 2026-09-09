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
// The legacy predicate `status='ok' AND superseded_by_parse_run_id IS NULL`
// appears in this file on purpose; scripts/publication-gate-predicates.test.ts
// allows it only here, in the worker's supersession batch, in the PoC store
// writer and in the read model's legacy comparison concept.

/** Selection of a run the repair route must publish: the legacy-current run
 * of a key whose projection does not name it. `?1` bounds the batch. */
const REPAIR_SELECTION = `SELECT p.id FROM parse_runs p
    WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM parse_runs q WHERE q.fetch_artifact_id=p.fetch_artifact_id
        AND q.parser_name=p.parser_name AND q.status='ok' AND q.superseded_by_parse_run_id IS NULL AND q.id>p.id)
    ORDER BY p.id LIMIT ?1`;

const UPSERT_PROJECTION = `ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET
    parse_run_id=excluded.parse_run_id,parser_version=excluded.parser_version,
    published_at=excluded.published_at,publication_kind='normal',release_id=NULL`;

/**
 * Statements appended to the publish batch after `status='ok'` is set and
 * older runs are superseded, inside the same D1 transaction. Both select the
 * run only if that batch left it current, so a lost lease (status still
 * pending) or a numerically older late arrival (born superseded) changes
 * nothing. The event is recorded before the pointer moves so it can name the
 * run it replaces.
 */
export function publicationStatements(
  db: D1Database,
  parseId: number,
  publishedAt: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
        SELECT p.fetch_artifact_id,p.parser_name,
          (SELECT x.parse_run_id FROM published_parse_runs x WHERE x.fetch_artifact_id=p.fetch_artifact_id AND x.parser_name=p.parser_name),
          p.id,'normal','pipeline','parse_ok',?2
        FROM parse_runs p WHERE p.id=?1 AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL`,
      )
      .bind(parseId, publishedAt),
    db
      .prepare(
        `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
        SELECT p.fetch_artifact_id,p.parser_name,p.id,p.parser_version,?2,'normal'
        FROM parse_runs p WHERE p.id=?1 AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL
        ${UPSERT_PROJECTION}`,
      )
      .bind(parseId, publishedAt),
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

/** Compares the projection with the legacy predicate (view of migration 0026). */
export async function publicationConsistency(
  db: D1Database,
  sampleLimit = 100,
): Promise<PublicationConsistency> {
  const counts = await db
    .prepare(
      `SELECT (SELECT count(*) FROM published_parse_runs) AS published,
        (SELECT count(*) FROM publication_gate_mismatches WHERE mismatch='legacy_only') AS legacy_only,
        (SELECT count(*) FROM publication_gate_mismatches WHERE mismatch='projection_only') AS projection_only`,
    )
    .first<{ published: number; legacy_only: number; projection_only: number }>();
  const sample = await db
    .prepare(
      "SELECT fetch_artifact_id,parser_name,parse_run_id,mismatch FROM publication_gate_mismatches ORDER BY parse_run_id LIMIT ?1",
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
export async function repairPublication(
  db: D1Database,
  request: RepairRequest,
): Promise<RepairResult> {
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
  const remaining = await db
    .prepare("SELECT count(*) AS n FROM publication_gate_mismatches")
    .first<number>("n");
  return { repaired: results[1]?.meta.changes ?? 0, remaining: remaining ?? 0 };
}
