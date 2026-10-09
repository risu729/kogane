// The economic-event command vocabulary (ADR 0054, G2; CORE 0071): the four
// kinds and the exact payload shapes a planner (G3) will read. No planner
// exists; these shapes are exercised only here and by the lifecycle's
// refusal tests. Synthetic ids and keys only; no amount anywhere.
import { describe, expect, test } from "bun:test";
import { IDENTITY_RESOLUTION_KIND, type BookClaim } from "../src/economic-contract.ts";
import {
  ECONOMIC_EVENT_COMMAND_KINDS,
  isEconomicEventCommandKind,
  validEconomicEventCommandPayload,
  validRestatedRevision,
  type EconomicEventCommandKind,
} from "../src/economic-event-commands.ts";

const claimOf = (row: string): BookClaim => ({
  book: "cash-movement",
  key: ["synthetic-bank", "synthetic-producer", null, "synthetic-account", row],
});
const legOf = (legIndex: number, row: number, role = "decrease") => ({
  legIndex,
  subjectRef: `account:acct_synthetic_${legIndex}`,
  role,
  basis: "cash-movement",
  source: { kind: "transaction", id: String(row), revision: "parse_run:1" },
});
const revisionOf = (claims: BookClaim[], legs = [legOf(0, 1)]) => ({
  kind: "transfer",
  state: "debited",
  unknownReason: null,
  legs,
  claims,
});
const withdrawnShape = {
  kind: "transfer",
  state: "unknown",
  unknownReason: "evidence_out_of_scope",
  legs: [],
  claims: [],
};
const reason = "Reviewed both rows";
const VALID: Record<EconomicEventCommandKind, Record<string, unknown>> = {
  "economic-event.adopt": { family: "bank-movement", proposalId: "proposal-synthetic-1", reason },
  "economic-event.correct": {
    family: "bank-movement",
    eventId: "transfer-synthetic-1",
    priorRevision: 1,
    revision: revisionOf(
      [claimOf("row-1"), claimOf("row-2")],
      [legOf(0, 1), legOf(1, 2, "increase")],
    ),
    releasedClaims: [claimOf("row-3")],
    reason,
  },
  "economic-event.withdraw": {
    family: "bank-movement",
    eventId: "transfer-synthetic-1",
    revision: 2,
    decisionRevisionId: "decision-synthetic-adopting",
    reason,
  },
  "economic-event.move": {
    family: "bank-movement",
    claim: claimOf("row-2"),
    from: {
      eventId: "transfer-synthetic-1",
      priorRevision: 1,
      revision: revisionOf([claimOf("row-1")]),
    },
    to: {
      eventId: "transfer-synthetic-2",
      priorRevision: 3,
      revision: revisionOf(
        [claimOf("row-2"), claimOf("row-4")],
        [legOf(0, 2), legOf(1, 4, "increase")],
      ),
    },
    reason,
  },
};
const without = (value: Record<string, unknown>, key: string) => {
  const { [key]: _dropped, ...rest } = value;
  return rest;
};

describe("the vocabulary", () => {
  test("is exactly the four kinds 0071 admits, without the reserved resolution kind", () => {
    expect([...ECONOMIC_EVENT_COMMAND_KINDS]).toEqual([
      "economic-event.adopt",
      "economic-event.correct",
      "economic-event.withdraw",
      "economic-event.move",
    ]);
    expect(isEconomicEventCommandKind(IDENTITY_RESOLUTION_KIND)).toBe(false);
    for (const kind of [
      "economic-event",
      "economic-event.delete",
      "economic-event.adopt ",
      1,
      null,
    ])
      expect(isEconomicEventCommandKind(kind)).toBe(false);
  });
});

