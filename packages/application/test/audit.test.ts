// The common audit record (ADR 0064, plan S1) against the real CORE schema:
// the builder refuses anything outside the closed vocabulary, an effect record
// exists exactly when its writer's guard held, the answer records stay under
// the daily caps and overflow into one aggregate per day, the chokepoint
// records every outcome once and never changes an answer, and the operator's
// page filters before its limit. Every value here is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  aggregateAuditOverflow,
  appendAnswerRecord,
  AUDIT_DAILY_CAPS,
  AUDIT_PAGE_SQL,
  type AuditActor,
  type AuditRow,
  buildAuditRecord,
  executeOperation,
  OPERATION_CATALOGUE,
  OperationCall,
  readAuditPage,
  requestCollection,
  toolOperation,
} from "../src/index.ts";
import { auditEffectWrite, auditInsertWrite, newAuditId } from "../src/audit/record.ts";
import type { CommandStore, Principal } from "../src/command/contract.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const SUBJECT = "operator@synthetic.test";
const CORRELATION = "11111111-2222-4333-8444-555555555555";
const ACTOR: AuditActor = {
  path: "ui",
  subject: SUBJECT,
  principal: SUBJECT,
  principalKind: "human",
  correlationId: CORRELATION,
};
const AT = "2026-10-09T01:02:03.004Z";
/** A provider string with a token-shaped value and an amount in it: never to be stored. */
const PROVIDER_TEXT = "架空商店 eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.dG9rZW4 ¥123,456 98765.43";

function read(rows = 1): Parameters<typeof buildAuditRecord>[1] {
  return {
    operation: "financial.query",
    riskClass: "R0",
    result: "read",
    diff: { kind: "read", rows, truncated: false },
  };
}

function count(db: Database, where = "1=1", ...binds: (string | number)[]): number {
  return (
    db.query(`SELECT count(*) AS n FROM audit_records WHERE ${where}`).get(...binds) as {
      n: number;
    }
  ).n;
}

