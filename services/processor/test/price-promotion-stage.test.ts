// ADR 0031 end to end: an SBI Shinsei FX board row is promoted only when its
// `customerCategory` is strictly equal to the stage category the balance
// summary of the same collection run states. Synthetic boards and pages are
// parsed by the deployed parsers through the sweep, then promoted; every value
// is synthetic.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { SBI_SHINSEI_FX_PER_UNIT_CURRENCIES } from "../../../packages/domain/src/price-sources.ts";
import { pricePromotionSweep, STAGE_SQL } from "../src/price-promotion-job.ts";
import { sweep } from "../src/worker.ts";
import { seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const NOW = "2026-09-07T00:05:00.000Z";
const FETCHED_MS = Date.parse("2026-09-07T00:02:00.000Z");
const TIERS = ["SYNTHETIC-1", "SYNTHETIC-2", "SYNTHETIC-3", "SYNTHETIC-4", "SYNTHETIC-TOP"];
const SUMMARY = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/balance-summary-and-stage.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { responseParam: { category: { responseParam: Record<string, unknown> } } };

/** The stored boards' shape (ADR 0028): USD and EUR once per tier, one CHF row, one JPY row. */
function board(tiers: readonly (string | number)[] = TIERS): unknown {
  const rows: Record<string, unknown>[] = [];
  for (const currency of ["USD", "EUR"])
    for (const [index, customerCategory] of tiers.entries())
      rows.push({
        currency,
        customerCategory,
        buyRate: `${140 + index}.00`,
        sellRate: `${142 + index}.00`,
        midRate: `${141 + index}.00`,
      });
  rows.push({
    currency: "CHF",
    customerCategory: tiers.at(-1),
    buyRate: "170.00",
    sellRate: "172.00",
    midRate: "171.00",
  });
  rows.push({ currency: "JPY", buyRate: "1", sellRate: "1", midRate: "1" });
  return {
    responseParam: {
      exchangeRateInformation: {
        requestParam: {},
        responseParam: { transactionTime: "20260907090100", exchangeRates: rows },
        header: {},
        errorInfo: {},
      },
    },
    header: { adapterResultCode: "0" },
  };
}

function summary(customerCategory: unknown): unknown {
  const page = structuredClone(SUMMARY);
  page.responseParam.category.responseParam["customerCategory"] = customerCategory;
  return page;
}

async function addArtifact(id: number, run: number, dataset: string, payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await env.EVIDENCE.put(sha, bytes);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO raw_objects VALUES(?,?,?)").bind(sha, bytes.length, sha),
    env.DB.prepare(
      "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role) VALUES(?,?,'sbi-shinsei-bank',?,?,NULL,'application/json',?,?,?,'collector_derived')",
    ).bind(id, run, dataset, `raw-${dataset}-${id}.json`, FETCHED_MS, FETCHED_MS, sha),
  ]);
}

/**
 * One sealed collection run: the stage pages first (as the collector reads
 * them), then the board. `stages` are the category values of the run's
 * balance-summary pages; none means the run has no such page.
 */
async function seedRun(run: number, stages: unknown[], boardPayload: unknown = board()) {
  await seedArtifact(
    env,
    run,
    "sbi-shinsei-bank",
    "exchange-rate",
    "raw-exchange-rate.json",
    boardPayload,
    false,
    FETCHED_MS,
  );
  for (const [index, category] of stages.entries())
    await addArtifact(run + 1 + index, run, "balance-summary-and-stage", summary(category));
  await env.DB.prepare("INSERT INTO fetch_run_seals(fetch_run_id,sealed_at_ms) VALUES(?,?)")
    .bind(run, FETCHED_MS)
    .run();
}

async function parseAll(): Promise<void> {
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
}

/** The (currency, tier) pairs promoted from the boards of the current test's run. */
const promotedTiers = async (): Promise<unknown[]> =>
  (
    await env.DB.prepare(
      `SELECT DISTINCT po.base_instrument_ref AS base,json_extract(v.extra_json,'$.customerCategory') AS tier
       FROM price_observations po JOIN price_observation_claims c ON c.price_id=po.id
       JOIN valuation_observations v ON v.id=c.observation_id
       WHERE c.rule_id='fx-sbi-shinsei-board-v1' AND c.parse_run_id IN
        (SELECT p.id FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE a.fetch_run_id=?)
       ORDER BY base,tier`,
    )
      .bind(run)
      .all()
  ).results;

