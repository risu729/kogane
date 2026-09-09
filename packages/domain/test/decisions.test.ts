import { describe, expect, test } from "bun:test";
import {
  checkFillAllocations,
  checkObligationAllocations,
  checkSourceAllocations,
  checkTransferConservation,
  RELATION_KINDS,
  validActor,
  validAllocation,
  validDecisionRevision,
  validOperationReceipt,
  validTypedRelation,
  type Allocation,
  type DecisionRevision,
  type OperationReceipt,
  type TypedRelation,
} from "../src/decisions.ts";
import { q } from "./helpers.ts";

const revision: DecisionRevision = {
  revisionId: "rev:1",
  decisionId: "decision:1",
  kind: "proposal",
  actor: { kind: "agent", id: "agent:reconciler", verification: "server" },
  method: "heuristic",
  recordedAt: "2026-09-01T09:00:00+09:00",
  reason: "Amounts and dates match.",
  targetRefs: ["rel:1"],
  evidenceRefs: ["ev:1"],
  supersedesRevisionRef: null,
  planDigest: null,
};

describe("decision records", () => {
  test("actors are server-verified or explicitly legacy-unknown", () => {
    expect(validActor({ kind: "human", id: "operator:1", verification: "server" })).toBe(true);
    expect(validActor({ kind: "legacy-unknown", id: null, verification: "legacy" })).toBe(true);
    expect(validActor({ kind: "legacy-unknown", id: "someone", verification: "legacy" })).toBe(
      false,
    );
    expect(validActor({ kind: "human", id: "operator:1", verification: "client" })).toBe(false);
    expect(validActor({ kind: "human", id: null, verification: "server" })).toBe(false);
    expect(validActor({ kind: "human", id: "x", verification: "server", token: "t" })).toBe(false);
  });

  test("revision kinds carry the references they need", () => {
    expect(validDecisionRevision(revision)).toBe(true);
    expect(validDecisionRevision({ ...revision, kind: "acceptance" })).toBe(false);
    expect(
      validDecisionRevision({ ...revision, kind: "acceptance", planDigest: "sha256:plan" }),
    ).toBe(true);
    expect(validDecisionRevision({ ...revision, kind: "supersession" })).toBe(false);
    expect(
      validDecisionRevision({
        ...revision,
        kind: "release-override",
        supersedesRevisionRef: "rev:0",
      }),
    ).toBe(true);
    expect(validDecisionRevision({ ...revision, targetRefs: [] })).toBe(false);
    expect(validDecisionRevision({ ...revision, recordedAt: "2026-09-01" })).toBe(false);
    expect(validDecisionRevision({ ...revision, confidence: 0.9 })).toBe(false);
    expect(
      validDecisionRevision({
        ...revision,
        actor: { kind: "legacy-unknown", id: null, verification: "legacy" },
        method: "legacy-unknown",
      }),
    ).toBe(true);
  });

  test("relations are a closed union of typed kinds", () => {
    expect([...RELATION_KINDS]).toEqual([
      "same_account",
      "connection_contains",
      "account_has_pocket",
      "statement_covers",
      "funded_by",
      "liable_party",
      "beneficial_owner",
      "same_underlying",
      "listed_as",
      "replaces_identifier",
      "provider_same",
      "supersedes",
      "supports",
      "contradicts",
      "pending_to_posted",
    ]);
    const relation: TypedRelation = {
      relationId: "rel:1",
      kind: "connection_contains",
      left: "connection:mf:x",
      right: "account:direct:yen",
      validity: null,
      evidenceRefs: ["ev:1"],
      status: "adopted",
      decisionRevisionRef: "rev:1",
    };
    expect(validTypedRelation(relation)).toBe(true);
    expect(validTypedRelation({ ...relation, kind: "same_as" })).toBe(false);
    expect(validTypedRelation({ ...relation, right: relation.left })).toBe(false);
    expect(validTypedRelation({ ...relation, confidence: 1 })).toBe(false);
    expect(
      validTypedRelation({
        ...relation,
        validity: {
          kind: "period",
          start: "2026-01",
          end: "2026-12",
          endExclusive: false,
          zone: null,
          granularity: "month",
        },
      }),
    ).toBe(true);
  });

  test("operation receipts distinguish accepted from published", () => {
    const receipt: OperationReceipt = {
      operationId: "op:1",
      idempotencyKey: "key:1",
      principalRef: "principal:owner",
      payloadDigest: "sha256:payload",
      status: "accepted",
      recordedAt: "2026-09-01T09:00:00Z",
      resultRef: null,
      expectedRevisions: { "account:1": 7 },
    };
    expect(validOperationReceipt(receipt)).toBe(true);
    expect(validOperationReceipt({ ...receipt, status: "done" })).toBe(false);
    expect(validOperationReceipt({ ...receipt, expectedRevisions: { "account:1": -1 } })).toBe(
      false,
    );
    expect(validOperationReceipt({ ...receipt, approved: true })).toBe(false);
  });
});

