import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";

const MIGRATION = "0045_expand_card_settlement_commands.sql";
const TABLES = ["change_plans", "approvals", "operation_receipts", "decision_outbox"];
const OLD_KINDS = [
  "identity.assign",
  "identity.release-override",
  "relation.accept",
  "relation.reject",
];
const NEW_KINDS = ["card-settlement.accept", "card-settlement.reject", "card-settlement.withdraw"];
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
function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((f) => f < MIGRATION))
    apply(db, file);
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
    if (id === 1) continue;
    db.run("UPDATE change_plans SET status=? WHERE plan_id=?", [
      id === 2 ? "committed" : "rejected",
      planId(id),
    ]);
    db.run("UPDATE operation_receipts SET status=?,published_at=? WHERE operation_id=?", [
      id === 2 ? "published" : "failed",
      id === 2 ? "published" : null,
      `operation-${id}`,
    ]);
    if (id === 2) db.run("UPDATE decision_outbox SET processed_at='completed' WHERE id=?", [id]);
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
  }));
}

test("0045 preserves every historical field, guard and FK with enforcement on at every statement", () => {
  const db = fixture();
  try {
    const before = { rows: rows(db), guards: guards(db), shape: shape(db) };
    apply(db, MIGRATION, () => {
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    expect({ rows: rows(db), guards: guards(db), shape: shape(db) }).toEqual(before);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name LIKE '%_expanded%'").all()).toEqual(
      [],
    );
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally {
    db.close();
  }
}, 30_000);

test("0045 permits only the three additional command kinds and keeps exact plan references", () => {
  const db = fixture();
  try {
    for (const kind of NEW_KINDS) expect(() => insertPlan(db, 10, kind)).toThrow();
    apply(db, MIGRATION);
    for (const [index, kind] of [...OLD_KINDS, ...NEW_KINDS].entries()) {
      insertPlan(db, index + 10, kind);
      insertReceipt(db, index + 10, kind);
    }
    insertPlan(db, 101, "identity.assign");
    for (const kind of ["card-settlement", "card-settlement.delete", "other"]) {
      expect(() => insertPlan(db, 100, kind)).toThrow();
      expect(() => insertReceipt(db, 101, kind)).toThrow();
    }
    expect(() => insertReceipt(db, 200, "card-settlement.accept")).toThrow("FOREIGN KEY");
  } finally {
    db.close();
  }
}, 30_000);

test("0045 keeps append-only history and forward-only approval/publication/progress guards", () => {
  const db = fixture();
  try {
    apply(db, MIGRATION);
    for (const table of TABLES) {
      expect(() => db.run(`DELETE FROM ${table}`)).toThrow();
      expect(() => db.run(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow();
    }
    expect(() => db.run("UPDATE change_plans SET payload_json='{}'")).toThrow();
    expect(() =>
      db.run("UPDATE change_plans SET status='planned' WHERE plan_id=?", [planId(2)]),
    ).toThrow();
    expect(() => db.run("UPDATE approvals SET uses_remaining=uses_remaining+1")).toThrow();
    expect(() => db.run(`UPDATE operation_receipts SET result_json='{"changed":true}'`)).toThrow();
    expect(() =>
      db.run("UPDATE operation_receipts SET status='accepted' WHERE operation_id='operation-2'"),
    ).toThrow();
    expect(() =>
      db.run("UPDATE decision_outbox SET processed_at='done',evidence_ref=NULL WHERE id=1"),
    ).toThrow();
    expect(() =>
      db.run("UPDATE decision_outbox SET required_source_revision=9 WHERE id=1"),
    ).toThrow();
    expect(() => db.run("UPDATE decision_outbox SET pending_polls=0 WHERE id=1")).toThrow();
    expect(() => db.run("UPDATE decision_outbox SET processed_at=NULL WHERE id=2")).toThrow();
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

test("an interrupted replacement rolls back the entire schema and historical graph", () => {
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
