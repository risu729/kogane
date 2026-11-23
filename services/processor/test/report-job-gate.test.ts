// The report job's skip gate (ADR 0129, migration 0106): with nothing it reads
// changed, a second run returns the stored report after one small read, and
// every change the report depends on (a revision move, a promoted price, the
// clock reaching a pending price, an earlier cutoff, a cut set) builds again.
// Every row is synthetic: a made-up account, security code, quantity and price.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { runReportJob, type ReportJobEnv, type ReportJobOptions } from "../src/report-job.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

/** The job's environment, with every statement it prepares recorded in order. */
function recorded(): { jobEnv: ReportJobEnv; statements: string[] } {
  const statements: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          statements.push(sql.replace(/\s+/gu, " ").trim());
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { jobEnv: { DB: db, EVIDENCE: env.EVIDENCE, REPORTS_ENABLED: "true" }, statements };
}

const run = (options: ReportJobOptions) => {
  const { jobEnv, statements } = recorded();
  return runReportJob(jobEnv, options).then((result) => ({ result, statements }));
};

let nextId = 9100;

/** One published synthetic position of `source`; returns its parse run and position ids. */
async function seedPosition(source: string, code: string): Promise<[number, number]> {
  const id = nextId++;
  // Captured before every cutoff below, so no position is recorded after one.
  await seedArtifact(
    env,
    id,
    source,
    "positions",
    `positions-${id}.json`,
    { synthetic: id },
    true,
    Date.parse("2026-09-01T00:00:00.000Z"),
  );
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
  return [parse!.id, position!.id];
}

/** A price promoted from the position's own parse run, effective at `effective`. */
async function promotePrice(
  source: string,
  code: string,
  ids: [number, number],
  effective: string,
  amount: string,
): Promise<void> {
  const priceId = `price:${code}:${effective}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO price_observations
          (id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,
           quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,
           market_ref,adjustment_policy_ref,recorded_at)
         VALUES (?,?,'1',0,'JPY',?,0,'nav',?,?,NULL,NULL,'2026-09-01T00:00:00.000Z')`,
    ).bind(
      priceId,
      `instrument:${source}:-:${code}`,
      amount,
      JSON.stringify({ kind: "instant", value: effective, zone: "UTC", basis: "collector" }),
      `claim:${priceId}`,
    ),
    env.DB.prepare(
      `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
       VALUES (?,'sbi-foreign-stock-price-last-v1','position',?,?,?,'2026-09-01T00:00:00.000Z')`,
    ).bind(priceId, ids[1], ids[0], `$.synthetic.${code}.${effective}`),
  ]);
}

function optionsFor(perimeterRef: string, cutoff: string, maxRows?: number): ReportJobOptions {
  return {
    actor: "report-job",
    now: cutoff,
    unitRef: "JPY",
    perimeterRef,
    knowledgeCutoff: cutoff,
    decimalPolicyRelease: "decimal-v1",
    ...(maxRows === undefined ? {} : { maxRows }),
  };
}

test("an unchanged store returns the stored report after one read", async () => {
  const ids = await seedPosition("gate-unchanged", "SYN-G1");
  await promotePrice("gate-unchanged", "SYN-G1", ids, "2026-09-01T00:00:00.000Z", "500");
  const options = optionsFor("perimeter:gate-unchanged", "2026-10-01T00:00:00.000Z");

  const built = await run(options);
  expect(built.result).toMatchObject({ generated: 1, gated: false });
  const later = await run({ ...options, now: "2026-10-01T00:05:00.000Z" });
  expect(later.result).toMatchObject({
    generated: 0,
    reused: 1,
    gated: true,
    reportId: built.result.reportId,
    contextId: built.result.contextId,
    contentDigest: built.result.contentDigest,
    runId: built.result.runId,
  });
  // The gate read is the only statement: no position, valuation or price read.
  expect(later.statements).toHaveLength(1);
  expect(later.statements[0]).toStartWith("SELECT r.source_revision");
});

