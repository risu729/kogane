// The report artifact catalogue's reads: the list, one artifact, its latest
// calculation run, the restrictions on its inputs and its events. Moved here
// from `services/app/src/reports-api.ts` (ADR 0081 point 2), so
// `GET /api/v2/reports[/…]` and `kogane.reports.read` run the same SQL and no
// MCP adapter holds any. The route keeps its query checks, the R2 reads and
// the replayability decision.
import type { EvidenceUseRestriction, Replayability } from "../../../domain/src/index";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

/**
 * The newest artifacts first, ties by id, so paging is deterministic. Catalogue
 * columns only: listing never reads a body from R2, never derives
 * replayability and never counts rows, so the list cannot disagree with what
 * re-displaying one report says about it. `?1` limit, `?2` offset.
 */
export const REPORT_LIST_SQL = `SELECT report_id,context_id,purpose,schema_version,content_digest,created_by,created_at
FROM report_artifacts
ORDER BY created_at DESC,report_id DESC
LIMIT ?1 OFFSET ?2`;

export interface ReportArtifactRow {
  report_id: string;
  context_id: string;
  purpose: string;
  schema_version: string;
  content_digest: string;
  storage_ref: string;
  created_by: string;
  created_at: string;
}

export interface CalculationRunRow {
  run_id: string;
  policy_refs_json: string;
  input_manifest_digest: string;
  status: string;
  replayability: Replayability;
  started_at: string;
  completed_at: string | null;
}

export interface ReportEventRow {
  kind: string;
  actor: string;
  related_report_id: string | null;
  occurred_at: string;
}

/** One page of the catalogue: up to `limit` rows from `offset`, newest first. */
export function listReportArtifacts(
  sql: SqlExecutor,
  limit: number,
  offset: number,
): Promise<Omit<ReportArtifactRow, "storage_ref">[]> {
  return sql.all(REPORT_LIST_SQL, [limit, offset]);
}

export function reportArtifact(
  sql: SqlExecutor,
  reportId: string,
): Promise<ReportArtifactRow | null> {
  return sql.first(
    `SELECT report_id,context_id,purpose,schema_version,content_digest,storage_ref,created_by,created_at
     FROM report_artifacts WHERE report_id=?`,
    [reportId],
  );
}

/** The newest calculation run of a context, or null when none was recorded. */
export function latestCalculationRun(
  sql: SqlExecutor,
  contextId: string,
): Promise<CalculationRunRow | null> {
  return sql.first(
    `SELECT run_id,policy_refs_json,input_manifest_digest,status,replayability,started_at,completed_at
     FROM calculation_runs WHERE context_id=? ORDER BY started_at DESC LIMIT 1`,
    [contextId],
  );
}

/** The use restrictions naming any of `refs`, directly or as an affected manifest. */
export async function reportRestrictions(
  sql: SqlExecutor,
  refs: readonly string[],
): Promise<EvidenceUseRestriction[]> {
  if (refs.length === 0) return [];
  const rows = await sql.all<{
    evidence_ref: string;
    restriction: EvidenceUseRestriction["restriction"];
    since: string;
    affected_manifests_json: string;
    actor: string;
    reason: string;
  }>(
    `SELECT evidence_ref,restriction,since,affected_manifests_json,actor,reason
       FROM evidence_use_restrictions
       WHERE evidence_ref IN (${refs.map(() => "?").join(",")})
          OR EXISTS(SELECT 1 FROM json_each(affected_manifests_json) m
                    WHERE m.value IN (${refs.map(() => "?").join(",")}))`,
    [...refs, ...refs],
  );
  return rows.map((row) => ({
    evidenceRef: row.evidence_ref,
    restriction: row.restriction,
    since: row.since,
    affectedManifests: [],
    actor: row.actor,
    reason: row.reason,
  }));
}

/** A report's first 200 events, oldest first. */
export function reportEvents(sql: SqlExecutor, reportId: string): Promise<ReportEventRow[]> {
  return sql.all(
    "SELECT kind,actor,related_report_id,occurred_at FROM report_events WHERE report_id=? ORDER BY occurred_at,id LIMIT 200",
    [reportId],
  );
}