describe("the record builder", () => {
  test("refuses every field outside its closed shape, naming the field and never the value", () => {
    const refusals: [string, () => unknown][] = [
      ["subject", () => buildAuditRecord({ ...ACTOR, subject: PROVIDER_TEXT }, read(), AT)],
      ["principal", () => buildAuditRecord({ ...ACTOR, principal: PROVIDER_TEXT }, read(), AT)],
      ["operation", () => buildAuditRecord(ACTOR, { ...read(), operation: PROVIDER_TEXT }, AT)],
      [
        "result_code",
        () =>
          buildAuditRecord(
            ACTOR,
            { ...read(), result: "refused", resultCode: PROVIDER_TEXT, diff: { kind: "none" } },
            AT,
          ),
      ],
      [
        "result_code",
        () => buildAuditRecord(ACTOR, { ...read(), result: "refused", diff: { kind: "none" } }, AT),
      ],
      ["result_code", () => buildAuditRecord(ACTOR, { ...read(), resultCode: "invalid" }, AT)],
      ["reason_code", () => buildAuditRecord(ACTOR, { ...read(), reasonCode: "Free Text" }, AT)],
      ["target_ref", () => buildAuditRecord(ACTOR, { ...read(), targetRef: PROVIDER_TEXT }, AT)],
      [
        "scope",
        () =>
          buildAuditRecord(
            ACTOR,
            { ...read(), scope: { namespace: "core-source", source: PROVIDER_TEXT } },
            AT,
          ),
      ],
      [
        "idempotency_key",
        () => buildAuditRecord(ACTOR, { ...read(), idempotencyKey: PROVIDER_TEXT }, AT),
      ],
      ["payload_digest", () => buildAuditRecord(ACTOR, { ...read(), payloadDigest: "abc" }, AT)],
      [
        "diff_json",
        () =>
          buildAuditRecord(
            ACTOR,
            {
              ...read(),
              diff: { kind: "read", rows: 1, truncated: false, note: PROVIDER_TEXT } as never,
            },
            AT,
          ),
      ],
      [
        "diff_json",
        () =>
          buildAuditRecord(
            ACTOR,
            { ...read(), diff: { kind: "read", rows: 98765.43, truncated: false } },
            AT,
          ),
      ],
      [
        "diff_json",
        () =>
          buildAuditRecord(
            ACTOR,
            {
              ...read(),
              diff: { kind: "revision", from: 1, to: 2, fields: ["merchant" as never] },
            },
            AT,
          ),
      ],
      ["correlation_id", () => buildAuditRecord({ ...ACTOR, correlationId: "x" }, read(), AT)],
      ["recorded_at", () => buildAuditRecord(ACTOR, read(), "2026-10-09T01:02:03Z")],
    ];
    for (const [field, build] of refusals) {
      let caught: unknown;
      try {
        build();
      } catch (error) {
        caught = error;
      }
      expect(caught, field).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(`audit_record_invalid:${field}`);
      expect((caught as Error).message).not.toContain("eyJ");
    }
  });

  test("no delegation, prepare or confirm exists in this slice", () => {
    expect(() =>
      buildAuditRecord({ ...ACTOR, principalKind: "delegated" as never }, read(), AT),
    ).toThrow("audit_record_invalid:principal_kind");
    expect(() => buildAuditRecord(ACTOR, { ...read(), step: "prepare" }, AT)).toThrow(
      "audit_record_invalid:step",
    );
    expect(() => buildAuditRecord(ACTOR, { ...read(), step: "confirm" }, AT)).toThrow(
      "audit_record_invalid:step",
    );
    // A subject path never carries the Processor's automatic principal, and
    // the Processor's own paths never carry a subject.
    expect(() => buildAuditRecord({ ...ACTOR, principalKind: "automatic" }, read(), AT)).toThrow(
      "audit_record_invalid:principal_kind",
    );
    expect(() => buildAuditRecord({ ...ACTOR, path: "alarm" }, read(), AT)).toThrow(
      "audit_record_invalid:subject",
    );
  });

  test("references outside the closed patterns are dropped, never stored", () => {
    const row = buildAuditRecord(
      ACTOR,
      {
        ...read(),
        refs: [
          `plan:${"a".repeat(64)}`,
          PROVIDER_TEXT,
          "field:requestedScope.from",
          "field:Has Space",
          "decision:dr_synthetic",
          `op_${"b".repeat(64)}`,
        ],
      },
      AT,
    );
    expect(JSON.parse(row.refs_json)).toEqual([
      `plan:${"a".repeat(64)}`,
      "field:requestedScope.from",
      "decision:dr_synthetic",
      `op_${"b".repeat(64)}`,
    ]);
  });

  test("the catalogue is closed: every tool, route and writer names a catalogued operation", () => {
    for (const operation of Object.keys(OPERATION_CATALOGUE))
      expect(operation).toMatch(/^[a-z][a-z0-9.-]{0,63}$/u);
    expect(toolOperation("kogane.financial.query", "mcp")).toBe("financial.query");
    expect(toolOperation("kogane.ops.collection.request", "mcp")).toBe("ops.collection.request");
    // The operations tools are not served on the HTTP agent route, and the
    // transport refusal and the daily aggregate are not tools.
    expect(toolOperation("kogane.ops.collection.request", "agent-http")).toBeNull();
    expect(toolOperation("kogane.mcp.request", "mcp")).toBeNull();
    expect(toolOperation("kogane.audit.overflow", "mcp")).toBeNull();
    expect(toolOperation("kogane.audit.search", "mcp")).toBeNull();
    expect(toolOperation("financial.query", "mcp")).toBeNull();
  });
});