let run = 0;
beforeEach(() => {
  run += 100;
});

test("the stated tier of the same run promotes USD and EUR per 1 unit; other tiers, CHF and JPY never", async () => {
  await seedRun(run, ["SYNTHETIC-TOP"]);
  await parseAll();
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE status='ok' AND parser_name='sbi-shinsei-balance-summary-and-stage'",
    ).first<number>("n"),
  ).toBeGreaterThan(0);
  // 2 currencies × 5 tiers × 3 rates, plus 3 CHF cells; the JPY row is skipped
  // by the parser.
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toEqual({
    scanned: 33,
    promoted: 6,
    basis_unverified: 0,
    unsupported_currency: 3,
    tier_unmatched: 24,
    stage_unstated: 0,
    stage_pending: 0,
    written: 6,
  });
  const prices = (
    await env.DB.prepare(
      `SELECT base_instrument_ref AS base,quote_unit_ref AS quote,base_quantity_coefficient AS per,
        price_kind AS kind,quote_amount_coefficient AS amount
       FROM price_observations ORDER BY base,kind`,
    ).all()
  ).results;
  // The top tier is the fifth row of each currency: 144 / 145 / 146.
  expect(prices).toEqual([
    { base: "EUR", quote: "JPY", per: "1", kind: "ask", amount: "146" },
    { base: "EUR", quote: "JPY", per: "1", kind: "bid", amount: "144" },
    { base: "EUR", quote: "JPY", per: "1", kind: "reference", amount: "145" },
    { base: "USD", quote: "JPY", per: "1", kind: "ask", amount: "146" },
    { base: "USD", quote: "JPY", per: "1", kind: "bid", amount: "144" },
    { base: "USD", quote: "JPY", per: "1", kind: "reference", amount: "145" },
  ]);
  expect(await promotedTiers()).toEqual([
    { base: "EUR", tier: "SYNTHETIC-TOP" },
    { base: "USD", tier: "SYNTHETIC-TOP" },
  ]);
  expect(SBI_SHINSEI_FX_PER_UNIT_CURRENCIES).not.toContain("CHF");
  // The stage row is no amount (INV05): its exact decimal is `missing`, never
  // zero, and no price claims it.
  expect(
    (
      await env.DB.prepare(
        `SELECT v.amount_text AS amount,v.currency,d.status,d.coefficient,
          (SELECT count(*) FROM price_observation_claims c WHERE c.observation_id=v.id) AS claims
         FROM valuation_observations v
         LEFT JOIN observation_decimal_values d ON d.kind='valuation' AND d.observation_id=v.id
         WHERE v.metric='provider_customer_category'`,
      ).all()
    ).results,
  ).toEqual([{ amount: null, currency: "XXX", status: "missing", coefficient: null, claims: 0 }]);
}, 60000);

test("a stage in another notation admits nothing: a number never equals a string", async () => {
  // The board states its tiers as numbers; the page states the top one as text.
  await seedRun(run, ["5"], board([1, 2, 3, 4, 5]));
  await parseAll();
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 33,
    promoted: 0,
    unsupported_currency: 3,
    tier_unmatched: 30,
    written: 0,
  });
  expect(await promotedTiers()).toEqual([]);
}, 60000);

test("a stage stated only by another run is not current for this board", async () => {
  // This run has no balance-summary page; the previous and a later run's pages
  // state the very tier the board lists.
  await seedRun(run, []);
  await seedRun(run + 50, ["SYNTHETIC-TOP"], board(["OTHER-RUN"]));
  await parseAll();
  // The first board's 30 per-1-unit cells have no stage of their own run; the
  // second board's 6 are of a tier its own run does not state.
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 42,
    promoted: 0,
    unsupported_currency: 6,
    tier_unmatched: 6,
    stage_unstated: 30,
    stage_pending: 0,
    written: 0,
  });
  expect(await promotedTiers()).toEqual([]);
}, 60000);

test("two stage pages of one run that disagree admit nothing, even the tier one of them names", async () => {
  await seedRun(run, ["SYNTHETIC-TOP", "SYNTHETIC-4"]);
  await parseAll();
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 33,
    promoted: 0,
    unsupported_currency: 3,
    tier_unmatched: 0,
    stage_unstated: 30,
    stage_pending: 0,
    written: 0,
  });
  // Two pages that agree are one stage.
  await seedRun(run + 50, ["SYNTHETIC-TOP", "SYNTHETIC-TOP"]);
  await parseAll();
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 33,
    promoted: 6,
    written: 6,
  });
}, 60000);

