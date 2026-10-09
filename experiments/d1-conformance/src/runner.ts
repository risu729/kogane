import generated, { corpusDigest } from "./corpus.generated.ts";
import type { SqlWrite } from "../../../packages/storage-d1/src/core/operations.ts";
import type { BatchCase, RaceCase, Corpus } from "./contract.ts";

const corpus: Corpus = generated;

interface Metric {
  statementsSubmitted: number;
  statementsReturned: number;
  durationMs: number | null;
  rowsRead: number | null;
  rowsWritten: number | null;
  changes: number[] | null;
  cpuMs: null;
}
interface CaseReport {
  name: string;
  passed: boolean;
  errorCode: string | null;
  metrics: Metric[];
}
interface TableShape {
  name: string;
  column_name: string;
  cid: number;
}

function closedError(error: unknown, codes: readonly string[]): string | null {
  const parts: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    parts.push(current.message);
    current = current.cause;
  }
  return codes.find((code) => parts.some((message) => message.includes(code))) ?? null;
}
function assert(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function prepare(db: D1Database, write: SqlWrite): D1PreparedStatement {
  return db.prepare(write.sql).bind(...write.binds);
}
async function batch(db: D1Database, writes: SqlWrite[]) {
  const results = await db.batch<Record<string, unknown>>(
    writes.map((write) => prepare(db, write)),
  );
  assert(
    results.length === writes.length && results.every((result) => result.success),
    "batch_result_invalid",
  );
  const sum = (field: "duration" | "rows_read" | "rows_written") =>
    results.every((result) => Number.isFinite(result.meta[field]))
      ? results.reduce((total, result) => total + result.meta[field], 0)
      : null;
  return {
    results,
    metric: {
      statementsSubmitted: writes.length,
      statementsReturned: results.length,
      durationMs: sum("duration"),
      rowsRead: sum("rows_read"),
      rowsWritten: sum("rows_written"),
      changes: results.map((result) => result.meta.changes),
      cpuMs: null,
    } satisfies Metric,
  };
}
function failedMetric(writes: SqlWrite[]): Metric {
  return {
    statementsSubmitted: writes.length,
    statementsReturned: 0,
    durationMs: null,
    rowsRead: null,
    rowsWritten: null,
    changes: null,
    cpuMs: null,
  };
}

/** Build bounded snapshot queries without a large compound SELECT. */
async function snapshotSql(db: D1Database): Promise<string[]> {
  const shape = await db
    .prepare(`SELECT m.name,p.name AS column_name,p.cid
    FROM sqlite_schema m JOIN pragma_table_info(m.name) p
    WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'
      AND m.name NOT LIKE '_cf_%' AND m.name<>'d1_migrations' AND m.name<>'conformance_run'
    ORDER BY m.name,p.cid`)
    .all<TableShape>();
  const tables = new Map<string, string[]>();
  for (const row of shape.results) {
    assert(
      /^[a-zA-Z0-9_]+$/u.test(row.name) && /^[a-zA-Z0-9_]+$/u.test(row.column_name),
      "schema_name_invalid",
    );
    const columns = tables.get(row.name) ?? [];
    columns.push(row.column_name);
    tables.set(row.name, columns);
  }
  assert(
    JSON.stringify([...tables.keys()].sort()) ===
      JSON.stringify(Object.keys(corpus.baselineCounts).sort()),
    "schema_baseline_mismatch",
  );
  const expressions = [...tables].map(([name, columns]) => {
    const quoted = columns.map((column) => '"' + column + '"');
    // Nest column groups so even a wide table stays below 32 function arguments.
    const groups = Array.from(
      { length: Math.ceil(quoted.length / 16) },
      (_, index) => "json_array(" + quoted.slice(index * 16, (index + 1) * 16).join(",") + ")",
    );
    return `(SELECT json_object('name','${name}','n',count(*),'rows',
      coalesce(json_group_array(json_array(${groups.join(",")})),'[]'))
      FROM (SELECT * FROM "${name}" ORDER BY ${quoted.join(",")}))`;
  });
  const chunks = Array.from(
    { length: Math.ceil(expressions.length / 16) },
    (_, index) =>
      "SELECT json_array(" +
      expressions.slice(index * 16, (index + 1) * 16).join(",") +
      ") AS state_json",
  );
  assert(
    chunks.every((sql) => new TextEncoder().encode(sql).length < 100_000),
    "snapshot_sql_limit",
  );
  return chunks;
}
async function snapshot(db: D1Database, sql: string[]): Promise<string> {
  const result = await db.batch<{ state_json: string }>(
    sql.map((statement) => db.prepare(statement)),
  );
  assert(
    result.every((item) => item.success),
    "snapshot_failed",
  );
  const text = JSON.stringify(result.map((item) => item.results));
  assert(new TextEncoder().encode(text).length < 2_000_000, "synthetic_snapshot_limit");
  return text;
}
async function checkBaseline(db: D1Database): Promise<void> {
  // Aggregate counts only, before any row snapshot or fixture write.
  const names = Object.keys(corpus.baselineCounts).sort();
  const expressions = names.map((name) => `(SELECT count(*) FROM "${name}") AS "${name}"`);
  const chunks = Array.from(
    { length: Math.ceil(expressions.length / 16) },
    (_, index) => "SELECT " + expressions.slice(index * 16, (index + 1) * 16).join(","),
  );
  const results = await db.batch<Record<string, number>>(chunks.map((sql) => db.prepare(sql)));
  const counts = Object.assign({}, ...results.flatMap((item) => item.results));
  assert(
    results.every((item) => item.success) &&
      Object.keys(counts).length === names.length &&
      names.every((name) => counts[name] === corpus.baselineCounts[name]),
    "nonempty_or_wrong_synthetic_database",
  );
}
async function ordinary(db: D1Database, sql: string[], item: BatchCase): Promise<CaseReport> {
  const before = await snapshot(db, sql);
  let metric: Metric;
  let code: string | null = null;
  let output: Awaited<ReturnType<typeof batch>> | undefined;
  try {
    output = await batch(db, item.writes);
    metric = output.metric;
  } catch (error) {
    code = closedError(error, item.codes ?? []);
    metric = failedMetric(item.writes);
    assert(item.expect === "reject" && code !== null, "unexpected_batch_error");
  }
  if (item.expect === "reject") {
    assert(output === undefined && code !== null, "expected_rejection_missing");
    assert((await snapshot(db, sql)) === before, "rollback_snapshot_changed");
  } else {
    assert(output !== undefined, "batch_result_missing");
    if (item.expect === "zero") {
      assert(output.metric.changes?.every((value) => value === 0) === true, "replay_wrote_rows");
      assert((await snapshot(db, sql)) === before, "replay_snapshot_changed");
    } else if (item.expect === "write") {
      assert(output.metric.changes?.every((value) => value > 0) === true, "expected_write_missing");
    } else {
      assert(output.results[0]?.results.length === item.rowCount, "bound_ids_result_count");
      assert(
        item.writes.length === 1 && item.writes[0]?.binds.length === 1,
        "bound_ids_parameter_count",
      );
      assert(output.metric.changes?.every((value) => value === 0) === true, "read_wrote_rows");
      const subjectJson = item.writes[0]?.binds[0];
      assert(typeof subjectJson === "string", "bound_ids_json_invalid");
      const expected: Record<string, number> = JSON.parse(subjectJson);
      const rows = output.results[0]!.results;
      assert(
        rows.length === Object.keys(expected).length &&
          new Set(rows.map((row) => row.subject_ref)).size === rows.length &&
          rows.every(
            (row) =>
              typeof row.subject_ref === "string" &&
              Object.hasOwn(expected, row.subject_ref) &&
              row.revision === expected[row.subject_ref],
          ),
        "bound_ids_result_content",
      );
    }
  }
  if (item.verify) {
    const row = await prepare(db, item.verify.write).first<
      Record<string, string | number | null>
    >();
    assert(
      row !== null &&
        Object.keys(item.verify.row).every((key) => row[key] === item.verify!.row[key]),
      "accepted_state_invalid",
    );
  }
  return { name: item.name, passed: true, errorCode: code, metrics: [metric] };
}
async function racing(db: D1Database, item: RaceCase): Promise<CaseReport> {
  // Sends two independent binding batches; does not force a chosen winner.
  const results = await Promise.allSettled(item.race.map((writes) => batch(db, writes)));
  const successful = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert(successful.length === (item.expect === "exclusive" ? 1 : 2), "race_success_count");
  assert(rejected.length === (item.expect === "exclusive" ? 1 : 0), "race_failure_count");
  const codes = rejected.map((result) => closedError(result.reason, item.codes ?? []));
  assert(
    codes.every((code) => code !== null),
    "race_unexpected_error",
  );
  if (item.expect === "idempotent")
    assert(
      successful.filter((result) => result.value.metric.changes?.every((value) => value === 0))
        .length === 1,
      "race_replay_changed",
    );
  const row = await prepare(db, item.verify).first<Record<string, number>>();
  assert(
    row !== null && Object.values(row).every((value) => value === 1),
    "race_live_holder_count",
  );
  return {
    name: item.name,
    passed: true,
    errorCode: codes[0] ?? null,
    metrics: results.map((result, index) =>
      result.status === "fulfilled" ? result.value.metric : failedMetric(item.race[index]!),
    ),
  };
}

export async function runConformance(db: D1Database, runtime: "local-miniflare" | "remote-d1") {
  const reports: CaseReport[] = [];
  const chunks = Math.ceil(Object.keys(corpus.baselineCounts).length / 16);
  const queryBudgetUpperBound =
    chunks +
    1 +
    corpus.seed.length +
    2 +
    2 +
    corpus.cases.reduce(
      (count, item) =>
        "race" in item
          ? count + item.race.reduce((n, writes) => n + writes.length, 0) + 1
          : count +
            item.writes.length +
            chunks * (item.expect === "reject" || item.expect === "zero" ? 2 : 1) +
            (item.verify ? 1 : 0),
      0,
    );
  assert(queryBudgetUpperBound <= 950, "paid_query_budget_exceeded");
  try {
    await checkBaseline(db);
  } catch (cause) {
    throw new Error("baseline stage", { cause });
  }
  let sql: string[];
  try {
    sql = await snapshotSql(db);
  } catch (cause) {
    throw new Error("snapshot SQL stage", { cause });
  }
  try {
    await batch(db, corpus.seed);
  } catch (cause) {
    throw new Error("seed stage", { cause });
  }
  for (const item of corpus.cases) {
    try {
      reports.push("race" in item ? await racing(db, item) : await ordinary(db, sql, item));
    } catch (error) {
      reports.push({
        name: item.name,
        passed: false,
        errorCode:
          closedError(error, [
            "unexpected_batch_error",
            "expected_rejection_missing",
            "rollback_snapshot_changed",
            "replay_wrote_rows",
            "replay_snapshot_changed",
            "expected_write_missing",
            "bound_ids_result_count",
            "bound_ids_parameter_count",
            "bound_ids_result_content",
            "read_wrote_rows",
            "accepted_state_invalid",
            "race_success_count",
            "race_failure_count",
            "race_unexpected_error",
            "race_replay_changed",
            "race_live_holder_count",
          ]) ?? "conformance_internal_failure",
        metrics: [],
      });
      break;
    }
  }
  const foreignKeys = await db.prepare("PRAGMA foreign_key_check").all();
  const unlogged = await db
    .prepare("SELECT count(*) AS n FROM unlogged_economic_revisions")
    .first<{ n: number }>();
  const passed =
    reports.length === corpus.cases.length &&
    reports.every((item) => item.passed) &&
    foreignKeys.results.length === 0 &&
    unlogged?.n === 0;
  return {
    version: corpus.version,
    runtime,
    corpusDigest,
    baseCommit: corpus.baseCommit,
    queryBudgetUpperBound,
    lastMigration: corpus.lastMigration,
    migrationDigest: corpus.migrationDigest,
    passed,
    cases: reports,
    foreignKeyViolations: foreignKeys.results.length,
    unloggedCount: unlogged?.n ?? null,
    cpuMs: null,
    cpuEvidence: "separate-worker-invocation-telemetry-required",
    remoteGateSatisfied: false,
  };
}