describe("payloads", () => {
  test("each kind accepts exactly its keys, a closed family and a non-blank reason", () => {
    for (const kind of ECONOMIC_EVENT_COMMAND_KINDS) {
      const payload = VALID[kind];
      expect(validEconomicEventCommandPayload(kind, payload)).toBe(true);
      // No caller fact, amount, approval or revision pin rides along.
      for (const extra of [
        { amount: "1000" },
        { quantity: { unit: "JPY", value: "1" } },
        { approved: true },
        { expectedRevisions: {} },
        { actorKind: "human" },
      ])
        expect(validEconomicEventCommandPayload(kind, { ...payload, ...extra })).toBe(false);
      for (const key of Object.keys(payload))
        expect(validEconomicEventCommandPayload(kind, without(payload, key))).toBe(false);
      for (const family of ["", "own-transfer", "Bank-movement", null, 1])
        expect(validEconomicEventCommandPayload(kind, { ...payload, family })).toBe(false);
      for (const blank of ["", " ", "x".repeat(1001), null])
        expect(validEconomicEventCommandPayload(kind, { ...payload, reason: blank })).toBe(false);
      // One kind's payload is never read as another's.
      for (const other of ECONOMIC_EVENT_COMMAND_KINDS)
        if (other !== kind) expect(validEconomicEventCommandPayload(other, payload)).toBe(false);
      expect(validEconomicEventCommandPayload(kind, null)).toBe(false);
      expect(validEconomicEventCommandPayload(kind, [payload])).toBe(false);
    }
  });

  test("adopt names a proposal; withdraw names the revision and the adopting decision", () => {
    const adopt = VALID["economic-event.adopt"];
    expect(
      validEconomicEventCommandPayload("economic-event.adopt", { ...adopt, proposalId: "" }),
    ).toBe(false);
    const withdraw = VALID["economic-event.withdraw"];
    for (const revision of [0, -1, 1.5, "2", null])
      expect(
        validEconomicEventCommandPayload("economic-event.withdraw", { ...withdraw, revision }),
      ).toBe(false);
    for (const decisionRevisionId of ["", null, "x".repeat(257)])
      expect(
        validEconomicEventCommandPayload("economic-event.withdraw", {
          ...withdraw,
          decisionRevisionId,
        }),
      ).toBe(false);
  });

  test("correct restates a full revision and lists what it releases, never a restated claim", () => {
    const correct = VALID["economic-event.correct"] as Record<string, unknown> & {
      revision: ReturnType<typeof revisionOf>;
    };
    const check = (patch: Record<string, unknown>) =>
      validEconomicEventCommandPayload("economic-event.correct", { ...correct, ...patch });
    expect(check({ releasedClaims: [] })).toBe(true);
    // A released claim that the restatement still holds.
    expect(check({ releasedClaims: [claimOf("row-1")] })).toBe(false);
    expect(check({ releasedClaims: [claimOf("row-3"), claimOf("row-3")] })).toBe(false);
    // A correction to `unknown` is a withdrawal.
    expect(check({ revision: withdrawnShape })).toBe(false);
    for (const priorRevision of [0, "1", null]) expect(check({ priorRevision })).toBe(false);
    expect(check({ eventId: "" })).toBe(false);
  });

  test("a restated revision is complete and states no value", () => {
    const base = revisionOf([claimOf("row-1")]);
    expect(validRestatedRevision(base)).toBe(true);
    expect(validRestatedRevision(withdrawnShape)).toBe(true);
    const leg = legOf(0, 1);
    for (const revision of [
      { ...base, legs: [] },
      { ...base, claims: [] },
      { ...base, claims: [claimOf("row-1"), claimOf("row-1")] },
      { ...base, claims: [{ book: "cash", key: claimOf("row-1").key }] },
      { ...base, legs: [legOf(1, 1)] },
      { ...base, legs: [legOf(0, 1), legOf(0, 2)] },
      { ...base, legs: [{ ...leg, quantity: { unit: "JPY", value: "1" } }] },
      { ...base, legs: [{ ...leg, subjectRef: "acct_synthetic_0" }] },
      { ...base, legs: [{ ...leg, subjectRef: "account:" }] },
      { ...base, legs: [{ ...leg, role: "transfer" }] },
      { ...base, legs: [{ ...leg, source: { ...leg.source, kind: "balance" } }] },
      { ...base, legs: [{ ...leg, source: { kind: "transaction", id: "1" } }] },
      { ...base, state: "captured" },
      { ...base, kind: "transfer-out" },
      { ...base, unknownReason: "kind_undecided" },
      { ...withdrawnShape, unknownReason: null },
      { ...withdrawnShape, claims: [claimOf("row-1")] },
      { ...withdrawnShape, legs: [leg] },
      { ...base, legs: Array.from({ length: 65 }, (_, index) => legOf(index, index)) },
      without(base, "claims"),
      { ...base, supersededBy: null },
    ])
      expect(validRestatedRevision(revision)).toBe(false);
  });

  test("move is one claim between two members: off the first, onto the second", () => {
    const move = VALID["economic-event.move"] as Record<string, unknown> & {
      from: Record<string, unknown>;
      to: Record<string, unknown>;
    };
    const check = (patch: Record<string, unknown>) =>
      validEconomicEventCommandPayload("economic-event.move", { ...move, ...patch });
    // The first member may be left holding nothing.
    expect(check({ from: { ...move.from, revision: withdrawnShape } })).toBe(true);
    expect(check({ to: { ...move.to, eventId: move.from.eventId } })).toBe(false);
    expect(
      check({ from: { ...move.from, revision: revisionOf([claimOf("row-1"), claimOf("row-2")]) } }),
    ).toBe(false);
    expect(check({ to: { ...move.to, revision: revisionOf([claimOf("row-4")]) } })).toBe(false);
    expect(check({ to: { ...move.to, revision: withdrawnShape } })).toBe(false);
    expect(check({ to: { ...move.to, priorRevision: 0 } })).toBe(false);
    expect(check({ from: without(move.from, "priorRevision") })).toBe(false);
    expect(check({ claim: { ...claimOf("row-2"), alias: null } })).toBe(false);
  });
});
