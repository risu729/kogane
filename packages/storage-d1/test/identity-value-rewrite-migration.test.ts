// ADR 0030 (amended): migration 0062 stages the one-time identity-value
// rewrite and retires the crosswalk. These tests seed a store migrated through
// 0061 with synthetic importer-era and collector-era MoneyForward and Vpass
// histories, apply 0062 statement by statement, and prove that:
//
// - only the one-to-one (`unique`) MoneyForward pairs of the shared-rows rule
//   are staged: not an ambiguous pair, not a value that shares nothing, and no
//   Vpass pair (those are the owner's to insert);
// - the migration aborts, and changes nothing, while the crosswalk table holds
//   a row;
// - the validation trigger refuses a bad shape, an unknown old or new value,
//   a chain and a many-to-one pair, and admits the owner's valid Vpass pair;
// - the table and its triggers are what the committed CORE ledger says.
//
// The shared-rows rule reads `current_identity_observations`. That view needs
// the whole publication and identity-run chain, so in the rule tests it is
// replaced by a table of the same columns the rule reads, filled directly;
// services/processor/test/moneyforward-producer-switch.test.ts runs the same
// statement against the real view on a pipeline-registered store.
//
// Everything is synthetic: identity values are repeated made-up hex digits,
// and the rows are placeholders in the observed shapes.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";
import { coreDatabase, fullCoreDatabase } from "./sqlite.ts";

const MIGRATION = "0062_identity_value_rewrite_staging.sql";
const IMPORTER = "collector-r2-importer";
const MF_COLLECTOR = "collector-moneyforward-me";
const VPASS_COLLECTOR = "collector-vpass";

const mf = (version: 1 | 2, digit: string) =>
  `moneyforward-account-v${version}-${digit.repeat(64)}`;
const vpass = (version: 1 | 2, digit: string) => `vpass-card-v${version}-${digit.repeat(64)}`;

// MoneyForward: A is a clean continuation; B's old value shares rows with two
// new values (ambiguous); C shares nothing (none).
const MF_OLD_A = mf(1, "a");
const MF_NEW_A = mf(2, "b");
const MF_OLD_B = mf(1, "c");
const MF_NEW_B1 = mf(2, "d");
const MF_NEW_B2 = mf(2, "e");
const MF_NEW_C = mf(2, "f");
// Vpass: the same statement line under both eras, which the rule would pair
// if it read Vpass; 0062 does not.
const VPASS_OLD = vpass(1, "1");
const VPASS_NEW = vpass(2, "2");

function apply(db: Database, file: string) {
  db.transaction(() => {
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file))) db.run(sql);
  })();
}

interface Seed {
  runs: number;
  units: number;
  accounts: number;
  observations: number;
}

/** One fetch run of `producer` with one unit keyed by `value`. */
function unit(db: Database, seed: Seed, source: string, producer: string, value: string) {
  seed.runs += 1;
  seed.units += 1;
  db.run("INSERT INTO fetch_runs(id,source_id,producer_id) VALUES(?,?,?)", [
    seed.runs,
    source,
    producer,
  ]);
  db.run("INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,?)", [
    seed.units,
    seed.runs,
    value,
    source === "vpass" ? "card" : "account",
  ]);
}

function reference(source: string, value: string): string {
  return JSON.stringify(source === "vpass" ? ["vpass:card", value] : [`moneyforward-me:${value}`]);
}

/** The source account the identity layer files `value` under for `producer`. */
function account(
  db: Database,
  seed: Seed,
  source: string,
  producer: string,
  value: string,
): string {
  seed.accounts += 1;
  const id = `sa-${seed.accounts}`;
  db.run("INSERT INTO source_accounts VALUES(?,?,?,?)", [
    id,
    source,
    producer,
    reference(source, value),
  ]);
  return id;
}

