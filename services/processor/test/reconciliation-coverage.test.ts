// Why the reconciliation lane's Vpass and MyJCB slices run stage A only: the
// purchase lane's candidate pass (src/card-purchase-job.ts) already proposes
// their pending-to-posted pairs, under the same `proposalIdentity`. On the
// scaled card store of packages/read-model/test/card-usage-scale-fixture.ts,
// built capture by capture with both lanes running after each capture day as
// production runs them, every stage B proposal the lane made while those
// slices ran stage B (#243) is sorted by what became of it:
//
//   - covered: both rows are the ones recognised events cite, and the
//     candidate pass wrote a proposal with the same digest;
//   - another capture: the same purchase pair in a capture other than the one
//     the events cite, which the candidate pass proposes once, for the cited
//     rows (#243 proposed one candidate per capture pair);
//   - refund against purchase: the pending row is a refund and the posted row
//     a purchase (or the reverse), which the candidate pass never pairs,
//     because they are never one event;
//   - not recognised: a row the purchase lane does not recognise (its
//     classification reason counted), so no event of it can be paired.
//
// Nothing else is allowed. The deployed lane then reads its pages and pairs
// nothing. CI builds `CI_SCALE`; KOGANE_RECONCILIATION_SCALE=full builds
// `FULL_SCALE` without the history (the coverage needs every capture's lanes,
// which takes hours there) and prints the tick costs docs/economic-events.md
// quotes. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { classifyCardUsage } from "../../../packages/domain/src/card-purchase.ts";
import {
  allCurrentUsage,
  CI_SCALE,
  FULL_SCALE,
  type ScaledStore,
  scaledStore,
} from "../../../packages/read-model/test/card-usage-scale-fixture.ts";
import { cardPurchaseSweep, cardUsageFactOf } from "../src/card-purchase-job.ts";
import {
  RECONCILIATION_SLICES,
  reconciliationSweep,
  type ReconciliationSlice,
  type ReconciliationSweepResult,
} from "../src/reconciliation-job.ts";

const FULL = process.env["KOGANE_RECONCILIATION_SCALE"] === "full";
const TIMEOUT = FULL ? 3_600_000 : 300_000;

/** The deployed slices as they ran before this change: stage A and stage B. */
const STAGE_B_SLICES: readonly ReconciliationSlice[] = RECONCILIATION_SLICES.map((slice) => ({
  ...slice,
  stages: ["A", "B"],
}));

interface Statement {
  sql: string;
  binds: SQLQueryBindings[];
}

/** SQL texts the lane sends, counted by what they read. */
interface Sent {
  groupReads: number;
  lookups: number;
  batches: number;
}

/**
 * `D1Database` over bun:sqlite: the calls both lanes make, nothing more. With
 * `proposals`, the lane's proposal lookups and inserts go to that map (digest
 * to target refs) instead of the table, as if the lane ran on a store of its
 * own: the table then holds only what the candidate pass wrote.
 */
function d1(store: Database, proposals?: Map<string, string>, sent?: Sent): D1Database {
  const prepare = (sql: string) => {
    if (sent !== undefined) {
      if (sql.startsWith("WITH keyed AS") || sql.startsWith("WITH ids(id) AS (SELECT value"))
        sent.groupReads += 1;
      if (sql.startsWith("SELECT proposal_digest")) sent.lookups += 1;
    }
    const statement = {
      sql,
      binds: [] as SQLQueryBindings[],
      bind: (...values: SQLQueryBindings[]) => {
        statement.binds = values;
        return statement;
      },
      first: async () => store.query(sql).get(...statement.binds) ?? null,
      all: async () => {
        if (proposals !== undefined && sql.startsWith("SELECT proposal_digest,status"))
          return {
            results: (JSON.parse(statement.binds[0] as string) as string[])
              .filter((digest) => proposals.has(digest))
              .map((digest) => ({ proposal_digest: digest, status: "proposed" })),
          };
        return { results: store.query(sql).all(...statement.binds) };
      },
      run: async () => ({ meta: { changes: store.query(sql).run(...statement.binds).changes } }),
    };
    return statement;
  };
  const batch = async (statements: Statement[]) => {
    if (sent !== undefined) sent.batches += 1;
    return store.transaction(() =>
      statements.map(({ sql, binds }) => {
        if (proposals !== undefined && sql.startsWith("INSERT INTO reconciliation_proposals")) {
          // The lane's insert binds the digest 10th and the target refs 4th.
          const digest = binds[9] as string;
          if (proposals.has(digest)) return { meta: { changes: 0 } };
          proposals.set(digest, binds[3] as string);
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: store.query(sql).run(...binds).changes } };
      }),
    )();
  };
  return { prepare, batch } as unknown as D1Database;
}

