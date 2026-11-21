// A report job interrupted before its artifact row is written must finish on
// the next run over the same inputs. The run id is the digest of the input
// manifest, so a retry meets the run the interrupted job left behind, and
// `calculation_results_run_building` refuses results for a run that is no
// longer building, before `ON CONFLICT DO NOTHING` is ever considered. Every
// row is synthetic: made-up accounts, security codes, quantities and prices.
import { afterAll, expect } from "bun:test";
import { runReportJob, type ReportJobEnv } from "../src/report-job.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import { settledTest } from "./support/settle.ts";

// The runtime starts while the module loads, so a case that times out fails
// alone (docs/ci.md, Miniflare under Bun; test/support/settle.ts).
const { mf, env } = await startPipeline();
const jobEnv: ReportJobEnv = { DB: env.DB, EVIDENCE: env.EVIDENCE, REPORTS_ENABLED: "true" };
const test = settledTest();
afterAll(async () => {
  await mf.dispose();
});

const options = {
  actor: "report-job",
  now: "2026-09-08T00:00:00.000Z",
  unitRef: "JPY",
  perimeterRef: "perimeter:test",
  knowledgeCutoff: "2026-12-31T00:00:00.000Z",
  decimalPolicyRelease: "decimal-v1",
};

/** One published synthetic position and a price claimed from its own snapshot. */
async function seedValuedPosition(id: number, code: string): Promise<void> {
  await seedArtifact(env, id, "other-test", "positions", `positions-${id}.json`, { synthetic: id });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,'synthetic-positions','1','2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(id)
    .first<{ id: number }>();
  await publishParse(env.DB, parse!.id);
  const position = await env.DB.prepare(
    `INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
     VALUES (?,'synthetic-account',?,'3',0,'$','{}') RETURNING id`,
  )
    .bind(parse!.id, code)
    .first<{ id: number }>();
  const priceId = `price:${code}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO price_observations
          (id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,
           quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,
           market_ref,adjustment_policy_ref,recorded_at)
         VALUES (?,?,'1',0,'JPY','500',0,'nav',?,?,NULL,NULL,'2026-09-01T00:00:00.000Z')`,
    ).bind(
      priceId,
      `instrument:other-test:-:${code}`,
      JSON.stringify({
        kind: "instant",
        value: "2026-09-01T00:00:00.000Z",
        zone: "UTC",
        basis: "collector",
      }),
      `claim:${priceId}`,
    ),
    env.DB.prepare(
      `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
       VALUES (?,'sbi-foreign-stock-price-last-v1','position',?,?,?,'2026-09-01T00:00:00.000Z')`,
    ).bind(priceId, position!.id, parse!.id, `$.synthetic.${code}`),
  ]);
}

/** EVIDENCE whose every write fails, standing for an R2 outage mid-job. */
const failingEvidence = new Proxy(env.EVIDENCE, {
  get(target, property, receiver) {
    if (property === "put")
      return () => Promise.reject(new Error("synthetic evidence write failure"));
    const value: unknown = Reflect.get(target, property, receiver);
    return typeof value === "function" ? (value as Function).bind(target) : value;
  },
});

/** The SQL each bound statement was prepared from, so a batch can be refused by content. */
function refusingDb(refuse: (sql: string) => boolean): D1Database {
  const sqlOf = new WeakMap<object, string>();
  const prepare = (sql: string): D1PreparedStatement => {
    const statement = env.DB.prepare(sql);
    sqlOf.set(statement, sql);
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => {
            const bound = target.bind(...values);
            sqlOf.set(bound, sql);
            return bound;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as Function).bind(target) : value;
      },
    });
  };
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return prepare;
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          if (statements.some((statement) => refuse(sqlOf.get(statement) ?? "")))
            return Promise.reject(new Error("synthetic batch failure"));
          return target.batch(statements);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as Function).bind(target) : value;
    },
  });
}

async function runState(runId: string | null) {
  const run = await env.DB.prepare("SELECT status FROM calculation_runs WHERE run_id=?")
    .bind(runId)
    .first<{ status: string }>();
  const results = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM calculation_results WHERE run_id=?",
  )
    .bind(runId)
    .first<{ n: number }>();
  return { status: run?.status ?? null, results: results?.n ?? 0 };
}