describe("the effect record joins its writer's guard", () => {
  const effect = (target: string, ref: string) =>
    buildAuditRecord(
      ACTOR,
      {
        operation: "schedules.job.update",
        riskClass: "R2",
        result: "applied",
        targetRef: target,
        refs: [ref],
        diff: { kind: "revision", from: 1, to: 2, fields: ["enabled"] },
      },
      AT,
      newAuditId(),
    );
  const holds = { sql: "EXISTS(SELECT 1 FROM sources WHERE id=?)", binds: ["sony-bank"] };
  const fails = { sql: "EXISTS(SELECT 1 FROM sources WHERE id=?)", binds: ["no-such-source"] };

  test("a guard that holds writes the record; one that matches no row writes none", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    const [none] = await store.batch([
      auditEffectWrite(effect("schedule:vpass", "schedule:vpass@2"), fails, {
        kind: "target-ref",
        ref: "schedule:vpass@2",
      }),
    ]);
    expect(none?.changes).toBe(0);
    const [one] = await store.batch([
      auditEffectWrite(effect("schedule:vpass", "schedule:vpass@2"), holds, {
        kind: "target-ref",
        ref: "schedule:vpass@2",
      }),
    ]);
    expect(one?.changes).toBe(1);
    expect(count(db)).toBe(1);
  });

  test("a second batch that saw the same effect adds no second record; another revision does", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    for (const [ref, expected] of [
      ["schedule:vpass@2", 1],
      ["schedule:vpass@2", 0],
      ["schedule:vpass@3", 1],
    ] as const) {
      const [written] = await store.batch([
        auditEffectWrite(effect("schedule:vpass", ref), holds, { kind: "target-ref", ref }),
      ]);
      expect(written?.changes).toBe(expected);
    }
    // `target`: one per target and operation; `each`: every effect its own.
    const once = (kind: "target" | "each") =>
      auditEffectWrite(effect("collection-lease:vpass", "schedule:vpass@9"), holds, { kind });
    expect((await store.batch([once("target")]))[0]?.changes).toBe(1);
    expect((await store.batch([once("target")]))[0]?.changes).toBe(0);
    expect((await store.batch([once("each")]))[0]?.changes).toBe(1);
    expect(count(db)).toBe(4);
  });

  test("a statement error rolls the record back with the effect", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    const before = count(db);
    await expect(
      store.batch([
        auditEffectWrite(effect("schedule:vpass", "schedule:vpass@2"), holds, {
          kind: "target-ref",
          ref: "schedule:vpass@2",
        }),
        // Refused by its CHECK: the whole batch, record included, is rolled back.
        { sql: "INSERT INTO audit_overflow_counters(day) VALUES('not-a-day')", binds: [] },
      ]),
    ).rejects.toThrow();
    expect(count(db)).toBe(before);
  });

  test("an answer result is never written as an effect, nor an effect as an answer", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    expect(() =>
      auditEffectWrite(buildAuditRecord(ACTOR, read(), AT), holds, { kind: "each" }),
    ).toThrow("audit_record_invalid:result");
    await expect(
      appendAnswerRecord(store, effect("schedule:vpass", "schedule:vpass@2")),
    ).rejects.toThrow();
  });
});

