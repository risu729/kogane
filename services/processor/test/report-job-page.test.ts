// The report job's position set when the store holds more than one reader
// page (501 rows) of positions and some of the first page were recorded after
// the knowledge cutoff (AT63), and when the store changes between two page
// reads (INV06). Every row is synthetic: made-up accounts, security codes and
// quantities.
import { afterAll, expect } from "bun:test";
import type { Miniflare } from "miniflare";
import { runReportJob, type ReportJobEnv } from "../src/report-job.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import { settledTest } from "./support/settle.ts";

let mf: Miniflare;
let env: Env;
let jobEnv: ReportJobEnv;
// Started while the module loads, never in a hook (test/support/settle.ts).
({ mf, env } = await startPipeline());
jobEnv = { DB: env.DB, EVIDENCE: env.EVIDENCE, REPORTS_ENABLED: "true" };
const test = settledTest();
afterAll(async () => {
  await mf?.dispose();
});

const CUTOFF = "2026-09-10T00:00:00.000Z";
const options = {
  actor: "report-job",
  now: CUTOFF,
  unitRef: "JPY",
  perimeterRef: "perimeter:test",
  knowledgeCutoff: CUTOFF,
  decimalPolicyRelease: "decimal-v1",
};

/** One published parse run holding `count` synthetic positions of `account`. */
async function seedPositions(
  artifactId: number,
  account: string,
  count: number,
  recordedAtMs: number,
  prefix: string,
): Promise<void> {
  await seedArtifact(env, artifactId, "other-test", "positions", `positions-${artifactId}.json`, {
    synthetic: artifactId,
  });
  await env.DB.prepare("UPDATE fetch_artifacts SET recorded_at_ms=?,fetched_at_ms=? WHERE id=?")
    .bind(recordedAtMs, Date.parse("2026-09-01T00:00:00.000Z"), artifactId)
    .run();
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,'synthetic-positions','1','2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(artifactId)
    .first<{ id: number }>();
  await publishParse(env.DB, parse!.id);
  const codes = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);
  await env.DB.prepare(
    `INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
     SELECT ?, ?, value, '1', 0, '$', '{}' FROM json_each(?)`,
  )
    .bind(parse!.id, account, JSON.stringify(codes))
    .run();
}

test("positions past the reader's first page are not dropped when late ones are filtered out", async () => {
  // Ten positions recorded after the cutoff sort first (account "a-late"),
  // then 501 recorded before it: the first page of 501 rows holds the ten late
  // ones and only 491 in-scope ones.
  await seedPositions(7001, "a-late", 10, Date.parse("2026-09-20T00:00:00.000Z"), "LATE");
  await seedPositions(7002, "b-known", 501, Date.parse("2026-09-05T00:00:00.000Z"), "SYN");

  const result = await runReportJob(jobEnv, options);
  expect(result.generated).toBe(1);
  // 501 positions are in scope and the bound is 500: the report says it is
  // truncated, rather than claiming 491 positions are the whole scope.
  expect(result.truncated).toBe(true);
  const run = await env.DB.prepare(
    "SELECT count(DISTINCT subject_ref) AS n FROM calculation_results WHERE run_id=?",
  )
    .bind(result.runId)
    .first<{ n: number }>();
  expect(run!.n).toBe(500);
  const late = await env.DB.prepare(
    "SELECT count(*) AS n FROM calculation_results WHERE run_id=? AND subject_ref LIKE ?",
  )
    .bind(result.runId, "%:LATE-%")
    .first<{ n: number }>();
  expect(late!.n).toBe(0);

  // With a bound above the in-scope count, every in-scope position is read,
  // including those on the reader's second page, and nothing is truncated.
  const all = await runReportJob(jobEnv, { ...options, maxRows: 600 });
  expect(all.truncated).toBe(false);
  const manifest = await env.DB.prepare(
    "SELECT count(DISTINCT subject_ref) AS n FROM calculation_results WHERE run_id=?",
  )
    .bind(all.runId)
    .first<{ n: number }>();
  expect(manifest!.n).toBe(501);
}, 120_000);

