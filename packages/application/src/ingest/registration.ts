// Registering a run: the acquisition session it belongs to, the run itself,
// and the report that says how it ended.
//
// Every write is conditional on its own absence and then read back and
// compared with what this request meant to write (`assertSame`). That is what
// makes a retried registration a no-op and a genuinely different second
// registration a conflict, rather than an overwrite of somebody's history.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05. The functions
// take an already-parsed request body instead of a `Request`, so the same code
// serves the legacy HTTP adapter and a Processor that registers a terminal
// run directly, with no HTTP hop (unified plan 02 §3).
import {
  parseCreateRunRequest,
  parseAddRunReportRequest,
} from "../../../evidence-contract/src/requests.ts";
import {
  insertAcquisitionSessionIfAbsent,
  insertFetchRunIfAbsent,
  insertRunReportIfAbsent,
  readAcquisitionSession,
  readFetchRunByKey,
  type RunReportFields,
} from "../../../storage-d1/src/core/fetch-runs.ts";
// The report read-back is the Drizzle pilot's; the conditional inserts above
// keep their guards in SQL (09 §2, decision D11).
import { readRunReport } from "../../../storage-d1/src/drizzle/fetch-runs.ts";
import { loadRun, requireRoute } from "./access.ts";
import { assertSame, type IngestEnv, type RecordValue } from "./contract.ts";

export interface CreatedRun {
  sessionId: number;
  runId: number;
}

/**
 * The terminal registration of a collection run: session then run, both
 * idempotent on the producer's own external ids.
 */
export async function createRun(
  env: IngestEnv,
  clientId: string,
  body: RecordValue,
): Promise<CreatedRun> {
  const {
    producerId,
    sourceId,
    externalIdNamespace: namespace,
    externalSessionId,
    sourceRunKey,
  } = parseCreateRunRequest(body);
  await requireRoute(env, clientId, producerId, sourceId);
  const now = Date.now();

  await insertAcquisitionSessionIfAbsent(
    env.DB,
    producerId,
    clientId,
    namespace,
    externalSessionId,
    now,
  );
  const session = await readAcquisitionSession(env.DB, producerId, namespace, externalSessionId);
  assertSame(
    session,
    {
      producer_id: producerId,
      first_recorded_by_client_id: clientId,
      external_id_namespace: namespace,
      external_session_id: externalSessionId,
    },
    "acquisition_session_conflict",
  );

  const sessionId = session!.id as number;
  await insertFetchRunIfAbsent(
    env.DB,
    sessionId,
    producerId,
    sourceId,
    clientId,
    sourceRunKey,
    now,
  );
  const run = await readFetchRunByKey(env.DB, sessionId, sourceId, sourceRunKey);
  assertSame(
    run,
    {
      acquisition_session_id: sessionId,
      producer_id: producerId,
      source_id: sourceId,
      first_recorded_by_client_id: clientId,
      source_run_key: sourceRunKey,
    },
    "fetch_run_conflict",
  );
  return { sessionId, runId: run!.id as number };
}

/** The run's own report: what the producer said it did, and how it ended. */
export async function addRunReport(
  env: IngestEnv,
  clientId: string,
  runId: number,
  body: RecordValue,
): Promise<{ reportId: number }> {
  await loadRun(env, clientId, runId);
  const { reportKey, reportKind, ...report } = parseAddRunReportRequest(body);
  // Key order matches the INSERT column list of `insertRunReportIfAbsent`.
  const fields: RunReportFields = {
    producer_version: report.producerVersion,
    producer_revision: report.producerRevision,
    manifest_schema_version: report.manifestSchemaVersion,
    producer_status: report.producerStatus,
    normalized_outcome: report.normalizedOutcome,
    started_at_ms: report.startedAtMs,
    started_at_basis: report.startedAtBasis,
    completed_at_ms: report.completedAtMs,
    completed_at_basis: report.completedAtBasis,
    declared_artifact_count: report.declaredArtifactCount,
    artifact_count_scope: report.artifactCountScope,
  };
  const now = Date.now();
  await insertRunReportIfAbsent(env.DB, runId, reportKey, reportKind, clientId, fields, now);
  const row = await readRunReport(env.DB, runId, reportKey);
  assertSame(
    row,
    { report_kind: reportKind, recorded_by_client_id: clientId, ...fields },
    "fetch_run_report_conflict",
  );
  return { reportId: row!.id as number };
}
