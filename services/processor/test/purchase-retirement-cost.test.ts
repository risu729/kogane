import { Database } from "bun:sqlite";
import { beforeAll, afterAll, expect, test } from "bun:test";
import { STALE_CARD_PURCHASE_KEYS_SQL } from "../../../packages/read-model/src/card-purchase-keys";
import { scaledStore, CI_SCALE } from "../../../packages/read-model/test/card-usage-scale-fixture";
import { cardPurchaseSweep } from "../src/card-purchase-job";
import { sweepDb } from "./sweep-cost-d1";

let base: Database;
beforeAll(async () => {
  base = (
    await scaledStore({
      ...CI_SCALE,
      dailyDays: 3,
      monthlyMonths: 1,
      cards: 1,
      postedMonths: 1,
      pages: [1, 1],
      rowsPerPage: [3, 5],
      bankRows: 3,
    })
  ).store.db;
}, 60000);
afterAll(() => base.close());
const copy = () => {
  const db = Database.deserialize(base.serialize());
  db.exec("PRAGMA foreign_keys=ON");
  return db;
};
const NOW = "2026-10-04T00:00:00.000Z";
const staleSql = (sql: string) => sql === STALE_CARD_PURCHASE_KEYS_SQL;
type Check = { revision: number; clean_revision: number | null; checking_revision: number | null };
const check = (db: Database) =>
  db
    .query("SELECT revision,clean_revision,checking_revision FROM card_purchase_retirement_check")
    .get() as Check;
async function settle(db: Database) {
  for (let tick = 0; tick < 20; tick++) {
    await cardPurchaseSweep(sweepDb(db), { now: NOW });
    if (check(db).revision === check(db).clean_revision) return;
  }
  throw new Error("retirement proof did not settle");
}

