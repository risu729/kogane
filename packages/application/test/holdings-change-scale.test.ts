// Reported holdings changes between two dates (src/query/holdings-change.ts;
// ADR 0075) on the scaled store with statement history
// (packages/read-model/test/card-usage-scale-fixture.ts): the complete CORE
// schema, no table statistics (D1 is never analyzed), daily container
// captures. Every statement one answer runs is recorded and its plan checked:
// no read walks an observation, parse, run or identity table whole beyond what
// dated-state-scale.test.ts already accepts for the same statement. CI builds
// `STATEMENT_CI_SCALE`; set KOGANE_DATED_STATE_SCALE=full to build
// `STATEMENT_SCALE` and print the timings docs/reported-state.md quotes. The
// scaled store holds no position containers, so the timing is the two dated
// reads and the keyed unit read. Synthetic values only.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  DATED_POSITION_QUANTITIES_SQL,
  DATED_SNAPSHOT_UNITS_SQL,
  DATED_STATEMENTS_SQL,
} from "../../read-model/src/dated-state.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { explain, type PlanStep } from "../../read-model/test/card-usage-plan.ts";
import {
  STATEMENT_CI_SCALE,
  STATEMENT_SCALE,
  type ScaledStore,
  scaledStore,
} from "../../read-model/test/card-usage-scale-fixture.ts";
import { queryHoldingsChange } from "../src/query/holdings-change.ts";

const FULL = process.env["KOGANE_DATED_STATE_SCALE"] === "full";
const TIMEOUT = FULL ? 1_800_000 : 60_000;
const OPTIONS = FULL ? STATEMENT_SCALE : STATEMENT_CI_SCALE;

let built: ScaledStore;
let db: Database;

beforeAll(async () => {
  built = await scaledStore(OPTIONS);
  db = built.store.db;
}, TIMEOUT);

const recording = (): SqlExecutor & { statements: [string, readonly unknown[]][] } => {
  const sql = {
    statements: [] as [string, readonly unknown[]][],
    all: async <T>(text: string, args: readonly unknown[]) => {
      sql.statements.push([text, args]);
      return db.query(text).all(...(args as SQLQueryBindings[])) as T[];
    },
    first: async <T>(text: string, args: readonly unknown[]) => {
      sql.statements.push([text, args]);
      return (db.query(text).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
  return sql;
};

/** Median wall time of `runs` executions, in milliseconds. */
async function timed(run: () => unknown, runs = 3): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return Math.round(times.sort((left, right) => left - right)[Math.floor(runs / 2)]! * 10) / 10;
}

const daysBefore = (days: number): string => {
  const end = Date.parse(`${OPTIONS.today}T00:00:00Z`);
  return new Date(end - days * 86_400_000).toISOString().slice(0, 10);
};

/** The relations dated-state-scale.test.ts accepts a dated read scanning whole. */
const BOUNDED = new Set([
  "a",
  "warning",
  "unit_policy",
  "container_policy",
  "dataset_snapshot_policies",
  "json_each",
  "CONSTANT",
  "dp",
  "l",
  "per",
  "s",
  "w",
  "observed_ids",
  "owned",
  "owned_runs",
  "owned_candidates",
]);

function unboundedScans(steps: readonly PlanStep[], allowed: readonly string[] = []): string[] {
  return steps
    .filter((step) => step.detail.startsWith("SCAN "))
    .map((step) => step.detail)
    .filter((detail) => {
      const name = detail.slice(5).split(" ")[0]!;
      return !(
        BOUNDED.has(name) ||
        allowed.includes(name) ||
        name.startsWith("dated_") ||
        /^\(subquery-\d+\)$/u.test(name)
      );
    });
}

describe("holdings changes on a scaled store without statistics", () => {
  test(
    "every statement of one answer is keyed or one the dated read already accepts",
    async () => {
      expect(
        db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
      ).toEqual({ n: 0 });
      const sql = recording();
      const result = await queryHoldingsChange(sql, {
        from: daysBefore(30),
        to: OPTIONS.today,
        today: OPTIONS.today,
      });
      // No position container in this store: nothing listed, and every
      // position container named as without a capture on both dates.
      expect(result.holdings).toEqual([]);
      expect(result.coverage.containersWithoutSnapshot.length).toBeGreaterThan(0);
      expect(sql.statements.map(([text]) => text)).toContain(DATED_SNAPSHOT_UNITS_SQL);
      for (const [text, args] of sql.statements)
        expect(
          // Ranking every captured statement total before the cutoff reads
          // every balance observation once, as `card_statement_facts` does.
          unboundedScans(explain(db, text, args), text === DATED_STATEMENTS_SQL ? ["b"] : []),
        ).toEqual([]);
      // The keyed reads, with keys this store does hold.
      expect(unboundedScans(explain(db, DATED_POSITION_QUANTITIES_SQL, ["[1,2,3]"]))).toEqual([]);
      expect(unboundedScans(explain(db, DATED_SNAPSHOT_UNITS_SQL, ["[1,2,3]"]))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "one answer is two dated reads and keyed lookups",
    async () => {
      const month = await timed(() =>
        queryHoldingsChange(recording(), {
          from: daysBefore(30),
          to: OPTIONS.today,
          today: OPTIONS.today,
        }),
      );
      if (FULL) console.log(JSON.stringify({ counts: built.counts, month }, null, 2));
      // Two answers of the dated read, each under its one-second target.
      expect(month).toBeLessThan(2_000);
    },
    TIMEOUT,
  );
});