const cursorsAtZero = (db: Database, table: string): boolean =>
  (db.query(`SELECT last_observation_id AS c FROM ${table}`).all() as { c: number }[]).every(
    (row) => row.c === 0,
  );

/** The purchase lane, ticked until its cursor wraps with nothing left to write. */
async function purchaseCycle(db: Database, now: string): Promise<void> {
  for (let tick = 0; tick < 1_000; tick += 1) {
    const result = await cardPurchaseSweep(d1(db), { now });
    const wrote = result.recognized + result.revised + result.reanchored + result.retired;
    if (
      !result.deferred &&
      wrote + result.proposed === 0 &&
      cursorsAtZero(db, "card_purchase_scan_cursor")
    )
      return;
  }
  throw new Error("coverage: the purchase lane never settled");
}

interface Cycle {
  ticks: number;
  ms: number;
  totals: Omit<ReconciliationSweepResult, "slices">;
  maxScanned: number;
}

/**
 * One reconciliation cycle: ticks until every slice's cursor is back at 0
 * with nothing written, or `maxTicks` ticks (then from cursor 0).
 */
async function laneCycle(
  db: Database,
  slices: readonly ReconciliationSlice[],
  now: string,
  options: { proposals?: Map<string, string>; sent?: Sent; maxTicks?: number | undefined } = {},
): Promise<Cycle> {
  const { proposals, sent, maxTicks } = options;
  if (maxTicks !== undefined) db.run("DELETE FROM reconciliation_scan_cursor");
  const totals = {
    scanned: 0,
    groups: 0,
    groupsSkipped: 0,
    groupsDeferred: 0,
    proposed: 0,
    known: 0,
    written: 0,
    failed: 0,
    autoAccepted: 0,
  };
  let maxScanned = 0;
  const start = performance.now();
  for (let tick = 1; tick <= 10_000; tick += 1) {
    const { slices: _slices, ...result } = await reconciliationSweep(d1(db, proposals, sent), {
      slices,
      now,
    });
    for (const [key, value] of Object.entries(result)) totals[key as keyof typeof totals] += value;
    maxScanned = Math.max(maxScanned, result.scanned);
    if (
      tick === maxTicks ||
      (result.written === 0 && cursorsAtZero(db, "reconciliation_scan_cursor"))
    )
      return { ticks: tick, ms: Math.round(performance.now() - start), totals, maxScanned };
  }
  throw new Error("coverage: the reconciliation lane never wrapped");
}

type Category =
  | "covered"
  | "another capture"
  | "refund against purchase"
  | `not recognised: ${string}`
  | "unexplained";

let built: ScaledStore;
let db: Database;
/** What the #243 lane proposed over the store's history: digest to target refs. */
const stageB = new Map<string, string>();
/** Why each recognition key the purchase lane saw current was not recognised. */
const exclusions = new Map<string, string>();

beforeAll(async () => {
  if (FULL) {
    built = await scaledStore(FULL_SCALE);
    db = built.store.db;
    return;
  }
  built = await scaledStore(CI_SCALE, async (store, day) => {
    const now = `${day}T06:00:00.000Z`;
    for (const row of allCurrentUsage(store)) {
      const classified = classifyCardUsage(cardUsageFactOf(row));
      if (!classified.ok && row.recognition_key !== null)
        exclusions.set(row.recognition_key, classified.reasonCode);
    }
    await purchaseCycle(store, now);
    await laneCycle(store, STAGE_B_SLICES, now, { proposals: stageB });
  });
  db = built.store.db;
}, TIMEOUT);

