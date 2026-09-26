// The reported state on a date (src/query/dated-state.ts) on the scaled store
// with statement history (packages/read-model/test/card-usage-scale-fixture.ts,
// `statements`): the complete CORE schema, no table statistics (D1 is never
// analyzed), three Vpass cards, a MyJCB connection and two banks captured
// daily, the SMBC balance and the St.George account snapshot among them as
// container snapshots, every statement total recaptured daily and the
// settlement reviews decided. The answer is the one each date's captures
// give, and no read walks an observation, parse or identity table whole. CI
// builds `STATEMENT_CI_SCALE`; set KOGANE_DATED_STATE_SCALE=full to build
// `STATEMENT_SCALE` (a few minutes) and print the timings
// docs/reported-state.md quotes. Synthetic values only.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { reportedStateCutoff, payablesFromPaymentDate } from "../../domain/src/reported-state.ts";
import {
  DATED_BALANCES_SQL,
  DATED_POSITIONS_SQL,
  DATED_SNAPSHOTS_SQL,
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
import { SETTLEMENT_SQL } from "../src/query/card-purchases.ts";
import { queryDatedState } from "../src/query/dated-state.ts";

const FULL = process.env["KOGANE_DATED_STATE_SCALE"] === "full";
const TIMEOUT = FULL ? 1_800_000 : 60_000;
const OPTIONS = FULL ? STATEMENT_SCALE : STATEMENT_CI_SCALE;

let built: ScaledStore;
let db: Database;

beforeAll(async () => {
  built = await scaledStore(OPTIONS);
  db = built.store.db;
}, TIMEOUT);

const executor = (): SqlExecutor => ({
  all: async <T>(sql: string, args: readonly unknown[]) =>
    db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
  first: async <T>(sql: string, args: readonly unknown[]) =>
    (db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
});

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

const middle = (): string => {
  const end = Date.parse(`${OPTIONS.today}T00:00:00Z`);
  return new Date(end - Math.floor(OPTIONS.dailyDays / 2) * 86_400_000).toISOString().slice(0, 10);
};

/**
 * Relations a dated read may scan whole: its own CTEs and subqueries, the
 * policy rows (`dataset_snapshot_policies`, `unit_policy`, `container_policy`,
 * a handful of configuration rows), a parse's warnings, the caller's JSON
 * keys, and `a`, the artifact scan the snapshot CTEs share with every current
 * read (per artifact, never per observation; docs/reported-state.md, Cost).
 */
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

describe("reported state on a scaled store without statistics", () => {
  test("the store is what D1 runs, with daily container captures and statements", () => {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    expect(built.counts.statementTotals).toBeGreaterThan(built.counts.captureDays);
    expect(built.counts.settlement!.accepted).toBeGreaterThan(0);
  });

  test(
    "each date reads the capture of that date, and its statements as they stood",
    async () => {
      for (const date of [OPTIONS.today, middle()]) {
        const cutoff = reportedStateCutoff(date);
        const state = await queryDatedState(executor(), { date });
        // Independently: the newest SMBC balance artifact before the cutoff.
        const newest = db
          .query(
            `SELECT max(fetched_at) AS at FROM observation_fetch_artifacts
             WHERE source_id='smbc-bank' AND dataset='balance-normalized' AND fetched_at<?`,
          )
          .get(cutoff) as { at: string };
        const smbc = state.snapshots.find((snapshot) => snapshot.sourceId === "smbc-bank")!;
        expect(smbc.capturedAt).toBe(newest.at);
        expect(smbc.freshness).toBe("same-day");
        expect(state.accounts.find((a) => a.sourceId === "smbc-bank")!.balances).toHaveLength(1);
        // The St.George captures carry no coverage claim, so under coverage-v1
        // none is a complete snapshot: named, never shown as empty.
        expect(state.coverage.containersWithoutSnapshot.map((c) => c.parserName)).toContain(
          "st-george-balances",
        );
        // Independently: the statement totals captured before the cutoff.
        const expected = db
          .query(
            `SELECT count(DISTINCT statement_key) AS n FROM (
               SELECT json_array(a.source_id,b.source_account,
                 coalesce(json_extract(b.extra_json,'$._kogane.period'),
                  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||
                  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2))) AS statement_key,
                 json_extract(b.extra_json,'$._kogane.paymentDate') AS due
               FROM balance_observations b
               JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
               JOIN parse_runs p ON p.id=b.parse_run_id
               JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
               WHERE b.metric='credit_statement_payment_amount' AND a.fetched_at<?
                 AND p.parser_name IN ('vpass-statement-page','myjcb-credit-statement-total')
                 AND json_extract(b.extra_json,'$._kogane.snapshotSemantics')='provider-reported-monthly-payment-amount'
                 AND json_extract(b.extra_json,'$._kogane.paymentDate')>=?)`,
          )
          .get(cutoff, payablesFromPaymentDate(date)) as { n: number };
        expect(state.payables.filter((p) => p.paymentDate !== null)).toHaveLength(expected.n);
        expect(state.payables.some((p) => p.status === "settled_on_or_before_date")).toBe(true);
        expect(state.payables.some((p) => p.status === "due_after_date")).toBe(true);
      }
    },
    TIMEOUT,
  );

  test(
    "no read walks an observation, parse, run or identity table whole",
    () => {
      const date = OPTIONS.today;
      const cutoff = reportedStateCutoff(date);
      const keys = JSON.stringify([["acct-card-0", "vpass", "2026-09"]]);
      expect(unboundedScans(explain(db, DATED_POSITIONS_SQL, [cutoff]))).toEqual([]);
      expect(unboundedScans(explain(db, DATED_BALANCES_SQL, [cutoff]))).toEqual([]);
      expect(unboundedScans(explain(db, DATED_SNAPSHOTS_SQL, [cutoff]))).toEqual([]);
      // Ranking every captured statement total before the cutoff reads every
      // balance observation once, as `card_statement_facts` itself does.
      expect(
        unboundedScans(
          explain(db, DATED_STATEMENTS_SQL, [cutoff, payablesFromPaymentDate(date), cutoff]),
          ["b"],
        ),
      ).toEqual([]);
      expect(unboundedScans(explain(db, SETTLEMENT_SQL, [keys]))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "one answer takes well under the one-second target",
    async () => {
      const today = await timed(() => queryDatedState(executor(), { date: OPTIONS.today }));
      const past = await timed(() => queryDatedState(executor(), { date: middle() }));
      if (FULL) {
        const cutoff = reportedStateCutoff(OPTIONS.today);
        const reads = {
          positions: await timed(() => db.query(DATED_POSITIONS_SQL).all(cutoff)),
          balances: await timed(() => db.query(DATED_BALANCES_SQL).all(cutoff)),
          snapshots: await timed(() => db.query(DATED_SNAPSHOTS_SQL).all(cutoff)),
          statements: await timed(() =>
            db
              .query(DATED_STATEMENTS_SQL)
              .all(cutoff, payablesFromPaymentDate(OPTIONS.today), cutoff),
          ),
        };
        console.log(JSON.stringify({ counts: built.counts, today, past, reads }, null, 2));
      }
      expect(today).toBeLessThan(1_000);
      expect(past).toBeLessThan(1_000);
    },
    TIMEOUT,
  );
});
