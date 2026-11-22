// The report job's provider-reported rows (UC30/AT30) when one instrument is
// held in two scopes: one security in two source accounts of one parse, as a
// broker shows one stock held in a taxable and a tax-exempt account. Each
// scope's provider valuation is its own `calculation_results` row, keyed as
// the table's primary key keys it (run, subject, scope, metric). Every row is
// synthetic: made-up accounts, a made-up code and made-up amounts.
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

const ACCOUNTS = ["synthetic-broker:taxable", "synthetic-broker:exempt"] as const;
const CODE = "SYN-0001";

test("one instrument held in two scopes keeps each scope's provider valuation", async () => {
  await seedArtifact(env, 8101, "other-test", "positions", "positions-8101.json", {
    synthetic: 8101,
  });
  await env.DB.prepare("UPDATE fetch_artifacts SET recorded_at_ms=?,fetched_at_ms=? WHERE id=8101")
    .bind(Date.parse("2026-09-05T00:00:00.000Z"), Date.parse("2026-09-01T00:00:00.000Z"))
    .run();
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (8101,'synthetic-positions','1','2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  ).first<{ id: number }>();
  await publishParse(env.DB, parse!.id);
  await env.DB.batch(
    ACCOUNTS.flatMap((account, index) => [
      env.DB.prepare(
        `INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
         VALUES (?,?,?,'1',0,?,'{}')`,
      ).bind(parse!.id, account, CODE, `$[${index}]`),
      env.DB.prepare(
        `INSERT INTO valuation_observations (parse_run_id,source_account,subject,metric,amount_text,amount_scale,currency,raw_locator,extra_json)
         VALUES (?,?,?,'market_value',?,0,'JPY',?,'{}')`,
      ).bind(parse!.id, account, CODE, String(100 * (index + 1)), `$[${index}].value`),
    ]),
  );

  const result = await runReportJob(jobEnv, options);
  expect(result.generated).toBe(1);
  const rows = await env.DB.prepare(
    `SELECT subject_ref,scope_ref,metric FROM calculation_results WHERE run_id=?
     ORDER BY metric,scope_ref`,
  )
    .bind(result.runId)
    .all<{ subject_ref: string; scope_ref: string; metric: string }>();
  const subject = `instrument:other-test:-:${CODE}`;
  // Both holdings are valued, and both scopes keep their provider row: the
  // second scope's row is not mistaken for a repeat of the first one's.
  expect(rows.results).toEqual([
    {
      subject_ref: subject,
      scope_ref: `scope:other-test:${ACCOUNTS[1]}`,
      metric: "holdings.valuation",
    },
    {
      subject_ref: subject,
      scope_ref: `scope:other-test:${ACCOUNTS[0]}`,
      metric: "holdings.valuation",
    },
    {
      subject_ref: subject,
      scope_ref: `scope:other-test:${ACCOUNTS[1]}`,
      metric: "provider.market_value",
    },
    {
      subject_ref: subject,
      scope_ref: `scope:other-test:${ACCOUNTS[0]}`,
      metric: "provider.market_value",
    },
  ]);
}, 120_000);
