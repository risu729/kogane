// Run structure endpoints (ranges, page groups, units, unit reports). Request
// bodies are validated by the shared evidence-contract parsers; this module
// keeps only the database writes and their read-back conflict checks.
import {
  parseAddPageGroupRequest,
  parseAddRunRangeRequest,
  parseAddUnitReportRequest,
  parseAddUnitRequest,
} from "../../../packages/evidence-contract/src/requests";
import type { JsonValue } from "./canonical";
import { ApiError, assertSame, loadRun, readJson, type RecordValue, type WorkerEnv } from "./http";

export async function addRunRange(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const { rangeKey, ...fields } = parseAddRunRangeRequest(await readJson(request));
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO fetch_run_ranges (
      fetch_run_id, range_key, range_kind, precision, start_value, end_value,
      start_inclusive, end_inclusive, basis, recorded_by_client_id, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_run_ranges WHERE fetch_run_id = ? AND range_key = ?
    )
  `)
    .bind(
      runId,
      rangeKey,
      fields.rangeKind,
      fields.precision,
      fields.startValue,
      fields.endValue,
      fields.startInclusive,
      fields.endInclusive,
      fields.basis,
      clientId,
      now,
      runId,
      rangeKey,
    )
    .run();
  const row = await env.DB.prepare(`
    SELECT id, range_kind, precision, start_value, end_value, start_inclusive,
           end_inclusive, basis, recorded_by_client_id
    FROM fetch_run_ranges WHERE fetch_run_id = ? AND range_key = ?
  `)
    .bind(runId, rangeKey)
    .first<RecordValue>();
  assertSame(
    row,
    {
      range_kind: fields.rangeKind,
      precision: fields.precision,
      start_value: fields.startValue,
      end_value: fields.endValue,
      start_inclusive: fields.startInclusive,
      end_inclusive: fields.endInclusive,
      basis: fields.basis,
      recorded_by_client_id: clientId,
    },
    "fetch_run_range_conflict",
  );
  return { rangeId: row!.id as number };
}

export async function addPageGroup(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const { pageGroupKey, declaredPageCount } = parseAddPageGroupRequest(await readJson(request));
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO fetch_page_groups (
      fetch_run_id, page_group_key, declared_page_count,
      recorded_by_client_id, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_page_groups WHERE fetch_run_id = ? AND page_group_key = ?
    )
  `)
    .bind(runId, pageGroupKey, declaredPageCount, clientId, now, runId, pageGroupKey)
    .run();
  const row = await env.DB.prepare(`
    SELECT id, declared_page_count, recorded_by_client_id
    FROM fetch_page_groups WHERE fetch_run_id = ? AND page_group_key = ?
  `)
    .bind(runId, pageGroupKey)
    .first<RecordValue>();
  assertSame(
    row,
    {
      declared_page_count: declaredPageCount,
      recorded_by_client_id: clientId,
    },
    "fetch_page_group_conflict",
  );
  return { pageGroupId: row!.id as number };
}

export async function addUnit(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const { parentUnitId, unitKind, unitKey, terminalReportRequired } = parseAddUnitRequest(
    await readJson(request),
  );
  if (parentUnitId !== null) {
    const parent = await env.DB.prepare(
      "SELECT 1 AS ok FROM fetch_units WHERE id = ? AND fetch_run_id = ?",
    )
      .bind(parentUnitId, runId)
      .first<{ ok: number }>();
    if (!parent) throw new ApiError(409, "parent_unit_missing");
  }
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO fetch_units (
      fetch_run_id, parent_unit_id, unit_kind, unit_key,
      terminal_report_required, recorded_by_client_id, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_units
      WHERE fetch_run_id = ? AND unit_kind = ? AND unit_key = ?
        AND (parent_unit_id = ? OR (parent_unit_id IS NULL AND ? IS NULL))
    )
  `)
    .bind(
      runId,
      parentUnitId,
      unitKind,
      unitKey,
      terminalReportRequired,
      clientId,
      now,
      runId,
      unitKind,
      unitKey,
      parentUnitId,
      parentUnitId,
    )
    .run();
  const row = await env.DB.prepare(`
    SELECT id, terminal_report_required, recorded_by_client_id
    FROM fetch_units
    WHERE fetch_run_id = ? AND unit_kind = ? AND unit_key = ?
      AND (parent_unit_id = ? OR (parent_unit_id IS NULL AND ? IS NULL))
  `)
    .bind(runId, unitKind, unitKey, parentUnitId, parentUnitId)
    .first<RecordValue>();
  assertSame(
    row,
    {
      terminal_report_required: terminalReportRequired,
      recorded_by_client_id: clientId,
    },
    "fetch_unit_conflict",
  );
  return { unitId: row!.id as number };
}

export async function addUnitReport(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  unitId: number,
): Promise<Record<string, JsonValue>> {
  const unit = await env.DB.prepare(`
    SELECT id, fetch_run_id FROM fetch_units WHERE id = ?
  `)
    .bind(unitId)
    .first<{ id: number; fetch_run_id: number }>();
  if (!unit) throw new ApiError(404, "unit_not_found");
  await loadRun(env, clientId, unit.fetch_run_id);
  const { reportKey, ...report } = parseAddUnitReportRequest(await readJson(request));
  const fields = {
    report_kind: report.reportKind,
    producer_status: report.producerStatus,
    normalized_outcome: report.normalizedOutcome,
    started_at_ms: report.startedAtMs,
    started_at_basis: report.startedAtBasis,
    completed_at_ms: report.completedAtMs,
    completed_at_basis: report.completedAtBasis,
    declared_artifact_count: report.declaredArtifactCount,
    artifact_count_scope: report.artifactCountScope,
    safe_failure_code: report.safeFailureCode,
  };
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO fetch_unit_reports (
      fetch_unit_id, report_key, report_kind, recorded_by_client_id,
      producer_status, normalized_outcome, started_at_ms, started_at_basis,
      completed_at_ms, completed_at_basis, declared_artifact_count,
      artifact_count_scope, safe_failure_code, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_unit_reports WHERE fetch_unit_id = ? AND report_key = ?
    )
  `)
    .bind(
      unitId,
      reportKey,
      fields.report_kind,
      clientId,
      fields.producer_status,
      fields.normalized_outcome,
      fields.started_at_ms,
      fields.started_at_basis,
      fields.completed_at_ms,
      fields.completed_at_basis,
      fields.declared_artifact_count,
      fields.artifact_count_scope,
      fields.safe_failure_code,
      now,
      unitId,
      reportKey,
    )
    .run();
  const row = await env.DB.prepare(`
    SELECT id, report_kind, recorded_by_client_id, producer_status,
           normalized_outcome, started_at_ms, started_at_basis, completed_at_ms,
           completed_at_basis, declared_artifact_count, artifact_count_scope,
           safe_failure_code
    FROM fetch_unit_reports WHERE fetch_unit_id = ? AND report_key = ?
  `)
    .bind(unitId, reportKey)
    .first<RecordValue>();
  assertSame(row, { recorded_by_client_id: clientId, ...fields }, "fetch_unit_report_conflict");
  return { unitReportId: row!.id as number };
}
