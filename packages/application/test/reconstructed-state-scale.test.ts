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
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import {
  STATEMENT_CI_SCALE,
  STATEMENT_SCALE,
  scaledStore,
} from "../../read-model/test/card-usage-scale-fixture.ts";
import type { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import { EconomicHistory, day } from "../../read-model/test/economic-history-fixture.ts";
import { KNOWN_WRITER_RELEASES } from "../../domain/src/reconstruction-adapter.ts";
import { readReconstructedState } from "../src/query/reconstructed-state-read.ts";
import { WORLD_GRANT } from "./reconstructed-state-world.ts";

const FULL = process.env["KOGANE_RECONSTRUCTED_STATE_SCALE"] === "full";
const TIMEOUT = FULL ? 1_800_000 : 120_000;
const OPTIONS = FULL ? STATEMENT_SCALE : STATEMENT_CI_SCALE;
const EVENTS = FULL ? 1_500 : 150;
const REVISIONS = FULL ? 3 : 2;
const ACCOUNT = "acct-bank";
const TODAY = OPTIONS.today;
const FROM = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 365 * 86_400_000)
  .toISOString()
  .slice(0, 10);
const NOW = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString();
const SETTLEMENT_RELEASE = KNOWN_WRITER_RELEASES["card-settlement-review"][0]!;

let db: Database;
/** Commits the scaled store's own lanes logged before these settlements. */
let existingCommits = 0;

beforeAll(async () => {
  const built = await scaledStore(OPTIONS);
  db = built.store.db;
  // `adopt` writes through the store's database only.
  const h = new EconomicHistory({ db } as unknown as DatedStore);
  existingCommits = (
    db.query("SELECT count(*) AS n FROM economic_commit_log").get() as { n: number }
  ).n;
  let clock = Date.parse(`${FROM}T00:00:00Z`);
  for (let event = 0; event < EVENTS; event += 1) {
    const posting = new Date(Date.parse(`${FROM}T00:00:00Z`) + (event % 360) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (let revision = 1; revision <= REVISIONS; revision += 1) {
      clock += 60_000;
      h.adopt({
        eventId: `ev-scale-${event}`,
        revision,
        legs: [
          {
            subject: ACCOUNT,
            amount: String(100 + revision),
            role: "decrease",
            basis: "cash-movement",
          },
          { subject: "acct-card-0", amount: null, role: "unresolved", basis: "obligation-change" },
        ],
        times: [["posting", day(posting)]],
        knownAt: new Date(clock).toISOString(),
        writerRelease: SETTLEMENT_RELEASE,
      });
    }
  }
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
 * The only whole scans any statement of this read may make, each already
 * accepted by the test that owns its statement: the dated reads' bounded
 * CTEs, subqueries, policy rows and `a`, the artifact scan their snapshot CTEs
 * share with every current read (dated-state-scale.test.ts); `b`, the
 * statement ranking's one pass over balance observations, as
 * `card_statement_facts` makes it (ibid.); the selector's schema probe, view
 * arms, newest-first epoch read and materialized key list
 * (economic-selector.test.ts); and `m`, the account mapping table, which no
 * index orders by account (ADR 0058). Any other scan fails.
 */
const ACCEPTED = new Set([
  "a",
  "b",
  "m",
  "w",
  "l",
  "s",
  "dp",
  "per",
  "warning",
  "unit_policy",
  "container_policy",
  "dataset_snapshot_policies",
  "observed_ids",
  "owned",
  "owned_runs",
  "owned_candidates",
  "json_each",
  "CONSTANT",
  "sqlite_master",
  "economic_revision_claims",
  "economic_identity_epochs",
]);
const accepted = (name: string): boolean =>
  ACCEPTED.has(name) || name.startsWith("dated_") || /^\(subquery-\d+\)$/u.test(name);

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
          if (!accepted(name)) scanned.push(`${step.detail} :: ${sql.slice(0, 60)}`);
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
