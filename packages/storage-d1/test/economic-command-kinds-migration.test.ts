// 0071 rebuilds the four command tables to add the economic-event command
// kinds (ADR 0054, G2), statement by statement as 0058 and 0051 did. These
// tests seed a store migrated through 0070 with synthetic history of every
// earlier kind and status, apply 0071 statement by statement with foreign
// keys on, and prove that nothing but the kind CHECK changed: in particular
// that every 0070 index, trigger and view survives the rebuild unchanged
// ("Rebuilding a table 0070 reads"). Every row is synthetic.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { IDENTITY_RESOLUTION_KIND } from "../../domain/src/economic-contract.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";
import { fullCoreDatabase } from "./sqlite.ts";

const MIGRATION = "0071_economic_event_command_kinds.sql";
const GUARD_MIGRATION = "0070_economic_commit_guard.sql";
const TABLES = ["change_plans", "approvals", "operation_receipts", "decision_outbox"];
/** Every kind the 0058 CHECK admits, in its order. */
const OLD_KINDS = [
  "identity.assign",
  "identity.release-override",
  "relation.accept",
  "relation.reject",
  "card-settlement.accept",
  "card-settlement.reject",
  "card-settlement.withdraw",
  "card-purchase.exclude",
  "card-purchase.restore",
  "card-refund.allocate",
  "card-refund.withdraw",
  "card-installment.link",
  "card-installment.unlink",
  "identity.crosswalk.accept",
];
const NEW_KINDS = [
  "economic-event.adopt",
  "economic-event.correct",
  "economic-event.withdraw",
  "economic-event.move",
];
const planId = (id: number) => id.toString(16).padStart(64, "0");
function insertPlan(db: Database, id: number, kind: string) {
  db.run(
    "INSERT INTO change_plans VALUES(?,?,?,?,'{}','{}','human','created','expires','planned')",
    [planId(id), kind, JSON.stringify({ target: `synthetic-${id}` }), "context"],
  );
}
function insertReceipt(db: Database, id: number, kind: string) {
  db.run("INSERT INTO operation_receipts VALUES(?,'human',?,?,?,'accepted','{}','created',NULL)", [
    `operation-${id}`,
    kind,
    planId(id),
    planId(id),
  ]);
}
function apply(db: Database, file: string, afterStatement?: (sql: string) => void) {
  db.transaction(() => {
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file))) {
      db.run(sql);
      afterStatement?.(sql);
    }
  })();
}
/** Every CORE migration before 0071 (0067 is not on main), then synthetic history of every kind. */
function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const earlier = migrationFiles(CORE_MIGRATIONS_URL).filter((f) => f < MIGRATION);
  expect(earlier.at(-1)).toBe(GUARD_MIGRATION);
  for (const file of earlier) apply(db, file);
  for (let index = 0; index < OLD_KINDS.length; index++) {
    const id = index + 1;
    const kind = OLD_KINDS[index]!;
    insertPlan(db, id, kind);
    insertReceipt(db, id, kind);
    db.run("INSERT INTO approvals VALUES(?,?,?,'human','server','[]','expires',2,'created')", [
      `approval-${id}`,
      planId(id),
      planId(id),
    ]);
    db.run("UPDATE approvals SET uses_remaining=uses_remaining-1 WHERE approval_id=?", [
      `approval-${id}`,
    ]);
    db.run(
      `INSERT INTO decision_revisions VALUES(?,'relation',?,1,'accept','manual','human',NULL,
      'synthetic migration history','[]',NULL,NULL,'created')`,
      [`decision-${id}`, `relation-${id}`],
    );
    db.run(
      `INSERT INTO decision_outbox(id,decision_revision_id,principal,operation_id,target,enqueued_at)
      VALUES(?,?,'human',?,'identity-projection','created')`,
      [id, `decision-${id}`, `operation-${id}`],
    );
    db.run(
      `UPDATE decision_outbox SET progress_code='pending',pending_polls=3,blocked_code='fixture',
      required_source_revision=5,evidence_ref='synthetic-snapshot',applied_source_revision=6,
      attempts=2,last_error_code='fixture',outcome='retry',available_at_ms=42,
      lease_token='synthetic-lease',lease_until_ms=100 WHERE id=?`,
      [id],
    );
    // Plan 1 stays open; the others reach every closed plan and receipt state.
    if (id === 1) continue;
    if (id % 2 === 0)
      db.run("UPDATE change_plans SET status='approved' WHERE plan_id=?", [planId(id)]);
    db.run("UPDATE change_plans SET status=? WHERE plan_id=?", [
      ["committed", "rejected", "stale"][id % 3]!,
      planId(id),
    ]);
    const published = id % 2 === 0;
    db.run("UPDATE operation_receipts SET status=?,published_at=? WHERE operation_id=?", [
      published ? "published" : "failed",
      published ? "published" : null,
      `operation-${id}`,
    ]);
    if (published) db.run("UPDATE decision_outbox SET processed_at='completed' WHERE id=?", [id]);
  }
  return db;
}
/** Every row of every table of the store, the 0070 tables and their seeded epoch included. */
function allRows(db: Database) {
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  return Object.fromEntries(
    tables.map((table) => [table, db.query(`SELECT * FROM "${table}" ORDER BY 1`).all()]),
  );
}
function guards(db: Database) {
  return db
    .query(
      "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE type IN ('trigger','index') ORDER BY name",
    )
    .all();
}
/** Every schema object outside the four rebuilt tables (their indexes and triggers are in `guards`). */
function untouched(db: Database) {
  return db
    .query(
      `SELECT type,name,tbl_name,sql FROM sqlite_schema
       WHERE tbl_name NOT IN (${TABLES.map((t) => `'${t}'`).join(",")}) ORDER BY type,name`,
    )
    .all();
}
function shape(db: Database) {
  return TABLES.map((table) => ({
    table,
    columns: db.query(`PRAGMA table_info(${table})`).all(),
    foreignKeys: db.query(`PRAGMA foreign_key_list(${table})`).all(),
    indexes: db.query(`PRAGMA index_list(${table})`).all(),
  }));
}
const kindList = (kinds: readonly string[]) => kinds.map((kind) => `'${kind}'`).join(",");
/** Table SQL, normalised (whitespace, rename quoting), with the widened kind list put back. */
function tableSql(db: Database, widened: boolean) {
  return TABLES.map((table) => {
    const row = db
      .query("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
      .get(table) as { sql: string };
    let sql = row.sql.replace(/\s+/gu, " ").replace(/"/gu, "");
    if (widened) {
      const narrowed = sql.replaceAll(kindList([...OLD_KINDS, ...NEW_KINDS]), kindList(OLD_KINDS));
      expect(narrowed !== sql).toBe(table === "change_plans" || table === "operation_receipts");
      sql = narrowed;
    }
    return { table, sql };
  });
}
/** The index, trigger and view objects 0070 creates, by name, on a store migrated through 0069. */
function guardObjectNames(): string[] {
  const db = new Database(":memory:");
  try {
    for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((f) => f < GUARD_MIGRATION))
      db.exec(migrationSql(CORE_MIGRATIONS_URL, file));
    const names = () =>
      new Set(
        (db.query("SELECT name FROM sqlite_schema").all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
    const before = names();
    db.exec(migrationSql(CORE_MIGRATIONS_URL, GUARD_MIGRATION));
    return [...names()].filter((name) => !before.has(name)).sort();
  } finally {
    db.close();
  }
}
function objectsNamed(db: Database, names: readonly string[]) {
  return db
    .query(
      `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY name`,
    )
    .all(...names);
}

test("0071 preserves every historical row, guard and FK with enforcement on at every statement", () => {
  const db = fixture();
  try {
    const before = { rows: allRows(db), guards: guards(db), shape: shape(db) };
    const beforeSql = tableSql(db, false);
    expect(before.guards.length).toBeGreaterThan(0);
    for (const table of TABLES)
      expect((before.rows[table] as unknown[]).length).toBe(OLD_KINDS.length);
    apply(db, MIGRATION, () => {
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    // Rows of every table, every index and trigger (byte-identical SQL) and the column/FK shape.
    expect({ rows: allRows(db), guards: guards(db), shape: shape(db) }).toEqual(before);
    // The table definitions differ in the widened kind CHECK and nothing else.
    expect(tableSql(db, true)).toEqual(beforeSql);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name LIKE '%_expanded%'").all()).toEqual(
      [],
    );
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally {
    db.close();
  }
}, 30_000);

test("0071 drops and recreates no 0070 object: every 0070 index, trigger and view is unchanged", () => {
  const names = guardObjectNames();
  // The 0070 objects ADR 0054 lists, the commit trigger among them.
  expect(names).toContain("economic_commit_log_guard");
  expect(names).toContain("economic_claims_guard");
  expect(names).toContain("live_consumption_claims");
  expect(names).toContain("economic_event_revisions_superseded_by");
  const db = fixture();
  try {
    const before = objectsNamed(db, names);
    expect(before.length).toBe(names.length);
    const outside = untouched(db);
    const dropped: string[] = [];
    apply(db, MIGRATION, (sql) => {
      const match = /^\s*DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?"?(\w+)/iu.exec(
        sql,
      );
      if (match) dropped.push(match[1]!);
    });
    // The migration drops exactly the four old command tables, nothing else.
    expect(dropped.sort()).toEqual([...TABLES].sort());
    expect(objectsNamed(db, names)).toEqual(before);
    // No object outside the four tables changed either, 0070's or older.
    expect(untouched(db)).toEqual(outside);
    // No 0070 object reads a command table, so nothing had to be dropped.
    for (const object of before as { sql: string | null }[])
      for (const table of TABLES)
        expect(new RegExp(`\\b${table}\\b`, "u").test(object.sql ?? "")).toBe(false);
  } finally {
    db.close();
  }
}, 30_000);

test("a fresh store migrated through 0071 has the same 0070 objects as one stopped at 0070", () => {
  const names = guardObjectNames();
  // A fresh store stopped at 0071: later migrations (0072, ADR 0057) add
  // objects of their own, which their own tests pin.
  const fresh = new Database(":memory:");
  fresh.exec("PRAGMA foreign_keys=ON");
  const through0070 = new Database(":memory:");
  try {
    for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((f) => f <= MIGRATION))
      fresh.exec(migrationSql(CORE_MIGRATIONS_URL, file));
    for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((f) => f <= GUARD_MIGRATION))
      through0070.exec(migrationSql(CORE_MIGRATIONS_URL, file));
    expect(migrationFiles(CORE_MIGRATIONS_URL)).toContain(MIGRATION);
    expect(objectsNamed(fresh, names)).toEqual(objectsNamed(through0070, names));
    // Every later migration too: the full store keeps every 0070 object as 0070 made it.
    const full = fullCoreDatabase();
    try {
      expect(objectsNamed(full, names)).toEqual(objectsNamed(through0070, names));
    } finally {
      full.close();
    }
    expect(untouched(fresh)).toEqual(untouched(through0070));
    expect(fresh.query("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const [index, kind] of NEW_KINDS.entries()) {
      insertPlan(fresh, 500 + index, kind);
      insertReceipt(fresh, 500 + index, kind);
    }
  } finally {
    fresh.close();
    through0070.close();
  }
}, 30_000);

test("0071 accepts exactly the four economic-event kinds; the reserved resolution kind stays refused", () => {
  const db = fixture();
  try {
    for (const [index, kind] of NEW_KINDS.entries()) {
      expect(() => insertPlan(db, 50 + index, kind)).toThrow("CHECK");
      insertPlan(db, 60 + index, "identity.assign");
      expect(() => insertReceipt(db, 60 + index, kind)).toThrow("CHECK");
    }
    apply(db, MIGRATION);
    for (const [index, kind] of [...OLD_KINDS, ...NEW_KINDS].entries()) {
      insertPlan(db, index + 100, kind);
      insertReceipt(db, index + 100, kind);
    }
    insertPlan(db, 201, "identity.assign");
    expect(IDENTITY_RESOLUTION_KIND).toBe("economic-event.resolve-identity");
    for (const kind of [
      IDENTITY_RESOLUTION_KIND,
      "economic-event",
      "economic-event.delete",
      "economic-event.adopt ",
      "Economic-event.adopt",
      "economic_event.adopt",
      "transfer.send",
      "other",
    ]) {
      expect(() => insertPlan(db, 200, kind)).toThrow("CHECK");
      expect(() => insertReceipt(db, 201, kind)).toThrow("CHECK");
    }
    expect(() => insertReceipt(db, 300, "economic-event.adopt")).toThrow("FOREIGN KEY");
  } finally {
    db.close();
  }
}, 30_000);

test("0071 keeps append-only history and forward-only approval/publication/progress guards", () => {
  const db = fixture();
  try {
    apply(db, MIGRATION);
    for (const table of TABLES) {
      expect(() => db.run(`DELETE FROM ${table}`)).toThrow();
      expect(() => db.run(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow();
    }
    expect(() =>
      db.run("UPDATE change_plans SET kind='economic-event.adopt' WHERE plan_id=?", [planId(1)]),
    ).toThrow("change plan is immutable except its status");
    expect(() => db.run("UPDATE approvals SET uses_remaining=uses_remaining+1")).toThrow(
      "approval is immutable except spending one use",
    );
    expect(() =>
      db.run(
        "UPDATE operation_receipts SET operation_kind='economic-event.move' WHERE operation_id='operation-1'",
      ),
    ).toThrow("operation receipt is immutable except its publication state");
    expect(() =>
      db.run("UPDATE decision_outbox SET processed_at='done',evidence_ref=NULL WHERE id=1"),
    ).toThrow("an outbox row is processed only with its completion evidence");
    // A plan of a new kind is guarded like every other one.
    insertPlan(db, 400, "economic-event.withdraw");
    expect(() => insertPlan(db, 400, "economic-event.withdraw")).toThrow(
      "change plan replacement is forbidden",
    );
  } finally {
    db.close();
  }
}, 30_000);

test("an interrupted 0071 rolls back the entire schema and historical graph", () => {
  const db = fixture();
  try {
    const before = {
      rows: allRows(db),
      schema: db.query("SELECT * FROM sqlite_schema ORDER BY name").all(),
    };
    expect(() =>
      apply(db, MIGRATION, (sql) => {
        if (sql.includes("RENAME TO operation_receipts"))
          throw new Error("synthetic interrupted migration");
      }),
    ).toThrow("synthetic interrupted migration");
    expect({
      rows: allRows(db),
      schema: db.query("SELECT * FROM sqlite_schema ORDER BY name").all(),
    }).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
}, 30_000);
