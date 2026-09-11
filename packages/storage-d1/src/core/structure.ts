// Run structure (migration 0001): the ranges a run covers, its page groups,
// its units and the report each unit ends with. Like the run rows themselves,
// every write is conditional on absence and read back, so a retry is a no-op
// and a genuine disagreement is a conflict rather than an overwrite.
//
// Extracted from `services/raw-evidence/src/structure.ts` by U05; SQL unchanged.
import type { D1Like, Row } from "../d1.ts";

export interface RunRangeFields {
  rangeKind: string;
  precision: string;
  startValue: string | null;
  endValue: string | null;
  startInclusive: number;
  endInclusive: number;
  basis: string | null;
}

export async function insertRunRangeIfAbsent(
  db: D1Like,
  runId: number,
  rangeKey: string,
  fields: RunRangeFields,
  clientId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO fetch_run_ranges (
      fetch_run_id, range_key, range_kind, precision, start_value, end_value,
      start_inclusive, end_inclusive, basis, recorded_by_client_id, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_run_ranges WHERE fetch_run_id = ? AND range_key = ?
    )
  `,
    )
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
}

export async function readRunRange(
  db: D1Like,
  runId: number,
  rangeKey: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, range_kind, precision, start_value, end_value, start_inclusive,
           end_inclusive, basis, recorded_by_client_id
    FROM fetch_run_ranges WHERE fetch_run_id = ? AND range_key = ?
  `,
    )
    .bind(runId, rangeKey)
    .first<Row>();
}

export async function insertPageGroupIfAbsent(
  db: D1Like,
  runId: number,
  pageGroupKey: string,
  declaredPageCount: number | null,
  clientId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO fetch_page_groups (
      fetch_run_id, page_group_key, declared_page_count,
      recorded_by_client_id, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_page_groups WHERE fetch_run_id = ? AND page_group_key = ?
    )
  `,
    )
    .bind(runId, pageGroupKey, declaredPageCount, clientId, now, runId, pageGroupKey)
    .run();
}

export async function readPageGroup(
  db: D1Like,
  runId: number,
  pageGroupKey: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, declared_page_count, recorded_by_client_id
    FROM fetch_page_groups WHERE fetch_run_id = ? AND page_group_key = ?
  `,
    )
    .bind(runId, pageGroupKey)
    .first<Row>();
}

/** Whether the parent unit a new unit names belongs to the same run. */
export async function unitBelongsToRun(
  db: D1Like,
  unitId: number,
  runId: number,
): Promise<boolean> {
  const parent = await db
    .prepare("SELECT 1 AS ok FROM fetch_units WHERE id = ? AND fetch_run_id = ?")
    .bind(unitId, runId)
    .first<{ ok: number }>();
  return parent !== null;
}

export async function insertUnitIfAbsent(
  db: D1Like,
  runId: number,
  parentUnitId: number | null,
  unitKind: string,
  unitKey: string,
  terminalReportRequired: number,
  clientId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO fetch_units (
      fetch_run_id, parent_unit_id, unit_kind, unit_key,
      terminal_report_required, recorded_by_client_id, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_units
      WHERE fetch_run_id = ? AND unit_kind = ? AND unit_key = ?
        AND (parent_unit_id = ? OR (parent_unit_id IS NULL AND ? IS NULL))
    )
  `,
    )
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
}

export async function readUnit(
  db: D1Like,
  runId: number,
  unitKind: string,
  unitKey: string,
  parentUnitId: number | null,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, terminal_report_required, recorded_by_client_id
    FROM fetch_units
    WHERE fetch_run_id = ? AND unit_kind = ? AND unit_key = ?
      AND (parent_unit_id = ? OR (parent_unit_id IS NULL AND ? IS NULL))
  `,
    )
    .bind(runId, unitKind, unitKey, parentUnitId, parentUnitId)
    .first<Row>();
}

/** The unit a unit-report names, with the run whose route authorizes it. */
export async function readUnitById(
  db: D1Like,
  unitId: number,
): Promise<{ id: number; fetch_run_id: number } | null> {
  return await db
    .prepare(
      `
    SELECT id, fetch_run_id FROM fetch_units WHERE id = ?
  `,
    )
    .bind(unitId)
    .first<{ id: number; fetch_run_id: number }>();
}

export interface UnitReportFields {
  report_kind: string;
  producer_status: string | null;
  normalized_outcome: string;
  started_at_ms: number | null;
  started_at_basis: string | null;
  completed_at_ms: number | null;
  completed_at_basis: string | null;
  declared_artifact_count: number | null;
  artifact_count_scope: string | null;
  safe_failure_code: string | null;
}

export async function insertUnitReportIfAbsent(
  db: D1Like,
  unitId: number,
  reportKey: string,
  fields: UnitReportFields,
  clientId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `
    INSERT INTO fetch_unit_reports (
      fetch_unit_id, report_key, report_kind, recorded_by_client_id,
      producer_status, normalized_outcome, started_at_ms, started_at_basis,
      completed_at_ms, completed_at_basis, declared_artifact_count,
      artifact_count_scope, safe_failure_code, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_unit_reports WHERE fetch_unit_id = ? AND report_key = ?
    )
  `,
    )
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
}

export async function readUnitReport(
  db: D1Like,
  unitId: number,
  reportKey: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT id, report_kind, recorded_by_client_id, producer_status,
           normalized_outcome, started_at_ms, started_at_basis, completed_at_ms,
           completed_at_basis, declared_artifact_count, artifact_count_scope,
           safe_failure_code
    FROM fetch_unit_reports WHERE fetch_unit_id = ? AND report_key = ?
  `,
    )
    .bind(unitId, reportKey)
    .first<Row>();
}
