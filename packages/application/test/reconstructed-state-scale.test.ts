// What one `GET /api/v2/reconstructed-state` costs at its bounds: the route's
// service (`readReconstructedState`) end to end, on the scaled statement store
// of packages/read-model/test/card-usage-scale-fixture.ts (the complete CORE
// schema, no table statistics: D1 is never analyzed) with an economic history
// written through CORE 0070's triggers on its SMBC account: settlements
// across the year before the store's last day, each revised under the log.
// Every statement the service runs is recorded and its plan checked: nothing
// scans a table whole beyond the scans the tests that own each statement
// already accept. CI builds `STATEMENT_CI_SCALE` with 150 events of two
// revisions; set KOGANE_RECONSTRUCTED_STATE_SCALE=full to build
// `STATEMENT_SCALE` with 1,500 events of three revisions (4,500 revisions,
// near the selector's 5,000) and print the timings the ADR 0058 amendment
// quotes. Synthetic values only.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  ACCOUNT_SOURCES_SQL,
  CLAIMS_SQL,
  ECONOMIC_SELECTOR_PRESENT_SQL,
  KEY_HOLDERS_SQL,
  SELECTOR_EPOCHS_SQL,
} from "../../read-model/src/economic-selector.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import { readReconstructedState } from "../src/query/reconstructed-state-read.ts";
import { reconstructedScaleStore } from "./reconstructed-state-scale-store.ts";
import { WORLD_GRANT } from "./reconstructed-state-world.ts";

const FULL = process.env["KOGANE_RECONSTRUCTED_STATE_SCALE"] === "full";
const TIMEOUT = FULL ? 1_800_000 : 120_000;

let db: Database;
let ACCOUNT = "";
let FROM = "";
let TODAY = "";
let NOW = "";
let EVENTS = 0;
let REVISIONS = 0;
/** Commits the scaled store's own lanes logged before these settlements. */
let existingCommits = 0;

beforeAll(async () => {
  const built = await reconstructedScaleStore(FULL);
  ({ db, account: ACCOUNT, from: FROM, to: TODAY, now: NOW } = built);
  ({ events: EVENTS, revisions: REVISIONS, existingCommits } = built);
}, TIMEOUT);

/** The store as the service's executor, recording every statement it runs. */
function recording(statements: Map<string, readonly unknown[]>): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) => {
      statements.set(sql, args);
      return db.query(sql).all(...(args as SQLQueryBindings[])) as T[];
    },
    first: async <T>(sql: string, args: readonly unknown[]) => {
      statements.set(sql, args);
      return (db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
}

async function read(body: Record<string, unknown>, statements = new Map()) {
  const outcome = await readReconstructedState({
    grant: WORLD_GRANT,
    sql: recording(statements),
    body: { account: ACCOUNT, from: FROM, to: TODAY, ...body },
    now: NOW,
  });
  if (!outcome.ok) throw new Error(outcome.refusal);
  return outcome.body;
}

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

/**
 * The only whole scans each statement of this read may make, by statement and
 * alias, each already accepted by the test that owns the statement: the dated
 * container reads' bounded CTEs, subqueries and policy rows and `a`, the
 * artifact pass their snapshot CTEs share with every current read
 * (dated-state-scale.test.ts); the statement read's CTEs and `b`, its one pass
 * over balance observations, as `card_statement_facts` makes it (ibid.); the
 * selector's schema probe, epoch read, view arms and materialized key list
 * (economic-selector.test.ts); and `m`, the account mapping table, which no
 * index orders by account (ADR 0058). Any other scan, or one of these aliases
 * in another statement, fails.
 */
const DATED_CONTAINERS = new Set([
  "a",
  "l",
  "dp",
  "per",
  "warning",
  "unit_policy",
  "container_policy",
  "dataset_snapshot_policies",
]);
const DATED_STATEMENTS = new Set([
  "b",
  "s",
  "observed_ids",
  "owned",
  "owned_runs",
  "owned_candidates",
]);
const SELECTOR = new Map<string, Set<string>>([
  [ECONOMIC_SELECTOR_PRESENT_SQL, new Set(["sqlite_master"])],
  [SELECTOR_EPOCHS_SQL, new Set(["economic_identity_epochs"])],
  [CLAIMS_SQL, new Set(["economic_revision_claims"])],
  [KEY_HOLDERS_SQL, new Set(["w"])],
  [ACCOUNT_SOURCES_SQL, new Set(["m"])],
]);
function accepted(sql: string, name: string): boolean {
  if (name === "CONSTANT" || name === "json_each") return true;
  const dated = name.startsWith("dated_") || /^\(subquery-\d+\)$/u.test(name);
  if (sql.startsWith("WITH dated_snapshot_policies")) return dated || DATED_CONTAINERS.has(name);
  if (sql.startsWith("WITH dated_statement_ranked")) return dated || DATED_STATEMENTS.has(name);
  return SELECTOR.get(sql)?.has(name) ?? false;
}

describe("one read at the route's bounds", () => {
  test(
    "answers, and no statement scans a growing table whole",
    async () => {
      const statements = new Map<string, readonly unknown[]>();
      const answer = await read({}, statements);
      expect(answer.status).not.toBe("unavailable");
      // The in-force revision of each settlement, beside what the store's own lanes wrote.
      expect(answer.knowledge!.revisions).toBeGreaterThanOrEqual(EVENTS);
      expect(answer.cut!.resolved.commitSeq).toBe(existingCommits + EVENTS * REVISIONS);
      expect(answer.reconstruction!.cells.length).toBeGreaterThan(0);
      expect(
        db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
      ).toEqual({ n: 0 });
      const scanned: string[] = [];
      for (const [sql, args] of statements)
        for (const step of explain(db, sql, args)) {
          if (!step.detail.startsWith("SCAN ") || step.detail.includes("VIRTUAL TABLE")) continue;
          const name = step.detail.slice(5).split(" ")[0]!;
          if (!accepted(sql, name)) scanned.push(`${step.detail} :: ${sql.slice(0, 60)}`);
        }
      expect(scanned).toEqual([]);
      expect(statements.size).toBeGreaterThan(10);
    },
    TIMEOUT,
  );

  test(
    "timings (printed, not asserted)",
    async () => {
      const latest = await read({});
      const epoch = latest.cut!.resolved.coreEpoch;
      const middle = existingCommits + Math.floor((EVENTS * REVISIONS) / 2);
      const logStart = latest.knowledge!.coverage.logStart!.knownAt;
      const figures = {
        events: EVENTS,
        inForce: latest.knowledge!.revisions,
        revisions: EVENTS * REVISIONS,
        commits: (db.query("SELECT count(*) AS n FROM economic_commit_log").get() as { n: number })
          .n,
        latestMs: await timed(() => read({})),
        sequenceMidMs: await timed(() => read({ cut: { coreEpoch: epoch, commitSeq: middle } })),
        instantNearStartMs: await timed(() =>
          read({ cut: { coreEpoch: epoch, instant: logStart } }),
        ),
      };
      console.log(`reconstructed-state scale ${FULL ? "full" : "ci"}: ${JSON.stringify(figures)}`);
      expect(figures.commits).toBe(existingCommits + EVENTS * REVISIONS);
    },
    TIMEOUT,
  );
});
