// CORE 0075 (ADR 0064): the common audit record and its overflow counters.
// These tests apply every migration and prove the table's own guards: it is
// append-only, every column refuses free text, the optional columns are set
// exactly where the ADR says, the two unique partial indexes hold, and an
// audit write never moves the CORE source revision. Every row is synthetic.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { CORE_MIGRATIONS_URL, migrationFiles } from "../src/migrations.ts";
import { fullCoreDatabase } from "./sqlite.ts";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const MIGRATION = "0075_audit_records.sql";
const FREE_TEXT = "Free text ¥123,456 eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj";
let sequence = 0;
function auditId(): string {
  sequence += 1;
  return `aud_${sequence.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

/** A valid `read` record; `overrides` replaces columns by name. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    audit_id: auditId(),
    recorded_at: "2026-10-09T01:02:03.004Z",
    path: "ui",
    subject: "operator@synthetic.test",
    principal: "operator@synthetic.test",
    principal_kind: "human",
    delegation_ref: null,
    operation: "command.simulate",
    risk_class: "R0",
    step: "call",
    scope_namespace: null,
    scope_source: null,
    target_ref: null,
    result: "read",
    result_code: null,
    reason_code: null,
    correlation_id: "11111111-2222-4333-8444-555555555555",
    idempotency_key: null,
    payload_digest: null,
    confirmation_digest: null,
    confirm_expires_at: null,
    confirms_audit_id: null,
    reverts_audit_id: null,
    refs_json: "[]",
    diff_json: '{"kind":"read","rows":1,"truncated":false}',
    ...overrides,
  };
}

function insert(db: Database, values: Record<string, unknown>, verb = "INSERT"): void {
  const columns = Object.keys(values);
  db.run(
    `${verb} INTO audit_records(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    Object.values(values) as never[],
  );
}

