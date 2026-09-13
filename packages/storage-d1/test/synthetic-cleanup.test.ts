import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";

const MIGRATION = "0043_remove_synthetic_bootstrap.sql";
const SHA = "a".repeat(64);
const DESCRIPTOR = "b".repeat(64);
function apply(db: Database, file: string) {
  db.transaction(() => {
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file))) db.run(sql);
  })();
}
function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  // The bootstrap runs predate the operational outbox introduced in 0035.
  for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((f) => f < "0035")) apply(db, file);
  db.exec(`
    INSERT INTO sources(id,provider,display_name) VALUES('retained-source','Fixture','Retained');
    INSERT INTO producers(id,kind,display_name) VALUES('cleanup-fixture','collector','Fixture');
    INSERT INTO ingest_clients(id,display_name) VALUES('cleanup-client','Fixture');
    INSERT INTO ingest_client_producers VALUES('cleanup-client','cleanup-fixture',1);
    INSERT INTO producer_sources VALUES('cleanup-fixture','kogane-synthetic',1),('cleanup-fixture','retained-source',1);
    INSERT INTO ingest_client_routes VALUES('cleanup-client','cleanup-fixture','kogane-synthetic',1),('cleanup-client','cleanup-fixture','retained-source',1);
    INSERT INTO raw_objects VALUES('${SHA}',3,'objects/aa/${SHA}',1000);
  `);
  for (const id of [1, 2, 3, 4]) {
    db.run(
      "INSERT INTO acquisition_sessions VALUES(?1,'cleanup-fixture','cleanup-client','synthetic',?2,1000)",
      [id, `session-${id}`],
    );
  }
  // Runs 1/2 share a session. Runs 1/4 use the dedicated source; run 3 is
  // explicitly annotated legacy bootstrap. Run 5 has another exclusion reason.
  for (const [id, session, source] of [
    [1, 1, "kogane-synthetic"],
    [2, 1, "retained-source"],
    [3, 2, "retained-source"],
    [4, 3, "kogane-synthetic"],
    [5, 4, "retained-source"],
  ] as const) {
    db.run(
      "INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,first_recorded_at_ms) VALUES(?1,?2,'cleanup-fixture',?3,'cleanup-client',1000)",
      [id, session, source],
    );
    db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,producer_id,first_ingested_by_client_id,artifact_key,artifact_role,payload_fidelity,lineage_disposition,sha256,byte_size,descriptor_version,descriptor_sha256,recorded_at_ms)
      VALUES(?1,?1,?2,'cleanup-fixture','cleanup-client','fixture.json','provider_response','exact','not_applicable','${SHA}',3,'v1','${DESCRIPTOR}',1000)`,
      [id, source],
    );
    db.run(
      "INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,declared_artifact_count,artifact_count_scope,recorded_at_ms) VALUES(?1,'terminal','terminal','cleanup-client','success',1,'all_catalogued',1000)",
      [id],
    );
    db.run(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id) VALUES(?1,?1,'${"c".repeat(64)}',1,'operator',1000,'cleanup-client')`,
      [id],
    );
    db.run(
      `INSERT INTO run_inventory_items VALUES(?1,?1,'fixture.json','${SHA}','${DESCRIPTOR}')`,
      [id],
    );
    db.run("INSERT INTO fetch_run_seals VALUES(?1,?1,1000,'cleanup-client')", [id]);
    db.run(
      `INSERT INTO ingestion_attempts(fetch_run_id,producer_id,source_id,ingest_client_id,external_attempt_id,completed_at_ms,observed_artifact_count,accepted_artifact_count,reused_artifact_count,rejected_artifact_count,sealed_inventory_id,outcome,recorded_at_ms)
      VALUES(?1,'cleanup-fixture',?2,'cleanup-client','fixture-attempt',1000,1,1,0,0,?1,'complete',1000)`,
      [id, source],
    );
  }
  db.exec(
    "INSERT INTO fetch_run_annotations VALUES(3,'exclude_from_financial_views','legacy-synthetic-bootstrap',0),(5,'exclude_from_financial_views','other-reason',0)",
  );
  for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((f) => f >= "0035" && f < "0043"))
    apply(db, file);
  return db;
}
const schema = (db: Database) =>
  db
    .query(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
const snapshot = (db: Database) =>
  (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name}"`).all() }));

test("0043 removes only bootstrap metadata, retains shared objects and sessions, and restores all guards", () => {
  using db = fixture();
  const beforeSchema = schema(db);
  const raw = db.query("SELECT * FROM raw_objects").all();
  const retained = [
    "fetch_runs",
    "fetch_artifacts",
    "fetch_run_reports",
    "run_inventories",
    "run_inventory_items",
    "fetch_run_seals",
    "ingestion_attempts",
  ].map((table) => ({
    table,
    rows: db
      .query(
        `SELECT * FROM ${table} WHERE ${table === "fetch_runs" ? "id" : "fetch_run_id"} IN (2,5)`,
      )
      .all(),
  }));
  apply(db, MIGRATION);
  expect(schema(db)).toEqual(beforeSchema);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("SELECT * FROM raw_objects").all()).toEqual(raw);
  for (const { table, rows } of retained)
    expect(db.query(`SELECT * FROM ${table}`).all()).toEqual(rows);
  expect(db.query("SELECT id FROM acquisition_sessions ORDER BY id").all()).toEqual([
    { id: 1 },
    { id: 4 },
  ]);
  expect(db.query("SELECT fetch_run_id FROM fetch_run_annotations").all()).toEqual([
    { fetch_run_id: 5 },
  ]);
  expect(db.query("SELECT id FROM sources WHERE id='kogane-synthetic'").all()).toEqual([]);
  expect(db.query("SELECT id FROM sources WHERE id='retained-source'").get()).toEqual({
    id: "retained-source",
  });
  expect(() => db.run("DELETE FROM fetch_artifacts WHERE id=2")).toThrow("append-only");
  expect(() => db.run("DELETE FROM raw_objects")).toThrow("append-only");
  // Rerunning the data-only cleanup does not affect the remaining data.
  const after = snapshot(db);
  apply(db, MIGRATION);
  expect(snapshot(db)).toEqual(after);
});

test("0043 fails atomically if unexpected parsed evidence depends on a bootstrap artifact", () => {
  using db = fixture();
  db.run(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status) VALUES(1,'fixture','1','2026-09-01T00:00:00Z','ok')",
  );
  const before = snapshot(db);
  const beforeSchema = schema(db);
  expect(() => apply(db, MIGRATION)).toThrow("FOREIGN KEY");
  expect(snapshot(db)).toEqual(before);
  expect(schema(db)).toEqual(beforeSchema);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