test("a write that moves the CORE revision builds again", async () => {
  const ids = await seedPosition("gate-revision", "SYN-G2");
  await promotePrice("gate-revision", "SYN-G2", ids, "2026-09-01T00:00:00.000Z", "500");
  const options = optionsFor("perimeter:gate-revision", "2026-10-01T00:00:00.000Z");
  const built = await run(options);
  expect(built.result.gated).toBe(false);
  expect((await run(options)).result.gated).toBe(true);

  // A new publication (here, of another source's position) moves the revision.
  await seedPosition("gate-revision-other", "SYN-G2B");
  const after = await run(options);
  expect(after.result.gated).toBe(false);
  expect(after.result.generated).toBe(1);
  expect(after.result.reportId).not.toBe(built.result.reportId);
  expect((await run(options)).result.gated).toBe(true);
});

test("a price promoted without a revision move builds again", async () => {
  const ids = await seedPosition("gate-price", "SYN-G3");
  const options = optionsFor("perimeter:gate-price", "2026-10-01T00:00:00.000Z");
  const unpriced = await run(options);
  expect(unpriced.result).toMatchObject({ generated: 1, unvaluedReasons: ["missing-price"] });
  expect((await run(options)).result.gated).toBe(true);

  const before = await env.DB.prepare(
    "SELECT source_revision FROM core_source_revision WHERE id=1",
  ).first<{ source_revision: number }>();
  await promotePrice("gate-price", "SYN-G3", ids, "2026-09-01T00:00:00.000Z", "500");
  const after = await env.DB.prepare(
    "SELECT source_revision FROM core_source_revision WHERE id=1",
  ).first<{ source_revision: number }>();
  // Prices sit outside the ledger: the revision alone would miss this.
  expect(after!.source_revision).toBe(before!.source_revision);

  const priced = await run(options);
  expect(priced.result).toMatchObject({ gated: false, generated: 1 });
  expect(priced.result.reportId).not.toBe(unpriced.result.reportId);
});

test("the gate ends when the clock reaches a pending price, and never covers an earlier cutoff", async () => {
  const ids = await seedPosition("gate-clock", "SYN-G4");
  await promotePrice("gate-clock", "SYN-G4", ids, "2026-09-01T00:00:00.000Z", "500");
  // Promoted now, effective later: no write happens when it becomes current.
  await promotePrice("gate-clock", "SYN-G4", ids, "2026-10-01T12:00:00.000Z", "700");
  const at = (cutoff: string) => run(optionsFor("perimeter:gate-clock", cutoff));

  const morning = await at("2026-10-01T06:00:00.000Z");
  expect(morning.result.gated).toBe(false);
  expect((await at("2026-10-01T11:59:59.000Z")).result).toMatchObject({
    gated: true,
    reportId: morning.result.reportId,
  });
  // An earlier cutoff than the stored build's may exclude what it included.
  expect((await at("2026-10-01T05:00:00.000Z")).result.gated).toBe(false);

  const noon = await at("2026-10-01T12:00:00.000Z");
  expect(noon.result.gated).toBe(false);
  expect(noon.result.reportId).not.toBe(morning.result.reportId);
  expect((await at("2026-10-01T12:05:00.000Z")).result).toMatchObject({
    gated: true,
    reportId: noon.result.reportId,
  });
});

test("a cut report is never gated", async () => {
  await seedPosition("gate-cut", "SYN-G5A");
  await seedPosition("gate-cut", "SYN-G5B");
  // Every position of every earlier case is in scope too, so one row is a cut.
  const options = optionsFor("perimeter:gate-cut", "2026-10-01T00:00:00.000Z", 1);
  const first = await run(options);
  expect(first.result).toMatchObject({ truncated: true, gated: false });
  const second = await run(options);
  expect(second.result).toMatchObject({ reused: 1, gated: false, truncated: true });
});
