// The `price_promotion` lane (src/price-promotion-job.ts, migration 0053,
// ADR 0020) end to end: synthetic fixtures are parsed by the deployed parsers
// through the sweep, then promoted. Every value is synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Miniflare } from "miniflare";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { selectPrices } from "../../../packages/read-model/src/price-selection.ts";
import type { FxQuoteBasisTable } from "../../../packages/domain/src/price-sources.ts";
import { PRICE_PROMOTION_BATCH, pricePromotionSweep } from "../src/price-promotion-job.ts";
import { sweep } from "../src/worker.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const fixture = (...path: string[]): Uint8Array =>
  new Uint8Array(
    readFileSync(
      new URL(`../../../tests/fixtures/observation-pipeline/${path.join("/")}`, import.meta.url),
    ),
  );
const FOREIGN = fixture(
  "sbi-securities",
  "2026-08-20",
  "run-20260820-210000-poc01",
  "foreign-cash-positions.json",
);
const DOMESTIC = fixture("sbi-parser-boundaries", "domestic-cash-positions.json");
const BOARD = fixture("sbi-shinsei-parser-boundaries", "exchange-rate.json");
/** Synthetic: the tests admit USD per 1 unit; production admits no currency yet. */
const USD_PER_ONE: FxQuoteBasisTable = { USD: { baseQuantity: "1", evidence: "synthetic" } };
const FETCHED_MS = Date.parse("2026-09-07T00:02:00.000Z");
const NOW = "2026-09-07T00:05:00.000Z";

const count = async (sql: string): Promise<number> =>
  (await env.DB.prepare(sql).first<number>("n")) ?? 0;
const cursor = async (kind: string): Promise<number | null> =>
  (await env.DB.prepare(
    "SELECT last_observation_id AS n FROM price_promotion_cursor WHERE claim_kind=?",
  )
    .bind(kind)
    .first<number>("n")) ?? null;

