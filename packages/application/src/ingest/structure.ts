// Run structure: the ranges a run covers, its page groups, its units and the
// report each unit ends with. Same shape as the run registration — validate,
// write conditionally, read back and compare.
//
// Extracted from `services/raw-evidence/src/structure.ts` by U05.
import {
  parseAddPageGroupRequest,
  parseAddRunRangeRequest,
  parseAddUnitReportRequest,
  parseAddUnitRequest,
} from "../../../evidence-contract/src/requests.ts";
import {
  insertPageGroupIfAbsent,
  insertRunRangeIfAbsent,
  insertUnitIfAbsent,
  insertUnitReportIfAbsent,
  readPageGroup,
  readRunRange,
  readUnit,
  readUnitById,
  readUnitReport,
  unitBelongsToRun,
  type UnitReportFields,
} from "../../../storage-d1/src/core/structure.ts";
import { loadRun } from "./access.ts";
import { assertSame, IngestError, type IngestEnv, type RecordValue } from "./contract.ts";

export async function addRunRange(
  env: IngestEnv,
  clientId: string,
  runId: number,
  body: RecordValue,
): Promise<{ rangeId: number }> {
  await loadRun(env, clientId, runId);
  const { rangeKey, ...fields } = parseAddRunRangeRequest(body);
  const now = Date.now();
  await insertRunRangeIfAbsent(env.DB, runId, rangeKey, fields, clientId, now);
  const row = await readRunRange(env.DB, runId, rangeKey);
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
  env: IngestEnv,
  clientId: string,
  runId: number,
  body: RecordValue,
): Promise<{ pageGroupId: number }> {
  await loadRun(env, clientId, runId);
  const { pageGroupKey, declaredPageCount } = parseAddPageGroupRequest(body);
  const now = Date.now();
  await insertPageGroupIfAbsent(env.DB, runId, pageGroupKey, declaredPageCount, clientId, now);
  const row = await readPageGroup(env.DB, runId, pageGroupKey);
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
  env: IngestEnv,
  clientId: string,
  runId: number,
  body: RecordValue,
): Promise<{ unitId: number }> {
  await loadRun(env, clientId, runId);
  const { parentUnitId, unitKind, unitKey, terminalReportRequired } = parseAddUnitRequest(body);
  if (parentUnitId !== null) {
    if (!(await unitBelongsToRun(env.DB, parentUnitId, runId)))
      throw new IngestError(409, "parent_unit_missing");
  }
  const now = Date.now();
  await insertUnitIfAbsent(
    env.DB,
    runId,
    parentUnitId,
    unitKind,
    unitKey,
    terminalReportRequired,
    clientId,
    now,
  );
  const row = await readUnit(env.DB, runId, unitKind, unitKey, parentUnitId);
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
  env: IngestEnv,
  clientId: string,
  unitId: number,
  body: RecordValue,
): Promise<{ unitReportId: number }> {
  const unit = await readUnitById(env.DB, unitId);
  if (!unit) throw new IngestError(404, "unit_not_found");
  await loadRun(env, clientId, unit.fetch_run_id);
  const { reportKey, ...report } = parseAddUnitReportRequest(body);
  const fields: UnitReportFields = {
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
  await insertUnitReportIfAbsent(env.DB, unitId, reportKey, fields, clientId, now);
  const row = await readUnitReport(env.DB, unitId, reportKey);
  assertSame(row, { recorded_by_client_id: clientId, ...fields }, "fetch_unit_report_conflict");
  return { unitReportId: row!.id as number };
}