test("a page whose category is unusable is refused by the parser and admits nothing", async () => {
  await seedRun(run, [null]);
  await parseAll();
  expect(
    await env.DB.prepare(
      `SELECT count(*) AS n FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
       WHERE a.fetch_run_id=? AND p.parser_name='sbi-shinsei-balance-summary-and-stage' AND p.status='error'`,
    )
      .bind(run)
      .first<number>("n"),
  ).toBe(1);
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 33,
    promoted: 0,
    tier_unmatched: 0,
    stage_unstated: 30,
  });
}, 60000);

test("a currency listed once is promoted only when that one row is in the stated tier; nothing falls back", async () => {
  // Observed 2026-09-27: some currencies have a single board row. USD's single
  // row is in the stated tier, EUR's in another one (synthetic tiers).
  const single = board(["SYNTHETIC-TOP"]) as {
    responseParam: {
      exchangeRateInformation: { responseParam: { exchangeRates: Record<string, unknown>[] } };
    };
  };
  const rows = single.responseParam.exchangeRateInformation.responseParam.exchangeRates;
  rows.find((row) => row["currency"] === "EUR")!["customerCategory"] = "SYNTHETIC-2";
  await seedRun(run, ["SYNTHETIC-TOP"], single);
  await parseAll();
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 9,
    promoted: 3,
    unsupported_currency: 3,
    tier_unmatched: 3,
    stage_unstated: 0,
    stage_pending: 0,
    written: 3,
  });
  expect(await promotedTiers()).toEqual([{ base: "USD", tier: "SYNTHETIC-TOP" }]);
}, 60000);

/** Parses one incremental job: the lowest artifact id first, so the board before its stage page. */
async function parseOne(): Promise<void> {
  await sweep(env, { lane: "incremental", maxJobs: 1 });
}

test("a board parsed before its stage page waits for it and is then promoted, not refused", async () => {
  await seedRun(run, ["SYNTHETIC-TOP"]);
  await parseOne();
  const stageJob = () =>
    env.DB.prepare(
      `SELECT j.status FROM observation_parse_jobs j
       WHERE j.fetch_artifact_id=? AND j.parser_name='sbi-shinsei-balance-summary-and-stage'`,
    )
      .bind(run + 1)
      .first<string>("status");
  expect(await stageJob()).toBe("pending");
  const before = await env.DB.prepare(
    "SELECT last_observation_id AS id FROM price_promotion_cursor WHERE claim_kind='valuation'",
  ).first<number>("id");
  // The board's rows are neither judged nor passed: the cursor stays put.
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toEqual({
    scanned: 0,
    promoted: 0,
    basis_unverified: 0,
    unsupported_currency: 0,
    tier_unmatched: 0,
    stage_unstated: 0,
    stage_pending: 33,
    written: 0,
  });
  expect(
    await env.DB.prepare(
      "SELECT last_observation_id AS id FROM price_promotion_cursor WHERE claim_kind='valuation'",
    ).first<number>("id"),
  ).toBe(before);
  await parseOne();
  expect(await stageJob()).toBe("done");
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 33,
    promoted: 6,
    unsupported_currency: 3,
    tier_unmatched: 24,
    stage_unstated: 0,
    stage_pending: 0,
    written: 6,
  });
  expect(await promotedTiers()).toEqual([
    { base: "EUR", tier: "SYNTHETIC-TOP" },
    { base: "USD", tier: "SYNTHETIC-TOP" },
  ]);
}, 60000);

test("the wait ends when the stage page's job fails: the board is then stage_unstated", async () => {
  await seedRun(run, [null]);
  await parseOne();
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 0,
    stage_pending: 33,
  });
  // The parser refuses the page; the job is failed and can never publish.
  await parseOne();
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 33,
    promoted: 0,
    unsupported_currency: 3,
    stage_unstated: 30,
    stage_pending: 0,
  });
}, 60000);

