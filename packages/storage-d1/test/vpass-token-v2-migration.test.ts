// 0057 rebuilds `identity_vpass_bindings` to widen its token CHECK from
// `vpass-card-v1-` to `vpass-card-v1-` or `vpass-card-v2-` (ADR 0029), and
// recreates `trusted_vpass_card_bindings` with the same prefix widened. These
// tests seed a store migrated through 0056 with synthetic pins, apply 0057
// statement by statement with foreign keys on, and prove that nothing but the
// CHECK changed: every row, every trigger byte for byte, the column, key and
// foreign-key shape. Then that the rebuilt table admits exactly v1 and v2
// tokens and keeps its append-only guards.
//
// The pins are written directly: the provenance trigger (which requires a
// trusted binding through the view) is set aside for the seed only and its
// own 0020 text is put back before 0057 runs. The provenance rule itself is
// exercised end to end in services/processor/test/vpass-collector-binding.test.ts.
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";
import { coreDatabase } from "./sqlite.ts";

const MIGRATION = "0057_vpass_card_token_v2.sql";
const TABLE = "identity_vpass_bindings";
const PROVENANCE = "identity_vpass_binding_provenance";
const hex = (char: string, length = 64) => char.repeat(length);

function apply(db: Database, file: string, afterStatement?: () => void) {
  db.transaction(() => {
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file))) {
      db.run(sql);
      afterStatement?.();
    }
  })();
}

/** Runs `write` with the provenance trigger set aside, then restores its exact text. */
function withoutProvenance(db: Database, write: () => void) {
  const { sql } = db
    .query("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
    .get(PROVENANCE) as { sql: string };
  db.run(`DROP TRIGGER ${PROVENANCE}`);
  try {
    write();
  } finally {
    db.run(sql);
  }
}

function pin(db: Database, run: string, unit: number, artifact: number, token: string) {
  db.run(`INSERT INTO ${TABLE} VALUES(?,?,?,?)`, [run, unit, artifact, token]);
}

/**
 * Every CORE migration from 0017 through 0056 over the Layer A stub, then
 * synthetic v1 pins whose parent rows exist.
 */
function fixture() {
  expect(
    migrationFiles(CORE_MIGRATIONS_URL)
      .filter((f) => f < MIGRATION)
      .at(-1),
  ).toBe("0056_sbi_shinsei_exchange_rate_policy_version.sql");
  const db = coreDatabase("0017", MIGRATION);
  db.exec("PRAGMA foreign_keys=ON");
  withoutProvenance(db, () => {
    for (let index = 1; index <= 5; index += 1) {
      db.run("INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'card')", [
        index,
        index,
        `card-00${index}`,
      ]);
      db.run(
        "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,artifact_key) VALUES(?,?,'vpass',?)",
        [index, index, `synthetic-${index}.json`],
      );
      db.run(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status) VALUES(?,?,'synthetic','1','2099-01-01','ok')",
        [index, index],
      );
      db.run("INSERT INTO identity_runs VALUES(?,?,2,'2099-01-01')", [`run-${index}`, index]);
      pin(db, `run-${index}`, index, index, `vpass-card-v1-${hex("0123456789abcdef"[index]!)}`);
    }
  });
  return db;
}

function rows(db: Database) {
  return db.query(`SELECT * FROM ${TABLE} ORDER BY identity_run_id`).all();
}
function triggers(db: Database) {
  return db
    .query(
      "SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' AND (tbl_name=? OR sql LIKE ?) ORDER BY name",
    )
    .all(TABLE, `%${TABLE}%`);
}
function shape(db: Database) {
  return {
    columns: db.query(`PRAGMA table_info(${TABLE})`).all(),
    foreignKeys: db.query(`PRAGMA foreign_key_list(${TABLE})`).all(),
    indexes: db.query(`PRAGMA index_list(${TABLE})`).all(),
  };
}
function tableSql(db: Database) {
  const row = db
    .query("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
    .get(TABLE) as {
    sql: string;
  };
  return row.sql.replace(/\s+/gu, " ");
}

test("0057 preserves every pin, guard and key with enforcement on at every statement", () => {
  const db = fixture();
  try {
    const before = { rows: rows(db), triggers: triggers(db), shape: shape(db) };
    expect(before.rows).toHaveLength(5);
    expect(before.triggers.length).toBe(6);
    const beforeSql = tableSql(db);
    apply(db, MIGRATION, () => {
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    expect({ rows: rows(db), triggers: triggers(db), shape: shape(db) }).toEqual(before);
    // The table definition differs in the token CHECK and nothing else.
    expect(
      tableSql(db).replace(
        "substr(card_token,1,14) IN ('vpass-card-v1-','vpass-card-v2-')",
        "substr(card_token,1,14)='vpass-card-v1-'",
      ),
    ).toBe(beforeSql);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name LIKE '%0057%'").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally {
    db.close();
  }
}, 30_000);

test("0057 admits exactly v1 and v2 tokens and keeps the pins append-only", () => {
  const db = fixture();
  try {
    const v2 = `vpass-card-v2-${hex("a")}`;
    withoutProvenance(db, () => {
      db.run("INSERT INTO identity_runs VALUES('run-9',1,3,'2099-01-01')");
      expect(() => pin(db, "run-9", 1, 1, v2)).toThrow("CHECK");
    });
    apply(db, MIGRATION);
    // The provenance guard is back: a pin with no trusted binding is refused.
    expect(() => pin(db, "run-9", 1, 1, v2)).toThrow("identity_vpass_binding_provenance_invalid");
    withoutProvenance(db, () => {
      for (const token of [
        `vpass-card-v3-${hex("a")}`,
        `vpass-card-v2-${hex("A")}`,
        `vpass-card-v2-${hex("a", 63)}`,
        `vpass-card-v2-${hex("a", 65)}`,
        `vpass-card-v2-${hex("a", 63)}g`,
        `Vpass-card-v2-${hex("a")}`,
      ]) {
        expect(() => pin(db, "run-9", 1, 1, token)).toThrow("CHECK");
      }
      pin(db, "run-9", 1, 1, v2);
      db.run("INSERT INTO identity_runs VALUES('run-10',2,3,'2099-01-01')");
      pin(db, "run-10", 2, 2, `vpass-card-v1-${hex("b")}`);
      // Replacement is refused as before.
      expect(() => pin(db, "run-9", 1, 1, v2)).toThrow("identity replacement is forbidden");
    });
    expect(() => db.run(`UPDATE ${TABLE} SET card_token=card_token`)).toThrow(
      "identity is append-only",
    );
    expect(() => db.run(`DELETE FROM ${TABLE}`)).toThrow("identity is append-only");
    expect(rows(db)).toHaveLength(7);
  } finally {
    db.close();
  }
}, 30_000);
