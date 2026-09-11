// D1-oriented load harness (architecture addendum 12 section 7; finding AR18).
//
// Opt-in: it only runs with `KOGANE_LOAD=1`, because building the fixture
// through the real ingest path is slow and the numbers are only meaningful
// when the shape is chosen deliberately. Without the variable the file records
// the budgets and the measurement plan and skips the measurement, so a normal
// `vitest run` stays fast.
//
//   KOGANE_LOAD=1 KOGANE_LOAD_DAYS=8 KOGANE_LOAD_UNITS=4 \
//   KOGANE_LOAD_OBSERVATIONS=5 vitest run test/load.test.ts
//
// What it measures for one screen of the reader: SQL statement count, rows
// read (D1 `meta.rows_read`), payload bytes and wall-time p95. What it asserts
// is the review's design rule: one screen's query cost must not be
// proportional to all of history. It measures the same screen at one size and
// at a larger one and compares.
//
// The fixture is synthetic (scripts/load-fixture.ts): generated accounts,
// generated amounts, a fixed seed. No real evidence is read or copied.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { observationApi } from "../src/observation-api";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import {
  balanceRows,
  DESIGN_LOAD,
  fixtureChecksum,
  shapeFromEnv,
  totalObservations,
  type LoadShape,
} from "../../../scripts/load-fixture";

/** The workers pool has no host environment; vitest.config.ts forwards ours. */
const config = JSON.parse(env.KOGANE_LOAD_CONFIG || "{}") as Record<string, string | undefined>;
const LOAD = config.KOGANE_LOAD === "1";
const measure = LOAD ? it : it.skip;

/**
 * Documented thresholds, not a capacity forecast. A breach is a design signal
 * to revisit the query, the read model or the partitioning first, and the
 * database only after that (addendum 12 section 7).
 */
export const BUDGETS = {
  /** Enforced: one screen is a fixed handful of statements, not one per row. */
  statementsPerScreen: 12,
  /** Enforced: a screen's response stays well inside a single bounded page. */
  payloadBytes: 1_500_000,
  /** Enforced, generously: this is a local Miniflare D1, not a latency measurement. */
  p95Ms: 5_000,
  /**
   * Enforced: rows read per screen must not grow faster than the data does.
   * A factor above 1 here would mean the query gets worse than linear.
   */
  maxRowsReadGrowthFactor: 1.2,
  /**
   * Recorded, NOT enforced. Addendum 12 section 7's actual pass criterion is
   * that one screen's query volume is not proportional to all history. The
   * current reader pages by offset over the whole visible set, so rows read
   * still grow roughly linearly with history — that is finding AR18, measured
   * rather than asserted away. The published balance projection (A07,
   * migration 0030) is the change that would let this become an assertion.
   */
  designTargetGrowthRatio: 1.5,
} as const;

interface Measurement {
  statements: number;
  rowsRead: number;
  payloadBytes: number;
  p95Ms: number;
}

/** Counts prepared statements and sums `meta.rows_read` for one request. */
function countingDb(db: D1Database): { db: D1Database; statements: number; rowsRead: number } {
  const counters = { statements: 0, rowsRead: 0 };
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => {
        counters.statements += 1;
        return wrapStatement(target.prepare(sql), counters);
      };
    },
  });
  return Object.assign(counters, { db: proxy as D1Database }) as unknown as {
    db: D1Database;
    statements: number;
    rowsRead: number;
  };
}

function wrapStatement(
  statement: D1PreparedStatement,
  counters: { rowsRead: number },
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const call = value.bind(target) as (...args: unknown[]) => unknown;
      if (property === "bind")
        return (...args: unknown[]) =>
          wrapStatement(call(...args) as D1PreparedStatement, counters);
      if (property === "all" || property === "run")
        return async (...args: unknown[]) => {
          const result = (await call(...args)) as { meta?: { rows_read?: number } };
          counters.rowsRead += result.meta?.rows_read ?? 0;
          return result;
        };
      return call;
    },
  });
}

async function screen(path: string, repetitions: number): Promise<Measurement> {
  const durations: number[] = [];
  let statements = 0;
  let rowsRead = 0;
  let payloadBytes = 0;
  for (let attempt = 0; attempt < repetitions; attempt += 1) {
    const counting = countingDb(env.DB);
    const request = new Request(`https://fixture.test${path}`);
    const started = Date.now();
    const response = await observationApi(
      request,
      { ...env, DB: counting.db },
      new URL(request.url),
    );
    const text = await response!.text();
    durations.push(Date.now() - started);
    statements = counting.statements;
    rowsRead = counting.rowsRead;
    payloadBytes = new TextEncoder().encode(text).length;
  }
  durations.sort((a, b) => a - b);
  return {
    statements,
    rowsRead,
    payloadBytes,
    p95Ms: durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)]!,
  };
}

