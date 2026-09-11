// The Drizzle half of `../core/fetch-runs.ts` (unified plan 09 §2, pilot).
//
// The read-back of a run report is the widest row in the pilot: eleven of its
// fourteen columns are nullable, across both storage classes. That is the
// point of including it — a mapper that turns an absent `completed_at_ms`
// into 0, or an absent `producer_status` into "", would be caught here and
// nowhere else.
import { and, eq } from "drizzle-orm";
import { coreDrizzle } from "./client.ts";
import { fetchRunReports } from "./schema/core.ts";
import type { D1Like } from "../d1.ts";

/** What a recorded report holds, for the read-back comparison after a write. */
export async function readRunReport(
  db: D1Like,
  runId: number,
  reportKey: string,
): Promise<Record<string, unknown> | null> {
  const rows = await coreDrizzle(db)
    .select({
      id: fetchRunReports.id,
      report_kind: fetchRunReports.reportKind,
      recorded_by_client_id: fetchRunReports.recordedByClientId,
      producer_version: fetchRunReports.producerVersion,
      producer_revision: fetchRunReports.producerRevision,
      manifest_schema_version: fetchRunReports.manifestSchemaVersion,
      producer_status: fetchRunReports.producerStatus,
      normalized_outcome: fetchRunReports.normalizedOutcome,
      started_at_ms: fetchRunReports.startedAtMs,
      started_at_basis: fetchRunReports.startedAtBasis,
      completed_at_ms: fetchRunReports.completedAtMs,
      completed_at_basis: fetchRunReports.completedAtBasis,
      declared_artifact_count: fetchRunReports.declaredArtifactCount,
      artifact_count_scope: fetchRunReports.artifactCountScope,
    })
    .from(fetchRunReports)
    .where(and(eq(fetchRunReports.fetchRunId, runId), eq(fetchRunReports.reportKey, reportKey)))
    .limit(1);
  return rows[0] ?? null;
}