describe("daily caps and the overflow aggregate (delegation matrix item 13)", () => {
  const actor = (principal: string): AuditActor => ({
    ...ACTOR,
    path: "mcp",
    principal,
    subject: principal,
    principalKind: "agent",
  });
  const refused: Parameters<typeof buildAuditRecord>[1] = {
    operation: "financial.query",
    riskClass: "R0",
    result: "refused",
    resultCode: "evidence_restricted",
    diff: { kind: "none" },
  };

  test("the 2,001st read is served but only counted; the 501st refusal likewise", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    for (let index = 0; index < AUDIT_DAILY_CAPS.read; index++)
      expect(await appendAnswerRecord(store, buildAuditRecord(actor("agent-a"), read(), AT))).toBe(
        "recorded",
      );
    for (let index = 0; index < 3; index++)
      expect(await appendAnswerRecord(store, buildAuditRecord(actor("agent-a"), read(), AT))).toBe(
        "overflow",
      );
    expect(count(db, "principal='agent-a' AND result='read'")).toBe(AUDIT_DAILY_CAPS.read);
    for (let index = 0; index < AUDIT_DAILY_CAPS.refused + 2; index++)
      await appendAnswerRecord(store, buildAuditRecord(actor("agent-a"), refused, AT));
    expect(count(db, "principal='agent-a' AND result='refused'")).toBe(AUDIT_DAILY_CAPS.refused);
    expect(
      db
        .query(
          "SELECT day,principal,path,result,count FROM audit_overflow_counters ORDER BY result",
        )
        .all(),
    ).toEqual([
      { day: "2026-10-09", principal: "agent-a", path: "mcp", result: "read", count: 3 },
      { day: "2026-10-09", principal: "agent-a", path: "mcp", result: "refused", count: 2 },
    ]);
    // Caps are per principal and per day.
    expect(await appendAnswerRecord(store, buildAuditRecord(actor("agent-b"), read(), AT))).toBe(
      "recorded",
    );
    expect(
      await appendAnswerRecord(
        store,
        buildAuditRecord(actor("agent-a"), read(), "2026-10-10T00:00:00.000Z"),
      ),
    ).toBe("recorded");
    // An applied record is never capped: a writer's effect record still lands.
    const applied = buildAuditRecord(
      actor("agent-a"),
      {
        operation: "reconcile.propose",
        riskClass: "R1",
        result: "applied",
        targetRef: `proposal:${"c".repeat(32)}`,
        diff: { kind: "decision", decisionRevisions: 1, commitSeq: null, counts: { targets: 3 } },
      },
      AT,
    );
    const [written] = await store.batch([
      auditEffectWrite(applied, { sql: "1=1", binds: [] }, { kind: "target" }),
    ]);
    expect(written?.changes).toBe(1);
  }, 60_000);

  test("past the prepared cap a prepare is not recorded and must be refused", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    // No path of this slice prepares (ADR 0063, plan S3); the store's cap is
    // exercised with synthetic prepared rows of the table's own shape.
    const prepared = (): AuditRow => ({
      ...buildAuditRecord(actor("agent-p"), read(), AT),
      result: "prepared",
      step: "prepare",
      diff_json: '{"kind":"none"}',
      confirmation_digest: `cfm_${"d".repeat(64)}` as never,
      confirm_expires_at: "2026-10-09T01:12:03.004Z" as never,
    });
    for (let index = 0; index < AUDIT_DAILY_CAPS.prepared; index++)
      expect(await appendAnswerRecord(store, prepared())).toBe("recorded");
    expect(await appendAnswerRecord(store, prepared())).toBe("cap_reached");
    expect(count(db, "result='prepared'")).toBe(AUDIT_DAILY_CAPS.prepared);
    expect(db.query("SELECT count(*) AS n FROM audit_overflow_counters").get()).toEqual({ n: 0 });
  }, 60_000);

  test("the next day's first tick writes one overflow record per counter with the exact count; a second tick none", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    db.run(`INSERT INTO audit_overflow_counters(day,principal,path,result,subject,principal_kind,count)
      VALUES('2026-10-09','agent-a','mcp','read','agent-a','agent',7),
            ('2026-10-09','agent-a','mcp','refused','agent-a','agent',2),
            ('2026-10-10','agent-a','mcp','read','agent-a','agent',4)`);
    // Same day: nothing ended, nothing written.
    expect(await aggregateAuditOverflow(store, new Date("2026-10-09T23:59:59.999Z"))).toEqual({
      counters: 0,
      written: 0,
    });
    expect(await aggregateAuditOverflow(store, new Date("2026-10-10T00:05:00.000Z"))).toEqual({
      counters: 2,
      written: 2,
    });
    const rows = db
      .query(
        "SELECT path,subject,principal,principal_kind,operation,result,diff_json FROM audit_records ORDER BY diff_json",
      )
      .all();
    expect(rows).toEqual([
      {
        path: "mcp",
        subject: "agent-a",
        principal: "agent-a",
        principal_kind: "agent",
        operation: "audit.overflow",
        result: "overflow",
        diff_json: '{"kind":"overflow","of":"read","count":7,"cap":2000}',
      },
      {
        path: "mcp",
        subject: "agent-a",
        principal: "agent-a",
        principal_kind: "agent",
        operation: "audit.overflow",
        result: "overflow",
        diff_json: '{"kind":"overflow","of":"refused","count":2,"cap":500}',
      },
    ]);
    // The ended day's counters are gone; today's stays for its own next day.
    expect(db.query("SELECT day FROM audit_overflow_counters").all()).toEqual([
      { day: "2026-10-10" },
    ]);
    expect(await aggregateAuditOverflow(store, new Date("2026-10-10T00:10:00.000Z"))).toEqual({
      counters: 0,
      written: 0,
    });
    expect(count(db)).toBe(2);
  });

  test("a counter that moved between the read and the batch is left for the next tick", async () => {
    const db = migratedDatabase();
    const inner = sqliteCommandStore(db);
    db.run(`INSERT INTO audit_overflow_counters(day,principal,path,result,subject,principal_kind,count)
      VALUES('2026-10-09','agent-a','mcp','read','agent-a','agent',7)`);
    const moving: CommandStore = {
      ...inner,
      batch: async (writes) => {
        db.run("UPDATE audit_overflow_counters SET count=count+1");
        return inner.batch(writes);
      },
    };
    expect(await aggregateAuditOverflow(moving, new Date("2026-10-10T00:05:00.000Z"))).toEqual({
      counters: 1,
      written: 0,
    });
    expect(count(db)).toBe(0);
    expect(await aggregateAuditOverflow(inner, new Date("2026-10-10T00:10:00.000Z"))).toEqual({
      counters: 1,
      written: 1,
    });
    expect(
      JSON.parse(
        (db.query("SELECT diff_json FROM audit_records").get() as { diff_json: string }).diff_json,
      ),
    ).toMatchObject({ count: 8 });
  });
});

