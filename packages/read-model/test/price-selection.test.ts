// Price selection (src/price-selection.ts) over the migrated CORE schema, with
// synthetic prices and claims only.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlExecutor } from "../src/reader";
import {
  PRICE_SELECTION_BOUND,
  PRICE_SELECTION_SQL,
  PriceSelectionError,
  selectPrices,
} from "../src/price-selection";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");

function migratedDatabase(): Database {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return db;
}

function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(text: string, args: readonly unknown[]) =>
      db.query(text).all(...(args as never[])) as T[],
    first: async <T>(text: string, args: readonly unknown[]) =>
      (db.query(text).get(...(args as never[])) as T | null) ?? null,
  };
}

const PARSER = "sbi-shinsei-exchange-rate";

function parse(db: Database, id: number, artifact: number, version = "1.0.0"): void {
  db.query(
    `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,?,?,?,'2026-09-07T00:00:00Z','ok','[]')`,
  ).run(id, artifact, PARSER, version);
}
function publish(db: Database, artifact: number, run: number, version = "1.0.0"): void {
  db.query(
    `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
     VALUES(?,?,?,?,'2026-09-07T00:00:00Z','normal')
     ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,
       parser_version=excluded.parser_version`,
  ).run(artifact, PARSER, run, version);
}
let nextObservation = 1;
function price(
  db: Database,
  options: {
    id: string;
    run: number;
    at: string;
    amount: string;
    base?: string;
    kind?: string;
    quote?: string;
    recordedAt?: string;
    effective?: Record<string, unknown>;
  },
): void {
  const observation = nextObservation++;
  db.query(
    `INSERT INTO valuation_observations(id,parse_run_id,source_account,subject,metric,amount_text,amount_scale,currency,raw_locator,extra_json)
     VALUES(?,?,'sbi-shinsei:fx-board','USD','bank_mid_rate',?,0,'JPY','json:$','{}')`,
  ).run(observation, options.run, options.amount);
  db.query(
    `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,
       quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,
       source_claim_ref,recorded_at)
     VALUES(?,?,'1',0,?,?,0,?,?,?,?)`,
  ).run(
    options.id,
    options.base ?? "USD",
    options.quote ?? "JPY",
    options.amount,
    options.kind ?? "reference",
    JSON.stringify(
      options.effective ?? {
        kind: "instant",
        value: options.at,
        zone: "Asia/Tokyo",
        basis: "provider",
      },
    ),
    `valuation_observations/${observation}#$.amount_text`,
    options.recordedAt ?? "2026-09-08T00:00:00.000Z",
  );
  db.query(
    `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
     VALUES(?,'fx-sbi-shinsei-board-v1','valuation',?,?,'$.amount_text','2026-09-08T00:00:00.000Z')`,
  ).run(options.id, observation, options.run);
}
const ids = async (db: Database, cutoff: string, base: string[] = ["USD"]) =>
  (await selectPrices(executor(db), { baseInstrumentRefs: base, cutoff })).map(
    (row) => row.price.id,
  );