/**
 * One current transaction observation filed under `sourceAccount`. For
 * MoneyForward the external id carries a per-era fingerprint (`era`) and the
 * rule compares the fields besides it; for Vpass it is the row itself.
 */
function row(
  db: Database,
  seed: Seed,
  sourceAccount: string,
  input: { source: string; era: string; line: number; month?: string },
) {
  seed.observations += 1;
  const month = input.month ?? "2099-02";
  const externalId =
    input.source === "vpass"
      ? `vpass-line-${input.line}`
      : `moneyforward-monthly:${input.era.repeat(32)}:${input.line}`;
  db.run(
    `INSERT INTO transaction_observations(id,parse_run_id,source_account,external_id,amount_minor,
      amount_text,amount_scale,currency,description,as_of,raw_locator,extra_json)
     VALUES(?,1,'synthetic',?,-100,'-100',0,'JPY',?,?,'row',?)`,
    [
      seed.observations,
      externalId,
      `synthetic row ${input.line}`,
      `${month}-0${input.line}`,
      JSON.stringify({ _kogane: { selectedMonth: month } }),
    ],
  );
  db.run(
    "INSERT INTO current_identity_observations(kind,observation_id,source_account_id) VALUES('transaction',?,?)",
    [seed.observations, sourceAccount],
  );
}

/** A store migrated through 0061 with the shared-rows view replaced by a table. */
function store(): { db: Database; seed: Seed } {
  const earlier = migrationFiles(CORE_MIGRATIONS_URL).filter((file) => file < MIGRATION);
  expect(earlier.at(-1)).toBe("0061_scheduled_payment_observations.sql");
  const db = coreDatabase("0017", MIGRATION);
  db.run(
    "INSERT INTO sources(id,provider) VALUES('vpass','synthetic'),('moneyforward-me','synthetic')",
  );
  db.run(
    `INSERT INTO producers(id) VALUES('${IMPORTER}'),('${MF_COLLECTOR}'),('${VPASS_COLLECTOR}')`,
  );
  db.run("DROP VIEW current_identity_observations");
  db.run(
    "CREATE TABLE current_identity_observations(kind TEXT,observation_id INTEGER,source_account_id TEXT)",
  );
  return { db, seed: { runs: 0, units: 0, accounts: 0, observations: 0 } };
}

/** Both eras of every synthetic MoneyForward and Vpass account above. */
function histories(db: Database, seed: Seed) {
  const mfSide = (producer: string, value: string) => {
    unit(db, seed, "moneyforward-me", producer, value);
    return account(db, seed, "moneyforward-me", producer, value);
  };
  const oldA = mfSide(IMPORTER, MF_OLD_A);
  const newA = mfSide(MF_COLLECTOR, MF_NEW_A);
  // A: January only the importer captured, February both.
  row(db, seed, oldA, { source: "moneyforward-me", era: "1", line: 1, month: "2099-01" });
  for (const line of [1, 2]) {
    row(db, seed, oldA, { source: "moneyforward-me", era: "1", line });
    row(db, seed, newA, { source: "moneyforward-me", era: "2", line });
  }
  const oldB = mfSide(IMPORTER, MF_OLD_B);
  const newB1 = mfSide(MF_COLLECTOR, MF_NEW_B1);
  const newB2 = mfSide(MF_COLLECTOR, MF_NEW_B2);
  for (const line of [3, 4]) row(db, seed, oldB, { source: "moneyforward-me", era: "3", line });
  row(db, seed, newB1, { source: "moneyforward-me", era: "4", line: 3 });
  row(db, seed, newB2, { source: "moneyforward-me", era: "5", line: 4 });
  const newC = mfSide(MF_COLLECTOR, MF_NEW_C);
  row(db, seed, newC, { source: "moneyforward-me", era: "6", line: 5, month: "2099-03" });

  unit(db, seed, "vpass", IMPORTER, VPASS_OLD);
  unit(db, seed, "vpass", VPASS_COLLECTOR, VPASS_NEW);
  const vpassOld = account(db, seed, "vpass", IMPORTER, VPASS_OLD);
  const vpassNew = account(db, seed, "vpass", VPASS_COLLECTOR, VPASS_NEW);
  row(db, seed, vpassOld, { source: "vpass", era: "7", line: 6 });
  row(db, seed, vpassNew, { source: "vpass", era: "7", line: 6 });
}