/**
 * `db`, with `inject` run once right after the first cutoff lookup answers:
 * after the job read the first positions page and before it reads the next,
 * as if another invocation published into the store between the two reads.
 */
function publishingBetweenPages(db: D1Database, inject: () => Promise<void>): D1Database {
  let pending = true;
  return new Proxy(db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!pending || !sql.includes("coalesce(a.recorded_at_ms, a.fetched_at_ms) > ?"))
          return statement;
        pending = false;
        return {
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              all: async <T>() => {
                const rows = await bound.all<T>();
                await inject();
                return rows;
              },
            };
          },
        };
      };
    },
  });
}

test("a row the offset shifts onto the next page is read once", async () => {
  const clean = await runReportJob(jobEnv, { ...options, maxRows: 600 });
  expect(clean.truncated).toBe(false);
  // Five positions recorded after the cutoff land between the two reads and
  // sort before every in-scope one, so the second page starts five rows
  // earlier and repeats the last five rows of the first.
  const shifted = await runReportJob(
    {
      ...jobEnv,
      DB: publishingBetweenPages(env.DB, () =>
        seedPositions(7003, "a-mid", 5, Date.parse("2026-09-21T00:00:00.000Z"), "MID"),
      ),
    },
    { ...options, maxRows: 600 },
  );
  // The five new rows were never read, so the pages were not one cut: the job
  // reads again, the late rows are excluded and no row is counted twice, so
  // the input set, and with it the context, is the clean run's (INV06).
  expect(shifted.contextId).toBe(clean.contextId);
  expect(shifted.truncated).toBe(false);
}, 120_000);

/**
 * Re-parse artifact 7002 (account "b-known") and publish the new run, which
 * replaces the earlier parse as the artifact's adopted result: the same
 * holdings come back under new observation ids, plus the `extra` codes. Each
 * re-parse is a new parser version, as a release re-parse is.
 */
let reparses = 0;
async function republishKnown(extra: readonly string[]): Promise<void> {
  reparses += 1;
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (7002,'synthetic-positions',?,'2026-09-08T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(`2.${reparses}`)
    .first<{ id: number }>();
  const codes = [
    ...extra,
    ...Array.from({ length: 501 }, (_, i) => `SYN-${String(i).padStart(4, "0")}`),
  ];
  await env.DB.prepare(
    `INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
     SELECT ?, 'b-known', value, '1', 0, '$', '{}' FROM json_each(?)`,
  )
    .bind(parse!.id, JSON.stringify(codes))
    .run();
  await publishParse(env.DB, parse!.id, "2026-09-08T00:00:00.000Z");
}

/** The stored body's rows of a report, read back from R2. */
async function bodyRows(reportId: string): Promise<{ subjectRef: string; scopeRef: string }[]> {
  const stored = await env.DB.prepare("SELECT storage_ref FROM report_artifacts WHERE report_id=?")
    .bind(reportId)
    .first<{ storage_ref: string }>();
  const object = await env.EVIDENCE.get(stored!.storage_ref);
  return ((await object!.json()) as { rows: { subjectRef: string; scopeRef: string }[] }).rows;
}

test("a snapshot republished between two page reads never counts a holding twice", async () => {
  // The store holds 15 late rows, then account "b-known"'s 501 holdings: the
  // first page ends at its 485th holding. A re-parse published between the
  // two reads adds one holding that sorts first, so the second page starts
  // one row earlier, on the new run's copy of the holding the first page
  // read last. Kept by observation id, both copies were counted (INV06).
  const republished = await runReportJob(
    { ...jobEnv, DB: publishingBetweenPages(env.DB, () => republishKnown(["AAA-0000"])) },
    { ...options, maxRows: 600 },
  );
  expect(republished.generated).toBe(1);
  expect(republished.skipped).toBeNull();
  const rows = await bodyRows(republished.reportId!);
  const holdings = rows.map((row) => `${row.scopeRef}|${row.subjectRef}`);
  // Every holding of the republished snapshot once, and nothing else.
  expect(new Set(holdings).size).toBe(holdings.length);
  expect(rows.length).toBe(502);
  // The report is the one a read of the republished store alone gives.
  const settled = await runReportJob(jobEnv, { ...options, maxRows: 600 });
  expect(settled.contextId).toBe(republished.contextId);
}, 120_000);

test("a cut that moves on every read is refused as snapshot_changed and stores nothing", async () => {
  const before = await env.DB.prepare("SELECT count(*) AS n FROM report_artifacts").first<{
    n: number;
  }>();
  let republishes = 0;
  const moving = new Proxy(env.DB, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("coalesce(a.recorded_at_ms, a.fetched_at_ms) > ?")) return statement;
        return {
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              all: async <T>() => {
                const rows = await bound.all<T>();
                republishes += 1;
                await republishKnown([`AAB-${String(republishes).padStart(4, "0")}`]);
                return rows;
              },
            };
          },
        };
      };
    },
  });
  const result = await runReportJob({ ...jobEnv, DB: moving }, { ...options, maxRows: 600 });
  expect(result.skipped).toBe("snapshot_changed");
  expect(result.generated).toBe(0);
  expect(result.reportId).toBeNull();
  const after = await env.DB.prepare("SELECT count(*) AS n FROM report_artifacts").first<{
    n: number;
  }>();
  expect(after!.n).toBe(before!.n);
}, 120_000);

