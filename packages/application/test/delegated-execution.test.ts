import { beforeAll, describe, expect, test } from "bun:test";
import {
  type DelegatedPrincipal,
  type OperationCall,
  OperationCall as Call,
  bindDelegatedWrite,
  prepareDelegatedOperation,
  confirmDelegatedOperation,
  delegatedBatchFailure,
  parseAuditEnvelope,
  processorCall,
} from "../src/index.ts";
import { buildAuditRecord } from "../src/audit/record.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";
import type { Database } from "bun:sqlite";
beforeAll(() => migratedDatabase().close(), 60_000);
const CORRELATION = "11111111-2222-4333-8444-555555555555";
function principal(budget = 2): DelegatedPrincipal {
  return {
    kind: "delegated",
    id: "mcp-client:synthetic-owner",
    delegator: "synthetic-owner",
    capabilities: ["operations.import.request", "schedules.job.update"],
    scopes: { sources: ["sony-bank"], accounts: "*", scheduleSources: ["sony-bank"] },
    notAfter: new Date(Date.now() + 3_600_000).toISOString(),
    delegationRef: `dlg_${"a".repeat(64)}`,
    budget: { writesPerDay: budget },
  };
}
function call(operation: "ops.import.request" | "schedules.job.update" = "ops.import.request") {
  return new Call(operation, {
    path: "mcp",
    subject: "synthetic-owner",
    principal: "mcp-client:synthetic-owner",
    principalKind: "agent",
    correlationId: CORRELATION,
  });
}
function setup() {
  const db = migratedDatabase();
  db.exec(
    "CREATE TABLE test_effect(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL); INSERT INTO test_effect VALUES(1,0)",
  );
  return { db, store: sqliteCommandStore(db) };
}
function write(c: OperationCall, db: Database, expectedRevision?: number) {
  const revision = (db.query("SELECT revision FROM test_effect").get() as { revision: number })
    .revision;
  const expected = expectedRevision ?? revision;
  const effect = c.effect(
    {
      targetRef: "schedule:sony-bank",
      scope: { namespace: "schedule-source", source: "sony-bank" },
      diff: { kind: "none" },
    },
    {
      sql: "changes()=1 AND EXISTS(SELECT 1 FROM test_effect WHERE id=1 AND revision=?)",
      binds: [expected + 1],
    },
    { kind: "each" },
  );
  const apply = db.transaction(() => {
    const updated = db.run("UPDATE test_effect SET revision=revision+1 WHERE id=1 AND revision=?", [
      expected,
    ]);
    if (updated.changes !== 1) throw new Error("revision_conflict");
    return db.run(effect.sql, effect.binds as (string | number | null)[]).changes;
  });
  c.settle(apply());
}
const payload = { revision: 0, enabled: false };
const confirmation = {
  idempotencyKey: "confirm-1",
  payload,
  targetRef: "schedule:sony-bank",
  scope: { namespace: "schedule-source" as const, source: "sony-bank" },
  expectedRevision: 0,
};