async function artifactCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM report_artifacts").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

test("a job whose body write fails leaves its run building, and the retry finishes it", async () => {
  await seedValuedPosition(8101, "SYN-A");
  await seedValuedPosition(8102, "SYN-B");

  await expect(runReportJob({ ...jobEnv, EVIDENCE: failingEvidence }, options)).rejects.toThrow(
    "synthetic evidence write failure",
  );
  expect(await artifactCount()).toBe(0);
  const runId = (
    await env.DB.prepare("SELECT run_id FROM calculation_runs").first<{ run_id: string }>()
  )?.run_id;
  // The run is not marked complete before its artifact exists.
  expect(await runState(runId ?? null)).toEqual({ status: "building", results: 2 });

  const retry = await runReportJob(jobEnv, { ...options, now: "2026-09-08T00:05:00.000Z" });
  expect(retry).toMatchObject({ generated: 1, reused: 0, runId, partition: "complete" });
  expect(await runState(retry.runId)).toEqual({ status: "complete", results: 2 });
  expect(await artifactCount()).toBe(1);
  expect(await env.EVIDENCE.head(`reports/${retry.contentDigest ?? ""}`)).not.toBeNull();

  const again = await runReportJob(jobEnv, { ...options, now: "2026-09-08T00:10:00.000Z" });
  expect(again).toMatchObject({ generated: 0, reused: 1, reportId: retry.reportId });
}, 120_000);

test("a refused artifact batch does not mark the run complete", async () => {
  await seedValuedPosition(8103, "SYN-C");

  await expect(
    runReportJob(
      { ...jobEnv, DB: refusingDb((sql) => sql.includes("INSERT INTO report_artifacts")) },
      options,
    ),
  ).rejects.toThrow("synthetic batch failure");
  const building = await env.DB.prepare(
    "SELECT run_id FROM calculation_runs WHERE status='building'",
  ).all<{ run_id: string }>();
  expect(building.results).toHaveLength(1);
  expect(await runState(building.results[0]!.run_id)).toEqual({
    status: "building",
    results: 3,
  });

  const retry = await runReportJob(jobEnv, options);
  expect(retry).toMatchObject({ generated: 1, runId: building.results[0]!.run_id });
  expect(await runState(retry.runId)).toEqual({ status: "complete", results: 3 });
}, 120_000);

test("a run an earlier build marked complete without its artifact is finished, not refused", async () => {
  // Before the completion moved into the artifact batch, a failure between the
  // two left a complete run with its results and no artifact, and every retry
  // over the same manifest was refused by calculation_results_run_building.
  // That state is built here the way the earlier code reached it: the results
  // of a building run, then its one forward status change.
  await seedValuedPosition(8104, "SYN-D");
  await expect(runReportJob({ ...jobEnv, EVIDENCE: failingEvidence }, options)).rejects.toThrow(
    "synthetic evidence write failure",
  );
  const stranded = await env.DB.prepare(
    "SELECT run_id FROM calculation_runs WHERE status='building'",
  ).first<{ run_id: string }>();
  await env.DB.prepare(
    "UPDATE calculation_runs SET status='complete',completed_at=? WHERE run_id=? AND status='building'",
  )
    .bind(options.now, stranded!.run_id)
    .run();
  expect(await runState(stranded!.run_id)).toEqual({ status: "complete", results: 4 });

  const before = await artifactCount();
  const retry = await runReportJob(jobEnv, { ...options, now: "2026-09-08T00:05:00.000Z" });
  expect(retry).toMatchObject({ generated: 1, runId: stranded!.run_id, partition: "complete" });
  // The finished run's results are the ones it already held; none is added.
  expect(await runState(retry.runId)).toEqual({ status: "complete", results: 4 });
  expect(await artifactCount()).toBe(before + 1);
  const completedAt = await env.DB.prepare(
    "SELECT completed_at FROM calculation_runs WHERE run_id=?",
  )
    .bind(retry.runId)
    .first<{ completed_at: string }>();
  expect(completedAt?.completed_at).toBe(options.now);
}, 120_000);
