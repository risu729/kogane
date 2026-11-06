// A change planned again after its plan expired, over unchanged data
// (ADR 0080). The plan id is the digest of what the plan would do, so before
// this a re-plan found the expired row under the same id, answered it with
// `created: false`, and the change could never be approved again until some
// unrelated decision moved one of its pins. Synthetic data only.
import { beforeAll, describe, expect, test } from "bun:test";
import { createPlan, planDigestOf } from "../src/command/plan.ts";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import { simulate } from "../src/command/simulate.ts";
import type { IdentityAssignPayload } from "../src/command/contract.ts";
import { queryInstrumentResolution } from "../src/query/instrument-resolution.ts";
import {
  candidateOf,
  decide,
  ids,
  OPERATOR,
  planners,
  stubDatabase,
  world,
} from "./instrument-resolution-world.ts";
import { sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => stubDatabase().close(), 60_000);

const TTL = 900;
const BASE_CONTEXT = "identity-current-v1";
/** Instants on a synthetic clock; each is named by its offset from T0 in minutes. */
const T0 = Date.parse("2099-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

async function fixture() {
  const w = await world();
  const id = ids(w);
  const candidate = candidateOf(
    await queryInstrumentResolution(w.sql),
    id.listing9001,
    id.broker9001,
  );
  const { candidate: _candidate, ...manual } = candidate.commands!.adopt!.payload;
  const payload: IdentityAssignPayload = { ...manual, reason: "synthetic manual assignment" };
  const store = sqliteCommandStore(w.db);
  const plan = (minutes: number) =>
    createPlan(
      "identity.assign",
      payload,
      { actor: OPERATOR, baseContextId: BASE_CONTEXT, now: at(minutes), ttlSeconds: TTL },
      store,
    );
  const rows = () =>
    w.db
      .query("SELECT plan_id,status,created_at,expires_at FROM change_plans ORDER BY created_at")
      .all();
  return { w, payload, store, plan, rows };
}

describe("a change planned again after its plan expired", () => {
  test("is a new open plan that approves and commits, while the expired one is kept as it was", async () => {
    const f = await fixture();
    const first = await f.plan(0);
    if (!first.ok) throw new Error(first.error);
    expect(first.created).toBe(true);
    // Unchanged data, same change, after the first plan's lifetime.
    const again = await f.plan(60);
    if (!again.ok) throw new Error(again.error);
    expect(again.created).toBe(true);
    expect(again.plan.planId).not.toBe(first.plan.planId);
    expect(again.plan.planDigest).toBe(again.plan.planId);
    expect(again.plan.status).toBe("planned");
    expect(again.plan.expectedRevisions).toEqual(first.plan.expectedRevisions);
    expect(Date.parse(again.plan.expiresAt)).toBe(Date.parse(at(60)) + TTL * 1000);
    // The expired plan is evidence of what was proposed: never rewritten.
    expect(f.rows()).toEqual([
      {
        plan_id: first.plan.planId,
        status: "planned",
        created_at: at(0),
        expires_at: first.plan.expiresAt,
      },
      {
        plan_id: again.plan.planId,
        status: "planned",
        created_at: at(60),
        expires_at: again.plan.expiresAt,
      },
    ]);
    // The old plan stays expired; the new one is the one a person can approve.
    const old = await approve(f.store, {
      planId: first.plan.planId,
      planDigest: first.plan.planDigest,
      actor: OPERATOR,
      scope: [],
      ttlSeconds: 600,
      now: at(61),
    });
    expect(old).toEqual({ ok: false, error: "plan_expired", refs: [first.plan.planId] });
    const approval = await approve(f.store, {
      planId: again.plan.planId,
      planDigest: again.plan.planDigest,
      actor: OPERATOR,
      scope: [],
      ttlSeconds: 600,
      now: at(61),
    });
    if (!approval.ok) throw new Error(approval.error);
    const committed = await commit(f.store, {
      operationId: "op-renewed-plan",
      principal: OPERATOR,
      planId: again.plan.planId,
      approvalId: approval.approval.approvalId,
      planners: planners(f.w.db),
      now: at(62),
    });
    if (!committed.ok) throw new Error(committed.error);
    expect(committed.replayed).toBe(false);
    expect(committed.receipt.planId).toBe(again.plan.planId);
  });

  test("is one plan for its whole lifetime, across a window boundary, and a third after it lapses too", async () => {
    const f = await fixture();
    const first = await f.plan(0);
    if (!first.ok) throw new Error(first.error);
    // Within the first plan's lifetime: the same plan, created once.
    const same = await f.plan(10);
    expect(same.ok && same.plan.planId).toBe(first.plan.planId);
    expect(same.ok && same.created).toBe(false);
    // 20 minutes in: the first plan lapsed at 15; a renewal is created in the
    // 15-minute window [15, 30) and lives until 35.
    const renewed = await f.plan(20);
    if (!renewed.ok) throw new Error(renewed.error);
    expect(renewed.created).toBe(true);
    // 32 minutes in, the next window: the renewal is still open and is the
    // answer, not a second open plan of the same change.
    const later = await f.plan(32);
    expect(later.ok && later.plan.planId).toBe(renewed.plan.planId);
    expect(later.ok && later.created).toBe(false);
    // 40 minutes in: the renewal lapsed at 35 as well; a third plan.
    const third = await f.plan(40);
    if (!third.ok) throw new Error(third.error);
    expect(third.created).toBe(true);
    expect(new Set([first.plan.planId, renewed.plan.planId, third.plan.planId]).size).toBe(3);
    expect(third.plan.status).toBe("planned");
    expect(f.rows()).toHaveLength(3);
  });

  test("a renewed plan simulates as fresh until a pin moves, then as stale", async () => {
    const f = await fixture();
    const first = await f.plan(0);
    if (!first.ok) throw new Error(first.error);
    const renewed = await f.plan(60);
    if (!renewed.ok) throw new Error(renewed.error);
    const fresh = await simulate(renewed.plan, f.store);
    if (!fresh.ok) throw new Error(fresh.error);
    expect(fresh.report.stale).toBe(false);
    expect(fresh.report.resimulatedPlanId).toBe(renewed.plan.planId);
    // Another decision moves the mapping the plan pinned.
    const moved = await decide(
      f.w,
      OPERATOR,
      "identity.assign",
      {
        subject: f.payload.subject,
        referenceId: f.payload.referenceId,
        targetId: f.payload.targetId,
        reason: "synthetic concurrent correction",
      },
      "op-renewal-concurrent",
    );
    expect(moved.stage).toBe("commit");
    expect(moved.result.ok).toBe(true);
    const stale = await simulate(renewed.plan, f.store);
    if (!stale.ok) throw new Error(stale.error);
    expect(stale.report.stale).toBe(true);
    // The id a fresh plan of the same change over the moved data would get.
    expect(stale.report.resimulatedPlanId).toBe(
      await planDigestOf({
        kind: "identity.assign",
        payload: f.payload,
        expectedRevisions: stale.report.currentRevisions,
        baseContextId: BASE_CONTEXT,
      }),
    );
  });

  test("an expired plan's own simulation reports it fresh, and a first plan keeps the documented digest", async () => {
    const f = await fixture();
    const first = await f.plan(0);
    if (!first.ok) throw new Error(first.error);
    expect(first.plan.planId).toBe(
      await planDigestOf({
        kind: "identity.assign",
        payload: f.payload,
        expectedRevisions: first.plan.expectedRevisions,
        baseContextId: BASE_CONTEXT,
      }),
    );
    const report = await simulate(first.plan, f.store);
    expect(report.ok && report.report.stale).toBe(false);
    expect(report.ok && report.report.resimulatedPlanId).toBe(first.plan.planId);
  });

  test("a row whose id is no derivation of its content still simulates as stale", async () => {
    const f = await fixture();
    const first = await f.plan(0);
    if (!first.ok) throw new Error(first.error);
    const forged = { ...first.plan, planId: "f".repeat(64), planDigest: "f".repeat(64) };
    const report = await simulate(forged, f.store);
    expect(report.ok && report.report.stale).toBe(true);
  });
});