test("rows read out of page order are kept in page order, so the bound keeps the cut's first rows", async () => {
  // The store now holds 15 late rows (accounts "a-late", "a-mid"), then
  // account "b-known"'s 502 in-scope holdings. With a bound of 485 the first
  // page keeps 485 rows, exactly the bound. Between the first and second
  // read, account "a-0" (500 rows, sorting first) and account "a-x" (one
  // in-scope row, sorting before "b-known") are published, so the second page
  // starts on "a-late" and returns the "a-x" row after rows that sort behind
  // it. Before the check, "a-0" is re-parsed with no rows. The set read is
  // then exactly the cut's rows up to the last one read, so the check passes;
  // kept in arrival order, the bound would drop the "a-x" row and keep a
  // "b-known" row the cut's first 485 do not hold.
  let between = true;
  let beforeCheck = true;
  const db = new Proxy(env.DB, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (beforeCheck && sql.includes("AS prefix_rows")) {
          beforeCheck = false;
          return {
            bind: (...args: unknown[]) => ({
              first: async <T>() => {
                const parse = await env.DB.prepare(
                  `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
                   VALUES (7004,'synthetic-positions','2','2026-09-08T00:00:00Z','ok','[]') RETURNING id`,
                ).first<{ id: number }>();
                await publishParse(env.DB, parse!.id, "2026-09-08T00:00:00.000Z");
                return statement.bind(...args).first<T>();
              },
            }),
          };
        }
        if (!between || !sql.includes("coalesce(a.recorded_at_ms, a.fetched_at_ms) > ?"))
          return statement;
        between = false;
        return {
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              all: async <T>() => {
                const rows = await bound.all<T>();
                await seedPositions(
                  7004,
                  "a-0",
                  500,
                  Date.parse("2026-09-05T00:00:00.000Z"),
                  "ZERO",
                );
                await seedPositions(7005, "a-x", 1, Date.parse("2026-09-05T00:00:00.000Z"), "XTRA");
                return rows;
              },
            };
          },
        };
      };
    },
  });
  const moved = await runReportJob({ ...jobEnv, DB: db }, { ...options, maxRows: 485 });
  expect(beforeCheck).toBe(false);
  expect(moved.skipped).toBeNull();
  expect(moved.truncated).toBe(true);
  const rows = await bodyRows(moved.reportId!);
  expect(rows.some((row) => row.subjectRef.includes("XTRA-0000"))).toBe(true);
  // The report is the one a read of the settled store gives under the bound.
  const settled = await runReportJob(jobEnv, { ...options, maxRows: 485 });
  expect(settled.contextId).toBe(moved.contextId);
}, 120_000);
