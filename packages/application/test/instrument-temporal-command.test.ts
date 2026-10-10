import { beforeAll, expect, test } from "bun:test";
import { createPlan } from "../src/command/plan.ts";
import { simulate } from "../src/command/simulate.ts";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import type { ChangeKind, ChangePayload } from "../src/command/contract.ts";
import { sqliteCommandStore } from "./sqlite-store.ts";
import {
  AGENT,
  OPERATOR,
  world,
  ids,
  planners,
  stubDatabase,
} from "./instrument-resolution-world.ts";

const NOW = "2099-01-01T00:00:00.000Z";
const TEMPORAL = `instrument-temporal:${"a".repeat(64)}`;
beforeAll(() => stubDatabase().close(), 60_000);

test("temporal references never plan a current-only assignment, release or relation, even with malformed suffixes", async () => {
  const w = await world();
  const id = ids(w);
  const store = sqliteCommandStore(w.db);
  const cases: [ChangeKind, ChangePayload][] = [
    [
      "identity.assign",
      {
        subject: "instrument",
        referenceId: id.broker9001,
        targetId: "synthetic-target",
        reason: "synthetic",
      },
    ],
    [
      "identity.release-override",
      { subject: "instrument", referenceId: id.broker9001, reason: "synthetic" },
    ],
    ...(["relation.accept", "relation.reject"] as const).map(
      (kind): [ChangeKind, ChangePayload] => [
        kind,
        {
          relationKind: "listed_as",
          fromRef: "instrument:synthetic",
          toRef: `identifier:${id.broker9001}`,
          validFrom: null,
          validTo: null,
          evidenceRefs: ["synthetic-evidence"],
          reason: "synthetic",
        },
      ],
    ),
  ];
  const before = w.snapshot();
  for (const [kind, payload] of cases) {
    for (const baseContextId of [
      TEMPORAL,
      "instrument-temporal:",
      "instrument-temporal:unknown",
      `instrument-temporal:${"b".repeat(300)}`,
    ]) {
      let reads = 0;
      const noReads = {
        ...store,
        first: async <T>(): Promise<T | null> => {
          reads++;
          return null;
        },
        all: async <T>(): Promise<T[]> => {
          reads++;
          return [];
        },
      };
      expect(
        await createPlan(
          kind,
          payload,
          { actor: AGENT, baseContextId, now: NOW, ttlSeconds: 900 },
          noReads,
        ),
      ).toMatchObject({ ok: false, error: "unsupported_semantics" });
      expect(reads).toBe(0);
      expect(w.snapshot()).toBe(before);
    }
  }
  w.db.close();
});

test("persisted temporal provenance refuses simulate, approve and fresh commit without consuming an approval; exact completed replay stays read-only", async () => {
  const w = await world();
  const id = ids(w);
  const store = sqliteCommandStore(w.db);
  const planned = await createPlan(
    "identity.release-override",
    {
      subject: "instrument",
      referenceId: id.broker9001,
      reason: "synthetic release",
    },
    { actor: OPERATOR, baseContextId: "manual:synthetic", now: NOW, ttlSeconds: 900 },
    store,
  );
  if (!planned.ok) throw new Error(`manual plan refused: ${planned.error}`);
  const approveInput = {
    actor: OPERATOR,
    planId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    scope: [],
    now: NOW,
    ttlSeconds: 600,
  };
  const approved = await approve(store, approveInput);
  if (!approved.ok) throw new Error(`manual approval refused: ${approved.error}`);
  const legacyStore = {
    ...store,
    first: async <T>(sql: string, binds?: readonly unknown[]): Promise<T | null> => {
      const row = await store.first<T>(sql, binds);
      if (
        row !== null &&
        typeof row === "object" &&
        sql.startsWith("SELECT plan_id,kind,payload_json")
      )
        Object.assign(row, { base_context_id: TEMPORAL });
      return row;
    },
  };
  const input = {
    operationId: "op-temporal-guard",
    principal: OPERATOR,
    planId: planned.plan.planId,
    approvalId: approved.approval.approvalId,
    planners: planners(w.db),
    now: NOW,
  };
  const before = w.snapshot();
  expect(await simulate({ ...planned.plan, baseContextId: TEMPORAL }, legacyStore)).toMatchObject({
    ok: false,
    error: "unsupported_semantics",
  });
  expect(await approve(legacyStore, approveInput)).toMatchObject({
    ok: false,
    error: "unsupported_semantics",
  });
  expect(await commit(legacyStore, input)).toMatchObject({
    ok: false,
    error: "unsupported_semantics",
  });
  expect(w.snapshot()).toBe(before);
  expect(
    w.db
      .query("SELECT uses_remaining FROM approvals WHERE approval_id=?")
      .get(approved.approval.approvalId),
  ).toEqual({ uses_remaining: 1 });
  // The ordinary current-only path still works. A later read of an existing
  // exact receipt never re-runs a writer or asks the caller to approve again.
  expect(await commit(store, input)).toMatchObject({ ok: true, replayed: false });
  const completed = w.snapshot();
  expect(await commit(legacyStore, { ...input, now: "2199-01-01T00:00:00.000Z" })).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(w.snapshot()).toBe(completed);
  expect(await commit(legacyStore, { ...input, idempotencyPayloadDigest: "wrong" })).toMatchObject({
    ok: false,
    error: "idempotency_conflict",
  });
  expect(w.snapshot()).toBe(completed);
  w.db.close();
});
