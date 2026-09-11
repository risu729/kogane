// The schema ledgers must describe the migrations that are on disk.
//
// Unified plan U01, acceptance test G0-01: a table nobody classified is kept
// and never enters a cleanup. The check that makes that real is mechanical —
// every table the migrations create must have an entry in the classification
// map, and the committed ledger must equal a fresh dump — so a new migration
// cannot add a table outside the retention decision, and a migration cannot
// change the schema without the ledger moving with it.
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CLASSIFICATION,
  LEDGER_JSON_PATH,
  LEDGER_MARKDOWN_PATH,
  MIGRATIONS_DIR,
  READ_CLASSIFICATION,
  READ_PROFILE,
  REPO_ROOT,
  applyMigrations,
  buildSchemaLedger,
  renderSchemaMarkdown,
  splitSqlStatements,
} from "./core-schema-ledger.ts";

const ledger = buildSchemaLedger(REPO_ROOT);
const readLedger = buildSchemaLedger(REPO_ROOT, READ_PROFILE);

describe("SQL statement splitter", () => {
  test("keeps a trigger body together and splits on real statement ends", () => {
    expect(
      splitSqlStatements(
        "CREATE TABLE t(a TEXT) STRICT;\n-- c;\nCREATE TRIGGER t_no_update BEFORE UPDATE ON t\nBEGIN SELECT RAISE(ABORT,'no; really'); END;\nINSERT INTO t(a) VALUES('x;y');",
      ),
    ).toEqual([
      "CREATE TABLE t(a TEXT) STRICT",
      "CREATE TRIGGER t_no_update BEFORE UPDATE ON t\nBEGIN SELECT RAISE(ABORT,'no; really'); END",
      "INSERT INTO t(a) VALUES('x;y')",
    ]);
  });

  test("a CASE … END inside a trigger body does not end the trigger", () => {
    // `END` closes both a CASE expression and a trigger body. The first inner
    // statement below ends with a CASE's END, and the string literal carries the
    // words BEGIN and END; neither may cut the trigger in two.
    expect(
      splitSqlStatements(
        "CREATE TRIGGER t_ai AFTER INSERT ON t\nBEGIN\n  INSERT INTO log(v) SELECT CASE WHEN NEW.a IS NULL THEN 0 ELSE 1 END;\n  SELECT RAISE(ABORT, 'BEGIN END; -- x');\nEND;\nCREATE TABLE u(a TEXT DEFAULT 'it''s; ok') STRICT;",
      ),
    ).toEqual([
      "CREATE TRIGGER t_ai AFTER INSERT ON t\nBEGIN\n  INSERT INTO log(v) SELECT CASE WHEN NEW.a IS NULL THEN 0 ELSE 1 END;\n  SELECT RAISE(ABORT, 'BEGIN END; -- x');\nEND",
      "CREATE TABLE u(a TEXT DEFAULT 'it''s; ok') STRICT",
    ]);
  });

  test("splitting a migration and replaying it statement by statement rebuilds the schema", () => {
    // Proof that the INSERT inventory below is not reading a mis-split file: a
    // trigger body cut at an inner `;` fails to execute, and a missed statement
    // shows up as a missing object. Only the object set is compared, because
    // sqlite_master stores each statement's original text, comments included.
    const db = new Database(":memory:");
    for (const file of readdirSync(join(REPO_ROOT, MIGRATIONS_DIR))
      .filter((entry) => entry.endsWith(".sql"))
      .sort())
      for (const statement of splitSqlStatements(
        readFileSync(join(REPO_ROOT, MIGRATIONS_DIR, file), "utf8"),
      ))
        db.run(statement);
    const rows = db
      .query(
        "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { type: string; name: string; tbl_name: string }[];
    db.close();
    expect(
      rows
        .map((row) => `${row.type} ${row.name} ${row.tbl_name}`)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(
      [
        ...ledger.tables.map((table) => `table ${table.name} ${table.name}`),
        ...ledger.views.map((view) => `view ${view.name} ${view.name}`),
        ...ledger.triggers.map((trigger) => `trigger ${trigger.name} ${trigger.table}`),
        ...ledger.indexes.map((index) => `index ${index.name} ${index.table}`),
      ].toSorted((a, b) => a.localeCompare(b)),
    );
  });
});

describe("G0-01 CORE schema ledger", () => {
  test("infra/schema/core-ledger.json is the current generator output", () => {
    expect(readFileSync(join(REPO_ROOT, LEDGER_JSON_PATH), "utf8")).toBe(
      `${JSON.stringify(ledger, null, 2)}\n`,
    );
  });

  test("infra/schema/core-ledger.md is the current generator output", () => {
    expect(readFileSync(join(REPO_ROOT, LEDGER_MARKDOWN_PATH), "utf8")).toBe(
      renderSchemaMarkdown(ledger),
    );
  });

  test("every table the migrations create is classified, and nothing stale is classified", () => {
    expect(
      ledger.tables.filter((table) => table.planRow.startsWith("MISSING")).map((t) => t.name),
    ).toEqual([]);
    expect(Object.keys(CLASSIFICATION).toSorted((a, b) => a.localeCompare(b))).toEqual(
      ledger.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  test("unclassified tables are kept, never dropped into a cleanup bucket", () => {
    // The plan's default. Listing them is the point: they are visible, and they
    // are on the protected side until someone classifies them deliberately.
    expect(ledger.summary.byClassification["unclassified-keep"]).toEqual([
      "dataset_snapshot_policies",
      "fetch_run_annotations",
      "observation_artifact_metadata",
      "observation_scan_state",
      "parse_issues",
    ]);
    for (const name of ledger.summary.byClassification["unclassified-keep"])
      expect(ledger.summary.byClassification["read-candidate"]).not.toContain(name);
  });

  test("only the tables chapter 04 §2 places in READ are READ candidates", () => {
    expect(ledger.summary.byClassification["read-candidate"]).toEqual([
      "balance_read_snapshots",
      // The active snapshot pointer of migration 0038 belongs to the same
      // rebuildable set: it names which snapshot the read model publishes, and
      // it moves to READ with them in U11.
      "balance_snapshot_pointer",
      "conversion_simulations",
      "current_balance_projection",
      "expiry_estimates",
      "scope_relations",
    ]);
  });

  test("every table is STRICT and the append-only guards are recorded per table", () => {
    expect(ledger.summary.nonStrictTables).toEqual([]);
    const guarded = ledger.tables.filter((table) => table.appendOnly);
    expect(guarded.length).toBeGreaterThan(60);
    for (const table of guarded) {
      expect(table.noUpdateTriggers.length).toBeGreaterThan(0);
      expect(table.noDeleteTriggers.length).toBeGreaterThan(0);
    }
    // Evidence and observations are append-only; losing a guard is a schema
    // regression, not a ledger detail.
    for (const name of [
      "raw_objects",
      "fetch_artifacts",
      "fetch_run_seals",
      "balance_observations",
      "transaction_observations",
      "observation_decimal_values",
      "publication_events",
    ])
      expect(ledger.tables.find((table) => table.name === name)?.appendOnly).toBe(true);
  });

  test("the migration inventory records the seed and backfill migrations of 06 §1", () => {
    const { db, migrations } = applyMigrations(REPO_ROOT);
    db.close();
    expect(migrations.map((entry) => entry.file)).toEqual(ledger.migrations.map((e) => e.file));
    // 0002 seeds the registry and 0024/0029 backfill; the plan says finding
    // them is not a reason to wipe the database, but they must stay visible.
    expect(ledger.summary.migrationsWithInserts).toContain("0002_registry.sql");
    expect(ledger.summary.migrationsWithInserts).toContain("0024_observation_decimals.sql");
    expect(ledger.summary.migrationsWithInserts).toContain("0029_decision_log.sql");
    expect(ledger.summary.migrationsWithInserts).not.toContain("0001_initial.sql");
  });
});

describe("G0-09 READ schema ledger", () => {
  test("infra/schema/read-ledger.json is the current generator output", () => {
    expect(readFileSync(join(REPO_ROOT, READ_PROFILE.jsonPath), "utf8")).toBe(
      `${JSON.stringify(readLedger, null, 2)}\n`,
    );
  });

  test("infra/schema/read-ledger.md is the current generator output", () => {
    expect(readFileSync(join(REPO_ROOT, READ_PROFILE.markdownPath), "utf8")).toBe(
      renderSchemaMarkdown(readLedger, READ_PROFILE),
    );
  });

  test("it is built from its own directory, never from the CORE one", () => {
    expect(READ_PROFILE.migrationsDir).toBe("packages/storage-d1/migrations/read");
    expect(readLedger.migrations.map((entry) => entry.file)).toEqual([
      "0001_read_baseline.sql",
      // U16: the reward second stage of 04 §2, in the same database.
      "0002_reward_read.sql",
    ]);
    // No CORE table can appear here, and no READ table in the CORE ledger.
    const core = new Set(ledger.tables.map((table) => table.name));
    expect(
      readLedger.tables.filter((table) => core.has(table.name)).map((table) => table.name),
    ).toEqual([
      // These three names exist in both databases on purpose while U11 is
      // behind its flag: CORE still carries the projection of migration 0030,
      // and READ carries the snapshot-scoped rebuild of it. They are different
      // tables in different databases, and nothing joins them (04 §1).
      "balance_read_snapshots",
      "balance_snapshot_pointer",
      // CORE's `conversion_simulations` and `expiry_estimates` of migration
      // 0033 keep their names; the READ tables of U16 are named apart
      // (`reward_*`) precisely so the two are never mistaken for each other.
      "current_balance_projection",
      "scope_relations",
    ]);
  });

  test("every READ table is classified, STRICT, and free of foreign keys to CORE", () => {
    expect(
      readLedger.tables.filter((table) => table.planRow.startsWith("MISSING")).map((t) => t.name),
    ).toEqual([]);
    expect(Object.keys(READ_CLASSIFICATION).toSorted((a, b) => a.localeCompare(b))).toEqual(
      readLedger.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(readLedger.summary.nonStrictTables).toEqual([]);
    const local = new Set(readLedger.tables.map((table) => table.name));
    for (const table of readLedger.tables)
      for (const key of table.foreignKeys)
        expect(`${table.name} -> ${key.references}`).toBe(
          `${table.name} -> ${local.has(key.references.split("(")[0] ?? "") ? key.references : "a CORE table"}`,
        );
  });

  test("the projection and the operational state are told apart", () => {
    expect(readLedger.summary.byClassification["read-projection"]).toEqual([
      "balance_read_snapshots",
      "current_balance_projection",
      "reward_conversion_simulations",
      "reward_expiry_estimates",
      "reward_expiry_snapshots",
      "reward_snapshot_input_refs",
      "scope_relations",
      "snapshot_input_refs",
    ]);
    expect(readLedger.summary.byClassification["read-operational"]).toEqual([
      "balance_snapshot_pointer",
      "read_build_checkpoints",
      "read_instance",
      "reward_build_checkpoints",
      "reward_snapshot_pointer",
    ]);
    // The CORE ledger keeps exactly the classifications it always had.
    expect(Object.keys(ledger.summary.byClassification)).toEqual([
      "core-keep",
      "read-candidate",
      "operational-mutable",
      "unclassified-keep",
    ]);
  });
});
