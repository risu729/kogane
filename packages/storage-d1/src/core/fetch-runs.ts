// Acquisition sessions, fetch runs and run reports (migration 0001): "a
// producer went and fetched something, here is when it started and how it
// ended". Every write is conditional on its own absence and read back, so a
// retried registration produces one row and a genuinely different second
// registration is reported as a conflict instead of overwriting the first.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05; SQL unchanged.
import type { D1Like, Row } from "../d1.ts";

export async function insertAcquisitionSessionIfAbsent(
  db: D1Like,
  producerId: string,
  clientId: string,
  namespace: string,
  externalSessionId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO acquisition_sessions (
      producer_id, first_recorded_by_client_id, external_id_namespace,
      external_session_id, first_recorded_at_ms
    ) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM acquisition_sessions
      WHERE producer_id = ? AND external_id_namespace = ? AND external_session_id = ?
    )
  `,
    )
    .bind(
      producerId,
      clientId,
      namespace,
      externalSessionId,
      now,
      producerId,
      namespace,
      externalSessionId,
    )
    .run();
}

/** The acquisition session a registered run belongs to, or null if it is gone. */
export async function readFetchRunSessionId(
  db: D1Like,
  fetchRunId: number,
): Promise<number | null> {
  const row = await db
    .prepare("SELECT acquisition_session_id FROM fetch_runs WHERE id = ?")
    .bind(fetchRunId)
    .first<{ acquisition_session_id: number | null }>();
  return row?.acquisition_session_id ?? null;
}

export async function readAcquisitionSession(
  db: D1Like,
  producerId: string,
  namespace: string,
  externalSessionId: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, producer_id, first_recorded_by_client_id,
           external_id_namespace, external_session_id
    FROM acquisition_sessions
    WHERE producer_id = ? AND external_id_namespace = ? AND external_session_id = ?
  `,
    )
    .bind(producerId, namespace, externalSessionId)
    .first<Row>();
}

export async function insertFetchRunIfAbsent(
  db: D1Like,
  sessionId: number,
  producerId: string,
  sourceId: string,
  clientId: string,
  sourceRunKey: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO fetch_runs (
      acquisition_session_id, producer_id, source_id,
      first_recorded_by_client_id, source_run_key, first_recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_runs
      WHERE acquisition_session_id = ? AND source_id = ? AND source_run_key = ?
    )
  `,
    )
    .bind(
      sessionId,
      producerId,
      sourceId,
      clientId,
      sourceRunKey,
      now,
      sessionId,
      sourceId,
      sourceRunKey,
    )
    .run();
}

export async function readFetchRunByKey(
  db: D1Like,
  sessionId: number,
  sourceId: string,
  sourceRunKey: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, acquisition_session_id, producer_id, source_id,
           first_recorded_by_client_id, source_run_key
    FROM fetch_runs
    WHERE acquisition_session_id = ? AND source_id = ? AND source_run_key = ?
  `,
    )
    .bind(sessionId, sourceId, sourceRunKey)
    .first<Row>();
}

/** Column list of `fetch_run_reports`, in the order the INSERT below binds. */
export interface RunReportFields {
  producer_version: string | null;
  producer_revision: string | null;
  manifest_schema_version: string | null;
  producer_status: string | null;
  normalized_outcome: string;
  started_at_ms: number | null;
  started_at_basis: string | null;
  completed_at_ms: number | null;
  completed_at_basis: string | null;
  declared_artifact_count: number | null;
  artifact_count_scope: string | null;
}

export async function insertRunReportIfAbsent(
  db: D1Like,
  runId: number,
  reportKey: string,
  reportKind: string,
  clientId: string,
  fields: RunReportFields,
  now: number,
): Promise<void> {
  const values = [runId, reportKey, reportKind, clientId, ...Object.values(fields), now];
  await db
    .prepare(
      `
    INSERT INTO fetch_run_reports (
      fetch_run_id, report_key, report_kind, recorded_by_client_id,
      producer_version, producer_revision, manifest_schema_version, producer_status,
      normalized_outcome, started_at_ms, started_at_basis, completed_at_ms,
      completed_at_basis, declared_artifact_count, artifact_count_scope, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM fetch_run_reports WHERE fetch_run_id = ? AND report_key = ?
    )
  `,
    )
    .bind(...values, runId, reportKey)
    .run();
}

export async function readRunReport(
  db: D1Like,
  runId: number,
  reportKey: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, report_kind, recorded_by_client_id, producer_version, producer_revision,
           manifest_schema_version, producer_status, normalized_outcome, started_at_ms,
           started_at_basis, completed_at_ms, completed_at_basis,
           declared_artifact_count, artifact_count_scope
    FROM fetch_run_reports WHERE fetch_run_id = ? AND report_key = ?
  `,
    )
    .bind(runId, reportKey)
    .first<Row>();
}
