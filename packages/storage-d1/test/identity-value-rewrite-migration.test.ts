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
// Then that migration 0063, on a store migrated through 0062 with a Vpass card
// and a MoneyForward account of both eras staged, rewrites exactly the five
// identity columns of the importer's rows and appends one mapping revision
// per collector source account of a staged value, leaves every other row,
// id, derived identity read and schema object as it was, drops only the
// staging table, and aborts without changing anything when a guard fails.
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
import { IDENTITY_AUDIT_QUERIES } from "../src/core/identity-audit.ts";
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

// ---------------------------------------------------------------------------
// 0063: the rewrite. A store migrated through 0062 holds both eras of one
// Vpass card and one MoneyForward account, through the real trusted-binding,
// publication and identity-run chain of the stub, plus an unpaired collector
// value; the pairs are staged as the owner stages them, and 0063 is applied
// statement by statement in one transaction, as D1 applies a migration.
// ---------------------------------------------------------------------------

const REWRITE = "0063_identity_value_rewrite_apply.sql";
const VPASS_NAMESPACE = "vpass-worker-card-v1";
const MF_OTHER = mf(2, "9");
/** The five columns 0063 rewrites (ADR 0030 amendment), and nothing else. */
const REWRITTEN = [
  "account_connection_reviews.connection_key",
  "fetch_units.unit_key",
  "identity_vpass_bindings.card_token",
  "source_accounts.reference_json",
  "transaction_observations.source_account",
];
const PAIRS = [
  [VPASS_OLD, VPASS_NEW],
  [MF_OLD_A, MF_NEW_A],
] as const;
const rewrite = (value: unknown) =>
  typeof value === "string"
    ? PAIRS.reduce((text, [from, to]) => text.split(from).join(to), value)
    : value;
/** The Layer A append-only guard of `fetch_units` (0001), which the stub omits. */
const FETCH_UNITS_GUARD = splitSqlStatements(
  migrationSql(CORE_MIGRATIONS_URL, "0001_initial.sql"),
).find((sql) => sql.startsWith("CREATE TRIGGER fetch_units_no_update"))!;

interface World {
  db: Database;
  /** Source-account ids by role. */
  sa: Record<"vpassOld" | "vpassNew" | "mfOld" | "mfNew" | "mfOther", string>;
  /** Account entities by role. */
  entity: Record<"vpassOld" | "vpassNew" | "mfOld" | "mfNew" | "mfOther", string>;
}

/** A synthetic 64-hex id with `prefix`, distinct per `n`. */
const opaque = (prefix: string, n: number) => `${prefix}_${n.toString(16).padStart(64, "0")}`;

