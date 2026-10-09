import { beforeAll, describe, expect, test } from "bun:test";
import { instrumentCandidatePlanIsPinned } from "../src/operations/instrument-candidate-context.ts";
import { createPlan, planDigestOf } from "../src/command/plan.ts";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import { simulate } from "../src/command/simulate.ts";
import { validPayload, type IdentityAssignPayload } from "../src/command/contract.ts";
import { queryInstrumentResolution } from "../src/query/instrument-resolution.ts";
import {
  AGENT,
  OPERATOR,
  world,
  heldWorld,
  ids,
  candidateOf,
  decide,
  planners,
  stubDatabase,
} from "./instrument-resolution-world.ts";
import { sqliteCommandStore } from "./sqlite-store.ts";
import { processorCall, type OperationName } from "../src/index.ts";
import type { Principal } from "../src/command/contract.ts";
const NOW = "2099-01-01T00:00:00.000Z";
beforeAll(() => stubDatabase().close(), 60_000);

async function fixture() {
  const w = await world();
  const id = ids(w);
  const candidate = candidateOf(
    await queryInstrumentResolution(w.sql),
    id.listing9001,
    id.broker9001,
  );
  const payload: IdentityAssignPayload = {
    ...candidate.commands!.adopt!.payload,
    reason: "synthetic candidate decision",
  };
  const store = sqliteCommandStore(w.db);
  const context = {
    actor: AGENT,
    baseContextId: candidate.candidateId,
    now: NOW,
    ttlSeconds: 3600,
  };
  const bump = async () => {
    const changed = await decide(
      w,
      OPERATOR,
      "identity.assign",
      {
        subject: "instrument",
        referenceId: candidate.anchorIdentifierId,
        targetId: payload.targetId,
        reason: "synthetic same-target correction",
      },
      "op-anchor-bump",
    );
    expect(changed.stage).toBe("commit");
    expect(changed.result.ok).toBe(true);
  };
  return { w, candidate, payload, store, context, bump };
}

