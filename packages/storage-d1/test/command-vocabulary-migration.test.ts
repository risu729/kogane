// 0051 rebuilds the four command tables to widen the kind CHECK (ADR 0017).
// These tests seed a store migrated through 0050 with synthetic history of
// every existing kind and status, apply 0051 statement by statement with
// foreign keys on, and prove that nothing but the CHECK changed.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";

const MIGRATION = "0051_card_purchase_review_commands.sql";
const TABLES = ["change_plans", "approvals", "operation_receipts", "decision_outbox"];
const OLD_KINDS = [
  "identity.assign",
  "identity.release-override",
  "relation.accept",
  "relation.reject",
  "card-settlement.accept",
  "card-settlement.reject",
  "card-settlement.withdraw",
];
const NEW_KINDS = [
  "card-purchase.exclude",
  "card-purchase.restore",
  "card-refund.allocate",
  "card-refund.withdraw",
  "card-installment.link",
  "card-installment.unlink",
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
/** Every CORE migration from 0017 through 0050, then synthetic history of every kind. */
function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const earlier = migrationFiles(CORE_MIGRATIONS_URL).filter((f) => f < MIGRATION);
  expect(earlier.at(-1)).toBe("0050_statement_fact_indexes.sql");
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
function rows(db: Database) {
  return Object.fromEntries(
    [...TABLES, "decision_revisions"].map((table) => [
      table,
      db.query(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
  );
}
function guards(db: Database) {
  return db
    .query(
      "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE type IN ('trigger','index') ORDER BY name",
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

test("0051 preserves every historical row, guard and FK with enforcement on at every statement", () => {
  const db = fixture();
  try {
    const before = { rows: rows(db), guards: guards(db), shape: shape(db) };
    const beforeSql = tableSql(db, false);
    expect(before.guards.length).toBeGreaterThan(0);
    for (const table of TABLES)
      expect((before.rows[table] as unknown[]).length).toBe(OLD_KINDS.length);
    apply(db, MIGRATION, () => {
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    // Rows, every index and trigger (byte-identical SQL) and the column/FK shape.
    expect({ rows: rows(db), guards: guards(db), shape: shape(db) }).toEqual(before);
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

test("0051 accepts exactly the six card review kinds and refuses unknown ones", () => {
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
    for (const kind of [
      "card-purchase",
      "card-purchase.delete",
      "card-refund.merge",
      "card-installment.relink",
      "payment.send",
      "other",
    ]) {
      expect(() => insertPlan(db, 200, kind)).toThrow("CHECK");
      expect(() => insertReceipt(db, 201, kind)).toThrow("CHECK");
    }
    expect(() => insertReceipt(db, 300, "card-purchase.exclude")).toThrow("FOREIGN KEY");
  } finally {
    db.close();
  }
}, 30_000);

test("0051 keeps append-only history and forward-only approval/publication/progress guards", () => {
  const db = fixture();
  try {
    apply(db, MIGRATION);
    for (const table of TABLES) {
      expect(() => db.run(`DELETE FROM ${table}`)).toThrow();
      expect(() => db.run(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow();
    }
    expect(() => db.run("UPDATE change_plans SET payload_json='{}'")).toThrow(
      "change plan is immutable except its status",
    );
    expect(() =>
      db.run("UPDATE change_plans SET kind='card-purchase.exclude' WHERE plan_id=?", [planId(1)]),
    ).toThrow("change plan is immutable except its status");
    expect(() =>
      db.run("UPDATE change_plans SET status='planned' WHERE plan_id=?", [planId(2)]),
    ).toThrow("change plan is immutable except its status");
    expect(() => db.run("UPDATE approvals SET uses_remaining=uses_remaining+1")).toThrow(
      "approval is immutable except spending one use",
    );
    expect(() => db.run(`UPDATE operation_receipts SET result_json='{"changed":true}'`)).toThrow(
      "operation receipt is immutable except its publication state",
    );
    expect(() =>
      db.run("UPDATE operation_receipts SET status='accepted' WHERE operation_id='operation-2'"),
    ).toThrow("operation receipt is immutable except its publication state");
    expect(() =>
      db.run("UPDATE decision_outbox SET processed_at='done',evidence_ref=NULL WHERE id=1"),
    ).toThrow("an outbox row is processed only with its completion evidence");
    expect(() =>
      db.run("UPDATE decision_outbox SET required_source_revision=9 WHERE id=1"),
    ).toThrow("an outbox row is processed only with its completion evidence");
    expect(() => db.run("UPDATE decision_outbox SET pending_polls=0 WHERE id=1")).toThrow(
      "an outbox row is processed only with its completion evidence",
    );
    expect(() => db.run("UPDATE decision_outbox SET processed_at=NULL WHERE id=2")).toThrow(
      "decision outbox row is immutable except its processing state",
    );
    // A plan of a new kind is guarded like every other one.
    insertPlan(db, 400, "card-refund.allocate");
    expect(() => insertPlan(db, 400, "card-refund.allocate")).toThrow(
      "change plan replacement is forbidden",
    );
    db.run("UPDATE approvals SET uses_remaining=uses_remaining-1 WHERE approval_id='approval-1'");
    db.run("UPDATE change_plans SET status='approved' WHERE plan_id=?", [planId(1)]);
    db.run(
      "UPDATE operation_receipts SET status='published',published_at='now' WHERE operation_id='operation-1'",
    );
    db.run("UPDATE decision_outbox SET processed_at='now' WHERE id=1");
  } finally {
    db.close();
  }
}, 30_000);

test("an interrupted 0051 rolls back the entire schema and historical graph", () => {
  const db = fixture();
  try {
    const before = {
      rows: rows(db),
      guards: guards(db),
      shape: shape(db),
      schema: db.query("SELECT * FROM sqlite_schema ORDER BY name").all(),
    };
    expect(() =>
      apply(db, MIGRATION, (sql) => {
        if (sql.includes("DROP TABLE change_plans"))
          throw new Error("synthetic interrupted migration");
      }),
    ).toThrow("synthetic interrupted migration");
    expect({
      rows: rows(db),
      guards: guards(db),
      shape: shape(db),
      schema: db.query("SELECT * FROM sqlite_schema ORDER BY name").all(),
    }).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
}, 30_000);