describe("CORE 0075", () => {
  test("is a CORE migration and creates both tables STRICT", () => {
    expect(migrationFiles(CORE_MIGRATIONS_URL)).toContain(MIGRATION);
    const db = fullCoreDatabase();
    for (const table of ["audit_records", "audit_overflow_counters"])
      expect(
        (
          db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
            sql: string;
          }
        ).sql,
      ).toMatch(/\) STRICT$/u);
  });

  test("audit records are append-only: no update, delete or replace", () => {
    const db = fullCoreDatabase();
    const first = row();
    insert(db, first);
    expect(() => db.run("UPDATE audit_records SET result='refused'")).toThrow(
      "audit records are append-only",
    );
    expect(() => db.run("DELETE FROM audit_records")).toThrow("audit records are append-only");
    expect(() => insert(db, { ...first, operation: "command.plan" }, "INSERT OR REPLACE")).toThrow(
      "audit record replacement is forbidden",
    );
    expect(db.query("SELECT operation FROM audit_records").all()).toEqual([
      { operation: "command.simulate" },
    ]);
  });

  test("the schema admits no free-text column: every TEXT column refuses free text", () => {
    const db = fullCoreDatabase();
    const columns = (
      db.query("SELECT name,type FROM pragma_table_info('audit_records')").all() as {
        name: string;
        type: string;
      }[]
    ).map((column) => {
      // Every column is TEXT (closed values) except none: there is no BLOB,
      // REAL or untyped column a writer could put anything into.
      expect(column.type).toBe("TEXT");
      return column.name;
    });
    expect(columns).toHaveLength(25);
    for (const column of columns) {
      const values =
        column === "refs_json"
          ? [JSON.stringify([FREE_TEXT])]
          : column === "diff_json"
            ? [
                JSON.stringify({ kind: "read", rows: 1, truncated: false, note: FREE_TEXT }),
                JSON.stringify({ kind: "read", rows: 1.5, truncated: false }),
                JSON.stringify({ kind: "read", rows: -1, truncated: false }),
                JSON.stringify({ kind: "read", "Has Space": 1 }),
                JSON.stringify({ kind: FREE_TEXT }),
                JSON.stringify([1]),
              ]
            : column === "confirms_audit_id" || column === "reverts_audit_id"
              ? [FREE_TEXT]
              : [FREE_TEXT, ""];
      for (const value of values)
        expect(() => insert(db, row({ [column]: value })), `${column}`).toThrow();
    }
    expect(db.query("SELECT count(*) AS n FROM audit_records").get()).toEqual({ n: 0 });
  });

  test("optional columns are set exactly where the record needs them", () => {
    const db = fullCoreDatabase();
    const refused = row({
      result: "refused",
      result_code: "subject_not_granted",
      diff_json: '{"kind":"none"}',
    });
    insert(db, refused);
    const invalid: Record<string, unknown>[] = [
      // A refusal needs its code; any other result carries none.
      row({ result: "refused", diff_json: '{"kind":"none"}' }),
      row({ result_code: "invalid_request" }),
      // A subject exactly on the subject paths, an automatic principal exactly off them.
      row({ subject: null }),
      row({ path: "alarm", principal_kind: "automatic" }),
      row({ path: "alarm", subject: null }),
      row({ principal_kind: "automatic" }),
      // A delegation reference exactly for a delegated principal.
      row({ principal_kind: "delegated" }),
      row({ delegation_ref: `dlg_${"a".repeat(64)}` }),
      // Scope columns together; prepare digests on `prepared` only; a confirm cites its prepare.
      row({ scope_namespace: "core-source" }),
      row({ scope_source: "sony-bank" }),
      row({ confirmation_digest: `cfm_${"a".repeat(64)}` }),
      // An applied confirm without the prepare it confirms; a citation off a confirm.
      row({ step: "confirm", result: "applied", diff_json: '{"kind":"none"}' }),
      row({ step: "confirm", result: "accepted", diff_json: '{"kind":"none"}' }),
      row({ confirms_audit_id: refused["audit_id"] }),
      row({ result: "overflow" }),
      row({ diff_json: '{"kind":"overflow","of":"read","count":1,"cap":2000}' }),
      // Shapes: time, id, correlation id, digest, key.
      row({ recorded_at: "2026-10-09T01:02:03Z" }),
      row({ recorded_at: "2026-10-09T25:02:03.004Z" }),
      row({ audit_id: "aud_not-a-uuid" }),
      row({ correlation_id: "not-a-uuid" }),
      row({ payload_digest: "A".repeat(64) }),
      row({ idempotency_key: "has space" }),
      row({ risk_class: "R5" }),
      row({ path: "cron" }),
    ];
    for (const values of invalid) expect(() => insert(db, values)).toThrow();
    // What the ADR allows does insert: a delegated principal with its reference,
    // a scoped record, an alarm record, an overflow record, and a refused
    // confirm with no matching prepare to cite (ADR 0064 amendment).
    insert(
      db,
      row({ principal_kind: "delegated", delegation_ref: `dlg_${"a".repeat(64)}`, path: "mcp" }),
    );
    insert(db, row({ scope_namespace: "schedule-source", scope_source: "sony-bank" }));
    insert(
      db,
      row({ path: "alarm", subject: null, principal: "alarm:vpass", principal_kind: "automatic" }),
    );
    insert(
      db,
      row({
        operation: "audit.overflow",
        result: "overflow",
        diff_json: '{"kind":"overflow","of":"read","count":3,"cap":2000}',
      }),
    );
    insert(
      db,
      row({
        operation: "schedules.job.update",
        risk_class: "R2",
        step: "confirm",
        result: "refused",
        result_code: "confirmation_invalid",
        diff_json: '{"kind":"none"}',
      }),
    );
    expect(db.query("SELECT count(*) AS n FROM audit_records").get()).toEqual({ n: 6 });
  });

  test("one applied record per caller key, and one per confirmed prepare", () => {
    const db = fullCoreDatabase();
    const applied = (overrides: Record<string, unknown> = {}) =>
      row({
        operation: "command.commit",
        risk_class: "R2",
        result: "applied",
        idempotency_key: "op-synthetic-1",
        target_ref: `plan:${"b".repeat(64)}`,
        diff_json: '{"kind":"none"}',
        ...overrides,
      });
    insert(db, applied());
    expect(() => insert(db, applied())).toThrow();
    expect(() => insert(db, applied({ result: "accepted" }))).toThrow();
    // A refusal or a replay under the same key is not an effect: allowed.
    insert(db, applied({ result: "refused", result_code: "idempotency_conflict" }));
    insert(db, applied({ result: "replayed" }));
    // Another principal's key, or another operation, is another key.
    insert(db, applied({ principal: "operator-two" }));
    insert(db, applied({ operation: "command.approve" }));
    // A confirm applies at most once (ADR 0063's two-step confirmation).
    const prepare = row({
      operation: "schedules.job.update",
      risk_class: "R2",
      step: "prepare",
      result: "prepared",
      confirmation_digest: `cfm_${"c".repeat(64)}`,
      confirm_expires_at: "2026-10-09T01:12:03.004Z",
      diff_json: '{"kind":"none"}',
    });
    insert(db, prepare);
    const confirm = () =>
      row({
        operation: "schedules.job.update",
        risk_class: "R2",
        step: "confirm",
        result: "applied",
        confirms_audit_id: prepare["audit_id"],
        diff_json: '{"kind":"none"}',
      });
    insert(db, confirm());
    expect(() => insert(db, confirm())).toThrow();
    // A confirm cites a record that exists.
    expect(() =>
      insert(db, { ...confirm(), confirms_audit_id: "aud_ffffffff-0000-4000-8000-000000000000" }),
    ).toThrow();
  });

  test("overflow counters are mutable bookkeeping with closed columns", () => {
    const db = fullCoreDatabase();
    const counter = (overrides: Record<string, unknown> = {}) => {
      const values = {
        day: "2026-10-09",
        principal: "agent-synthetic",
        path: "mcp",
        result: "read",
        subject: "agent-synthetic",
        principal_kind: "agent",
        count: 1,
        ...overrides,
      };
      db.run(
        `INSERT INTO audit_overflow_counters(${Object.keys(values).join(",")}) VALUES(${Object.keys(
          values,
        )
          .map(() => "?")
          .join(",")})`,
        Object.values(values) as never[],
      );
    };
    counter();
    expect(() => counter()).toThrow();
    for (const bad of [
      { day: "2026-13-01" },
      { day: FREE_TEXT },
      { path: "alarm" },
      { result: "applied" },
      { result: "prepared" },
      { principal_kind: "automatic" },
      { count: 0 },
      { subject: FREE_TEXT },
    ])
      expect(() => counter({ ...bad, principal: `p-${JSON.stringify(bad).length}` })).toThrow();
    db.run("UPDATE audit_overflow_counters SET count=count+1");
    db.run("DELETE FROM audit_overflow_counters");
    expect(db.query("SELECT count(*) AS n FROM audit_overflow_counters").get()).toEqual({ n: 0 });
  });

  test("an audit write never moves the CORE source revision", () => {
    const db = fullCoreDatabase();
    const revision = () => db.query("SELECT source_revision FROM core_source_revision").get();
    const before = revision();
    insert(db, row());
    db.run(`INSERT INTO audit_overflow_counters(day,principal,path,result,subject,principal_kind,count)
      VALUES('2026-10-09','agent-synthetic','mcp','read','agent-synthetic','agent',1)`);
    expect(revision()).toEqual(before);
  });
});