test("the lane promotes VT, AAPL, the domestic price and the admitted FX rows, and counts the rest", async () => {
  await seedArtifact(
    env,
    700,
    "sbi-securities",
    "foreign-cash-positions",
    "foreign-cash-positions.json",
    FOREIGN,
    true,
    FETCHED_MS,
  );
  await seedArtifact(
    env,
    701,
    "sbi-securities",
    "domestic-cash-positions",
    "domestic-cash-positions.json",
    DOMESTIC,
    true,
    FETCHED_MS,
  );
  await seedArtifact(
    env,
    702,
    "sbi-shinsei-bank",
    "exchange-rate",
    "raw-exchange-rate.json",
    BOARD,
    true,
    FETCHED_MS,
  );
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
  expect(
    await count(
      "SELECT count(*) AS n FROM parse_runs WHERE status='ok' AND parser_name IN ('sbi-foreign-cash-positions','sbi-domestic-cash-positions','sbi-shinsei-exchange-rate')",
    ),
  ).toBe(3);

  const result = await pricePromotionSweep(env.DB, { now: NOW, fxQuoteBasis: USD_PER_ONE });
  // Valuation claims: 6 FX cells (USD admitted, EUR not) and one domestic
  // `current_price`. Position claims: VT and AAPL.
  expect(result).toEqual({
    scanned: 9,
    promoted: 6,
    basis_unverified: 0,
    unsupported_currency: 3,
    written: 6,
  });
  const prices = (
    await env.DB.prepare(
      `SELECT po.base_instrument_ref,po.quote_unit_ref,po.quote_amount_coefficient,po.quote_amount_scale,
        po.price_kind,json_extract(po.effective_time,'$.basis') AS basis,c.rule_id,c.claim_kind,c.json_path,
        po.source_claim_ref=c.claim_kind||'_observations/'||c.observation_id||'#'||c.json_path AS ref_matches
       FROM price_observations po JOIN price_observation_claims c ON c.price_id=po.id
       ORDER BY po.base_instrument_ref,po.price_kind`,
    ).all()
  ).results;
  expect(prices).toEqual([
    {
      base_instrument_ref: "USD",
      quote_unit_ref: "JPY",
      quote_amount_coefficient: "147",
      quote_amount_scale: 0,
      price_kind: "ask",
      basis: "provider",
      rule_id: "fx-sbi-shinsei-board-v1",
      claim_kind: "valuation",
      json_path: "$.amount_text",
      ref_matches: 1,
    },
    {
      base_instrument_ref: "USD",
      quote_unit_ref: "JPY",
      quote_amount_coefficient: "145",
      quote_amount_scale: 0,
      price_kind: "bid",
      basis: "provider",
      rule_id: "fx-sbi-shinsei-board-v1",
      claim_kind: "valuation",
      json_path: "$.amount_text",
      ref_matches: 1,
    },
    {
      base_instrument_ref: "USD",
      quote_unit_ref: "JPY",
      quote_amount_coefficient: "146",
      quote_amount_scale: 0,
      price_kind: "reference",
      basis: "provider",
      rule_id: "fx-sbi-shinsei-board-v1",
      claim_kind: "valuation",
      json_path: "$.amount_text",
      ref_matches: 1,
    },
    {
      base_instrument_ref: "instrument:sbi-securities:NASDAQ:AAPL",
      quote_unit_ref: "USD",
      quote_amount_coefficient: "22435",
      quote_amount_scale: 2,
      price_kind: "reference",
      basis: "collector",
      rule_id: "sbi-foreign-stock-price-last-v1",
      claim_kind: "position",
      json_path: "$.stockPrice.last",
      ref_matches: 1,
    },
    {
      base_instrument_ref: "instrument:sbi-securities:NYSEARCA:VT",
      quote_unit_ref: "USD",
      quote_amount_coefficient: "1307",
      quote_amount_scale: 1,
      price_kind: "reference",
      basis: "collector",
      rule_id: "sbi-foreign-stock-price-last-v1",
      claim_kind: "position",
      json_path: "$.stockPrice.last",
      ref_matches: 1,
    },
    {
      base_instrument_ref: "instrument:sbi-securities:XTKS:1234",
      quote_unit_ref: "JPY",
      quote_amount_coefficient: "1200",
      quote_amount_scale: 0,
      price_kind: "reference",
      basis: "collector",
      rule_id: "sbi-domestic-current-price-v1",
      claim_kind: "valuation",
      json_path: "$.amount_text",
      ref_matches: 1,
    },
  ]);
  // Every price is per 1 unit and recorded at the tick's instant.
  expect(
    await count(
      `SELECT count(*) AS n FROM price_observations WHERE base_quantity_coefficient='1'
        AND base_quantity_scale=0 AND recorded_at='${NOW}'`,
    ),
  ).toBe(6);
  expect(await cursor("valuation")).toBeGreaterThan(0);
  expect(await cursor("position")).toBeGreaterThan(0);

  // Without the synthetic table, the production rule list admits no FX row.
  await env.DB.prepare("DELETE FROM price_promotion_cursor").run();
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toEqual({
    scanned: 9,
    promoted: 3,
    basis_unverified: 0,
    unsupported_currency: 6,
    written: 0,
  });
}, 60000);

test("replay writes nothing: the same tick, or the same claims from a reset cursor", async () => {
  const before = await count("SELECT count(*) AS n FROM price_observations");
  expect(await pricePromotionSweep(env.DB, { now: NOW, fxQuoteBasis: USD_PER_ONE })).toEqual({
    scanned: 0,
    promoted: 0,
    basis_unverified: 0,
    unsupported_currency: 0,
    written: 0,
  });
  await env.DB.prepare("DELETE FROM price_promotion_cursor").run();
  const again = await pricePromotionSweep(env.DB, {
    now: "2026-09-08T00:00:00.000Z",
    fxQuoteBasis: USD_PER_ONE,
  });
  expect(again).toMatchObject({ scanned: 9, promoted: 6, written: 0 });
  expect(await count("SELECT count(*) AS n FROM price_observations")).toBe(before);
  expect(await count("SELECT count(*) AS n FROM price_observation_claims")).toBe(before);
  // Nothing was rewritten either: the first tick's instant is still on every row.
  expect(
    await count(`SELECT count(*) AS n FROM price_observations WHERE recorded_at<>'${NOW}'`),
  ).toBe(0);
}, 60000);

