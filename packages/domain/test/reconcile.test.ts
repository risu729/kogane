// The candidate matcher (addendum 07 section 3). Every case here checks that a
// rule proposes and never adopts, and that agreement on an amount and a date is
// not evidence of identity or of ownership.
import { describe, expect, test } from "bun:test";
import { RELATION_KINDS, RELATION_STATUS_STORAGE } from "../src/decisions.ts";
import {
  DEFAULT_MATCH_OPTIONS,
  matchProposals,
  proposalIdentity,
  RECONCILIATION_KINDS,
  stageAProposals,
  stageBProposals,
  stageCProposals,
  validReconciliationProposal,
  type MatchFact,
} from "../src/reconcile.ts";
import { q } from "./helpers.ts";

const scope = {
  sourceId: "vpass",
  credentialEpoch: "producer-a/namespace-1",
  accountNamespace: "vpass:synthetic-card",
};

function fact(overrides: Partial<MatchFact> & { id: string }): MatchFact {
  const { id, ...rest } = overrides;
  return {
    ref: { kind: "transaction", id: `transaction:${id}`, revision: "parse_run:1" },
    scope,
    sourceAccount: "vpass:synthetic-card",
    externalId: null,
    identifierOrigin: "collector-fingerprint",
    providerLinkId: null,
    settlementState: "unknown",
    quantity: q("JPY", "-1200"),
    occurred: { kind: "local-date", value: "2026-03-01", zone: null, basis: "provider" },
    counterparty: "synthetic-merchant",
    statementPeriod: "2026-03",
    ownerRef: null,
    ...rest,
  };
}

describe("stage A: the same provider row observed twice", () => {
  test("a provider-issued identifier inside one namespace is auto-acceptable", () => {
    const proposals = stageAProposals([
      fact({ id: "1", externalId: "provider-row-1", identifierOrigin: "provider" }),
      fact({ id: "2", externalId: "provider-row-1", identifierOrigin: "provider" }),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "provider_same", stage: "A", status: "proposed" });
    expect(proposals[0]!.autoAcceptable).toBe(true);
    expect(proposals[0]!.rationaleCodes).toContain("provider_identifier_equal");
    expect(proposals.every(validReconciliationProposal)).toBe(true);
  });

  test("a collector fingerprint is proposed, never accepted", () => {
    const proposals = stageAProposals([
      fact({ id: "1", externalId: "fingerprint-1" }),
      fact({ id: "2", externalId: "fingerprint-1" }),
    ]);
    expect(proposals[0]!.autoAcceptable).toBe(false);
    expect(proposals[0]!.rationaleCodes).toContain("collector_fingerprint_identifier");
  });

  test("the same identifier in another credential epoch or namespace proves nothing", () => {
    const other = {
      ...scope,
      credentialEpoch: "producer-a/namespace-2",
    };
    expect(
      stageAProposals([
        fact({ id: "1", externalId: "provider-row-1", identifierOrigin: "provider" }),
        fact({ id: "2", externalId: "provider-row-1", identifierOrigin: "provider", scope: other }),
      ]),
    ).toEqual([]);
  });
});

describe("stage B: pending becomes posted inside one provider", () => {
  const pending = fact({ id: "1", settlementState: "pending" });
  const posted = fact({ id: "2", settlementState: "posted", quantity: q("JPY", "-1234") });

  test("without a provider link id the pair is a candidate only (UC13, SC03)", () => {
    const proposals = stageBProposals([pending, posted]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "pending_to_posted",
      stage: "B",
      status: "proposed",
      autoAcceptable: false,
    });
    expect(proposals[0]!.rationaleCodes).toContain("no_provider_link_id");
    expect(proposals[0]!.rejectionConditions).toContain("provider_link_absent");
    // Nothing here says the two rows are the same purchase.
    expect(proposals[0]!.decisionRevisionRef).toBeNull();
  });

  test("an explicit provider link id makes exactly one pair auto-acceptable", () => {
    const linkedPending = { ...pending, providerLinkId: "auth-1" };
    const linkedPosted = { ...posted, providerLinkId: "auth-1" };
    const proposals = stageBProposals([linkedPending, linkedPosted]);
    expect(proposals[0]!.autoAcceptable).toBe(true);
    expect(proposals[0]!.rationaleCodes).toContain("provider_link_id_equal");
  });

  test("two posted rows of the same amount and day are both candidates, never merged", () => {
    const twin = fact({ id: "3", settlementState: "posted", quantity: q("JPY", "-1234") });
    const proposals = stageBProposals([pending, posted, twin]);
    expect(proposals).toHaveLength(2);
    for (const proposal of proposals) {
      expect(proposal.autoAcceptable).toBe(false);
      expect(proposal.rationaleCodes).toContain("multiple_candidates");
      expect(proposal.rejectionConditions).toContain("candidate_not_unique");
    }
  });

  test("a look-alike row is its own candidate and never becomes automatic", () => {
    const linked = { ...pending, providerLinkId: "auth-1" };
    const linkedPosted = { ...posted, providerLinkId: "auth-1" };
    const twin = fact({ id: "3", settlementState: "posted", quantity: q("JPY", "-1234") });
    const proposals = stageBProposals([linked, linkedPosted, twin]);
    expect(proposals).toHaveLength(2);
    const automatic = proposals.filter((proposal) => proposal.autoAcceptable);
    // The provider stated one link; the look-alike stays a reviewed candidate.
    expect(automatic).toHaveLength(1);
    expect(automatic[0]!.targetRefs[1]!.id).toBe("transaction:2");
  });

  test("a date far outside the window and a different statement period do not pair", () => {
    const distant = fact({
      id: "4",
      settlementState: "posted",
      statementPeriod: "2026-09",
      occurred: { kind: "local-date", value: "2026-09-20", zone: null, basis: "provider" },
    });
    expect(stageBProposals([pending, distant], DEFAULT_MATCH_OPTIONS)).toEqual([]);
  });
});