describe("delegated writer transaction", () => {
  test("R1 effect and audit are atomic, bound to the canonical payload, and a retry replays", async () => {
    const { db, store } = setup(),
      p = principal(),
      c = call();
    expect(
      await bindDelegatedWrite(store, c, p, {
        capability: "operations.import.request",
        idempotencyKey: "r1",
        payload,
      }),
    ).toBeNull();
    write(c, db);
    expect(c.recorded).toBe(true);
    const row = await bindDelegatedWrite(store, call(), p, {
      capability: "operations.import.request",
      idempotencyKey: "r1",
      payload,
    });
    expect(row?.principal_kind).toBe("delegated");
    expect(row?.delegation_ref).toBe(p.delegationRef);
    expect(row?.payload_digest).toHaveLength(64);
    await expect(
      bindDelegatedWrite(store, call(), p, {
        capability: "operations.import.request",
        idempotencyKey: "r1",
        payload: { revision: 1 },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    db.close();
  });
  test("a spent rolling-day budget rolls the effect back, even when two calls pre-read together", async () => {
    const { db, store } = setup(),
      p = principal(1),
      a = call(),
      b = call();
    for (const [c, key] of [
      [a, "first"],
      [b, "raced"],
    ] as const)
      await bindDelegatedWrite(store, c, p, {
        capability: "operations.import.request",
        idempotencyKey: key,
        payload,
      });
    write(a, db);
    expect(() => write(b, db)).toThrow();
    expect(await delegatedBatchFailure(store, b)).toMatchObject({
      code: "delegation_budget_exceeded",
    });
    expect(db.query("SELECT revision FROM test_effect").get()).toEqual({ revision: 1 });
    expect(db.query("SELECT count(*) n FROM audit_records WHERE result='accepted'").get()).toEqual({
      n: 1,
    });
    db.close();
  });
  test("writer failure leaves no effect or applied record", async () => {
    const { db, store } = setup(),
      c = call();
    await bindDelegatedWrite(store, c, principal(), {
      capability: "operations.import.request",
      idempotencyKey: "failure",
      payload,
    });
    const effect = c.effect(
      { targetRef: "schedule:sony-bank", diff: { kind: "none" } },
      { sql: "1=1", binds: [] },
      { kind: "each" },
    );
    expect(() =>
      db.transaction(() => {
        db.run(effect.sql, effect.binds as (string | number | null)[]);
        db.exec("INSERT INTO nonexistent_table VALUES(1)");
      })(),
    ).toThrow();
    expect(db.query("SELECT count(*) n FROM audit_records").get()).toEqual({ n: 0 });
    db.close();
  });
  test("expiry checked inside the effect batch", async () => {
    const { db, store } = setup(),
      p = { ...principal(), notAfter: new Date(Date.now() - 1000).toISOString() },
      c = call();
    await bindDelegatedWrite(store, c, p, {
      capability: "operations.import.request",
      idempotencyKey: "expired",
      payload,
    });
    expect(() => write(c, db)).toThrow();
    expect(await delegatedBatchFailure(store, c)).toMatchObject({ code: "delegation_expired" });
    db.close();
  });
  test("no capability, missing key and an R2 direct call are refused before effects", async () => {
    const { db, store } = setup(),
      p = principal();
    await expect(
      bindDelegatedWrite(store, call(), p, {
        capability: "operations.replay.request",
        idempotencyKey: "x",
        payload,
      }),
    ).rejects.toMatchObject({ code: "capability_not_delegated" });
    await expect(
      bindDelegatedWrite(store, call(), p, {
        capability: "operations.import.request",
        idempotencyKey: undefined,
        payload,
      }),
    ).rejects.toMatchObject({ code: "idempotency_required" });
    await expect(
      bindDelegatedWrite(store, call("schedules.job.update"), p, {
        capability: "schedules.job.update",
        idempotencyKey: "x",
        payload,
      }),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    db.close();
  });
});

describe("two-step confirmation", () => {
  test("prepare records no effect and is valid at most ten minutes; stale revision writes nothing", async () => {
    const { db, store } = setup(),
      p = principal(),
      c = call("schedules.job.update");
    await expect(
      prepareDelegatedOperation(store, c, p, "schedules.job.update", confirmation, 1),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(db.query("SELECT count(*) n FROM audit_records").get()).toEqual({ n: 0 });
    const now = new Date(),
      result = await prepareDelegatedOperation(
        store,
        c,
        p,
        "schedules.job.update",
        confirmation,
        0,
        now,
      );
    expect(Date.parse(result.confirmation.expiresAt) - now.getTime()).toBe(600000);
    expect(c.recorded).toBe(true);
    expect(db.query("SELECT revision FROM test_effect").get()).toEqual({ revision: 0 });
    db.close();
  });
  test("confirm binds principal, delegation, key, payload, revision, target and scope", async () => {
    const { db, store } = setup(),
      p = principal();
    const prepared = await prepareDelegatedOperation(
      store,
      call("schedules.job.update"),
      p,
      "schedules.job.update",
      confirmation,
      0,
    );
    for (const changed of [
      { ...confirmation, idempotencyKey: "other" },
      { ...confirmation, payload: { enabled: true } },
      { ...confirmation, expectedRevision: 1 },
      { ...confirmation, targetRef: "schedule:smbc" },
      { ...confirmation, scope: { namespace: "schedule-source" as const, source: "smbc" } },
    ])
      await expect(
        confirmDelegatedOperation(
          store,
          call("schedules.job.update"),
          p,
          "schedules.job.update",
          changed,
          prepared.confirmation.digest,
        ),
      ).rejects.toMatchObject({ code: "confirmation_invalid" });
    await expect(
      confirmDelegatedOperation(
        store,
        call("schedules.job.update"),
        { ...p, delegationRef: `dlg_${"b".repeat(64)}` },
        "schedules.job.update",
        confirmation,
        prepared.confirmation.digest,
      ),
    ).rejects.toMatchObject({ code: "confirmation_invalid" });
    await expect(
      confirmDelegatedOperation(
        store,
        call("schedules.job.update"),
        p,
        "schedules.job.update",
        confirmation,
        `cfm_${"0".repeat(64)}`,
      ),
    ).rejects.toMatchObject({ code: "confirmation_invalid" });
    db.close();
  });
  test("two confirms racing the same prepare apply once, and replay refuses", async () => {
    const { db, store } = setup(),
      p = principal(),
      a = call("schedules.job.update"),
      b = call("schedules.job.update");
    const prepared = await prepareDelegatedOperation(
      store,
      call("schedules.job.update"),
      p,
      "schedules.job.update",
      confirmation,
      0,
    );
    for (const c of [a, b])
      await confirmDelegatedOperation(
        store,
        c,
        p,
        "schedules.job.update",
        confirmation,
        prepared.confirmation.digest,
      );
    write(a, db);
    expect(() => write(b, db)).toThrow();
    expect(await delegatedBatchFailure(store, b)).toMatchObject({ code: "confirmation_used" });
    expect(db.query("SELECT revision FROM test_effect").get()).toEqual({ revision: 1 });
    await expect(
      confirmDelegatedOperation(
        store,
        call("schedules.job.update"),
        p,
        "schedules.job.update",
        confirmation,
        prepared.confirmation.digest,
      ),
    ).rejects.toMatchObject({ code: "confirmation_used" });
    db.close();
  });
  test("expired prepare refuses; expiry crossing during effect rolls back", async () => {
    const { db, store } = setup(),
      p = principal(),
      now = new Date(Date.now() - 601000);
    const prepared = await prepareDelegatedOperation(
      store,
      call("schedules.job.update"),
      p,
      "schedules.job.update",
      confirmation,
      0,
      now,
    );
    await expect(
      confirmDelegatedOperation(
        store,
        call("schedules.job.update"),
        p,
        "schedules.job.update",
        confirmation,
        prepared.confirmation.digest,
      ),
    ).rejects.toMatchObject({ code: "confirmation_expired" });
    const c = call("schedules.job.update");
    await confirmDelegatedOperation(
      store,
      c,
      p,
      "schedules.job.update",
      confirmation,
      prepared.confirmation.digest,
      now,
    );
    expect(() => write(c, db)).toThrow();
    expect(await delegatedBatchFailure(store, c)).toMatchObject({ code: "confirmation_expired" });
    db.close();
  });
  test("a target changed after preparation is refused by the native writer without an effect record", async () => {
    const { db, store } = setup(),
      p = principal();
    const prepared = await prepareDelegatedOperation(
      store,
      call("schedules.job.update"),
      p,
      "schedules.job.update",
      confirmation,
      0,
    );
    db.exec("UPDATE test_effect SET revision=1");
    const c = call("schedules.job.update");
    await confirmDelegatedOperation(
      store,
      c,
      p,
      "schedules.job.update",
      confirmation,
      prepared.confirmation.digest,
    );
    expect(() => write(c, db, confirmation.expectedRevision)).toThrow("revision_conflict");
    expect(
      db.query("SELECT count(*) n FROM audit_records WHERE result IN ('applied','accepted')").get(),
    ).toEqual({ n: 0 });
    expect(db.query("SELECT revision FROM test_effect").get()).toEqual({ revision: 1 });
    const other = { ...p, id: "mcp-client:another-owner", delegator: "another-owner" };
    const otherCall = new Call("schedules.job.update", {
      path: "mcp",
      subject: other.delegator,
      principal: other.id,
      principalKind: "agent",
      correlationId: CORRELATION,
    });
    await expect(
      confirmDelegatedOperation(
        store,
        otherCall,
        other,
        "schedules.job.update",
        confirmation,
        prepared.confirmation.digest,
      ),
    ).rejects.toMatchObject({ code: "confirmation_invalid" });
    db.close();
  });
  test("prepare cap refuses rather than returning an unrecorded confirmation", async () => {
    const { db, store } = setup(),
      p = principal();
    const now = new Date();
    for (let i = 0; i < 200; i++)
      await prepareDelegatedOperation(
        store,
        call("schedules.job.update"),
        p,
        "schedules.job.update",
        { ...confirmation, idempotencyKey: `cap-${i}` },
        0,
        now,
      );
    await expect(
      prepareDelegatedOperation(
        store,
        call("schedules.job.update"),
        p,
        "schedules.job.update",
        confirmation,
        0,
        now,
      ),
    ).rejects.toMatchObject({ code: "audit_cap_reached" });
    db.close();
  });
});

test("private envelope is closed and cannot turn a UI or agent principal into delegated", async () => {
  const { db, store } = setup(),
    c = call(),
    p = principal();
  await bindDelegatedWrite(store, c, p, {
    capability: "operations.import.request",
    idempotencyKey: "headers",
    payload,
  });
  const headers = new Headers(c.envelopeHeaders()),
    env = parseAuditEnvelope(headers)!;
  expect(processorCall(env, "ops.import.request", p.id, "delegated").actor).toMatchObject({
    principalKind: "delegated",
    delegationRef: p.delegationRef,
  });
  expect(() => processorCall(env, "ops.import.request", p.id, "agent")).toThrow();
  headers.set("x-kogane-audit-path", "ui");
  expect(parseAuditEnvelope(headers)).toBeNull();
  headers.set("x-kogane-audit-path", "mcp");
  headers.set("x-kogane-delegated-execution", '{"unknown":true}');
  expect(parseAuditEnvelope(headers)).toBeNull();
  expect(() =>
    buildAuditRecord(
      {
        path: "ui",
        subject: p.delegator,
        principal: p.id,
        principalKind: "delegated",
        delegationRef: p.delegationRef,
        correlationId: CORRELATION,
      },
      { operation: "financial.query", riskClass: "R0", result: "read", diff: { kind: "none" } },
      new Date().toISOString(),
    ),
  ).toThrow();
  db.close();
});
