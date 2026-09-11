// The READ baseline schema and what it refuses (unified plan 04 §1, §3, 05 §4).
//
// Acceptance: G2-07 (a re-sent chunk), G2-09 (a displaced writer), G2-10 (the
// pointer never goes backwards), G0-09 (dropping READ and re-applying the
// migrations restores an empty, usable database).
import { describe, expect, test } from "bun:test";
import { migrationFiles, READ_MIGRATIONS_PATH, READ_MIGRATIONS_URL } from "../src/migrations.ts";
import { createSqliteReadDatabase } from "./sqlite-read-database.ts";

interface MasterRow {
  type: string;
  name: string;
  sql: string | null;
}

const schema = () => {
  const { sqlite } = createSqliteReadDatabase();
  return sqlite
    .query("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as MasterRow[];
};

describe("the READ baseline", () => {
  test("starts at 0001 and is the only directory the read database is built from", () => {
    expect(migrationFiles(READ_MIGRATIONS_URL)).toEqual([
      "0001_read_baseline.sql",
      "0002_reward_read.sql",
    ]);
    expect(READ_MIGRATIONS_PATH).toBe("packages/storage-d1/migrations/read");
  });

  test("declares the tables the plan puts in READ, and nothing else", () => {
    expect(
      schema()
        .filter((row) => row.type === "table")
        .map((row) => row.name)
        .sort(),
    ).toEqual([
      "balance_read_snapshots",
      "balance_snapshot_pointer",
      "current_balance_projection",
      "read_build_checkpoints",
      "read_instance",
      // U16, migration 0002: the reward second stage, under the same rules.
      "reward_build_checkpoints",
      "reward_conversion_simulations",
      "reward_expiry_estimates",
      "reward_expiry_snapshots",
      "reward_snapshot_input_refs",
      "reward_snapshot_pointer",
      "scope_relations",
      "snapshot_input_refs",
    ]);
  });

  test("every table is STRICT", () => {
    for (const row of schema().filter((entry) => entry.type === "table"))
      expect(`${row.name}: ${/\bSTRICT\b/u.test(row.sql ?? "") ? "strict" : "loose"}`).toBe(
        `${row.name}: strict`,
      );
  });

  test("no foreign key names a CORE table (04 §1: two databases cannot be joined)", () => {
    const { sqlite } = createSqliteReadDatabase();
    const tables = (
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    const local = new Set(tables);
    for (const table of tables)
      for (const key of sqlite.query(`PRAGMA foreign_key_list("${table}")`).all() as {
        table: string;
      }[])
        expect(`${table} -> ${key.table} (${local.has(key.table) ? "read" : "core"})`).toBe(
          `${table} -> ${key.table} (read)`,
        );
  });

  test("a snapshot cannot be written before this database has an identity", async () => {
    const { sqlite } = createSqliteReadDatabase();
    expect(() =>
      sqlite
        .query(
          `INSERT INTO balance_read_snapshots(snapshot_id,content_key,attempt,input_digest,
            build_digest,contract_version,read_instance_id,source_revision,visibility_revision,
            core_epoch,status,row_count,input_manifest_json,projection_release,created_at)
           VALUES(?1,?2,1,?3,?4,'projection-input-v1','instance-1',1,1,'core-epoch-1','building',
             0,'{}','balance-projection-v1','2026-09-11T00:00:00.000Z')`,
        )
        .run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)),
    ).toThrow(/read instance/u);
  });
});