describe("stage C: a correspondence across sources", () => {
  const bank = fact({
    id: "10",
    scope: { sourceId: "synthetic-bank", credentialEpoch: "producer-b/ns", accountNamespace: "b" },
    sourceAccount: "synthetic-bank:ordinary",
    quantity: q("JPY", "-10000"),
    counterparty: "synthetic-card-issuer",
  });
  const card = fact({
    id: "11",
    scope: { sourceId: "synthetic-card", credentialEpoch: "producer-c/ns", accountNamespace: "c" },
    sourceAccount: "synthetic-card:root",
    quantity: q("JPY", "10000"),
    counterparty: "synthetic-bank",
  });

  test("the same amount on nearby days is a candidate, never an accepted transfer (UC23, AT23)", () => {
    const proposals = stageCProposals([bank, card]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "funded_by",
      stage: "C",
      status: "proposed",
      autoAcceptable: false,
    });
    expect(proposals[0]!.rejectionConditions).toContain("owner_not_established");
    expect(proposals[0]!.rationaleCodes).not.toContain("owner_established_self");
  });

  test("an established owner on both sides is recorded as a reason and still not accepted", () => {
    const proposals = stageCProposals([
      { ...bank, ownerRef: "party:self" },
      { ...card, ownerRef: "party:self" },
    ]);
    expect(proposals[0]!.rationaleCodes).toContain("owner_established_self");
    expect(proposals[0]!.rejectionConditions).not.toContain("owner_not_established");
    // Cross-source correspondences are reviewed at this stage, whatever agrees.
    expect(proposals[0]!.autoAcceptable).toBe(false);
  });

  test("an owner claimed by only one side never establishes a self transfer", () => {
    const proposals = stageCProposals([{ ...bank, ownerRef: "party:self" }, card]);
    expect(proposals[0]!.rejectionConditions).toContain("owner_not_established");
  });
});

describe("proposal contract", () => {
  test("every reconciliation kind is a relation kind the store already accepts", () => {
    for (const kind of RECONCILIATION_KINDS)
      expect(RELATION_KINDS as readonly string[]).toContain(kind);
  });

  test("the domain relation statuses map onto the four stored values", () => {
    expect(new Set(Object.values(RELATION_STATUS_STORAGE))).toEqual(
      new Set(["proposed", "accepted", "rejected", "released"]),
    );
    expect(RELATION_STATUS_STORAGE.adopted).toBe("accepted");
    expect(RELATION_STATUS_STORAGE.superseded).toBe("released");
  });

  test("matchProposals is deterministic and its identity ignores the rationale", () => {
    const facts = [
      fact({ id: "1", settlementState: "pending" }),
      fact({ id: "2", settlementState: "posted" }),
    ];
    const first = matchProposals(facts);
    expect(matchProposals(facts)).toEqual(first);
    expect(matchProposals([...facts].reverse())).toEqual(first);
    expect(proposalIdentity(first[0]!)).toEqual({
      kind: "pending_to_posted",
      stage: "B",
      method: "rule",
      policyRelease: "reconciliation-rules-v1",
      targetRefs: [
        "transaction/transaction:1@parse_run:1",
        "transaction/transaction:2@parse_run:1",
      ],
    });
  });

  test("a proposal claiming auto-acceptance without provider evidence is invalid", () => {
    const proposals = stageBProposals([
      fact({ id: "1", settlementState: "pending" }),
      fact({ id: "2", settlementState: "posted" }),
    ]);
    expect(validReconciliationProposal({ ...proposals[0]!, autoAcceptable: true })).toBe(false);
    expect(validReconciliationProposal(proposals[0]!)).toBe(true);
  });
});
