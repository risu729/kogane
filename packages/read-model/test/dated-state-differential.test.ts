// The MoneyForward source exclusion (DATED_STATE_EXCLUDED_SOURCES) against the
// dated reads as shipped before it (dated-state-legacy-sql.ts): on random
// synthetic stores the shipped text returns exactly the frozen text's rows
// without those of `moneyforward-me`, in the same order, and its plans read
// the same tables the same way without table statistics. Synthetic values only.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { reportedStateCutoff } from "../../domain/src/reported-state";
import { DATED_BALANCES_SQL, DATED_POSITIONS_SQL, DATED_SNAPSHOTS_SQL } from "../src/dated-state";
import { DatedStore } from "./dated-state-fixture";
import {
  LEGACY_DATED_BALANCES_SQL,
  LEGACY_DATED_POSITIONS_SQL,
  LEGACY_DATED_SNAPSHOTS_SQL,
} from "./dated-state-legacy-sql";

const MF = "moneyforward-me";

/** mulberry32: a small seeded generator, so a failing seed replays. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTAINERS = [
  {
    source: MF,
    dataset: "account-detail",
    parser: "moneyforward-detail-balances",
    version: "1.0.1",
    units: ["mf-conn-a", "mf-conn-b"],
    metric: "reported_account_value_jpy",
  },
  {
    source: "sbi-securities",
    dataset: "domestic-cash-positions",
    parser: "sbi-domestic-cash-positions",
    positions: true,
  },
  {
    source: "smbc-bank",
    dataset: "balance-normalized",
    parser: "smbc-direct-balance",
    metric: "available_balance",
  },
  {
    source: "st-george",
    dataset: "account-snapshot",
    parser: "st-george-balances",
    version: "1.0.1",
    metric: "account_balance",
  },
  {
    source: "sbi-securities",
    dataset: "account-assets-current",
    parser: "sbi-account-assets-current",
    metric: "total_assets",
  },
] as const;

/** A store of 4–24 captures over 2026-09-01..09-10, each complete, partial, failed or unclaimed. */
function randomStore(seed: number): DatedStore {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const store = new DatedStore();
  const captures = 4 + Math.floor(next() * 21);
  for (let index = 0; index < captures; index += 1) {
    const container = pick(CONTAINERS);
    const day = 1 + Math.floor(next() * 10);
    const fetchedAt = `2026-09-${String(day).padStart(2, "0")}T${String(Math.floor(next() * 24)).padStart(2, "0")}:00:00Z`;
    const rows = Math.floor(next() * 3);
    const accounts = ["acct-a", "acct-b"];
    // A MoneyForward capture also writes a position, so the positions read
    // has its rows to leave out (the deployed parser emits none).
    const withPositions = "positions" in container || (container.source === MF && next() < 0.5);
    store.capture({
      source: container.source,
      dataset: container.dataset,
      parser: container.parser,
      ...("version" in container ? { version: container.version } : {}),
      ...("units" in container ? { unitKey: pick(container.units) } : {}),
      fetchedAt,
      outcome: next() < 0.85 ? "success" : "failure",
      ...(next() < 0.8
        ? { claim: next() < 0.8 ? ("complete" as const) : ("partial" as const) }
        : {}),
      positions: withPositions
        ? Array.from({ length: rows }, (_, row) => ({
            account: `${container.source}:${pick(accounts)}`,
            code: `${1000 + row}`,
            quantity: String(1 + Math.floor(next() * 50)),
            ...(next() < 0.5 ? { value: Math.floor(next() * 100_000) } : {}),
          }))
        : [],
      balances:
        "metric" in container
          ? Array.from({ length: rows }, () => ({
              account: `${container.source}:${pick(accounts)}`,
              metric: container.metric,
              instrument: container.source === "st-george" ? "AUD" : "JPY",
              minor: next() < 0.1 ? null : Math.floor(next() * 1_000_000),
            }))
          : [],
    });
  }
  return store;
}

function rows<T>(store: DatedStore, sql: string, date: string): T[] {
  return store.db.query(sql).all(reportedStateCutoff(date) as SQLQueryBindings) as T[];
}

const READS = [
  {
    name: "positions",
    shipped: DATED_POSITIONS_SQL,
    legacy: LEGACY_DATED_POSITIONS_SQL,
    key: "source_id",
  },
  {
    name: "balances",
    shipped: DATED_BALANCES_SQL,
    legacy: LEGACY_DATED_BALANCES_SQL,
    key: "source_id",
  },
  {
    name: "snapshots",
    shipped: DATED_SNAPSHOTS_SQL,
    legacy: LEGACY_DATED_SNAPSHOTS_SQL,
    key: "perimeter_source_id",
  },
] as const;

describe("the shipped dated reads against the frozen text", () => {
  test("on random stores, only the moneyforward-me rows differ", () => {
    const leftOut = { positions: 0, balances: 0, snapshots: 0 };
    for (let seed = 1; seed <= 60; seed += 1) {
      const store = randomStore(seed);
      for (const date of ["2026-08-31", "2026-09-03", "2026-09-06", "2026-09-10"]) {
        for (const read of READS) {
          const legacy = rows<Record<string, unknown>>(store, read.legacy, date);
          const shipped = rows<Record<string, unknown>>(store, read.shipped, date);
          const kept = legacy.filter((row) => row[read.key] !== MF);
          expect({ seed, date, read: read.name, rows: shipped }).toEqual({
            seed,
            date,
            read: read.name,
            rows: kept,
          });
          leftOut[read.name] += legacy.length - kept.length;
        }
      }
    }
    // The stores did hold MoneyForward rows the frozen text read.
    expect(leftOut.positions).toBeGreaterThan(0);
    expect(leftOut.balances).toBeGreaterThan(0);
    expect(leftOut.snapshots).toBeGreaterThan(0);
  }, 60_000);

  test("without table statistics, the shipped plans scan no table the frozen ones do not", () => {
    // The source predicate moves the planner's join order (an automatic index
    // on the artifact scan `a` becomes a second pass over it), so the plans are
    // not step-for-step equal; what each scans whole is the frozen plan's, and
    // the scaled-store check (dated-state-scale.test.ts) bounds those scans.
    const store = randomStore(7);
    expect(
      store.db
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
        .get(),
    ).toEqual({ n: 0 });
    const scanned = (sql: string) =>
      new Set(
        (
          store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(reportedStateCutoff("2026-09-10")) as {
            detail: string;
          }[]
        )
          .map((step) => step.detail)
          .filter((detail) => detail.startsWith("SCAN "))
          .map((detail) => detail.slice(5).split(" ")[0]!),
      );
    for (const read of READS) {
      const legacy = scanned(read.legacy);
      expect({
        read: read.name,
        scans: [...scanned(read.shipped)].filter((name) => !legacy.has(name)),
      }).toEqual({
        read: read.name,
        scans: [],
      });
    }
  });
});