/** Every stage B proposal the lane made, by category. */
function categorise(): Map<Category, number> {
  const candidates = new Set(
    (
      db
        .query(
          "SELECT proposal_digest AS d FROM reconciliation_proposals WHERE kind='pending_to_posted' AND stage='B'",
        )
        .all() as { d: string }[]
    ).map((row) => row.d),
  );
  const candidatePairs = new Set(
    (
      db
        .query(
          "SELECT target_refs_json AS t FROM reconciliation_proposals WHERE kind='pending_to_posted' AND stage='B'",
        )
        .all() as { t: string }[]
    ).map((row) => idsOf(row.t).join(" ")),
  );
  const keyOf = db.prepare(`SELECT json_array(fa.source_id,fr.producer_id,ses.external_id_namespace,
      t.source_account,t.external_id) AS k
    FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id
    JOIN observation_fetch_artifacts fa ON fa.id=p.fetch_artifact_id
    JOIN fetch_runs fr ON fr.id=fa.fetch_run_id
    JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id WHERE t.id=?`);
  const holder = db.prepare(`SELECT k.observation_id AS o,r.kind FROM current_card_purchase_keys k
    JOIN economic_event_revisions r ON r.event_id=k.event_id AND r.revision=k.revision
    WHERE k.recognition_key=?`);
  const counts = new Map<Category, number>();
  for (const [digest, targets] of stageB) {
    const [pending, posted] = idsOf(targets) as [number, number];
    const held = [pending, posted].map((id) => {
      const key = (keyOf.get(id) as { k: string }).k;
      return { id, key, event: holder.get(key) as { o: number; kind: string } | null };
    });
    let category: Category;
    const missing = held.find((side) => side.event === null);
    if (missing !== undefined)
      category = `not recognised: ${exclusions.get(missing.key) ?? "never current"}`;
    else if (held[0]!.event!.kind !== held[1]!.event!.kind) category = "refund against purchase";
    else if (held.every((side) => side.event!.o === side.id))
      category = candidates.has(digest) ? "covered" : "unexplained";
    else
      category = candidatePairs.has(held.map((side) => side.event!.o).join(" "))
        ? "another capture"
        : "unexplained";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return counts;
}

function idsOf(targets: string): number[] {
  return (JSON.parse(targets) as { id: string }[]).map((ref) =>
    Number(ref.id.slice("transaction:".length)),
  );
}

describe("the purchase lane's candidate pass covers the reconciliation lane's stage B", () => {
  test.skipIf(FULL)(
    "every stage B proposal of the Vpass and MyJCB slices is covered, another capture of a covered pair, or documented",
    () => {
      const counts = Object.fromEntries(categorise());
      // The numbers docs/economic-events.md ("Matching stages") quotes for this store.
      expect(counts).toEqual({
        covered: 26,
        "another capture": 151,
        "refund against purchase": 21,
        "not recognised: payment_type_unsupported": 94,
      });
      expect(stageB.size).toBe(292);
      // One candidate per purchase pair instead of one per capture pair.
      const candidates = db
        .query(
          "SELECT count(*) AS n FROM reconciliation_proposals WHERE kind='pending_to_posted' AND stage='B'",
        )
        .get() as { n: number };
      expect(candidates.n).toBe(26);
    },
    TIMEOUT,
  );

  test(
    "the deployed lane reads its pages and nothing else, and writes no proposal",
    async () => {
      const before = db.query("SELECT count(*) AS n FROM reconciliation_proposals").get();
      const sent: Sent = { groupReads: 0, lookups: 0, batches: 0 };
      // At full scale a cycle of the #243 lane takes over an hour; ten ticks
      // of each are measured there instead.
      const maxTicks = FULL ? 10 : undefined;
      const cycle = await laneCycle(db, RECONCILIATION_SLICES, "2026-09-25T00:00:00Z", {
        sent,
        maxTicks,
      });
      expect(cycle.totals.scanned).toBeGreaterThan(0);
      expect(cycle.totals).toMatchObject({
        groups: 0,
        groupsSkipped: 0,
        groupsDeferred: 0,
        proposed: 0,
        known: 0,
        written: 0,
        failed: 0,
      });
      expect(sent).toEqual({ groupReads: 0, lookups: 0, batches: 0 });
      expect(db.query("SELECT count(*) AS n FROM reconciliation_proposals").get()).toEqual(before);
      if (FULL) {
        // Before: the #243 lane's ticks over the whole store, on a proposal store of its own.
        const stageBCycle = await laneCycle(db, STAGE_B_SLICES, "2026-09-25T00:00:00Z", {
          proposals: new Map(),
          maxTicks,
        });
        console.log(
          JSON.stringify(
            {
              store: built.counts,
              stageA: { ...cycle, msPerTick: Math.round(cycle.ms / cycle.ticks) },
              stageB: { ...stageBCycle, msPerTick: Math.round(stageBCycle.ms / stageBCycle.ticks) },
            },
            null,
            2,
          ),
        );
      }
    },
    TIMEOUT,
  );
});