function rewriteWorld(): World {
  expect(
    migrationFiles(CORE_MIGRATIONS_URL)
      .filter((file) => file < REWRITE)
      .at(-1),
  ).toBe(MIGRATION);
  const db = coreDatabase("0017", REWRITE);
  db.exec("PRAGMA foreign_keys=ON");
  db.run(FETCH_UNITS_GUARD);
  db.run(
    "INSERT INTO sources(id,provider) VALUES('vpass','synthetic'),('moneyforward-me','synthetic')",
  );
  db.run(
    `INSERT INTO producers(id) VALUES('${IMPORTER}'),('${MF_COLLECTOR}'),('${VPASS_COLLECTOR}')`,
  );
  let sequence = 0;
  const next = () => (sequence += 1);
  const at = "2026-09-01T00:00:00.000Z";

  /** A sealed successful run of `producer` in its own session. */
  const run = (source: string, producer: string, namespace = "synthetic", key = "default") => {
    const id = next();
    db.run(
      "INSERT INTO acquisition_sessions(id,external_session_id,producer_id,external_id_namespace) VALUES(?,?,?,?)",
      [id, `session-${id}`, producer, namespace],
    );
    db.run(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms,source_run_key) VALUES(?,?,?,?,0,?)",
      [id, source, id, producer, key],
    );
    db.run("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)", [id]);
    db.run("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)", [id]);
    return id;
  };
  const unit = (runId: number, key: string, kind: string) => {
    const id = next();
    db.run("INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,?)", [
      id,
      runId,
      key,
      kind,
    ]);
    db.run("INSERT INTO fetch_unit_reports VALUES(?,'terminal','success',NULL)", [id]);
    return id;
  };
  const artifact = (
    runId: number,
    source: string,
    dataset: string,
    key: string,
    unitId: number,
  ) => {
    const id = next();
    db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role)
       VALUES(?,?,?,?,?,?,'application/json',0,0,?,'provider_response')`,
      [id, runId, source, dataset, key, unitId, id.toString(16).padStart(64, "0")],
    );
    return id;
  };
  /** A published `ok` parse of `artifactId` with one transaction row per line. */
  const parse = (artifactId: number, sourceAccount: string, lines: number) => {
    const id = next();
    db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic','1',?,'pending','[]')",
      [id, artifactId, at],
    );
    const rows: number[] = [];
    for (let line = 1; line <= lines; line += 1)
      rows.push(
        Number(
          db.run(
            `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,amount_minor,amount_text,amount_scale,currency,description,as_of,raw_locator,extra_json)
             VALUES(?,?,?,-100,'-100',0,'JPY','synthetic row','2099-02-03','row','{}')`,
            [id, sourceAccount, `synthetic-${id}-${line}`],
          ).lastInsertRowid,
        ),
      );
    db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [id]);
    db.run(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,'synthetic',NULL,?,'normal','pipeline','parse_ok',?)",
      [artifactId, id, at],
    );
    db.run(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,'synthetic',?,'1',?,'normal')",
      [artifactId, id, at],
    );
    return { parse: id, rows };
  };
  const sourceAccount = (source: string, producer: string, key: string[]) => {
    const id = opaque("sa", next());
    db.run("INSERT INTO source_accounts VALUES(?,?,?,?)", [
      id,
      source,
      producer,
      JSON.stringify(key),
    ]);
    const entity = opaque("account", next());
    db.run("INSERT INTO accounts VALUES(?,'synthetic','card-statement','provider-local')", [
      entity,
    ]);
    db.run(
      "INSERT INTO account_mappings VALUES(?,?,1,?,'rule','synthetic',1,?,'synthetic','provider-local')",
      [opaque("am", next()), id, entity, at],
    );
    return { id, entity };
  };
  /** A sealed identity run over `parsed`, every row filed under `sa`. */
  const identify = (
    parsed: { parse: number; rows: number[] },
    sa: string,
    pin?: { unit: number; binding: number; token: string },
  ) => {
    const id = `ir-${parsed.parse}`;
    db.run("INSERT INTO identity_runs VALUES(?,?,?,?)", [id, parsed.parse, pin ? 2 : 1, at]);
    db.run("INSERT INTO identity_run_policies VALUES(?,?,?,?,?,?)", [
      id,
      parsed.parse,
      pin ? "vpass-card-binding" : "identity-default",
      pin ? "vpass-card-binding-v2" : "identity-default-v1",
      "c".repeat(64),
      JSON.stringify(
        pin
          ? [
              {
                kind: "trusted-vpass-card-binding",
                financialUnitId: pin.unit,
                bindingArtifactId: pin.binding,
                cardToken: pin.token,
              },
            ]
          : [],
      ),
    ]);
    if (pin)
      db.run("INSERT INTO identity_vpass_bindings VALUES(?,?,?,?)", [
        id,
        pin.unit,
        pin.binding,
        pin.token,
      ]);
    const mapping = (
      db.query("SELECT id FROM current_account_mappings WHERE source_account_id=?").get(sa) as {
        id: string;
      }
    ).id;
    for (const row of parsed.rows)
      db.run("INSERT INTO identity_observations VALUES(?,?,'transaction',?,?,?,'[]')", [
        `io-${id}-${row}`,
        id,
        row,
        sa,
        mapping,
      ]);
    db.run("INSERT INTO identity_run_seals VALUES(?,?,?)", [id, parsed.rows.length, at]);
  };

  // Vpass, importer era: a statement run whose card ordinal the importer's
  // sidecar binding run keyed by the v1 token (the trusted binding of 0020).
  const financial = run("vpass", IMPORTER, VPASS_NAMESPACE);
  const card = unit(financial, "card-001", "card");
  const statement = artifact(financial, "vpass", "statement-page", "cards/card-001/p.json", card);
  const bindingRun = next();
  db.run(
    "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms,source_run_key) VALUES(?,'vpass',?,?,0,'card-001-vpass-card-binding-v1')",
    [bindingRun, financial, IMPORTER],
  );
  db.run("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)", [bindingRun]);
  db.run("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)", [bindingRun]);
  const tokenUnit = unit(bindingRun, VPASS_OLD, "card");
  const binding = next();
  db.run(
    `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,artifact_role,format_id,format_version)
     VALUES(?,?,'vpass','card-identity-binding','card-identity-binding.json',?,'collector_derived','vpass-card-identity-binding-json','1')`,
    [binding, bindingRun, tokenUnit],
  );
  const vpassOld = sourceAccount("vpass", IMPORTER, ["vpass:card", VPASS_OLD]);
  identify(parse(statement, "vpass:card-001", 2), vpassOld.id, {
    unit: card,
    binding,
    token: VPASS_OLD,
  });
  // Vpass, collector era: a unit keyed by the v2 token and the collector's
  // source account for it (no collector-era statement row is parsed).
  unit(run("vpass", VPASS_COLLECTOR), VPASS_NEW, "card");
  const vpassNew = sourceAccount("vpass", VPASS_COLLECTOR, ["vpass:card", VPASS_NEW]);

  // MoneyForward: the importer's and the collector's captures of one account,
  // each with its account-detail page and an unresolved connection review,
  // and a collector-only account that is not staged.
  const mfSide = (producer: string, value: string) => {
    const runId = run("moneyforward-me", producer);
    const account = unit(runId, value, "account");
    const detail = artifact(runId, "moneyforward-me", "account-detail", "detail.html", account);
    const month = artifact(runId, "moneyforward-me", "monthly-transactions", "m.html", account);
    const sa = sourceAccount("moneyforward-me", producer, [`moneyforward-me:${value}`]);
    identify(parse(month, `moneyforward-me:${value}`, 2), sa.id);
    db.run(
      `INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,reason,verifier_version,detail_artifact_id,direct_reference_ids_json,created_at)
       VALUES(?,?,1,'synthetic','unresolved','synthetic','1',?,'[]',?)`,
      [producer, value, detail, at],
    );
    return sa;
  };
  const mfOld = mfSide(IMPORTER, MF_OLD_A);
  const mfNew = mfSide(MF_COLLECTOR, MF_NEW_A);
  const mfOther = mfSide(MF_COLLECTOR, MF_OTHER);
  return {
    db,
    sa: {
      vpassOld: vpassOld.id,
      vpassNew: vpassNew.id,
      mfOld: mfOld.id,
      mfNew: mfNew.id,
      mfOther: mfOther.id,
    },
    entity: {
      vpassOld: vpassOld.entity,
      vpassNew: vpassNew.entity,
      mfOld: mfOld.entity,
      mfNew: mfNew.entity,
      mfOther: mfOther.entity,
    },
  };
}

/** Stages the two pairs the way the owner's stage reads in production. */
function stageBoth(db: Database) {
  db.run("INSERT INTO identity_value_rewrites VALUES('moneyforward-me',?,?,'shared-rows')", [
    MF_OLD_A,
    MF_NEW_A,
  ]);
  db.run("INSERT INTO identity_value_rewrites VALUES('vpass',?,?,'owner-recomputed')", [
    VPASS_OLD,
    VPASS_NEW,
  ]);
}

type Row = Record<string, unknown>;
/** Every row of every table, keyed by table then rowid. */
function tables(db: Database): Map<string, Map<number, Row>> {
  const names = (
    db
      .query(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return new Map(
    names.map((name) => [
      name,
      new Map(
        (db.query(`SELECT rowid AS _rowid_,* FROM "${name}" ORDER BY rowid`).all() as Row[]).map(
          (row) => {
            const { _rowid_: rowid, ...rest } = row;
            return [rowid as number, rest];
          },
        ),
      ),
    ]),
  );
}
const schema = (db: Database) =>
  db
    .query(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name<>'identity_value_rewrites' ORDER BY type,name",
    )
    .all();
/** The derived identity reads and the aggregate identity audit. */
const reads = (db: Database) => ({
  eligible: db.query("SELECT * FROM eligible_identity_runs ORDER BY id").all(),
  current: db
    .query("SELECT * FROM current_identity_observations ORDER BY identity_run_id,observation_id")
    .all(),
  trusted: db
    .query("SELECT * FROM trusted_vpass_card_bindings ORDER BY financial_artifact_id")
    .all()
    .map((row) => ({ ...(row as Row), card_token: rewrite((row as Row).card_token) })),
  audit: IDENTITY_AUDIT_QUERIES.map((query) => [query.name, db.query(query.sql).all()]),
});
/** Every text cell holding a staged old value, as `table.column`. */
function oldValueCells(db: Database, values: readonly string[]): string[] {
  const found: string[] = [];
  for (const [table, rows] of tables(db))
    for (const row of rows.values())
      for (const [column, value] of Object.entries(row))
        if (typeof value === "string" && values.some((old) => value.includes(old)))
          found.push(`${table}.${column}`);
  return [...new Set(found)].sort();
}

describe("0063 rewrite", () => {
  test("rewrites the five columns of the importer's rows and changes nothing else", () => {
    const world = rewriteWorld();
    const { db } = world;
    try {
      stageBoth(db);
      const before = tables(db);
      const beforeSchema = schema(db);
      const beforeReads = reads(db);
      const revision = db.query("SELECT * FROM core_source_revision").get() as Row;
      apply(db, REWRITE);
      const after = tables(db);

      // Row counts: every table the same, but account_mappings (one revision
      // per collector source account of a staged new value) and the dropped
      // staging table.
      expect([...after.keys()]).toEqual(
        [...before.keys()].filter((name) => name !== "identity_value_rewrites"),
      );
      const changed = new Set<string>();
      for (const [table, rows] of after) {
        const previous = before.get(table)!;
        if (table === "account_mappings") {
          expect(rows.size).toBe(previous.size + 2);
          continue;
        }
        if (table === "core_source_revision") continue;
        // Same rowids, so the same primary keys and hashed ids.
        expect([table, [...rows.keys()]]).toEqual([table, [...previous.keys()]]);
        for (const [rowid, row] of rows) {
          const old = previous.get(rowid)!;
          for (const [column, value] of Object.entries(row)) {
            if (value === old[column]) continue;
            changed.add(`${table}.${column}`);
            // A changed cell is one of the five columns, and it is exactly
            // the old cell with the staged old value replaced by the new one.
            expect(REWRITTEN).toContain(`${table}.${column}`);
            expect(value).toBe(rewrite(old[column]));
          }
        }
      }
      expect([...changed].sort()).toEqual(REWRITTEN);
      // The rows of the importer only: the collector's rows are untouched.
      expect(after.get("fetch_units")!.size).toBe(before.get("fetch_units")!.size);
      expect(
        db
          .query(
            "SELECT producer_id,reference_json FROM source_accounts WHERE id IN (?,?) ORDER BY source_id",
          )
          .all(world.sa.mfOld, world.sa.vpassOld),
      ).toEqual([
        // Exactly the JSON the identity store writes (`JSON.stringify`).
        { producer_id: IMPORTER, reference_json: JSON.stringify([`moneyforward-me:${MF_NEW_A}`]) },
        { producer_id: IMPORTER, reference_json: JSON.stringify(["vpass:card", VPASS_NEW]) },
      ]);
      // The mapping revisions appended: each collector source account of a
      // staged new value, re-pointed to the importer-era entity as a rule
      // with the current revision's policy version, label and status.
      const previousMappings = new Set(
        [...before.get("account_mappings")!.values()].map((row) => row.id),
      );
      expect(
        [...after.get("account_mappings")!.values()]
          .filter((row) => !previousMappings.has(row.id))
          .map(({ created_at: _created, ...row }) => row)
          .sort((a, b) => String(a.source_account_id).localeCompare(String(b.source_account_id))),
      ).toEqual(
        (
          [
            [world.sa.mfNew, world.entity.mfOld],
            [world.sa.vpassNew, world.entity.vpassOld],
          ] as const
        )
          .map(([sa, entity]) => {
            const current = db
              .query("SELECT id FROM account_mappings WHERE source_account_id=? AND revision=1")
              .get(sa) as { id: string };
            return {
              id: `${current.id}-r2`,
              source_account_id: sa,
              revision: 2,
              account_id: entity,
              method: "rule",
              reason: "identity-value-rewrite",
              policy_version: 1,
              label: "synthetic",
              status: "provider-local",
            };
          })
          .sort((a, b) => a.source_account_id!.localeCompare(b.source_account_id!)),
      );
      // The revision counter moved, so read snapshots are rebuilt.
      expect(
        (db.query("SELECT source_revision FROM core_source_revision").get() as Row).source_revision,
      ).toBeGreaterThan(revision.source_revision as number);

      // No staged old value remains, except where the ADR keeps it: the
      // identity run policies' dependency JSON (and digest) stay as recorded.
      expect(oldValueCells(db, [VPASS_OLD, MF_OLD_A])).toEqual([
        "identity_run_policies.dependency_set_json",
      ]);
      // Every guard is back with its exact text, and the staging table is gone.
      expect(schema(db)).toEqual(beforeSchema);
      expect(tableExists(db, "identity_value_rewrites")).toEqual({ n: 0 });
      expect(() => db.run("UPDATE fetch_units SET unit_kind=unit_kind")).toThrow(
        "fetch_units is append-only",
      );
      // The derived identity reads are what they were (the trusted binding
      // with its token now v2) and the aggregate audit is unchanged.
      expect(reads(db)).toEqual(beforeReads);
      // Every current observation of a pair resolves to the importer-era
      // entity; the unpaired value keeps its own; the collector-era entities
      // stay in accounts with no current mapping.
      expect(
        db
          .query(
            `SELECT DISTINCT s.reference_json,m.account_id FROM current_identity_observations o
              JOIN source_accounts s ON s.id=o.source_account_id
              JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
             ORDER BY 1`,
          )
          .all(),
      ).toEqual(
        [
          {
            reference_json: JSON.stringify([`moneyforward-me:${MF_NEW_A}`]),
            account_id: world.entity.mfOld,
          },
          {
            reference_json: JSON.stringify([`moneyforward-me:${MF_OTHER}`]),
            account_id: world.entity.mfOther,
          },
          {
            reference_json: JSON.stringify(["vpass:card", VPASS_NEW]),
            account_id: world.entity.vpassOld,
          },
        ].sort((a, b) => a.reference_json.localeCompare(b.reference_json)),
      );
      expect(
        db
          .query("SELECT count(*) AS n FROM current_account_mappings WHERE account_id IN (?,?)")
          .get(world.entity.mfNew, world.entity.vpassNew),
      ).toEqual({ n: 0 });
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  }, 30_000);

  test("an empty stage changes nothing but the staging table", () => {
    const { db } = rewriteWorld();
    try {
      const before = tables(db);
      const beforeSchema = schema(db);
      apply(db, REWRITE);
      before.delete("identity_value_rewrites");
      expect(tables(db)).toEqual(before);
      expect(schema(db)).toEqual(beforeSchema);
      expect(tableExists(db, "identity_value_rewrites")).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 30_000);

  /** Applies 0063 expecting `code`, then proves nothing of it applied. */
  function aborts(db: Database, code: string) {
    const before = tables(db);
    const beforeSchema = db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all();
    expect(() => apply(db, REWRITE)).toThrow(code);
    expect(tables(db)).toEqual(before);
    expect(db.query("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(
      beforeSchema,
    );
  }

  test("a manual or protected mapping on a collector source account of a staged new value aborts it", () => {
    // A manual revision (a protected subject while no decision releases it).
    {
      const world = rewriteWorld();
      try {
        stageBoth(world.db);
        world.db.run(
          "INSERT INTO account_mappings VALUES(?,?,2,?,'manual','synthetic',1,'2026-09-02','synthetic','provider-local')",
          [opaque("am", 9001), world.sa.mfNew, world.entity.mfNew],
        );
        aborts(world.db, "identity_value_rewrite_mapping_held");
      } finally {
        world.db.close();
      }
    }
    // An active override (a manual revision its assign decision describes)
    // with a later rule revision on top: current is a rule, still protected.
    {
      const world = rewriteWorld();
      try {
        stageBoth(world.db);
        world.db.run(
          "INSERT INTO account_mappings VALUES(?,?,2,?,'manual','synthetic',1,'2026-09-02','synthetic','provider-local')",
          [opaque("am", 9003), world.sa.vpassNew, world.entity.vpassNew],
        );
        world.db.run(
          `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
           VALUES('dr-synthetic','account_mapping',?,2,'assign','legacy-migration','synthetic',NULL,'synthetic','[]',1,NULL,'2026-09-02')`,
          [world.sa.vpassNew],
        );
        world.db.run(
          "INSERT INTO account_mappings VALUES(?,?,3,?,'rule','synthetic',1,'2026-09-03','synthetic','provider-local')",
          [opaque("am", 9004), world.sa.vpassNew, world.entity.vpassNew],
        );
        expect(
          world.db
            .query("SELECT method FROM current_account_mappings WHERE source_account_id=?")
            .get(world.sa.vpassNew),
        ).toEqual({ method: "rule" });
        aborts(world.db, "identity_value_rewrite_mapping_held");
      } finally {
        world.db.close();
      }
    }
  }, 30_000);

  test("a pair no longer valid, or an old value left outside the five columns, aborts it", () => {
    // After staging, the importer came to carry the new value too.
    {
      const world = rewriteWorld();
      try {
        stageBoth(world.db);
        world.db.run("INSERT INTO source_accounts VALUES(?,'moneyforward-me',?,?)", [
          opaque("sa", 9002),
          IMPORTER,
          JSON.stringify([`moneyforward-me:${MF_NEW_A}`]),
        ]);
        aborts(world.db, "identity_value_rewrite_stage_invalid");
      } finally {
        world.db.close();
      }
    }
    // A MoneyForward balance row under the old value: outside the rewrite.
    {
      const world = rewriteWorld();
      try {
        stageBoth(world.db);
        const parse = world.db
          .query("SELECT parse_run_id AS id FROM transaction_observations WHERE source_account=?")
          .get(`moneyforward-me:${MF_OLD_A}`) as { id: number };
        world.db.run(
          "INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json) VALUES(?,?,'synthetic','JPY','row','{}')",
          [parse.id, `moneyforward-me:${MF_OLD_A}`],
        );
        aborts(world.db, "identity_value_rewrite_old_value_remains");
      } finally {
        world.db.close();
      }
    }
  }, 30_000);
});

test("after 0063 neither the staging table nor the crosswalk exists, and the five guards are their defining migrations' text, as the committed CORE ledger records", () => {
  const ledger = JSON.parse(
    readFileSync(new URL("../../../infra/schema/core-ledger.json", import.meta.url), "utf8"),
  ) as {
    tables: { name: string; triggers: string[] }[];
    triggers: { name: string; table: string; sqlSha256: string }[];
  };
  const digest = (sql: string) => createHash("sha256").update(sql).digest("hex").slice(0, 16);
  const db = fullCoreDatabase();
  try {
    expect(
      db
        .query(
          "SELECT count(*) AS n FROM sqlite_schema WHERE tbl_name IN ('identity_value_rewrites','account_identity_crosswalk') OR name GLOB 'identity_value_rewrite_*'",
        )
        .get(),
    ).toEqual({ n: 0 });
    for (const name of ["identity_value_rewrites", "account_identity_crosswalk"])
      expect(ledger.tables.some((entry) => entry.name === name)).toBe(false);
    const defined: [string, string][] = [
      ["fetch_units_no_update", "0001_initial.sql"],
      ["transaction_observations_no_update", "0017_observation_pipeline.sql"],
      ["source_accounts_no_update", "0018_identity.sql"],
      ["account_connection_no_update", "0023_account_connections.sql"],
      ["identity_vpass_bindings_no_update", "0057_vpass_card_token_v2.sql"],
    ];
    for (const [name, file] of defined) {
      const original = splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file)).find((sql) =>
        sql.startsWith(`CREATE TRIGGER ${name} `),
      )!;
      const stored = db
        .query("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
        .get(name) as { sql: string };
      expect([name, stored.sql]).toEqual([name, original]);
      expect(digest(stored.sql)).toBe(
        ledger.triggers.find((entry) => entry.name === name)!.sqlSha256,
      );
    }
  } finally {
    db.close();
  }
}, 30_000);
