import type { JsonValue } from "./canonical";
import {
  ApiError,
  OPAQUE,
  assertSame,
  enumValue,
  exactKeys,
  integerValue,
  loadRun,
  readJson,
  stringValue,
  type RecordValue,
  type WorkerEnv,
} from "./http";

const OUTCOMES = [
  "success", "partial", "failed", "running", "human_required", "cancelled", "unknown",
] as const;
const TIME_BASES = ["source", "manifest", "schedule", "file_metadata", "email", "operator", "unknown"] as const;

export interface RangeFields {
  rangeKind: string;
  precision: string;
  startValue: string | null;
  endValue: string | null;
  startInclusive: number;
  endInclusive: number;
  basis: string;
}

function boolInteger(value: unknown, field: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new ApiError(400, `invalid_${field}`);
}

function canonicalRangeValue(value: unknown, precision: string, field: string): string | null {
  const parsed = stringValue(value, field, { optional: true, max: 35 });
  if (parsed === null) return null;
  if (precision === "month" && /^\d{4}-(0[1-9]|1[0-2])$/.test(parsed)) return parsed;
  if (precision === "date" && /^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    const date = new Date(`${parsed}T00:00:00.000Z`);
    if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === parsed) return parsed;
  }
  if (precision === "instant") {
    const date = new Date(parsed);
    if (!Number.isNaN(date.valueOf()) && date.toISOString() === parsed) return parsed;
  }
  throw new ApiError(400, `invalid_${field}`);
}

export function parseRangeFields(value: RecordValue): RangeFields {
  const precision = enumValue(value.precision, "precision", ["instant", "date", "month"] as const)!;
  const startValue = canonicalRangeValue(value.startValue, precision, "start_value");
  const endValue = canonicalRangeValue(value.endValue, precision, "end_value");
  if (startValue === null && endValue === null) throw new ApiError(400, "empty_range");
  if (startValue !== null && endValue !== null && startValue > endValue) {
    throw new ApiError(400, "reversed_range");
  }
  return {
    rangeKind: enumValue(value.rangeKind, "range_kind", [
      "requested", "declared_coverage", "selector",
    ] as const)!,
    precision,
    startValue,
    endValue,
    startInclusive: boolInteger(value.startInclusive, "start_inclusive", 1),
    endInclusive: boolInteger(value.endInclusive, "end_inclusive", 1),
    basis: enumValue(value.basis, "range_basis", [
      "source", "request", "manifest", "operator",
    ] as const)!,
  };
}

export async function addRunRange(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const input = await readJson(request);
  exactKeys(input, [
    "rangeKey", "rangeKind", "precision", "startValue", "endValue",
    "startInclusive", "endInclusive", "basis",
  ]);
  const rangeKey = stringValue(input.rangeKey, "range_key", { max: 200, pattern: OPAQUE })!;
  const fields = parseRangeFields(input);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO fetch_run_ranges (
      fetch_run_id, range_key, range_kind, precision, start_value, end_value,
      start_inclusive, end_inclusive, basis, recorded_by_client_id, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_run_ranges WHERE fetch_run_id = ? AND range_key = ?
    )
  `).bind(
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
  ).run();
  const row = await env.DB.prepare(`
    SELECT id, range_kind, precision, start_value, end_value, start_inclusive,
           end_inclusive, basis, recorded_by_client_id
    FROM fetch_run_ranges WHERE fetch_run_id = ? AND range_key = ?
  `).bind(runId, rangeKey).first<RecordValue>();
  assertSame(row, {
    range_kind: fields.rangeKind,
    precision: fields.precision,
    start_value: fields.startValue,
    end_value: fields.endValue,
    start_inclusive: fields.startInclusive,
    end_inclusive: fields.endInclusive,
    basis: fields.basis,
    recorded_by_client_id: clientId,
  }, "fetch_run_range_conflict");
  return { rangeId: row!.id as number };
}

export async function addPageGroup(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const input = await readJson(request);
  exactKeys(input, ["pageGroupKey", "declaredPageCount"]);
  const pageGroupKey = stringValue(input.pageGroupKey, "page_group_key", { pattern: OPAQUE })!;
  const declaredPageCount = integerValue(input.declaredPageCount, "declared_page_count", true);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO fetch_page_groups (
      fetch_run_id, page_group_key, declared_page_count,
      recorded_by_client_id, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_page_groups WHERE fetch_run_id = ? AND page_group_key = ?
    )
  `).bind(runId, pageGroupKey, declaredPageCount, clientId, now, runId, pageGroupKey).run();
  const row = await env.DB.prepare(`
    SELECT id, declared_page_count, recorded_by_client_id
    FROM fetch_page_groups WHERE fetch_run_id = ? AND page_group_key = ?
  `).bind(runId, pageGroupKey).first<RecordValue>();
  assertSame(row, {
    declared_page_count: declaredPageCount,
    recorded_by_client_id: clientId,
  }, "fetch_page_group_conflict");
  return { pageGroupId: row!.id as number };
}

