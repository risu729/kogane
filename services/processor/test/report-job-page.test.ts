// The report job's position set when the store holds more than one reader
// page (501 rows) of positions and some of the first page were recorded after
// the knowledge cutoff (AT63). Every row is synthetic: made-up accounts,
// security codes and quantities.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { runReportJob, type ReportJobEnv } from "../src/report-job.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
let jobEnv: ReportJobEnv;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  jobEnv = { DB: env.DB, EVIDENCE: env.EVIDENCE, REPORTS_ENABLED: "true" };
}, 30000);
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
  // The late rows are excluded and no row is counted twice, so the input set,
  // and with it the context, is the clean run's (INV06).
  expect(shifted.contextId).toBe(clean.contextId);
  expect(shifted.truncated).toBe(false);
}, 120_000);
