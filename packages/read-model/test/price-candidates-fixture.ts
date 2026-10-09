// A migrated CORE store with parse runs, publication history and promoted
// prices, for the candidate-read tests here and the market-data query tests in
// packages/application. Synthetic only: every instrument, amount and time is
// invented by the caller.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PriceKey } from "../../domain/src/market-data.ts";
import type { SqlExecutor } from "../src/reader";
import { fromTemplate } from "./schema-template";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");

export function migratedDatabase(): Database {
  return fromTemplate("core", () => {
    const db = new Database(":memory:");
    for (const name of readdirSync(MIGRATIONS)
      .filter((entry) => entry.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    return db;
  });
}

export function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(text: string, args: readonly unknown[]) =>
      db.query(text).all(...(args as never[])) as T[],
    first: async <T>(text: string, args: readonly unknown[]) =>
      (db.query(text).get(...(args as never[])) as T | null) ?? null,
  };
}

const PARSER = "sbi-shinsei-exchange-rate";
export const USD: PriceKey = {
  baseInstrumentRef: "USD",
  quoteUnitRef: "JPY",
  priceKind: "reference",
};

/** A store with parse runs, publication history and promoted prices. */
export class PriceStore {
  readonly db = migratedDatabase();
  private observation = 1;
  private readonly published = new Map<number, number>();

  parse(id: number, artifact: number, version = `1.0.${id}`): this {
    this.db
      .query(
        `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
         VALUES(?,?,?,?,'2026-09-01T00:00:00Z','ok','[]')`,
      )
      .run(id, artifact, PARSER, version);
    return this;
  }

  /** Moves the pointer and appends the event, as the pipeline writer does. */
  publish(artifact: number, run: number, at: string, kind = "normal"): this {
    const version = (this.db.query("SELECT parser_version FROM parse_runs WHERE id=?").get(run) as {
      parser_version: string;
    })!.parser_version;
    this.db
      .query(
        `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,
           parser_version=excluded.parser_version, published_at=excluded.published_at,
           publication_kind=excluded.publication_kind`,
      )
      .run(artifact, PARSER, run, version, at, kind);
    this.db
      .query(
        `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
         VALUES(?,?,?,?,?,'pipeline','test',?)`,
      )
      .run(artifact, PARSER, this.published.get(artifact) ?? null, run, kind, at);
    this.published.set(artifact, run);
    return this;
  }

  price(options: {
    id: string;
    run: number;
    at?: string;
    amount: string;
    key?: PriceKey;
    rule?: string;
    recordedAt?: string;
    effective?: string;
  }): this {
    const key = options.key ?? USD;
    const observation = this.observation++;
    this.db
      .query(
        `INSERT INTO valuation_observations(id,parse_run_id,source_account,subject,metric,amount_text,amount_scale,currency,raw_locator,extra_json)
         VALUES(?,?,'test:board','USD','bank_mid_rate',?,0,'JPY','json:$','{}')`,
      )
      .run(observation, options.run, options.amount);
    const [coefficient, fraction = ""] = options.amount.split(".");
    this.db
      .query(
        `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,
           quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,
           source_claim_ref,recorded_at)
         VALUES(?,?,'1',0,?,?,?,?,?,?,?)`,
      )
      .run(
        options.id,
        key.baseInstrumentRef,
        key.quoteUnitRef,
        `${coefficient}${fraction}`,
        fraction.length,
        key.priceKind,
        options.effective ??
          JSON.stringify({
            kind: "instant",
            value: options.at ?? "2026-09-10T10:00:00+09:00",
            zone: "Asia/Tokyo",
            basis: "provider",
          }),
        `valuation_observations/${observation}#$.amount_text`,
        options.recordedAt ?? "2026-09-10T02:00:00.000Z",
      );
    this.db
      .query(
        `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
         VALUES(?,?,'valuation',?,?,'$.amount_text','2026-09-10T02:00:00.000Z')`,
      )
      .run(options.id, options.rule ?? "fx-sbi-shinsei-board-v1", observation, options.run);
    return this;
  }
}