describe("price selection", () => {
  test("the latest price at or before the cutoff, compared as instants, not as text", async () => {
    const db = migratedDatabase();
    parse(db, 1, 1);
    publish(db, 1, 1);
    parse(db, 2, 2);
    publish(db, 2, 2);
    // 09:00+09:00 is 00:00Z; 08:00+09:00 is the previous day 23:00Z, although
    // its text sorts after "2026-09-06T23:30:00Z".
    price(db, { id: "p-early", run: 1, at: "2026-09-07T08:00:00+09:00", amount: "140" });
    price(db, { id: "p-late", run: 2, at: "2026-09-07T09:00:00+09:00", amount: "146" });
    expect(await ids(db, "2026-09-06T22:59:59Z")).toEqual([]);
    expect(await ids(db, "2026-09-06T23:30:00Z")).toEqual(["p-early"]);
    expect(await ids(db, "2026-09-07T00:00:00Z")).toEqual(["p-late"]);
    expect(await ids(db, "2026-09-10T00:00:00+09:00")).toEqual(["p-late"]);
    const [selected] = await selectPrices(executor(db), {
      baseInstrumentRefs: ["USD"],
      cutoff: "2026-09-10T00:00:00Z",
    });
    expect(selected).toEqual({
      price: {
        id: "p-late",
        baseInstrumentRef: "USD",
        baseQuantity: { coefficient: "1", scale: 0 },
        quoteUnitRef: "JPY",
        quoteAmount: { coefficient: "146", scale: 0 },
        priceKind: "reference",
        effectiveTime: {
          kind: "instant",
          value: "2026-09-07T09:00:00+09:00",
          zone: "Asia/Tokyo",
          basis: "provider",
        },
        sourceClaimRef: "valuation_observations/2#$.amount_text",
        marketRef: null,
        adjustmentPolicyRef: null,
      },
      recordedAt: "2026-09-08T00:00:00.000Z",
      claim: {
        ruleId: "fx-sbi-shinsei-board-v1",
        claimKind: "valuation",
        observationId: 2,
        parseRunId: 2,
        jsonPath: "$.amount_text",
      },
    });
  });

  test("a re-parse yields new price rows and selection moves to them; the old rows stay", async () => {
    const db = migratedDatabase();
    parse(db, 1, 1, "1.0.0");
    publish(db, 1, 1, "1.0.0");
    price(db, { id: "p-old", run: 1, at: "2026-09-07T09:00:00+09:00", amount: "146" });
    expect(await ids(db, "2026-09-08T00:00:00Z")).toEqual(["p-old"]);
    // The same artifact parsed again: its own observation, its own price.
    parse(db, 2, 1, "1.0.1");
    price(db, { id: "p-new", run: 2, at: "2026-09-07T09:00:00+09:00", amount: "147" });
    // Not yet published: selection still reads the old parse.
    expect(await ids(db, "2026-09-08T00:00:00Z")).toEqual(["p-old"]);
    publish(db, 1, 2, "1.0.1");
    expect(await ids(db, "2026-09-08T00:00:00Z")).toEqual(["p-new"]);
    expect(
      db.query("SELECT id FROM price_observations ORDER BY id").all() as { id: string }[],
    ).toEqual([{ id: "p-new" }, { id: "p-old" }]);
  });

  test("one row per base, quote and kind, each filter narrowing it", async () => {
    const db = migratedDatabase();
    parse(db, 1, 1);
    publish(db, 1, 1);
    const at = "2026-09-07T09:00:00+09:00";
    price(db, { id: "mid", run: 1, at, amount: "146" });
    price(db, { id: "bid", run: 1, at, amount: "145", kind: "bid" });
    price(db, { id: "eur", run: 1, at, amount: "161", base: "EUR" });
    price(db, { id: "usd-in-aud", run: 1, at, amount: "1", quote: "AUD" });
    // Same instant: the later recorded row, then the higher id.
    price(db, { id: "mid-2", run: 1, at, amount: "146", recordedAt: "2026-09-08T00:00:01.000Z" });
    // A date-only price is never selected against an instant cutoff.
    price(db, {
      id: "dated",
      run: 1,
      at,
      amount: "150",
      base: "GBP",
      effective: { kind: "local-date", value: "2026-09-07", zone: "Asia/Tokyo", basis: "provider" },
    });
    const cutoff = "2026-09-08T00:00:00Z";
    expect(await ids(db, cutoff, ["USD", "EUR", "GBP", "CHF"])).toEqual([
      "eur",
      "usd-in-aud",
      "bid",
      "mid-2",
    ]);
    const only = async (quoteUnitRef: string | null, priceKind: "reference" | "bid" | null) =>
      (
        await selectPrices(executor(db), {
          baseInstrumentRefs: ["USD"],
          cutoff,
          quoteUnitRef,
          priceKind,
        })
      ).map((row) => row.price.id);
    expect(await only("JPY", null)).toEqual(["bid", "mid-2"]);
    expect(await only("JPY", "reference")).toEqual(["mid-2"]);
    expect(await only(null, "reference")).toEqual(["usd-in-aud", "mid-2"]);
  });

  test("an unpublished or failed parse's price is never selected", async () => {
    const db = migratedDatabase();
    parse(db, 1, 1);
    price(db, { id: "unpublished", run: 1, at: "2026-09-07T09:00:00+09:00", amount: "146" });
    expect(await ids(db, "2026-09-08T00:00:00Z")).toEqual([]);
  });

  test("the query is refused rather than guessed", async () => {
    const db = migratedDatabase();
    const sql = executor(db);
    for (const cutoff of ["2026-09-08", "yesterday", "2026-09-08T00:00:00"])
      await expect(selectPrices(sql, { baseInstrumentRefs: ["USD"], cutoff })).rejects.toThrow(
        PriceSelectionError,
      );
    await expect(
      selectPrices(sql, {
        baseInstrumentRefs: Array.from({ length: PRICE_SELECTION_BOUND + 1 }, (_, i) => `I${i}`),
        cutoff: "2026-09-08T00:00:00Z",
      }),
    ).rejects.toThrow("too_many_instruments");
    expect(await selectPrices(sql, { baseInstrumentRefs: [], cutoff: "bad" })).toEqual([]);
  });

  test("prices and their claims are append-only", () => {
    const db = migratedDatabase();
    parse(db, 1, 1);
    price(db, { id: "p", run: 1, at: "2026-09-07T09:00:00+09:00", amount: "146" });
    expect(() => db.exec("UPDATE price_observation_claims SET json_path='$.x'")).toThrow(
      "append-only",
    );
    expect(() => db.exec("DELETE FROM price_observation_claims")).toThrow("append-only");
    expect(() => db.exec("UPDATE price_observations SET recorded_at='x'")).toThrow("append-only");
    // A claim must name an observation of its own parse run and kind.
    expect(() =>
      db.exec(`INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
        VALUES('p','fx-sbi-shinsei-board-v1','position',1,1,'$','x')`),
    ).toThrow();
  });

  test("the plan reaches prices by instrument and claims by price without statistics", () => {
    const db = migratedDatabase();
    const plan = (
      db
        .query(`EXPLAIN QUERY PLAN ${PRICE_SELECTION_SQL}`)
        .all('["USD"]', "2026-09-08T00:00:00Z", null, null) as { detail: string }[]
    ).map((row) => row.detail);
    expect(plan.some((line) => /SCAN (po|price_observations)\b/u.test(line))).toBe(false);
    expect(plan.some((line) => /SCAN (c|price_observation_claims)\b/u.test(line))).toBe(false);
    expect(plan.some((line) => line.includes("price_observations_instrument"))).toBe(true);
  });
});
