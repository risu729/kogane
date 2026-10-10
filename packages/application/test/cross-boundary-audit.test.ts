import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  OperationCall,
  bindDelegatedWrite,
  prepareDelegatedOperation,
  confirmDelegatedOperation,
  replayDelegatedConfirmation,
  delegatedBatchFailure,
  type DelegatedPrincipal,
  type OperationName,
} from "../src/index.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => migratedDatabase().close(), 60_000);
const CORRELATION = "11111111-2222-4333-8444-555555555555";
function principal(budget = 1): DelegatedPrincipal {
  return {
    kind: "delegated",
    id: "mcp-client:cross-boundary-owner",
    delegator: "cross-boundary-owner",
    capabilities: ["operations.import.request", "schedules.job.update"],
    scopes: { sources: ["sony-bank"], accounts: "*", scheduleSources: ["sony-bank"] },
    delegationRef: "dlg_" + "a".repeat(64),
    notAfter: new Date(Date.now() + 3_600_000).toISOString(),
    budget: { writesPerDay: budget },
  };
}
function call(operation: OperationName) {
  return new OperationCall(operation, {
    path: "mcp",
    subject: "cross-boundary-owner",
    principal: "mcp-client:cross-boundary-owner",
    principalKind: "agent",
    correlationId: CORRELATION,
  });
}
function setup() {
  const db = migratedDatabase();
  db.exec(
    "CREATE TABLE boundary_effect(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL); INSERT INTO boundary_effect VALUES(1,0),(2,0)",
  );
  return { db, store: sqliteCommandStore(db) };
}
const intent = {
  idempotencyKey: "job-confirm",
  payload: { revision: 0, enabled: false },
  targetRef: "schedule:sony-bank",
  scope: { namespace: "schedule-source" as const, source: "sony-bank" },
  expectedRevision: 0,
};
function apply(db: Database, c: OperationCall, id: number, expected = 0) {
  const effect = c.effect(
    {
      targetRef: "schedule:sony-bank",
      scope: { namespace: "schedule-source", source: "sony-bank" },
      diff: { kind: "none" },
    },
    {
      sql: "changes()=1 AND EXISTS(SELECT 1 FROM boundary_effect WHERE id=? AND revision=?)",
      binds: [id, expected + 1],
    },
    { kind: "each" },
  );
  const result = db.transaction(() => {
    const updated = db.run(
      "UPDATE boundary_effect SET revision=revision+1 WHERE id=? AND revision=?",
      [id, expected],
    );
    if (updated.changes !== 1) throw new Error("revision_conflict");
    return db.run(effect.sql, effect.binds as (string | number | null)[]).changes;
  })();
  c.settle(result);
}
function effects(db: Database) {
  return db.query("SELECT id,revision FROM boundary_effect ORDER BY id").all();
}
async function preparedPair(budget = 1) {
  const fixture = setup(),
    p = principal(budget);
  const prep = await prepareDelegatedOperation(
    fixture.store,
    call("schedules.job.update"),
    p,
    "schedules.job.update",
    intent,
    0,
  );
  const confirmed = call("schedules.job.update");
  await confirmDelegatedOperation(
    fixture.store,
    confirmed,
    p,
    "schedules.job.update",
    intent,
    prep.confirmation.digest,
  );
  const imported = call("ops.import.request");
  await bindDelegatedWrite(fixture.store, imported, p, {
    capability: "operations.import.request",
    idempotencyKey: "import-boundary",
    payload: { runId: 1 },
  });
  return { ...fixture, p, prep, confirmed, imported };
}

test("R1 import and R2 settings helper share one principal budget in either reservation order", async () => {
  for (const first of ["R1", "R2"] as const) {
    const { db, store, imported, confirmed } = await preparedPair();
    const winner = first === "R1" ? imported : confirmed;
    const loser = first === "R1" ? confirmed : imported;
    apply(db, winner, 1);
    expect(() => apply(db, loser, 2)).toThrow();
    expect(await delegatedBatchFailure(store, loser)).toMatchObject({
      code: "delegation_budget_exceeded",
    });
    expect(effects(db)).toEqual([
      { id: 1, revision: 1 },
      { id: 2, revision: 0 },
    ]);
    expect(
      db.query("SELECT count(*) n FROM audit_records WHERE result IN ('applied','accepted')").get(),
    ).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) n FROM audit_records WHERE result='prepared'").get()).toEqual({
      n: 1,
    });
    db.close();
  }
});