describe("executeOperation", () => {
  function context(db: Database, failures: string[] = []) {
    const store = sqliteCommandStore(db);
    return {
      path: "ui" as const,
      subject: SUBJECT,
      correlationId: CORRELATION,
      sink: { append: (row: AuditRow) => appendAnswerRecord(store, row) },
      onWriteFailure: () => failures.push("audit_write_failed"),
      clock: () => new Date(AT),
    };
  }
  const refusal = new Error("synthetic refusal");

  test("a refusal is recorded once with its closed code and rethrown unchanged", async () => {
    const db = migratedDatabase();
    await expect(
      executeOperation(context(db), "command.commit", () => Promise.reject(refusal), {
        value: () => ({ result: "effect" }),
        error: () => ({
          result: "refused",
          code: "approval_required",
          fields: ["planId", "Not A Field", PROVIDER_TEXT],
        }),
      }),
    ).rejects.toBe(refusal);
    expect(
      db
        .query(
          "SELECT path,subject,principal,principal_kind,operation,risk_class,result,result_code,target_ref,refs_json,correlation_id FROM audit_records",
        )
        .all(),
    ).toEqual([
      {
        path: "ui",
        subject: SUBJECT,
        principal: SUBJECT,
        principal_kind: "human",
        operation: "command.commit",
        risk_class: "R2",
        result: "refused",
        result_code: "approval_required",
        target_ref: null,
        refs_json: '["field:planId"]',
        correlation_id: CORRELATION,
      },
    ]);
  });

  test("a read records its row count, a quiet write its replay, an effect nothing more", async () => {
    const db = migratedDatabase();
    expect(
      await executeOperation(context(db), "command.simulate", async () => "answer", {
        value: () => ({ result: "read", rows: 1, truncated: false }),
        error: () => ({ result: "failed", code: "internal_error" }),
      }),
    ).toBe("answer");
    // A classifier cannot upgrade a write that wrote nothing into a read.
    await executeOperation(context(db), "command.plan", async () => null, {
      value: () => ({ result: "read", rows: 1, truncated: false }),
      error: () => ({ result: "failed", code: "internal_error" }),
    });
    await executeOperation(context(db), "command.plan", async () => null, {
      value: () => ({ result: "effect" }),
      error: () => ({ result: "failed", code: "internal_error" }),
    });
    expect(
      db.query("SELECT operation,result,diff_json FROM audit_records ORDER BY rowid").all(),
    ).toEqual([
      {
        operation: "command.simulate",
        result: "read",
        diff_json: '{"kind":"read","rows":1,"truncated":false}',
      },
      { operation: "command.plan", result: "replayed", diff_json: '{"kind":"none"}' },
    ]);
  });

  test("a grade after the call starts is what the record names; a call the writer recorded is not recorded again", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    await executeOperation(
      context(db),
      "ops.projection.request",
      async (call: OperationCall) => {
        call.grade("ops-operator", "human");
        const write = call.effect(
          { targetRef: `op_${"e".repeat(64)}`, diff: { kind: "request", status: "accepted" } },
          { sql: "1=1", binds: [] },
          { kind: "target" },
        );
        const [result] = await store.batch([write]);
        call.settle(result?.changes);
        return call.recorded;
      },
      { value: () => ({ result: "replayed" }), error: () => ({ result: "failed", code: "x" }) },
    );
    expect(
      db.query("SELECT principal,result,step,correlation_id FROM audit_records").all(),
    ).toEqual([
      { principal: "ops-operator", result: "accepted", step: "call", correlation_id: CORRELATION },
    ]);
  });

  test("recording never changes the answer: a failed write is reported, not thrown", async () => {
    const db = migratedDatabase();
    const failures: string[] = [];
    const broken = {
      ...context(db, failures),
      sink: { append: () => Promise.reject(new Error("synthetic D1 outage")) },
    };
    expect(
      await executeOperation(broken, "financial.query", async () => 42, {
        value: () => ({ result: "read", rows: 3, truncated: false }),
        error: () => ({ result: "failed", code: "internal_error" }),
      }),
    ).toBe(42);
    await expect(
      executeOperation(broken, "financial.query", () => Promise.reject(refusal), {
        value: () => ({ result: "read", rows: 3, truncated: false }),
        error: () => ({ result: "refused", code: "evidence_restricted" }),
      }),
    ).rejects.toBe(refusal);
    // A subject the record cannot hold is reported the same way.
    await executeOperation(
      { ...context(db, failures), subject: PROVIDER_TEXT },
      "financial.query",
      async () => 1,
      {
        value: () => ({ result: "read", rows: 1, truncated: false }),
        error: () => ({ result: "failed", code: "internal_error" }),
      },
    );
    expect(failures).toEqual(["audit_write_failed", "audit_write_failed", "audit_write_failed"]);
    expect(count(db)).toBe(0);
  });
});