/** Seed one day's worth of the shape: one run, `units` artifacts, one published parse each. */
async function seedDay(shape: LoadShape, day: number, rows: ReturnType<typeof balanceRows>) {
  const run = await seedRun({ count: shape.units, source: "other-test", dataset: "load" });
  const parseIds: number[] = [];
  for (const artifact of run.artifacts) {
    const parse = await env.DB.prepare(
      `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
       VALUES (?,'load-balances','1',?,'ok','[]') RETURNING id`,
    )
      .bind(artifact.id, `2026-09-07T00:00:0${day % 10}Z`)
      .first<{ id: number }>();
    parseIds.push(parse!.id);
    await publishParse(parse!.id);
  }
  let inserted = 0;
  const batch: D1PreparedStatement[] = [];
  for (let unit = 0; unit < shape.units; unit += 1)
    for (let index = 0; index < shape.observationsPerDay; index += 1) {
      const next = rows.next();
      if (next.done) break;
      const row = next.value;
      batch.push(
        env.DB.prepare(
          `INSERT INTO balance_observations (parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
           VALUES (?,?,?,?,?,?,?,'{}')`,
        ).bind(
          parseIds[unit]!,
          row.sourceAccount,
          row.metric,
          row.instrument,
          row.amountMinor,
          row.asOf,
          row.rawLocator,
        ),
      );
      inserted += 1;
    }
  if (batch.length > 0) await env.DB.batch(batch);
  return inserted;
}

describe("D1 load budgets", () => {
  it("documents the design load and the budgets it is measured against", () => {
    expect(totalObservations(DESIGN_LOAD)).toBe(14_600_000);
    // The generator is deterministic: the same seed gives the same fixture.
    const shape = { ...DESIGN_LOAD, days: 3, units: 2, observationsPerDay: 4 };
    expect(fixtureChecksum(shape)).toBe(fixtureChecksum({ ...shape }));
    expect(fixtureChecksum({ ...shape, seed: 2 })).not.toBe(fixtureChecksum(shape));
    expect(BUDGETS.statementsPerScreen).toBeGreaterThan(0);
    if (!LOAD)
      console.log(
        JSON.stringify({ event: "load_harness_skipped", reason: "KOGANE_LOAD not set", BUDGETS }),
      );
  });

  measure(
    "one screen's cost does not grow with all of history",
    async () => {
      await seedRegistry();
      const shape = shapeFromEnv(config);
      const rows = balanceRows(shape);
      let seeded = 0;
      const samples: { observations: number; screens: Record<string, Measurement> }[] = [];
      const checkpoints = new Set([Math.ceil(shape.days / 4), shape.days]);
      for (let day = 0; day < shape.days; day += 1) {
        seeded += await seedDay(shape, day, rows);
        if (!checkpoints.has(day + 1)) continue;
        samples.push({
          observations: seeded,
          screens: {
            list: await screen("/api/balances?source=other-test", 5),
            latest: await screen("/api/balances?source=other-test&view=summaries", 5),
            history: await screen("/api/balances?source=other-test&offset=0", 5),
          },
        });
      }
      const [small, large] = samples;
      expect(small).toBeDefined();
      expect(large).toBeDefined();
      const dataGrowth = large!.observations / small!.observations;
      const growth: Record<string, number> = {};
      for (const [name, budget] of Object.entries(large!.screens))
        growth[name] = budget.rowsRead / Math.max(1, small!.screens[name]!.rowsRead);
      // The measurement is the output of this harness; it carries counts,
      // durations and byte sizes only, never an amount or an account.
      console.log(
        JSON.stringify(
          {
            event: "load_measurement",
            shape,
            dataGrowth,
            growth,
            designTargetMet: Object.values(growth).every(
              (value) => value <= BUDGETS.designTargetGrowthRatio,
            ),
            samples,
          },
          null,
          2,
        ),
      );

      for (const [name, budget] of Object.entries(large!.screens)) {
        expect(budget.statements, `${name} statements`).toBeLessThanOrEqual(
          BUDGETS.statementsPerScreen,
        );
        expect(budget.payloadBytes, `${name} payload`).toBeLessThanOrEqual(BUDGETS.payloadBytes);
        expect(budget.p95Ms, `${name} p95`).toBeLessThanOrEqual(BUDGETS.p95Ms);
        expect(
          growth[name]!,
          `${name} rows read grew ${growth[name]!.toFixed(2)}x while the data grew ${dataGrowth.toFixed(2)}x`,
        ).toBeLessThanOrEqual(dataGrowth * BUDGETS.maxRowsReadGrowthFactor);
      }
    },
    600_000,
  );
});