export async function addUnit(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const input = await readJson(request);
  exactKeys(input, ["parentUnitId", "unitKind", "unitKey", "terminalReportRequired"]);
  const parentUnitId = integerValue(input.parentUnitId, "parent_unit_id", true);
  if (parentUnitId !== null) {
    const parent = await env.DB.prepare(
      "SELECT 1 AS ok FROM fetch_units WHERE id = ? AND fetch_run_id = ?",
    ).bind(parentUnitId, runId).first<{ ok: number }>();
    if (!parent) throw new ApiError(409, "parent_unit_missing");
  }
  const unitKind = stringValue(input.unitKind, "unit_kind", { max: 100 })!;
  const unitKey = stringValue(input.unitKey, "unit_key", { pattern: OPAQUE })!;
  const terminalRequired = boolInteger(input.terminalReportRequired, "terminal_report_required", 0);
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
  `).bind(
    runId,
    parentUnitId,
    unitKind,
    unitKey,
    terminalRequired,
    clientId,
    now,
    runId,
    unitKind,
    unitKey,
    parentUnitId,
    parentUnitId,
  ).run();
  const row = await env.DB.prepare(`
    SELECT id, terminal_report_required, recorded_by_client_id
    FROM fetch_units
    WHERE fetch_run_id = ? AND unit_kind = ? AND unit_key = ?
      AND (parent_unit_id = ? OR (parent_unit_id IS NULL AND ? IS NULL))
  `).bind(runId, unitKind, unitKey, parentUnitId, parentUnitId).first<RecordValue>();
  assertSame(row, {
    terminal_report_required: terminalRequired,
    recorded_by_client_id: clientId,
  }, "fetch_unit_conflict");
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
  `).bind(unitId).first<{ id: number; fetch_run_id: number }>();
  if (!unit) throw new ApiError(404, "unit_not_found");
  await loadRun(env, clientId, unit.fetch_run_id);
  const input = await readJson(request);
  exactKeys(input, [
    "reportKey", "reportKind", "producerStatus", "normalizedOutcome",
    "startedAtMs", "startedAtBasis", "completedAtMs", "completedAtBasis",
    "declaredArtifactCount", "artifactCountScope", "safeFailureCode",
  ]);
  const reportKey = stringValue(input.reportKey, "report_key", { pattern: OPAQUE })!;
  const fields = {
    report_kind: enumValue(input.reportKind, "report_kind", ["progress", "terminal"] as const)!,
    producer_status: stringValue(input.producerStatus, "producer_status", { optional: true, max: 100 }),
    normalized_outcome: enumValue(input.normalizedOutcome ?? "unknown", "normalized_outcome", OUTCOMES)!,
    started_at_ms: integerValue(input.startedAtMs, "started_at_ms", true),
    started_at_basis: enumValue(input.startedAtBasis, "started_at_basis", TIME_BASES, true),
    completed_at_ms: integerValue(input.completedAtMs, "completed_at_ms", true),
    completed_at_basis: enumValue(input.completedAtBasis, "completed_at_basis", TIME_BASES, true),
    declared_artifact_count: integerValue(input.declaredArtifactCount, "declared_artifact_count", true),
    artifact_count_scope: enumValue(input.artifactCountScope, "artifact_count_scope", [
      "direct", "subtree", "producer_defined",
    ] as const, true),
    safe_failure_code: stringValue(input.safeFailureCode, "safe_failure_code", { optional: true, max: 100 }),
  };
  if ((fields.started_at_ms === null) !== (fields.started_at_basis === null) ||
      (fields.completed_at_ms === null) !== (fields.completed_at_basis === null) ||
      (fields.declared_artifact_count === null) !== (fields.artifact_count_scope === null)) {
    throw new ApiError(400, "unit_report_field_pair_mismatch");
  }
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
  `).bind(
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
  ).run();
  const row = await env.DB.prepare(`
    SELECT id, report_kind, recorded_by_client_id, producer_status,
           normalized_outcome, started_at_ms, started_at_basis, completed_at_ms,
           completed_at_basis, declared_artifact_count, artifact_count_scope,
           safe_failure_code
    FROM fetch_unit_reports WHERE fetch_unit_id = ? AND report_key = ?
  `).bind(unitId, reportKey).first<RecordValue>();
  assertSame(row, { recorded_by_client_id: clientId, ...fields }, "fetch_unit_report_conflict");
  return { unitReportId: row!.id as number };
}