test("a re-parse yields new price rows and selection moves to them; the old rows stay", async () => {
  const sql = d1Executor(env.DB);
  const vt = "instrument:sbi-securities:NYSEARCA:VT";
  const cutoff = "2026-09-10T00:00:00Z";
  const [first] = await selectPrices(sql, { baseInstrumentRefs: [vt], cutoff });
  expect(first?.price.baseInstrumentRef).toBe(vt);
  // A second successful parse of the same artifact, with its own observations
  // (as a new parser version writes), then published.
  const old = (await env.DB.prepare(
    "SELECT id FROM parse_runs WHERE parser_name='sbi-foreign-cash-positions' AND status='ok'",
  ).first<number>("id"))!;
  const next = (await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     SELECT fetch_artifact_id,parser_name,'9.9.9-synthetic','2026-09-09T00:00:00.000Z','ok','[]'
     FROM parse_runs WHERE id=? RETURNING id`,
  )
    .bind(old)
    .first<number>("id"))!;
  await env.DB.prepare(
    `INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,
      quantity_text,quantity_scale,currency,as_of,observed_at,raw_locator,extra_json)
     SELECT ?,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,
      as_of,observed_at,raw_locator,extra_json FROM position_observations WHERE parse_run_id=? ORDER BY id`,
  )
    .bind(next, old)
    .run();
  const tick = await pricePromotionSweep(env.DB, { now: "2026-09-09T00:01:00.000Z" });
  expect(tick).toMatchObject({ scanned: 2, promoted: 2, written: 2 });
  // Not yet published: selection still names the first parse's price.
  expect((await selectPrices(sql, { baseInstrumentRefs: [vt], cutoff }))[0]?.price.id).toBe(
    first!.price.id,
  );
  await publishParse(env.DB, next, "2026-09-09T00:02:00.000Z");
  const [moved] = await selectPrices(sql, { baseInstrumentRefs: [vt], cutoff });
  expect(moved?.price.id).not.toBe(first!.price.id);
  expect(moved?.claim.parseRunId).toBe(next);
  // The first price is still there for the contexts that used it.
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM price_observations WHERE id=?")
      .bind(first!.price.id)
      .first<number>("n"),
  ).toBe(1);
}, 60000);

test("prices, their claims and the evidence they came from are append-only", async () => {
  for (const statement of [
    "UPDATE price_observations SET quote_amount_coefficient='1'",
    "DELETE FROM price_observations",
    "UPDATE price_observation_claims SET rule_id='x'",
    "DELETE FROM price_observation_claims",
  ])
    await expect(env.DB.prepare(statement).run()).rejects.toThrow(/append-only/u);
  // The cursor is operational state and moves only forward.
  const at = (await cursor("position"))!;
  await env.DB.prepare(
    `INSERT INTO price_promotion_cursor(claim_kind,last_observation_id) VALUES('position',1)
     ON CONFLICT(claim_kind) DO UPDATE SET
      last_observation_id=max(price_promotion_cursor.last_observation_id,excluded.last_observation_id)`,
  ).run();
  expect(await cursor("position")).toBe(at);
}, 60000);

test("a tampered row is refused, a pending parse holds the cursor, and a tick stops at its budget", async () => {
  // A foreign position whose price does not reconcile with its market value.
  const element = JSON.parse(new TextDecoder().decode(FOREIGN)) as {
    listSecuritiesBalances: { securitiesBalances: { stockPrice: { last: string } }[] };
  };
  element.listSecuritiesBalances.securitiesBalances[0]!.stockPrice.last = "130.71";
  await seedArtifact(
    env,
    710,
    "sbi-securities",
    "foreign-cash-positions",
    "foreign-cash-positions.json",
    element,
    true,
    FETCHED_MS,
  );
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({
    scanned: 2,
    promoted: 1,
    basis_unverified: 1,
    written: 1,
  });

  // A parse still pending: its rows are not passed by the cursor.
  const run = (await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(710,'sbi-foreign-cash-positions','9.9.8-synthetic','2026-09-09T00:00:00.000Z','pending','[]') RETURNING id`,
  ).first<number>("id"))!;
  const before = (await cursor("position"))!;
  await env.DB.prepare(
    `INSERT INTO position_observations(parse_run_id,source_account,security_code,market,quantity_text,
      quantity_scale,currency,raw_locator,extra_json)
     SELECT ?,source_account,security_code,market,quantity_text,quantity_scale,currency,raw_locator,extra_json
     FROM position_observations WHERE parse_run_id=(SELECT max(id) FROM parse_runs
       WHERE parser_name='sbi-foreign-cash-positions' AND status='ok')`,
  )
    .bind(run)
    .run();
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({ scanned: 0 });
  expect(await cursor("position")).toBe(before);
  await env.DB.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(run).run();
  expect(await pricePromotionSweep(env.DB, { now: NOW, limit: 1 })).toMatchObject({
    scanned: 1,
  });
  expect(await pricePromotionSweep(env.DB, { now: NOW })).toMatchObject({ scanned: 1 });
  expect(PRICE_PROMOTION_BATCH).toBe(500);
}, 60000);