describe("an operations request records its acceptance in its own batch", () => {
  const OPERATOR: Principal = {
    id: "ops-operator",
    kind: "human",
    verification: "server",
    capabilities: ["interpretation.propose", "interpretation.accept"],
  };
  const NOW = "2026-10-09T00:00:00Z";
  const request = {
    source: "sony-bank",
    requestedScope: { from: "2026-01-01", to: "2026-01-31" },
    idempotencyKey: "audit-synthetic",
  };
  const call = () =>
    new OperationCall("ops.collection.request", { ...ACTOR, principal: OPERATOR.id });

  test("accepted once; a re-send writes no effect record", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    const first = call();
    const accepted = await requestCollection({
      store,
      principal: OPERATOR,
      now: NOW,
      request,
      audit: first,
    });
    expect(accepted.ok && !accepted.replayed).toBe(true);
    expect(first.recorded).toBe(true);
    const second = call();
    const replayed = await requestCollection({
      store,
      principal: OPERATOR,
      now: NOW,
      request,
      audit: second,
    });
    expect(replayed.ok && replayed.replayed).toBe(true);
    expect(second.recorded).toBe(false);
    expect(
      db
        .query(
          "SELECT operation,result,target_ref,scope_namespace,scope_source,idempotency_key,diff_json FROM audit_records",
        )
        .all(),
    ).toEqual([
      {
        operation: "ops.collection.request",
        result: "accepted",
        target_ref: accepted.ok ? accepted.receipt.operationId : null,
        scope_namespace: "core-source",
        scope_source: "sony-bank",
        idempotency_key: "audit-synthetic",
        diff_json: '{"kind":"request","status":"accepted"}',
      },
    ]);
  });

  test("a batch that raises leaves neither the request nor its record", async () => {
    const db = migratedDatabase();
    const inner = sqliteCommandStore(db);
    const raising: CommandStore = {
      ...inner,
      batch: (writes) =>
        inner.batch([
          ...writes,
          { sql: "INSERT INTO audit_overflow_counters(day) VALUES('x')", binds: [] },
        ]),
    };
    const audit = call();
    await expect(
      requestCollection({ store: raising, principal: OPERATOR, now: NOW, request, audit }),
    ).rejects.toThrow();
    expect(audit.recorded).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM ops_requests").get()).toEqual({ n: 0 });
    expect(count(db)).toBe(0);
  });

  test("two raced senders of one key write one request and one record", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    // Both read "no such operation" before either writes: the loser's insert
    // matches no row, and its record statement finds the winner's record.
    let reads = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing: CommandStore = {
      ...store,
      first: async (sql, binds) => {
        const row = await store.first(sql, binds);
        if (sql.includes("FROM ops_requests") && row === null && ++reads === 2) release();
        return row as never;
      },
      batch: async (writes) => {
        await bothRead;
        return store.batch(writes);
      },
    };
    const [a, b] = [call(), call()];
    const [first, second] = await Promise.all([
      requestCollection({ store: racing, principal: OPERATOR, now: NOW, request, audit: a }),
      requestCollection({ store: racing, principal: OPERATOR, now: NOW, request, audit: b }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    expect([a.recorded, b.recorded].filter(Boolean)).toHaveLength(1);
    expect(db.query("SELECT count(*) AS n FROM ops_requests").get()).toEqual({ n: 1 });
    expect(count(db)).toBe(1);
  });
});

describe("the operator's page", () => {
  function seed(db: Database) {
    const store = sqliteCommandStore(db);
    const writes = [];
    for (let index = 0; index < 120; index++) {
      const at = new Date(Date.parse("2026-10-09T00:00:00.000Z") + index * 1000).toISOString();
      writes.push(
        auditInsertWrite(
          buildAuditRecord(
            ACTOR,
            index % 2 === 0
              ? read(index)
              : {
                  operation: "command.plan",
                  riskClass: "R1",
                  result: "replayed",
                  diff: { kind: "none" },
                },
            at,
          ),
        ),
      );
    }
    return store.batch(writes);
  }

  test("filters before the limit, pages by a cursor bound to its filters, and returns no total", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    await seed(db);
    const first = await readAuditPage(store, { operation: "financial.query" }, null);
    if (!first.ok) throw new Error("unreachable");
    expect(first.records).toHaveLength(50);
    expect(first.records.every((record) => record.operation === "financial.query")).toBe(true);
    expect(first.records[0]!.recordedAt > first.records[49]!.recordedAt).toBe(true);
    expect(Object.keys(first).sort()).toEqual(["cursor", "ok", "records"]);
    const second = await readAuditPage(store, { operation: "financial.query" }, first.cursor);
    if (!second.ok) throw new Error("unreachable");
    expect(second.records).toHaveLength(10);
    expect(second.cursor).toBeNull();
    const ids = new Set([...first.records, ...second.records].map((record) => record.auditId));
    expect(ids.size).toBe(60);
    // A cursor is bound to the filters it was issued under.
    expect(await readAuditPage(store, { operation: "command.plan" }, first.cursor)).toEqual({
      ok: false,
      code: "stale_context",
    });
    expect(await readAuditPage(store, {}, "not-a-cursor!")).toEqual({
      ok: false,
      code: "invalid_query",
    });
    // A day range is inclusive of both days.
    const day = await readAuditPage(
      store,
      { from: "2026-10-09", to: "2026-10-09", result: "replayed" },
      null,
    );
    expect(day.ok && day.records.length).toBe(50);
    const other = await readAuditPage(store, { from: "2026-10-10" }, null);
    expect(other.ok && other.records.length).toBe(0);
  });

  test("query plans read through the audit indexes, without table statistics", () => {
    const db = migratedDatabase();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'").get(),
    ).toEqual({ n: 0 });
    const plan = (sql: string, binds: unknown[]) =>
      (
        db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[]
      ).map((row) => row.detail);
    // The page: newest first through the time index, no sort.
    const page = plan(AUDIT_PAGE_SQL, [null, null, null, null, null, null, null, null, 51]);
    expect(page.join("\n")).toContain("audit_records_by_time");
    expect(page.join("\n")).not.toContain("TEMP B-TREE");
    // The daily cap's count: the principal's own records of the day.
    const capped = plan(
      "SELECT count(*) FROM audit_records WHERE principal=? AND result=? AND recorded_at>=? AND recorded_at<?",
      ["a", "read", "2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z"],
    );
    expect(capped.join("\n")).toContain("audit_records_by_principal");
    // The one-record-per-effect check of an effect statement: by target.
    const row = buildAuditRecord(
      ACTOR,
      {
        operation: "schedules.job.update",
        riskClass: "R2",
        result: "applied",
        targetRef: "schedule:vpass",
        refs: ["schedule:vpass@2"],
        diff: { kind: "revision", from: 1, to: 2, fields: [] },
      },
      AT,
    );
    const write = auditEffectWrite(
      row,
      { sql: "1=1", binds: [] },
      {
        kind: "target-ref",
        ref: "schedule:vpass@2",
      },
    );
    const effect = plan(write.sql.replace(/^INSERT INTO audit_records\([^)]*\) /u, ""), [
      ...write.binds,
    ]);
    expect(effect.join("\n")).toContain("audit_records_by_target");
    expect(effect.join("\n")).not.toMatch(/SCAN a\b/u);
    // The overflow tick: ended days through the counter table's key.
    const tick = plan(
      "SELECT day,principal,path,result,subject,principal_kind,count FROM audit_overflow_counters WHERE day<?1 ORDER BY day,principal,path,result LIMIT ?2",
      ["2026-10-10", 100],
    );
    expect(tick.join("\n")).toMatch(/SEARCH audit_overflow_counters USING (?:INDEX|PRIMARY KEY)/u);
    expect(tick.join("\n")).not.toContain("TEMP B-TREE");
  });
});

