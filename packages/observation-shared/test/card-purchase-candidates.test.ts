// The `candidates` field of `GET /api/v2/card-purchases`: a pending-to-posted
// candidate carries exactly the relation payload its proposal's targets give,
// so a client never builds relation ends or evidence itself. Synthetic only.
import { describe, expect, test } from "bun:test";
import {
  capturedPurchase,
  linkCandidate,
  purchasePage,
} from "../../application/test/card-purchase-view-fixture.ts";
import { validCardPurchasePage } from "../src/card-purchase-contract.ts";

const withCandidates = (...candidates: ReturnType<typeof linkCandidate>[]) =>
  purchasePage([{ ...capturedPurchase(), candidates }]);

describe("card purchase candidates contract", () => {
  test("accepts an open, a merged and a closed candidate", () => {
    expect(validCardPurchasePage(withCandidates())).toBe(true);
    expect(validCardPurchasePage(withCandidates(linkCandidate()))).toBe(true);
    const merged = linkCandidate({
      proposalStatus: "accepted",
      proposalRevision: 1,
      relationStatus: "accepted",
      relationRevision: 1,
      actions: ["withdraw"],
    });
    expect(validCardPurchasePage(withCandidates(merged))).toBe(true);
    const closed = linkCandidate({
      proposalStatus: "rejected",
      proposalRevision: 1,
      relationStatus: "rejected",
      relationRevision: 1,
      actions: [],
      blockers: ["proposal_closed"],
    });
    expect(validCardPurchasePage(withCandidates(closed))).toBe(true);
    const unrecognised = linkCandidate({
      pending: { ...linkCandidate().pending, eventId: null, revision: null, state: null },
      actions: ["reject"],
      blockers: ["row_not_recognized"],
    });
    expect(validCardPurchasePage(withCandidates(unrecognised))).toBe(true);
  });

  test("refuses a relation payload the proposal's targets do not give", () => {
    const base = linkCandidate();
    for (const relation of [
      // The historical double prefix is never a canonical end.
      { ...base.relation, fromRef: "transaction:transaction:23" },
      { ...base.relation, toRef: base.relation.fromRef },
      { ...base.relation, evidenceRefs: base.relation.evidenceRefs.slice(0, 1) },
      { ...base.relation, evidenceRefs: [...base.relation.evidenceRefs].reverse() },
      { ...base.relation, validFrom: "2026-08-01" },
      { ...base.relation, relationKind: "supersedes" },
    ])
      expect(
        validCardPurchasePage(withCandidates({ ...base, relation } as typeof base)),
      ).toBe(false);
  });

  test("refuses unknown fields, codes and inconsistent sides", () => {
    const base = linkCandidate();
    const tampered: unknown[] = [
      { ...base, score: 0.9 },
      { ...base, actions: ["merge"] },
      { ...base, actions: ["accept", "accept"] },
      { ...base, blockers: ["looks_different"] },
      { ...base, rationaleCodes: ["ai_says_same"] },
      { ...base, proposalStatus: "maybe" },
      { ...base, pending: { ...base.pending, revision: null } },
      { ...base, posted: { ...base.posted, eventId: "event_other" } },
      { ...base, posted: { ...base.posted, usageDate: "2026-02-30" } },
    ];
    for (const candidate of tampered)
      expect(
        validCardPurchasePage(withCandidates(candidate as ReturnType<typeof linkCandidate>)),
      ).toBe(false);
    const many = Array.from({ length: 11 }, () => linkCandidate());
    expect(validCardPurchasePage(withCandidates(...many))).toBe(false);
  });
});
