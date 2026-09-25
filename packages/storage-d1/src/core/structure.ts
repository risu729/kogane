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

// ── what a staged registration already recorded (issue #87) ────────────
//
// A registration that spans invocations must not redo its structure on every
// call: the manifest may name 1,000 units and 1,000 ranges, and re-adding each
// one is several statements. One read per kind tells the caller what exists,
// so each call spends its budget only on what is missing.

export interface RunUnitRow {
  id: number;
  unit_kind: string;
  unit_key: string;
  parent_unit_id: number | null;
}

/** Every unit of one run, in id order. */
export async function readRunUnits(db: D1Like, runId: number): Promise<RunUnitRow[]> {
  const rows = await db
    .prepare(
      `
    SELECT id, unit_kind, unit_key, parent_unit_id
    FROM fetch_units WHERE fetch_run_id = ? ORDER BY id
  `,
    )
    .bind(runId)
    .all<RunUnitRow>();
  return rows.results;
}

/** The range keys one run already has. */
export async function readRunRangeKeys(db: D1Like, runId: number): Promise<string[]> {
  const rows = await db
    .prepare(
      `
    SELECT range_key FROM fetch_run_ranges WHERE fetch_run_id = ? ORDER BY range_key
  `,
    )
    .bind(runId)
    .all<{ range_key: string }>();
  return rows.results.map((row) => row.range_key);
}

/** The unit reports one run's units already have, by unit id and report key. */
export async function readRunUnitReportKeys(
  db: D1Like,
  runId: number,
): Promise<{ fetch_unit_id: number; report_key: string }[]> {
  const rows = await db
    .prepare(
      `
    SELECT r.fetch_unit_id, r.report_key
    FROM fetch_unit_reports r JOIN fetch_units u ON u.id = r.fetch_unit_id
    WHERE u.fetch_run_id = ? ORDER BY r.id
  `,
    )
    .bind(runId)
    .all<{ fetch_unit_id: number; report_key: string }>();
  return rows.results;
}
