import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";

test("0042 removes only retired caches and revokes old clients without losing canonical rows", () => {
  using db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const apply = (file: string) => {
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file))) db.run(sql);
  };
  for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((file) => file < "0042"))
    apply(file);
  db.run(
    "INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms) VALUES(?1,3,?2,1000)",
    ["a".repeat(64), `objects/aa/${"a".repeat(64)}`],
  );
  db.run(
    "INSERT INTO ingest_clients(id,display_name,active) VALUES('processor-shared-r2','Synthetic shared client',1)",
  );
  const retired = [
    "balance_snapshot_pointer",
    "current_balance_projection",
    "scope_relations",
    "balance_read_snapshots",
    "expiry_estimates",
    "conversion_simulations",
  ];
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const retained = tables.filter((name) => !retired.includes(name) && name !== "ingest_clients");
  const snapshot = () =>
    retained.map((name) => ({ name, rows: db.query(`SELECT * FROM "${name}"`).all() }));
  const before = snapshot();
  const clients = db
    .query("SELECT id FROM ingest_clients WHERE id LIKE 'collector-r2-%' ORDER BY id")
    .all();
  expect(clients).toHaveLength(12);
  apply("0042_retire_legacy_projections.sql");
  expect(snapshot()).toEqual(before);
  for (const name of retired)
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?1").get(name),
    ).toBeNull();
  expect(
    db.query("SELECT id FROM ingest_clients WHERE id LIKE 'collector-r2-%' ORDER BY id").all(),
  ).toEqual(clients);
  expect(
    db.query("SELECT id FROM ingest_clients WHERE id LIKE 'collector-r2-%' AND active<>0").all(),
  ).toEqual([]);
  expect(
    db.query("SELECT active FROM ingest_clients WHERE id='processor-shared-r2'").get(),
  ).toEqual({ active: 1 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