test("two prechecked confirms with different native rows still consume preparation once", async () => {
  const { db, store, p, prep, confirmed } = await preparedPair(10);
  const raced = call("schedules.job.update");
  await confirmDelegatedOperation(
    store,
    raced,
    p,
    "schedules.job.update",
    intent,
    prep.confirmation.digest,
  );
  apply(db, confirmed, 1);
  expect(() => apply(db, raced, 2)).toThrow();
  expect(await delegatedBatchFailure(store, raced)).toMatchObject({ code: "confirmation_used" });
  expect(effects(db)).toEqual([
    { id: 1, revision: 1 },
    { id: 2, revision: 0 },
  ]);
  expect(db.query("SELECT count(*) n FROM audit_records WHERE result='applied'").get()).toEqual({
    n: 1,
  });
  db.close();
});

test("delegation revision changes do not reset the shared rolling budget", async () => {
  const { db, store, p, imported } = await preparedPair();
  apply(db, imported, 1);
  const other = call("ops.import.request");
  await bindDelegatedWrite(
    store,
    other,
    { ...p, delegationRef: "dlg_" + "b".repeat(64) },
    {
      capability: "operations.import.request",
      idempotencyKey: "new-declaration",
      payload: { runId: 2 },
    },
  );
  expect(() => apply(db, other, 2)).toThrow();
  expect(await delegatedBatchFailure(store, other)).toMatchObject({
    code: "delegation_budget_exceeded",
  });
  expect(effects(db)).toEqual([
    { id: 1, revision: 1 },
    { id: 2, revision: 0 },
  ]);
  db.close();
});

test("completed exact confirmation replays after native revision movement and exhausted budget", async () => {
  const { db, store, p, prep, confirmed } = await preparedPair();
  apply(db, confirmed, 1);
  db.exec("UPDATE boundary_effect SET revision=9 WHERE id=1");
  const replay = await replayDelegatedConfirmation(
    store,
    call("schedules.job.update"),
    p,
    "schedules.job.update",
    intent,
    prep.confirmation.digest,
  );
  expect(replay?.result).toBe("applied");
  expect(effects(db)).toEqual([
    { id: 1, revision: 9 },
    { id: 2, revision: 0 },
  ]);
  expect(db.query("SELECT count(*) n FROM audit_records WHERE result='applied'").get()).toEqual({
    n: 1,
  });
  await expect(
    replayDelegatedConfirmation(
      store,
      call("schedules.job.update"),
      { ...p, delegationRef: "dlg_" + "b".repeat(64) },
      "schedules.job.update",
      intent,
      prep.confirmation.digest,
    ),
  ).rejects.toMatchObject({ code: "confirmation_invalid" });
  await expect(
    replayDelegatedConfirmation(
      store,
      call("schedules.job.update"),
      p,
      "schedules.job.update",
      { ...intent, payload: { enabled: true } },
      prep.confirmation.digest,
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  db.close();
});

test("a native revision guard is required independently of an unconsumed preparation", async () => {
  const { db, store, confirmed } = await preparedPair(10);
  db.exec("UPDATE boundary_effect SET revision=1 WHERE id=1");
  expect(() => apply(db, confirmed, 1, 0)).toThrow("revision_conflict");
  expect(confirmed.recorded).toBe(false);
  expect(
    db.query("SELECT count(*) n FROM audit_records WHERE result IN ('applied','accepted')").get(),
  ).toEqual({ n: 0 });
  expect(effects(db)).toEqual([
    { id: 1, revision: 1 },
    { id: 2, revision: 0 },
  ]);
  expect(await delegatedBatchFailure(store, confirmed)).toBeNull();
  db.close();
});
