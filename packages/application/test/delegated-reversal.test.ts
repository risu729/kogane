import { expect, test } from "bun:test";
import type { ChangePlan, CommandStore, CommandReceipt } from "../src/command/contract.ts";
import { assertDelegatedReversal } from "../src/delegation/reversal.ts";

const AUDIT = "aud_11111111-2222-4333-8444-555555555555";
const PLAN = "a".repeat(64);
const PRIMARY = "relation:pending_to_posted|from:a|to:b";
function fixture(
  options: {
    current?: boolean;
    audit?: boolean;
    receipt?: boolean;
    receiptChange?: Partial<CommandReceipt>;
    refs?: string[];
  } = {},
) {
  const original = {
    plan_id: PLAN,
    kind: "relation.accept",
    payload_json: JSON.stringify({
      relationKind: "pending_to_posted",
      fromRef: "from:a",
      toRef: "to:b",
      validFrom: "2026-10-01",
      validTo: null,
      evidenceRefs: [],
      reason: "synthetic",
    }),
    base_context_id: "synthetic",
    expected_revisions_json: JSON.stringify({ [PRIMARY]: 0 }),
    simulation_json: "{}",
    created_by: "mcp-client:owner",
    created_at: "2026-10-10T00:00:00.000Z",
    expires_at: "2026-10-10T00:10:00.000Z",
    status: "committed",
  };
  const receipt: CommandReceipt = {
    operationId: "original-operation",
    principal: "mcp-client:owner",
    operationKind: "relation.accept",
    planId: PLAN,
    planDigest: PLAN,
    payloadDigest: "b".repeat(64),
    status: "accepted",
    acceptedAt: original.created_at,
    publishedAt: null,
    decisionRevisionId: "original-decision",
    expectedRevisions: { [PRIMARY]: 0 },
    outboxTargets: [],
    result: {
      decisionRevisionId: "original-decision",
      revision: 1,
      relationId: "original-relation",
    },
    ...options.receiptChange,
  };
  const store: CommandStore = {
    async first<T>(sql: string, binds: readonly unknown[]) {
      if (sql.includes("audit_records")) {
        expect(binds).toEqual([AUDIT, "owner", "mcp-client:owner", "owner"]);
        expect(sql).toContain("result='applied'");
        return options.audit === false
          ? null
          : ({
              target_ref: `plan:${PLAN}`,
              principal: receipt.principal,
              refs_json: JSON.stringify(
                options.refs ?? ["operation:original-operation", "decision:original-decision"],
              ),
            } as T);
      }
      if (sql.includes("operation_receipts"))
        return options.receipt === false
          ? null
          : ({
              result_json: JSON.stringify(receipt),
              status: "accepted",
              created_at: receipt.acceptedAt,
              published_at: null,
            } as T);
      if (sql.startsWith("SELECT 1 AS valid")) {
        expect(sql).toContain("op.actor_verification='server'");
        expect(sql).toContain("r.decision_revision_id=d.id");
        expect(binds.at(-1)).toBe(JSON.stringify({ [PRIMARY]: 1 }));
        return options.current === false ? null : ({ valid: 1 } as T);
      }
      return original as T;
    },
    async all<T>() {
      return [] as T[];
    },
    async batch() {
      throw new Error("read-only reversal validation");
    },
  };
  const plan: ChangePlan = {
    planId: "d".repeat(64),
    planDigest: "d".repeat(64),
    baseContextId: "synthetic",
    createdBy: "mcp-client:owner",
    createdAt: original.created_at,
    expiresAt: original.expires_at,
    status: "planned",
    simulation: {
      kind: "relation.reject",
      targets: [],
      before: { attributedObservations: 0, relations: 1 },
      after: { attributedObservations: 0, relations: 0 },
      invalidations: [],
      affectedScopes: [],
      affectedParseRuns: 0,
      outboxTargets: [],
    },
    kind: "relation.reject",
    payload: JSON.parse(original.payload_json),
    expectedRevisions: { [PRIMARY]: 1 },
  };
  return { store, plan };
}

test("audit-linked reversal binds endpoints, interval, immutable receipt and still-current effect", async () => {
  const { store, plan } = fixture();
  await expect(
    assertDelegatedReversal(store, "owner", "mcp-client:owner", plan, AUDIT),
  ).resolves.toMatchObject({ sql: expect.stringContaining("entity_relations") });
  for (const changed of [
    { fromRef: "from:other" },
    { toRef: "to:other" },
    { validFrom: "2026-10-02" },
    { validTo: "2026-10-31" },
    { relationKind: "beneficial_owner" },
  ]) {
    await expect(
      assertDelegatedReversal(
        store,
        "owner",
        "mcp-client:owner",
        {
          ...plan,
          payload: { ...plan.payload, ...changed },
        } as ChangePlan,
        AUDIT,
      ),
    ).rejects.toMatchObject({ code: "revert_invalid" });
  }
  for (const invalidPlan of [
    { ...plan, kind: "relation.accept" } as ChangePlan,
    { ...plan, expectedRevisions: { [PRIMARY]: 2 } },
  ])
    await expect(
      assertDelegatedReversal(store, "owner", "mcp-client:owner", invalidPlan, AUDIT),
    ).rejects.toMatchObject({ code: "revert_invalid" });
});

test("missing, foreign, mismatched or no-longer-current original effect cannot authorize a reversal", async () => {
  for (const options of [
    { audit: false },
    { receipt: false },
    { current: false },
    { refs: ["operation:original-operation", "decision:another-decision"] },
    { receiptChange: { operationId: "another-operation" } },
    { receiptChange: { planId: "c".repeat(64) } },
    { receiptChange: { planDigest: "c".repeat(64) } },
    { receiptChange: { decisionRevisionId: "another-decision" } },
    { receiptChange: { expectedRevisions: { [PRIMARY]: 9 } } },
    { receiptChange: { result: { decisionRevisionId: "original-decision", revision: 2 } } },
  ]) {
    const { store, plan } = fixture(options);
    await expect(
      assertDelegatedReversal(store, "owner", "mcp-client:owner", plan, AUDIT),
    ).rejects.toMatchObject({ code: "revert_invalid" });
  }
});