const staged = (db: Database) =>
  db
    .query("SELECT source_id,old_value,new_value,basis FROM identity_value_rewrites ORDER BY 1,2")
    .all();
const tableExists = (db: Database, name: string) =>
  db.query("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name=?").get(name);

describe("0062 staging", () => {
  test("stages exactly the one-to-one MoneyForward pairs of the shared-rows rule", () => {
    const { db, seed } = store();
    try {
      histories(db, seed);
      const before = {
        accounts: db.query("SELECT * FROM source_accounts ORDER BY id").all(),
        units: db.query("SELECT * FROM fetch_units ORDER BY id").all(),
        rows: db.query("SELECT * FROM transaction_observations ORDER BY id").all(),
      };
      apply(db, MIGRATION);
      // A only: B is ambiguous (one old value, two new), C shares nothing,
      // and Vpass is not read by the rule.
      expect(staged(db)).toEqual([
        {
          source_id: "moneyforward-me",
          old_value: MF_OLD_A,
          new_value: MF_NEW_A,
          basis: "shared-rows",
        },
      ]);
      // Staging writes nothing else: the evidence is as it was.
      expect({
        accounts: db.query("SELECT * FROM source_accounts ORDER BY id").all(),
        units: db.query("SELECT * FROM fetch_units ORDER BY id").all(),
        rows: db.query("SELECT * FROM transaction_observations ORDER BY id").all(),
      }).toEqual(before);
      expect(tableExists(db, "account_identity_crosswalk")).toEqual({ n: 0 });
      expect(tableExists(db, "identity_value_rewrite_0062_guard")).toEqual({ n: 0 });
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }
  }, 30_000);

  test("a pair with a competitor of another shape, or whose new value the importer carries, is not staged", () => {
    // A collector-era v1 value (a collector that held the importer's key)
    // shares A's rows: old A now shares rows with two new values. Uniqueness
    // is measured before the v1 -> v2 shape filter, so A is not staged.
    {
      const { db, seed } = store();
      try {
        histories(db, seed);
        unit(db, seed, "moneyforward-me", MF_COLLECTOR, mf(1, "5"));
        const keyed = account(db, seed, "moneyforward-me", MF_COLLECTOR, mf(1, "5"));
        row(db, seed, keyed, { source: "moneyforward-me", era: "8", line: 1 });
        apply(db, MIGRATION);
        expect(staged(db)).toEqual([]);
      } finally {
        db.close();
      }
    }
    // The importer itself carries A's new value: it is importer-era already.
    {
      const { db, seed } = store();
      try {
        histories(db, seed);
        unit(db, seed, "moneyforward-me", IMPORTER, MF_NEW_A);
        const carried = account(db, seed, "moneyforward-me", IMPORTER, MF_NEW_A);
        row(db, seed, carried, { source: "moneyforward-me", era: "9", line: 7, month: "2099-04" });
        apply(db, MIGRATION);
        expect(staged(db)).toEqual([]);
      } finally {
        db.close();
      }
    }
  }, 30_000);

  test("an empty store stages nothing and drops the crosswalk", () => {
    const { db } = store();
    try {
      apply(db, MIGRATION);
      expect(staged(db)).toEqual([]);
      expect(tableExists(db, "account_identity_crosswalk")).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 30_000);

  test("aborts, changing nothing, while the crosswalk holds a row", () => {
    const { db, seed } = store();
    try {
      histories(db, seed);
      db.run(
        "INSERT INTO account_identity_crosswalk VALUES(?,'moneyforward-me',?,?,'{}','decision-1','operation-1','human','created')",
        [`xw_${"0".repeat(64)}`, MF_OLD_A, MF_NEW_A],
      );
      const schema = db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all();
      expect(() => apply(db, MIGRATION)).toThrow("CHECK constraint failed");
      expect(db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(
        schema,
      );
      expect(db.query("SELECT count(*) AS n FROM account_identity_crosswalk").get()).toEqual({
        n: 1,
      });
      expect(tableExists(db, "identity_value_rewrites")).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("0062 validation trigger", () => {
  function staging() {
    const { db, seed } = store();
    histories(db, seed);
    apply(db, MIGRATION);
    const insert = (
      source: string,
      oldValue: string,
      newValue: string,
      basis = "owner-recomputed",
    ) =>
      db.run("INSERT INTO identity_value_rewrites VALUES(?,?,?,?)", [
        source,
        oldValue,
        newValue,
        basis,
      ]);
    return { db, seed, insert };
  }

  test("admits the owner's Vpass pair of an importer-era and a collector-era token", () => {
    const { db, insert } = staging();
    try {
      insert("vpass", VPASS_OLD, VPASS_NEW);
      expect(staged(db)).toContainEqual({
        source_id: "vpass",
        old_value: VPASS_OLD,
        new_value: VPASS_NEW,
        basis: "owner-recomputed",
      });
    } finally {
      db.close();
    }
  }, 30_000);

  test("refuses a bad shape, source or basis", () => {
    const { db, insert } = staging();
    try {
      for (const [source, oldValue, newValue, basis] of [
        ["vpass", VPASS_NEW, VPASS_OLD, "owner-recomputed"],
        ["vpass", VPASS_OLD, vpass(1, "3"), "owner-recomputed"],
        ["vpass", `vpass-card-v1-${"A".repeat(64)}`, VPASS_NEW, "owner-recomputed"],
        ["vpass", `vpass-card-v1-${"1".repeat(63)}`, VPASS_NEW, "owner-recomputed"],
        ["vpass", `vpass-card-v3-${"1".repeat(64)}`, VPASS_NEW, "owner-recomputed"],
        ["vpass", MF_OLD_A, VPASS_NEW, "owner-recomputed"],
        ["moneyforward-me", VPASS_OLD, VPASS_NEW, "owner-recomputed"],
        ["mizuho-bank", VPASS_OLD, VPASS_NEW, "owner-recomputed"],
        ["vpass", VPASS_OLD, VPASS_NEW, "guessed"],
      ] as const)
        expect(() => insert(source, oldValue, newValue, basis)).toThrow();
      expect(staged(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 30_000);

  test("refuses an old value the importer does not carry and a new value it does or nothing carries", () => {
    const { db, seed, insert } = staging();
    try {
      // Unknown old value: no importer source account or fetch unit.
      expect(() => insert("vpass", vpass(1, "9"), VPASS_NEW)).toThrow(
        "identity_value_rewrite_old_unknown",
      );
      // An importer fetch unit without the importer's source account.
      unit(db, seed, "vpass", IMPORTER, vpass(1, "8"));
      expect(() => insert("vpass", vpass(1, "8"), VPASS_NEW)).toThrow(
        "identity_value_rewrite_old_unknown",
      );
      // An importer source account without an importer fetch unit.
      account(db, seed, "vpass", IMPORTER, vpass(1, "7"));
      expect(() => insert("vpass", vpass(1, "7"), VPASS_NEW)).toThrow(
        "identity_value_rewrite_old_unknown",
      );
      // A new value no collector fetch unit carries.
      expect(() => insert("vpass", VPASS_OLD, vpass(2, "9"))).toThrow(
        "identity_value_rewrite_new_unknown",
      );
      // A new value the importer carries is importer-era, not new.
      unit(db, seed, "vpass", VPASS_COLLECTOR, vpass(2, "6"));
      unit(db, seed, "vpass", IMPORTER, vpass(2, "6"));
      account(db, seed, "vpass", IMPORTER, vpass(2, "6"));
      expect(() => insert("vpass", VPASS_OLD, vpass(2, "6"))).toThrow(
        "identity_value_rewrite_new_unknown",
      );
      // Values of the other source are unknown here.
      expect(() => insert("moneyforward-me", MF_OLD_B, VPASS_NEW)).toThrow();
      expect(staged(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 30_000);

  test("refuses many-to-one pairs and chains", () => {
    const { db, seed, insert } = staging();
    try {
      // B's values are known and unstaged: pair B1 with old B by hand.
      insert("moneyforward-me", MF_OLD_B, MF_NEW_B1);
      // One old value to a second new value, and a second old value to a
      // new value already staged.
      expect(() => insert("moneyforward-me", MF_OLD_B, MF_NEW_B2)).toThrow(
        "identity_value_rewrite_not_one_to_one",
      );
      unit(db, seed, "moneyforward-me", IMPORTER, mf(1, "9"));
      account(db, seed, "moneyforward-me", IMPORTER, mf(1, "9"));
      expect(() => insert("moneyforward-me", mf(1, "9"), MF_NEW_B1)).toThrow(
        "identity_value_rewrite_not_one_to_one",
      );
      expect(() => insert("moneyforward-me", mf(1, "9"), MF_NEW_A)).toThrow(
        "identity_value_rewrite_not_one_to_one",
      );
      // A chain (b -> c after a -> b) needs a staged new value as an old one,
      // which is v2 and so neither importer-era nor of the old shape.
      expect(() => insert("moneyforward-me", MF_NEW_A, MF_NEW_C)).toThrow();
      expect(() => insert("moneyforward-me", MF_NEW_C, MF_OLD_A)).toThrow();
      expect(staged(db)).toEqual([
        {
          source_id: "moneyforward-me",
          old_value: MF_OLD_A,
          new_value: MF_NEW_A,
          basis: "shared-rows",
        },
        {
          source_id: "moneyforward-me",
          old_value: MF_OLD_B,
          new_value: MF_NEW_B1,
          basis: "owner-recomputed",
        },
      ]);
    } finally {
      db.close();
    }
  }, 30_000);
});

test("the staging table and its triggers are what the committed CORE ledger records", () => {
  const ledger = JSON.parse(
    readFileSync(new URL("../../../infra/schema/core-ledger.json", import.meta.url), "utf8"),
  ) as {
    tables: { name: string; classification: string; sqlSha256: string; triggers: string[] }[];
    triggers: { name: string; table: string; sqlSha256: string }[];
  };
  const digest = (sql: string) => createHash("sha256").update(sql).digest("hex").slice(0, 16);
  const db = fullCoreDatabase();
  try {
    const objects = db
      .query(
        "SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN ('identity_value_rewrites','account_identity_crosswalk') ORDER BY name",
      )
      .all() as { type: string; name: string; sql: string | null }[];
    const table = ledger.tables.find((entry) => entry.name === "identity_value_rewrites")!;
    expect(table.classification).toBe("operational-mutable");
    expect(ledger.tables.some((entry) => entry.name === "account_identity_crosswalk")).toBe(false);
    expect(objects.filter((object) => object.type === "table")).toEqual([
      { type: "table", name: "identity_value_rewrites", sql: expect.any(String) },
    ]);
    expect(digest(objects.find((object) => object.type === "table")!.sql!)).toBe(table.sqlSha256);
    const triggers = objects.filter((object) => object.type === "trigger");
    expect(triggers.map((trigger) => trigger.name)).toEqual(table.triggers);
    for (const trigger of triggers)
      expect(digest(trigger.sql!)).toBe(
        ledger.triggers.find((entry) => entry.name === trigger.name)!.sqlSha256,
      );
  } finally {
    db.close();
  }
}, 30_000);