describe("candidate assignment provenance and server pins", () => {
  test("legacy candidate plans or plans missing either pin require re-planning at every lifecycle phase", async () => {
    const f = await fixture();
    const planned = await createPlan("identity.assign", f.payload, f.context, f.store);
    if (!planned.ok) throw new Error("plan refused");
    const { candidate: _candidate, ...manual } = f.payload;
    for (const changed of [
      { ...planned.plan, payload: manual },
      {
        ...planned.plan,
        expectedRevisions: { [`instrument_mapping:${f.payload.referenceId}`]: 1 },
      },
      {
        ...planned.plan,
        expectedRevisions: { [`instrument_mapping:${f.candidate.anchorIdentifierId}`]: 1 },
      },
    ]) {
      expect(instrumentCandidatePlanIsPinned(changed)).toBe(false);
      expect(await simulate(changed, f.store)).toMatchObject({ ok: false, error: "stale_context" });
      const legacyStore = {
        ...f.store,
        first: async <T>(sql: string, binds?: readonly unknown[]): Promise<T | null> => {
          const row = await f.store.first<T>(sql, binds);
          if (
            row !== null &&
            typeof row === "object" &&
            sql.startsWith("SELECT plan_id,kind,payload_json")
          )
            Object.assign(row, {
              payload_json: JSON.stringify(changed.payload),
              expected_revisions_json: JSON.stringify(changed.expectedRevisions),
            });
          return row;
        },
      };
      const before = f.w.snapshot();
      expect(
        await approve(legacyStore, {
          planId: changed.planId,
          planDigest: changed.planDigest,
          actor: OPERATOR,
          scope: [],
          ttlSeconds: 3600,
          now: NOW,
        }),
      ).toMatchObject({ ok: false, error: "stale_context" });
      expect(
        await commit(legacyStore, {
          operationId: "op-legacy",
          principal: OPERATOR,
          planId: changed.planId,
          approvalId: "missing",
          planners: planners(f.w.db),
          now: NOW,
        }),
      ).toMatchObject({ ok: false, error: "stale_context" });
      expect(f.w.snapshot()).toBe(before);
    }
    f.w.db.close();
  });
  test("the plan and digest preserve the candidate and both mapping pins; direct manual correction is distinct", async () => {
    const f = await fixture();
    const planned = await createPlan("identity.assign", f.payload, f.context, f.store);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.payload).toEqual(f.payload);
    expect(planned.plan.expectedRevisions).toEqual({
      [`instrument_mapping:${f.candidate.subjectIdentifierId}`]: 1,
      [`instrument_mapping:${f.candidate.anchorIdentifierId}`]: 1,
    });
    const { candidate: _candidate, ...manual } = f.payload;
    const direct = await createPlan(
      "identity.assign",
      manual,
      { ...f.context, baseContextId: "manual:correction" },
      f.store,
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.plan.payload).not.toHaveProperty("candidate");
    expect(direct.plan.expectedRevisions).toEqual({
      [`instrument_mapping:${f.candidate.subjectIdentifierId}`]: 1,
    });
    expect(direct.plan.planDigest).not.toBe(planned.plan.planDigest);
    expect(
      await planDigestOf({
        kind: "identity.assign",
        payload: manual,
        expectedRevisions: planned.plan.expectedRevisions,
        baseContextId: f.context.baseContextId,
      }),
    ).not.toBe(planned.plan.planDigest);
    f.w.db.close();
  });
  test("candidate context refuses omitted, altered, mismatched, held or unknown provenance without saving a plan", async () => {
    const f = await fixture();
    const before = f.w.snapshot();
    const { candidate: _candidate, ...manual } = f.payload;
    for (const [payload, context] of [
      [manual, f.context],
      [f.payload, { ...f.context, baseContextId: "manual:correction" }],
      [
        {
          ...f.payload,
          candidate: { ...f.payload.candidate!, candidateId: "instrument-candidate:other|pair" },
        },
        { ...f.context, baseContextId: "instrument-candidate:other|pair" },
      ],
      [{ ...f.payload, targetId: "missing-target" }, f.context],
      [
        {
          ...f.payload,
          candidate: { ...f.payload.candidate!, anchorIdentifierId: ids(f.w).listing9003 },
        },
        f.context,
      ],
      [
        { ...f.payload, candidate: { ...f.payload.candidate!, subjectMappingRevision: 2 } },
        f.context,
      ],
    ] as const) {
      expect((await createPlan("identity.assign", payload, context, f.store)).ok).toBe(false);
      expect(f.w.snapshot()).toBe(before);
    }
    for (const candidate of [
      null,
      {},
      { ...f.payload.candidate!, anchorMappingRevision: 0 },
      { ...f.payload.candidate!, expectedRevisions: {} },
    ])
      expect(validPayload("identity.assign", { ...f.payload, candidate })).toBe(false);
    f.w.db.close();
  });
  test("a held candidate cannot be relabelled as an open candidate or given adoption provenance", async () => {
    const { w, listing, broker } = await heldWorld();
    const resolution = await queryInstrumentResolution(w.sql);
    const candidate = candidateOf(resolution, listing, broker);
    const anchor = resolution.identifiers.find(
      (row) => row.identifierId === candidate.anchorIdentifierId,
    )!;
    const subject = resolution.identifiers.find(
      (row) => row.identifierId === candidate.subjectIdentifierId,
    )!;
    const before = w.snapshot();
    const payload = {
      subject: "instrument",
      referenceId: subject.identifierId,
      targetId: anchor.instrumentId,
      reason: "synthetic held attempt",
      candidate: {
        candidateId: candidate.candidateId,
        anchorIdentifierId: anchor.identifierId,
        anchorMappingRevision: anchor.mappingRevision,
        subjectMappingRevision: subject.mappingRevision,
      },
    };
    expect(
      await createPlan(
        "identity.assign",
        payload,
        { actor: AGENT, baseContextId: candidate.candidateId, now: NOW, ttlSeconds: 3600 },
        sqliteCommandStore(w.db),
      ),
    ).toMatchObject({ ok: false, error: "stale_context" });
    expect(w.snapshot()).toBe(before);
    w.db.close();
  });
  test("a same-target anchor revision change between read and plan refuses the candidate", async () => {
    const f = await fixture();
    await f.bump();
    const before = f.w.snapshot();
    expect(await createPlan("identity.assign", f.payload, f.context, f.store)).toMatchObject({
      ok: false,
      error: "stale_context",
    });
    expect(f.w.snapshot()).toBe(before);
    f.w.db.close();
  });
  test("anchor changes after planning are detected by simulation and approval", async () => {
    const f = await fixture();
    const planned = await createPlan("identity.assign", f.payload, f.context, f.store);
    if (!planned.ok) throw new Error("plan refused");
    await f.bump();
    expect(await simulate(planned.plan, f.store)).toMatchObject({
      ok: false,
      error: "stale_context",
    });
    expect(
      await approve(f.store, {
        planId: planned.plan.planId,
        planDigest: planned.plan.planDigest,
        actor: OPERATOR,
        scope: [],
        ttlSeconds: 3600,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, error: "stale_context" });
    f.w.db.close();
  });
  for (const phase of ["before-commit", "before-batch"] as const)
    test(`anchor changes ${phase} prevent the mutation, receipt, outbox and approval consumption`, async () => {
      const f = await fixture();
      const planned = await createPlan("identity.assign", f.payload, f.context, f.store);
      if (!planned.ok) throw new Error("plan refused");
      const approved = await approve(f.store, {
        planId: planned.plan.planId,
        planDigest: planned.plan.planDigest,
        actor: OPERATOR,
        scope: [],
        ttlSeconds: 3600,
        now: NOW,
      });
      if (!approved.ok) throw new Error("approval refused");
      const subjectRows = () =>
        f.w.db
          .query("SELECT * FROM instrument_mappings WHERE identifier_id=? ORDER BY revision")
          .all(f.payload.referenceId);
      const before = subjectRows();
      if (phase === "before-commit") await f.bump();
      let injected = false;
      const racing = {
        ...f.store,
        batch: async (writes: Parameters<typeof f.store.batch>[0]) => {
          if (
            phase === "before-batch" &&
            !injected &&
            writes.some((write) => write.sql.includes("INSERT INTO operation_receipts"))
          ) {
            injected = true;
            await f.bump();
          }
          return f.store.batch(writes);
        },
      };
      const result = await commit(racing, {
        operationId: "op-candidate",
        principal: OPERATOR,
        planId: planned.plan.planId,
        approvalId: approved.approval.approvalId,
        planners: planners(f.w.db),
        now: NOW,
      });
      expect(result).toMatchObject({ ok: false, error: "stale_context" });
      if (phase === "before-batch") expect(injected).toBe(true);
      expect(subjectRows()).toEqual(before);
      expect(
        f.w.db.query("SELECT * FROM operation_receipts WHERE operation_id='op-candidate'").all(),
      ).toEqual([]);
      expect(
        f.w.db.query("SELECT * FROM decision_outbox WHERE operation_id='op-candidate'").all(),
      ).toEqual([]);
      expect(
        f.w.db
          .query("SELECT uses_remaining FROM approvals WHERE approval_id=?")
          .get(approved.approval.approvalId),
      ).toEqual({ uses_remaining: 1 });
      f.w.db.close();
    });

  test("a stale candidate refusal writes no audit record; a pinned plan records once (ADR 0064)", async () => {
    // The pin checks refuse before any batch, so the writer appends no record:
    // the refusal is the App's to record, once, from the closed code.
    const f = await fixture();
    const records = () =>
      f.w.db
        .query(
          "SELECT operation,result,target_ref FROM audit_records ORDER BY recorded_at,audit_id",
        )
        .all();
    const call = (operation: OperationName, principal: Principal) =>
      processorCall(
        { path: "ui", correlationId: crypto.randomUUID() },
        operation,
        principal.id,
        principal.kind === "human" ? "human" : "agent",
      );
    const planCall = call("command.plan", AGENT);
    const planned = await createPlan(
      "identity.assign",
      f.payload,
      { ...f.context, audit: planCall },
      f.store,
    );
    if (!planned.ok) throw new Error("plan refused");
    expect(planCall.recorded).toBe(true);
    expect(records()).toEqual([
      { operation: "command.plan", result: "applied", target_ref: `plan:${planned.plan.planId}` },
    ]);
    // A legacy candidate plan (no candidate pins) is refused at approve and commit.
    const { candidate: _candidate, ...manual } = f.payload;
    const legacyStore = {
      ...f.store,
      first: async <T>(sql: string, binds?: readonly unknown[]): Promise<T | null> => {
        const row = await f.store.first<T>(sql, binds);
        if (
          row !== null &&
          typeof row === "object" &&
          sql.startsWith("SELECT plan_id,kind,payload_json")
        )
          Object.assign(row, { payload_json: JSON.stringify(manual) });
        return row;
      },
    };
    const approveCall = call("command.approve", OPERATOR);
    expect(
      await approve(legacyStore, {
        planId: planned.plan.planId,
        planDigest: planned.plan.planDigest,
        actor: OPERATOR,
        scope: [],
        ttlSeconds: 3600,
        now: NOW,
        audit: approveCall,
      }),
    ).toMatchObject({ ok: false, error: "stale_context" });
    const commitCall = call("command.commit", OPERATOR);
    expect(
      await commit(legacyStore, {
        operationId: "op-legacy-audit",
        principal: OPERATOR,
        planId: planned.plan.planId,
        approvalId: "missing",
        planners: planners(f.w.db),
        now: NOW,
        audit: commitCall,
      }),
    ).toMatchObject({ ok: false, error: "stale_context" });
    // An anchor that moved refuses a new plan and the pinned plan's approval.
    await f.bump();
    const stalePlanCall = call("command.plan", AGENT);
    expect(
      await createPlan(
        "identity.assign",
        f.payload,
        { ...f.context, audit: stalePlanCall },
        f.store,
      ),
    ).toMatchObject({ ok: false, error: "stale_context" });
    const staleApproveCall = call("command.approve", OPERATOR);
    expect(
      await approve(f.store, {
        planId: planned.plan.planId,
        planDigest: planned.plan.planDigest,
        actor: OPERATOR,
        scope: [],
        ttlSeconds: 3600,
        now: NOW,
        audit: staleApproveCall,
      }),
    ).toMatchObject({ ok: false, error: "stale_context" });
    for (const refused of [approveCall, commitCall, stalePlanCall, staleApproveCall])
      expect(refused.recorded).toBe(false);
    expect(records()).toHaveLength(1);
    f.w.db.close();
  });
});
