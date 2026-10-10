import { expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CORE_MIGRATIONS_URL,
  READ_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";
import { applyTestReadMigrations, applyTestSql } from "./migration-setup.ts";

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

async function snapshot(db: D1Database) {
  const schema = (
    await db
      .prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
      ORDER BY type,name`)
      .all<SchemaObject>()
  ).results;
  const tables = schema.filter((row) => row.type === "table").map((row) => row.name);
  const rows = await db.batch(
    tables.map((name) => db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"')),
  );
  return {
    schema,
    rows: tables.map((name, index) => ({
      name,
      rows: rows[index]!.results.map((row) => JSON.stringify(row)).sort(),
    })),
  };
}

test("per-file test setup preserves the complete production schema, seeded data and constraints", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["CORE_SERIAL", "CORE_BATCH", "READ_SERIAL", "READ_BATCH"],
    }),
  );
  try {
    const serial = await mf.getD1Database("CORE_SERIAL");
    const batched = await mf.getD1Database("CORE_BATCH");
    const readSerial = await mf.getD1Database("READ_SERIAL");
    const readBatched = await mf.getD1Database("READ_BATCH");
    // Frozen algorithm, not the new helper: one native call per statement.
    for (const name of migrationFiles(CORE_MIGRATIONS_URL))
      for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, name)))
        await serial.prepare(sql).run();
    for (const name of migrationFiles(CORE_MIGRATIONS_URL))
      await applyTestSql(batched, migrationSql(CORE_MIGRATIONS_URL, name));
    for (const name of migrationFiles(READ_MIGRATIONS_URL))
      for (const sql of splitSqlStatements(migrationSql(READ_MIGRATIONS_URL, name)))
        await readSerial.prepare(sql).run();
    await applyTestReadMigrations(readBatched);

    expect(await snapshot(batched)).toEqual(await snapshot(serial));
    expect(await snapshot(readBatched)).toEqual(await snapshot(readSerial));
    for (const db of [serial, batched, readSerial, readBatched])
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    // Exercise actual production constraints, beyond equality on empty tables.
    for (const db of [serial, batched]) {
      await db
        .prepare(`INSERT INTO raw_objects(sha256,byte_size,blob_key,first_stored_at_ms)
        VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'synthetic/schema',1)`)
        .run();
      await expect(
        db
          .prepare(`UPDATE raw_objects SET byte_size=2
        WHERE sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`)
          .run(),
      ).rejects.toThrow(/append.only|immutable/i);
      await expect(
        db
          .prepare(`INSERT INTO ingest_client_producers(ingest_client_id,producer_id)
        VALUES('missing-client','missing-producer')`)
          .run(),
      ).rejects.toThrow(/FOREIGN KEY/i);
    }
    expect(await snapshot(batched)).toEqual(await snapshot(serial));
  } finally {
    await mf.dispose();
  }
}, 120_000);

test("a failed test migration rolls back that file without undoing its predecessor", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await applyTestSql(
      db,
      "CREATE TABLE earlier(id INTEGER PRIMARY KEY); INSERT INTO earlier VALUES(1);",
    );
    await expect(
      applyTestSql(
        db,
        `CREATE TABLE later(id INTEGER PRIMARY KEY);
      INSERT INTO later VALUES(1); INSERT INTO earlier VALUES(1);`,
      ),
    ).rejects.toThrow();
    expect((await db.prepare("SELECT * FROM earlier").all()).results).toEqual([{ id: 1 }]);
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name='later'").first(),
    ).toBeNull();
    await applyTestSql(db, "-- an empty migration has no work\n");
  } finally {
    await mf.dispose();
  }
});