test("a stage job out of attempts, of another version or of a stopped replay plan is not waited for", async () => {
  await seedRun(run, ["SYNTHETIC-TOP"]);
  await parseOne();
  const job = (sql: string) =>
    env.DB.prepare(
      `UPDATE observation_parse_jobs SET ${sql}
       WHERE fetch_artifact_id=? AND parser_name='sbi-shinsei-balance-summary-and-stage'`,
    )
      .bind(run + 1)
      .run();
  const valuationCursor = () =>
    env.DB.prepare(
      "SELECT last_observation_id AS id FROM price_promotion_cursor WHERE claim_kind='valuation'",
    ).first<number>("id");
  const before = await valuationCursor();
  const judge = async () => {
    const result = await pricePromotionSweep(env.DB, { now: NOW });
    await env.DB.prepare(
      "UPDATE price_promotion_cursor SET last_observation_id=? WHERE claim_kind='valuation'",
    )
      .bind(before)
      .run();
    return result;
  };
  // A lease lost on the last attempt: `running` but never runnable again.
  await job("status='running',attempts=5");
  expect(await judge()).toMatchObject({ scanned: 33, stage_unstated: 30, stage_pending: 0 });
  // A replay job whose plan is paused.
  await env.DB.prepare(
    `INSERT INTO observation_replay_plans(id,created_at_ms,updated_at_ms,source_id,parser_name,
      parser_version,artifact_id_high_water,status,reason)
     VALUES(?,0,0,'sbi-shinsei-bank','sbi-shinsei-balance-summary-and-stage','0.1.0',?,'paused','synthetic')`,
  )
    .bind(run, run + 1)
    .run();
  await job(`status='pending',attempts=0,replay_plan_id=${run}`);
  expect(await judge()).toMatchObject({ scanned: 33, stage_unstated: 30, stage_pending: 0 });
  // Another version of the parser than the deployed one.
  await job("status='pending',attempts=0,replay_plan_id=NULL,parser_version='0.0.9'");
  expect(await judge()).toMatchObject({ scanned: 33, stage_unstated: 30, stage_pending: 0 });
  // The same job, runnable again: the board waits.
  await job("status='pending',attempts=0,replay_plan_id=NULL,parser_version='0.1.0'");
  expect(await judge()).toMatchObject({ scanned: 0, stage_pending: 33 });
}, 60000);

test("the stage read reaches every table by key without statistics", () => {
  const migrations = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");
  const db = new Database(":memory:");
  for (const name of readdirSync(migrations)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(migrations, name), "utf8"));
  const plan = (
    db.query(`EXPLAIN QUERY PLAN ${STAGE_SQL}`).all("[1,2,3]") as { detail: string }[]
  ).map((row) => row.detail);
  // Shown in the test output so a reviewer sees the plan the assertion reads.
  console.log(plan.join("\n"));
  for (const table of ["v", "p", "a", "sa", "pp", "s", "wa", "j", "wp", "rp"])
    expect(plan.some((line) => line.startsWith(`SCAN ${table} `) || line === `SCAN ${table}`)).toBe(
      false,
    );
  // Driven from the page's own rows: never from all stage rows of every run.
  expect(plan).toContain("SEARCH sa USING INDEX idx_fetch_artifacts_run_role (fetch_run_id=?)");
  expect(plan).toContain("SEARCH s USING INDEX idx_val_obs_parse_run (parse_run_id=?)");
  expect(plan).toContain("SEARCH wa USING INDEX idx_fetch_artifacts_run_role (fetch_run_id=?)");
  expect(
    plan.some((line) =>
      /^SEARCH j USING (?:PRIMARY KEY|INDEX sqlite_autoindex_observation_parse_jobs_1) \(fetch_artifact_id=\? AND parser_name=\? AND parser_version=\?\)$/u.test(
        line,
      ),
    ),
  ).toBe(true);
  expect(
    plan.some((line) => /^SEARCH wp USING (?:PRIMARY KEY|(?:COVERING )?INDEX)/u.test(line)),
  ).toBe(true);
  expect(plan.some((line) => /^SEARCH rp USING INTEGER PRIMARY KEY/u.test(line))).toBe(true);
  expect(plan.some((line) => /^SEARCH pp USING (?:PRIMARY KEY|INDEX)/u.test(line))).toBe(true);
  expect(plan.some((line) => line.includes("idx_val_obs_subject"))).toBe(false);
  expect(plan.some((line) => line.includes("idx_fetch_artifacts_source_dataset_time"))).toBe(false);
  for (const table of ["v", "p", "a"])
    expect(plan).toContain(`SEARCH ${table} USING INTEGER PRIMARY KEY (rowid=?)`);
  db.close();
});
