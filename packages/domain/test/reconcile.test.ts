// The candidate matcher (addendum 07 section 3). Every case here checks that a
// rule proposes and never adopts, and that agreement on an amount and a date is
// not evidence of identity or of ownership.
import { describe, expect, test } from "bun:test";
import { canonicalDigest, canonicalJson } from "../src/context.ts";
import { RELATION_KINDS, RELATION_STATUS_STORAGE } from "../src/decisions.ts";
import {
  DEFAULT_MATCH_OPTIONS,
  matchProposals,
  postedInWindow,
  proposalIdentity,
  RECONCILIATION_KINDS,
  stageAProposals,
  stageBProposals,
  stageCProposals,
  validReconciliationProposal,
  type MatchFact,
} from "../src/reconcile.ts";
import type { TemporalValue } from "../src/time.ts";
import { q } from "./helpers.ts";

const scope = {
  sourceId: "vpass",
  credentialEpoch: "producer-a/namespace-1",
  accountNamespace: "vpass:synthetic-card",
};

/** A provider usage day, as both Vpass displays and both MyJCB ledgers date a row. */
function day(value: string): TemporalValue {
  return { kind: "local-date", value, zone: null, basis: "provider" };
}

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

  test("a collector fingerprint pairs nothing, however often the row is re-captured", () => {
    // Every daily capture of one displayed row carries the same fingerprint;
    // which capture is current is snapshot currentness, not a relation.
    const captures = ["1", "2", "3"].map((id) => fact({ id, externalId: "fingerprint-1" }));
    expect(stageAProposals(captures)).toEqual([]);
    // One provider side does not make the pair a provider identifier.
    expect(
      stageAProposals([
        fact({ id: "1", externalId: "row-1", identifierOrigin: "provider" }),
        fact({ id: "2", externalId: "row-1" }),
      ]),
    ).toEqual([]);
    // Nor does an origin nobody recorded.
    expect(
      stageAProposals([
        fact({ id: "1", externalId: "row-1", identifierOrigin: "unknown" }),
        fact({ id: "2", externalId: "row-1", identifierOrigin: "unknown" }),
      ]),
    ).toEqual([]);
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

describe("stage B: the matching window", () => {
  const window = DEFAULT_MATCH_OPTIONS.dayWindow;
  const pending = fact({ id: "1", settlementState: "pending", occurred: day("2026-03-10") });
  const postedOn = (id: string, value: string, amount = "-1200") =>
    fact({ id, settlementState: "posted", occurred: day(value), quantity: q("JPY", amount) });

  test("the window is the domain's day window, counted forward from the pending day", () => {
    expect(window).toBe(5);
    expect(postedInWindow(day("2026-03-10"), day("2026-03-10"), window)).toBe(true);
    expect(postedInWindow(day("2026-03-10"), day("2026-03-15"), window)).toBe(true);
    expect(postedInWindow(day("2026-03-10"), day("2026-03-16"), window)).toBe(false);
    expect(postedInWindow(day("2026-03-10"), day("2026-03-09"), window)).toBe(false);
    // Across a month end, by civil days.
    expect(postedInWindow(day("2026-02-27"), day("2026-03-04"), window)).toBe(true);
    expect(postedInWindow({ kind: "unknown", reasonCode: "x" }, day("2026-03-10"), window)).toBe(
      false,
    );
  });

  test("UC13: a posted row on the pending day or up to the window after it is a candidate", () => {
    for (const value of ["2026-03-10", "2026-03-15"]) {
      const [proposal, ...others] = stageBProposals([pending, postedOn("2", value)]);
      expect(others).toEqual([]);
      expect(proposal).toMatchObject({ kind: "pending_to_posted", autoAcceptable: false });
      expect(proposal!.rationaleCodes).toEqual(
        expect.arrayContaining(["date_within_window", "same_statement_period", "amount_equal"]),
      );
    }
  });

  test("a posted row before the pending day or past the window is not proposed at all", () => {
    // Same statement period, same amount, same merchant: none of it pairs a
    // posted row the authorisation cannot have become.
    expect(stageBProposals([pending, postedOn("2", "2026-03-09")])).toEqual([]);
    expect(stageBProposals([pending, postedOn("2", "2026-03-16")])).toEqual([]);
    expect(stageBProposals([pending, postedOn("2", "2026-03-31")])).toEqual([]);
  });

  test("a row without a provider day is never in the window, whatever its period", () => {
    const undated = fact({
      id: "2",
      settlementState: "posted",
      occurred: { kind: "unknown", reasonCode: "provider_date_absent" },
    });
    expect(stageBProposals([pending, undated])).toEqual([]);
  });

  test("one statement month pairs each pending row with its own window, not the whole month", () => {
    // Three purchases of one month: before the window rule every pending row
    // paired with every posted row of the period (9 candidates, all ambiguous).
    const facts = [
      fact({ id: "1", settlementState: "pending", occurred: day("2026-03-01") }),
      fact({ id: "2", settlementState: "pending", occurred: day("2026-03-12") }),
      fact({ id: "3", settlementState: "pending", occurred: day("2026-03-24") }),
      postedOn("11", "2026-03-02"),
      postedOn("12", "2026-03-12"),
      postedOn("13", "2026-03-26"),
    ];
    const proposals = stageBProposals(facts);
    expect(proposals.map((proposal) => proposal.targetRefs.map((ref) => ref.id))).toEqual([
      ["transaction:1", "transaction:11"],
      ["transaction:2", "transaction:12"],
      ["transaction:3", "transaction:13"],
    ]);
    for (const proposal of proposals)
      expect(proposal.rationaleCodes).not.toContain("multiple_candidates");
  });

  test("SC03: two same-amount purchases on one day stay four reviewed candidates", () => {
    const facts = [
      fact({ id: "1", settlementState: "pending", occurred: day("2026-03-10") }),
      fact({ id: "2", settlementState: "pending", occurred: day("2026-03-10") }),
      postedOn("11", "2026-03-10"),
      postedOn("12", "2026-03-11"),
    ];
    const proposals = stageBProposals(facts);
    expect(proposals).toHaveLength(4);
    for (const proposal of proposals) {
      expect(proposal.autoAcceptable).toBe(false);
      expect(proposal.rationaleCodes).toContain("multiple_candidates");
      expect(proposal.rejectionConditions).toContain("candidate_not_unique");
    }
  });

  test("a posted amount that differs stays a candidate inside the window, after the equal one", () => {
    // A foreign-currency charge converted at posting, or a hold settled lower:
    // the amounts disagree and the reviewer is told so; the rule decides nothing.
    const differs = postedOn("2", "2026-03-11", "-1234");
    const equal = postedOn("3", "2026-03-12");
    const proposals = stageBProposals([pending, differs, equal]);
    expect(proposals.map((proposal) => proposal.targetRefs[1]!.id)).toEqual([
      "transaction:3",
      "transaction:2",
    ]);
    expect(proposals[0]!.rationaleCodes).toContain("amount_equal");
    expect(proposals[1]!.rationaleCodes).not.toContain("amount_equal");
    expect(proposals[1]!.rejectionConditions).toContain("amount_differs");
    for (const proposal of proposals)
      expect(proposal.rationaleCodes).toContain("multiple_candidates");
    // Alone in its window the differing amount is still the one candidate.
    const [alone, ...others] = stageBProposals([pending, differs]);
    expect(others).toEqual([]);
    expect(alone!.rationaleCodes).not.toContain("multiple_candidates");
  });

  test("UC23: agreement inside the window is a candidate, never an owner or an acceptance", () => {
    const [proposal] = stageBProposals([pending, postedOn("2", "2026-03-10")]);
    expect(proposal).toMatchObject({
      status: "proposed",
      decisionRevisionRef: null,
      autoAcceptable: false,
    });
    expect(proposal!.rationaleCodes).not.toContain("owner_established_self");
    expect(proposal!.rejectionConditions).toContain("provider_link_absent");
  });

  test("a pair the provider itself linked is proposed whatever its days", () => {
    const [proposal, ...others] = stageBProposals([
      { ...pending, providerLinkId: "auth-1" },
      { ...postedOn("2", "2026-04-20"), providerLinkId: "auth-1" },
    ]);
    expect(others).toEqual([]);
    expect(proposal!.autoAcceptable).toBe(true);
    expect(proposal!.rationaleCodes).toContain("provider_link_id_equal");
    expect(proposal!.rationaleCodes).not.toContain("date_within_window");
  });

  test("a pair still proposed keeps its stored identity byte for byte", async () => {
    // `reconciliation_proposals.proposal_digest` is this digest, and a writer
    // skips a pair whose digest is stored. The window only removes pairs: an
    // in-window pair, whatever its rationale, keeps the identity and digest
    // it had before the rule, so a decided pair is never proposed again.
    const [proposal] = stageBProposals([
      fact({ id: "1", settlementState: "pending" }),
      fact({
        id: "2",
        settlementState: "posted",
        occurred: day("2026-03-04"),
        quantity: q("JPY", "-1234"),
      }),
    ]);
    expect(canonicalJson(proposalIdentity(proposal!))).toBe(
      '{"kind":"pending_to_posted","method":"rule","policyRelease":"reconciliation-rules-v1","stage":"B","targetRefs":["transaction/transaction:1@parse_run:1","transaction/transaction:2@parse_run:1"]}',
    );
    expect(await canonicalDigest(proposalIdentity(proposal!))).toBe(
      "7a3b4973d327ff4bfe531d1d6560d4937e4432d88be88d0fa24a47a31463a515",
    );
    const [provider] = stageAProposals([
      fact({ id: "1", externalId: "provider-row-1", identifierOrigin: "provider" }),
      fact({ id: "2", externalId: "provider-row-1", identifierOrigin: "provider" }),
    ]);
    expect(await canonicalDigest(proposalIdentity(provider!))).toBe(
      "fca4c1a479278ac43541dbce3c99ebf344feb238fd95346de040f98d0dddd604",
    );
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

  test("the stored digest of a pair is pinned and ignores how the evidence cites the rows", async () => {
    // `reconciliation_proposals.proposal_digest` is this digest, and a writer
    // inserts only `WHERE NOT EXISTS` a row with it. The pinned value is what
    // the matcher produced before its evidence stopped double-prefixing the
    // refs (`transaction:transaction:1`), so every stored proposal keeps its
    // digest and no decided pair is proposed again beside its old row.
    const [proposal] = stageBProposals([
      fact({ id: "1", settlementState: "pending" }),
      fact({ id: "2", settlementState: "posted" }),
    ]);
    expect(proposal!.evidenceRefs).toEqual(["transaction:1", "transaction:2"]);
    const pinned = "7a3b4973d327ff4bfe531d1d6560d4937e4432d88be88d0fa24a47a31463a515";
    expect(await canonicalDigest(proposalIdentity(proposal!))).toBe(pinned);
    const historical = {
      ...proposal!,
      evidenceRefs: ["transaction:transaction:1", "transaction:transaction:2"],
    };
    expect(await canonicalDigest(proposalIdentity(historical))).toBe(pinned);
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