test("the no-statistics bytecode dependency closure is covered by direct triggers or the existing source revision ledger", () => {
  const db = copy();
  try {
    const pages = new Map(
      (
        db.query("SELECT rootpage,tbl_name FROM sqlite_master WHERE rootpage>0").all() as {
          rootpage: number;
          tbl_name: string;
        }[]
      ).map((row) => [row.rootpage, row.tbl_name]),
    );
    const dependencies = new Set(
      (
        db.query("EXPLAIN " + STALE_CARD_PURCHASE_KEYS_SQL).all(0, -1, 100) as {
          opcode: string;
          p2: number;
        }[]
      )
        .filter((row) => row.opcode === "OpenRead")
        .map((row) => pages.get(row.p2)),
    );
    expect(dependencies.size).toBeGreaterThan(20);
    const triggers = db
      .query("SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger'")
      .all() as { tbl_name: string; sql: string }[];
    for (const dependency of dependencies)
      for (const action of ["INSERT", "UPDATE", "DELETE"])
        expect(
          triggers.some(
            (row) =>
              row.tbl_name === dependency &&
              row.sql.includes(`AFTER ${action} ON ${dependency}`) &&
              /UPDATE (core_source_revision|card_purchase_retirement_check) /.test(row.sql),
          ),
        ).toBe(true);
    expect(
      triggers.some(
        (row) =>
          row.tbl_name === "core_source_revision" &&
          row.sql.includes("AFTER UPDATE ON core_source_revision") &&
          row.sql.includes("UPDATE card_purchase_retirement_check"),
      ),
    ).toBe(true);
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("unchanged ticks skip the full retirement set while recognition and candidates continue; low-id publication and epoch changes invalidate", async () => {
  const db = copy();
  try {
    await settle(db);
    const sqls: string[] = [];
    const count = sweepDb(db, (sql) => {
      sqls.push(sql);
      return sql;
    });
    const before = check(db);
    for (let tick = 0; tick < 3; tick++) await cardPurchaseSweep(count, { now: NOW });
    expect(sqls.filter(staleSql)).toHaveLength(0);
    expect(
      sqls.some((sql) => sql.includes("FROM keyed") && sql.includes("observation_id > ?1")),
    ).toBe(true);
    expect(check(db)).toEqual(before);
    // Same count, same maximum id; a low-id adopted pointer UPDATE still invalidates.
    db.run(
      "UPDATE published_parse_runs SET published_at=published_at WHERE parse_run_id=(SELECT min(parse_run_id) FROM published_parse_runs)",
    );
    expect(check(db).revision).toBeGreaterThan(before.revision);
    sqls.length = 0;
    await cardPurchaseSweep(count, { now: NOW });
    expect(sqls.filter(staleSql)).toHaveLength(1);
    await settle(db);
    db.run("UPDATE card_purchase_retirement_check SET clean_policy='old-contract'");
    sqls.length = 0;
    await cardPurchaseSweep(count, { now: NOW });
    expect(sqls.filter(staleSql)).toHaveLength(1);
    expect(
      (
        db.query("SELECT clean_policy FROM card_purchase_retirement_check").get() as {
          clean_policy: string;
        }
      ).clean_policy,
    ).toBe("card-purchase-retirement-v1");
    await settle(db);
    db.run("UPDATE core_source_revision SET core_epoch='synthetic-restored' WHERE id=1");
    expect(check(db).revision).not.toBe(check(db).clean_revision);
  } finally {
    db.close();
  }
});

test("overlapping empty reads cannot certify clean after a mutation; dirty intervals latch writes", async () => {
  const db = copy();
  try {
    await settle(db);
    db.run("UPDATE core_source_revision SET source_revision=source_revision+1");
    const dirty = check(db).revision;
    for (let i = 0; i < 5; i++)
      db.run("UPDATE core_source_revision SET source_revision=source_revision+1");
    expect(check(db).revision).toBe(dirty);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const both = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const raced = sweepDb(
      db,
      (sql) => sql,
      async (sql) => {
        if (!staleSql(sql)) return;
        reads++;
        if (reads === 2) arrived();
        await gate;
      },
    );
    const first = cardPurchaseSweep(raced, { now: NOW }),
      second = cardPurchaseSweep(raced, { now: NOW });
    await both;
    expect(check(db).checking_revision).toBe(dirty);
    db.run("UPDATE core_source_revision SET source_revision=source_revision+1");
    expect(check(db).revision).toBe(dirty + 1);
    release();
    await Promise.all([first, second]);
    expect(check(db).clean_revision).not.toBe(check(db).revision);
    await settle(db);
    expect(check(db).clean_revision).toBe(check(db).revision);
  } finally {
    db.close();
  }
});

test("nonempty retirement pages never mark clean, including full deferred pages and rejected batches", async () => {
  const db = copy();
  try {
    const result = await cardPurchaseSweep(sweepDb(db), { now: NOW, retireLimit: 1 });
    expect(result.retired).toBe(1);
    expect(result.deferred).toBe(true);
    expect(check(db).revision).not.toBe(check(db).clean_revision);
    const good = sweepDb(db);
    const failing = {
      prepare: good.prepare.bind(good),
      async batch() {
        throw new Error("synthetic failure");
      },
    } as unknown as D1Database;
    for (let tick = 0; tick < 2; tick++) {
      const failed = await cardPurchaseSweep(failing, { now: NOW, retireLimit: 1 });
      expect(failed.failed).toBeGreaterThan(0);
      expect(failed.deferred).toBe(false);
      expect(check(db).revision).not.toBe(check(db).clean_revision);
    }
    await settle(db);
  } finally {
    db.close();
  }
});

test("the unchanged retirement guard costs a primary-key read instead of the scaled current-set recomputation", async () => {
  const built = await scaledStore(CI_SCALE);
  const db = built.store.db;
  try {
    await settle(db);
    const sql =
      "SELECT revision,clean_revision FROM card_purchase_retirement_check WHERE singleton=1";
    const plan = db.query("EXPLAIN QUERY PLAN " + sql).all() as { detail: string }[];
    expect(plan).toHaveLength(1);
    expect(plan[0]!.detail).toContain("USING INTEGER PRIMARY KEY");
    const measure = (query: string, args: (number | string)[]) => {
      const start = performance.now();
      for (let i = 0; i < 10; i++) db.query(query).all(...args);
      return performance.now() - start;
    };
    expect(db.query(STALE_CARD_PURCHASE_KEYS_SQL).all(0, -1, 100)).toEqual([]);
    console.log("synthetic unchanged retirement cost", {
      observations: built.counts.transactionObservations,
      shippedMs: measure(STALE_CARD_PURCHASE_KEYS_SQL, [0, -1, 100]),
      guardMs: measure(sql, []),
    });
  } finally {
    db.close();
  }
}, 60000);