describe("the operator's page seeks the time index", () => {
  // The page text as this slice first wrote it: every bound behind `IS NULL
  // OR`, which the planner can only walk from the newest record. Frozen here
  // so the range form that replaced it is proven to answer the same rows.
  const FIRST_PAGE_SQL = `SELECT ${[
    "audit_id",
    "recorded_at",
    "path",
    "subject",
    "principal",
    "principal_kind",
    "delegation_ref",
    "operation",
    "risk_class",
    "step",
    "scope_namespace",
    "scope_source",
    "target_ref",
    "result",
    "result_code",
    "reason_code",
    "correlation_id",
    "idempotency_key",
    "payload_digest",
    "confirmation_digest",
    "confirm_expires_at",
    "confirms_audit_id",
    "reverts_audit_id",
    "refs_json",
    "diff_json",
  ].join(",")} FROM audit_records
  WHERE (?1 IS NULL OR operation=?1) AND (?2 IS NULL OR path=?2)
    AND (?3 IS NULL OR principal_kind=?3) AND (?4 IS NULL OR result=?4)
    AND (?5 IS NULL OR recorded_at>=?5) AND (?6 IS NULL OR recorded_at<?6)
    AND (?7 IS NULL OR recorded_at<?7 OR (recorded_at=?7 AND audit_id<?8))
  ORDER BY recorded_at DESC, audit_id DESC LIMIT ?9`;

  /** A deterministic pseudo-random sequence, so a failure reproduces. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }
  const pick = <T>(next: () => number, values: readonly T[]): T =>
    values[Math.floor(next() * values.length)]!;

  test("answers exactly what the first text answered, on a random store with tied instants", async () => {
    const db = migratedDatabase();
    const store = sqliteCommandStore(db);
    const next = random(64);
    const days = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
    const writes = [];
    for (let index = 0; index < 600; index++) {
      // Few distinct instants, so many records share one and the cursor's
      // tie on `audit_id` is exercised.
      const at = `${pick(next, days)}T${pick(next, ["00:00:00.000", "06:30:15.250", "23:59:59.999"])}Z`;
      const human = next() < 0.5;
      const result = pick(next, ["read", "refused", "replayed"] as const);
      writes.push(
        auditInsertWrite(
          buildAuditRecord(
            {
              ...ACTOR,
              path: human ? "ui" : pick(next, ["agent-http", "mcp"] as const),
              principalKind: human ? "human" : "agent",
            },
            {
              operation: pick(next, ["financial.query", "command.plan", "ops.operation.get"]),
              riskClass: "R0",
              result,
              ...(result === "refused" ? { resultCode: "subject_not_granted" } : {}),
              diff:
                result === "read" ? { kind: "read", rows: 1, truncated: false } : { kind: "none" },
            },
            at,
          ),
        ),
      );
    }
    await store.batch(writes);
    const ids = db.query("SELECT recorded_at,audit_id FROM audit_records").all() as {
      recorded_at: string;
      audit_id: string;
    }[];
    for (let query = 0; query < 400; query++) {
      const from = next() < 0.4 ? pick(next, days) : null;
      const to = next() < 0.4 ? pick(next, days) : null;
      const cursor = next() < 0.6 ? pick(next, ids) : null;
      const binds = [
        next() < 0.3 ? pick(next, ["financial.query", "command.plan"]) : null,
        next() < 0.3 ? pick(next, ["ui", "mcp"]) : null,
        next() < 0.3 ? pick(next, ["human", "agent"]) : null,
        next() < 0.3 ? pick(next, ["read", "refused"]) : null,
        from === null ? null : `${from}T00:00:00.000Z`,
        to === null ? null : new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString(),
        cursor?.recorded_at ?? null,
        cursor?.audit_id ?? null,
        pick(next, [1, 7, 51, 1000]),
      ] as never[];
      expect(db.query(AUDIT_PAGE_SQL).all(...binds)).toEqual(
        db.query(FIRST_PAGE_SQL).all(...binds),
      );
    }
    // Paged to the end, every filter set reads the same sequence as before.
    for (const filters of [
      {},
      { result: "read" as const },
      { from: "2026-10-08", to: "2026-10-09" },
    ]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await readAuditPage(store, filters, cursor, 7);
        if (!page.ok) throw new Error("unreachable");
        seen.push(...page.records.map((record) => record.auditId));
        cursor = page.cursor;
      } while (cursor !== null);
      const all = (
        db
          .query(FIRST_PAGE_SQL)
          .all(
            null,
            null,
            null,
            filters.result ?? null,
            "from" in filters ? `${filters.from}T00:00:00.000Z` : null,
            "to" in filters ? "2026-10-10T00:00:00.000Z" : null,
            null,
            null,
            10_000,
          ) as { audit_id: string }[]
      ).map((row) => row.audit_id);
      expect(seen).toEqual(all);
    }
  });

  test("every bound is one range on the time index, without table statistics", () => {
    const db = migratedDatabase();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'").get(),
    ).toEqual({ n: 0 });
    for (const operation of [null, "financial.query"])
      for (const from of [null, "2026-10-01T00:00:00.000Z"])
        for (const to of [null, "2026-10-02T00:00:00.000Z"])
          for (const cursor of [null, "2026-10-01T12:00:00.000Z"]) {
            const plan = (
              db
                .query(`EXPLAIN QUERY PLAN ${AUDIT_PAGE_SQL}`)
                .all(
                  operation,
                  null,
                  null,
                  null,
                  from,
                  to,
                  cursor,
                  cursor === null ? null : `aud_${"0".repeat(8)}-0000-4000-8000-000000000000`,
                  51,
                ) as { detail: string }[]
            )
              .map((row) => row.detail)
              .join("\n");
            expect(plan).toContain("SEARCH audit_records USING INDEX audit_records_by_time");
            expect(plan).not.toContain("SCAN");
            expect(plan).not.toContain("TEMP B-TREE");
          }
  });
});