describe("allocation conservation", () => {
  const allocation = (
    id: string,
    amount: string,
    role: Allocation["role"] = "principal",
    unit = "JPY",
  ): Allocation => ({
    allocationId: id,
    sourceRef: "payment:1",
    targetRef: "obligation:1",
    role,
    quantity: q(unit, amount),
  });

  test("same-asset transfers balance exactly or report the gap (SC09)", () => {
    expect(
      checkTransferConservation({
        sourceDecrease: q("crypto:synthetic", "1.000"),
        destinationIncrease: q("crypto:synthetic", "0.999"),
        explicitFees: [q("crypto:synthetic", "0.001")],
        unresolvedDifference: null,
      }),
    ).toEqual({ ok: true, unresolvedDifference: q("crypto:synthetic", "0") });
    const gap = checkTransferConservation({
      sourceDecrease: q("crypto:synthetic", "1.000"),
      destinationIncrease: q("crypto:synthetic", "0.998"),
      explicitFees: [q("crypto:synthetic", "0.001")],
      unresolvedDifference: null,
    });
    expect(gap).toMatchObject({
      ok: false,
      error: { code: "conservation_violated", difference: q("crypto:synthetic", "0.001") },
    });
    expect(
      checkTransferConservation({
        sourceDecrease: q("crypto:synthetic", "1.000"),
        destinationIncrease: q("crypto:synthetic", "0.998"),
        explicitFees: [q("crypto:synthetic", "0.001")],
        unresolvedDifference: q("crypto:synthetic", "0.001"),
      }),
    ).toEqual({ ok: true, unresolvedDifference: q("crypto:synthetic", "0.001") });
    // A fee in a different asset is not folded into the same-unit equation.
    expect(
      checkTransferConservation({
        sourceDecrease: q("crypto:synthetic", "1"),
        destinationIncrease: q("crypto:synthetic", "1"),
        explicitFees: [q("crypto:gas", "0.001")],
        unresolvedDifference: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "unit_mismatch" } });
    expect(
      checkTransferConservation({
        sourceDecrease: q("crypto:synthetic", "1"),
        destinationIncrease: {
          unitRef: "crypto:synthetic",
          value: { status: "missing", reasonCode: "not_yet_observed" },
        },
        explicitFees: [],
        unresolvedDifference: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "value_not_exact" } });
  });

  test("allocations never exceed the outstanding obligation, the executed quantity or the source amount (INV06)", () => {
    expect(
      checkObligationAllocations({
        outstanding: q("JPY", "12000"),
        allocations: [allocation("a1", "4000")],
      }),
    ).toEqual({
      ok: true,
      allocated: q("JPY", "4000"),
      remaining: q("JPY", "8000"),
    });
    expect(
      checkObligationAllocations({
        outstanding: q("JPY", "12000"),
        allocations: [allocation("a1", "8000"), allocation("a2", "5000")],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "allocation_exceeds_limit",
        refs: ["a1", "a2"],
        difference: q("JPY", "-1000"),
      },
    });
    expect(
      checkFillAllocations({
        executedQuantity: q("share:synthetic", "10"),
        fills: [
          allocation("f1", "6", "fill", "share:synthetic"),
          allocation("f2", "4", "fill", "share:synthetic"),
        ],
      }),
    ).toEqual({
      ok: true,
      allocated: q("share:synthetic", "10"),
      remaining: q("share:synthetic", "0"),
    });
    expect(
      checkSourceAllocations({
        sourceAmount: q("JPY", "400"),
        allocations: [allocation("r1", "400", "refund"), allocation("r2", "400", "refund")],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "allocation_exceeds_limit" },
    });
    expect(
      checkSourceAllocations({
        sourceAmount: q("JPY", "400"),
        allocations: [allocation("r1", "-100", "refund")],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "negative_allocation", refs: ["r1"] },
    });
    expect(
      checkObligationAllocations({
        outstanding: q("JPY", "100"),
        allocations: [allocation("u", "1", "principal", "USD")],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "unit_mismatch" },
    });
    expect(validAllocation(allocation("a", "1"))).toBe(true);
    expect(validAllocation({ ...allocation("a", "1"), note: "x" })).toBe(false);
    expect(validAllocation({ ...allocation("a", "1"), role: "gift" })).toBe(false);
  });
});
