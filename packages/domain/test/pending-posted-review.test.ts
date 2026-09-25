// Pending-to-posted links as one purchase (card purchase plan §1.2): the merge
// and split drafts, the linked revision the lane keeps a merged event current
// with, and the one definition of what a review may do. Synthetic rows only.
import { describe, expect, test } from "bun:test";
import {
  cardPurchaseEventId,
  cardPurchaseLinkedRevision,
  cardPurchaseMerge,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  cardPurchaseSplit,
  cardPurchaseSummary,
  recognitionKey,
  type CardPurchaseDraft,
  type CardPurchaseLive,
  type CardUsageFact,
} from "../src/card-purchase.ts";
import { eventTransition, type SourceFactRef } from "../src/events.ts";
import {
  canonicalRelationEnd,
  cardPurchaseSubjectRef,
  pendingPostedEvidenceRefs,
  pendingPostedMarker,
  pendingPostedProposalId,
  pendingPostedRelation,
  pendingPostedReview,
  pendingPostedReviewRequested,
  proposalSubjectRef,
  type PendingPostedHolder,
  type PendingPostedTarget,
} from "../src/pending-posted-review.ts";
import { stageBProposals, type MatchFact } from "../src/reconcile.ts";
import { exactQuantity, integerDecimal } from "../src/values.ts";

/**
 * A MyJCB ledger row in the production shape. The pending and posted pair
 * here is MyJCB's unconfirmed and confirmed ledger: a Vpass pending
 * (customized) row is not recognised until the meaning of its payment-type
 * field (`bunkatsuYaku`, `0` on every production row) is verified, so the
 * Vpass pending side is not exercised here yet. A single payment's usage and
 * payment texts agree, in the provider's sign.
 */
function row(overrides: Partial<CardUsageFact> = {}): CardUsageFact {
  return {
    observationId: 101,
    parseRunId: 11,
    sourceId: "myjcb",
    producerId: "card-producer",
    externalIdNamespace: "myjcb-connection-v1",
    sourceAccount: "myjcb:connection-a:root",
    externalId: "myjcb-credit-ledger:confirmed:row-q:0",
    accountId: "acct-card",
    identityPolicyFamily: "identity-default",
    providerStatus: "confirmed",
    amount: exactQuantity("JPY", integerDecimal(-1234), "decimal-v1"),
    usageDate: "2026-08-21",
    // The combined ご利用先など／支払区分 cell production MyJCB rows carry.
    paymentType: "架空店舗 1回払",
    statementPeriod: "2026年9月お支払い分",
    capturedAt: "2026-09-07T00:00:00.000Z",
    providerSaleCode: null,
    usageAmountText: "1,234円",
    paymentAmountText: "1,234円",
    newestRepresentation: true,
    ...overrides,
  };
}
const POSTED = row();
const PENDING = row({
  observationId: 100,
  parseRunId: 10,
  externalId: "myjcb-credit-ledger:unconfirmed:row-p:0",
  providerStatus: "unconfirmed",
  amount: exactQuantity("JPY", integerDecimal(-1200), "decimal-v1"),
  usageDate: "2026-08-20",
  usageAmountText: "1,200円",
  paymentAmountText: "1,200円",
});
/** A refund row: the provider's minus sign on both texts. */
const REFUND = row({
  externalId: "refund-row",
  amount: exactQuantity("JPY", integerDecimal(1234)),
  usageAmountText: "-1,234円",
  paymentAmountText: "-1,234円",
});

async function recognised(fact: CardUsageFact): Promise<CardPurchaseDraft> {
  const draft = await cardPurchaseRevision({
    action: "recognize",
    eventId: await cardPurchaseEventId("purchase", recognitionKey(fact)!),
    revision: 1,
    fact,
  });
  if (!draft) throw new Error("draft rejected");
  return draft;
}

const live = (draft: CardPurchaseDraft): CardPurchaseLive => ({
  revision: draft.revision,
  keys: draft.keys,
  sidecar: draft.sidecar,
});

async function retired(draft: CardPurchaseDraft): Promise<CardPurchaseDraft> {
  const next = await cardPurchaseRetirement({
    live: draft.revision,
    keys: draft.keys,
    sidecar: draft.sidecar,
  });
  if (!next) throw new Error("retirement rejected");
  return next;
}

const captured = (drafts: readonly CardPurchaseDraft[]) => {
  const summary = cardPurchaseSummary(drafts.map((draft) => draft.revision));
  if (!summary.ok) throw new Error("summary failed");
  const jpy = summary.summary.units[0];
  const text = (value: unknown) =>
    (value as { value: { value?: { coefficient: string } } } | undefined)?.value.value
      ?.coefficient ?? "0";
  return {
    captured: text(jpy?.captured),
    authorized: text(jpy?.authorized),
    unresolved: summary.summary.unresolved,
  };
};

describe("merge", () => {
  test("the pending-origin event survives authorized → captured with the posted content and both keys", async () => {
    const pending = await recognised(PENDING);
    const posted = await recognised(POSTED);
    expect(captured([pending, posted])).toEqual({
      captured: "1234",
      authorized: "1200",
      unresolved: 0,
    });
    const merge = await cardPurchaseMerge({ survivor: live(pending), absorbed: live(posted) });
    expect(merge).not.toBeNull();
    const { draft } = merge!;
    expect(merge!.survivor).toEqual({ eventId: pending.revision.eventId, revision: 1 });
    expect(merge!.absorbed).toEqual({ eventId: posted.revision.eventId, revision: 1 });
    expect(eventTransition("purchase", "authorized", "captured")).toEqual({ ok: true });
    expect(draft).toMatchObject({
      action: "merge",
      revision: {
        eventId: pending.revision.eventId,
        revision: 2,
        kind: "purchase",
        state: "captured",
        unknownReason: null,
        effectiveTime: posted.revision.effectiveTime,
      },
      sidecar: posted.sidecar,
    });
    // One purchase-recognition leg: the posted amount, moved, never added.
    expect(draft.revision.legs).toEqual([
      { ...posted.revision.legs[0]!, eventId: pending.revision.eventId, revision: 2 },
    ]);
    expect(draft.keys.map((key) => key.role)).toEqual(["posted", "pending"]);
    // Posted evidence first, then the pending row; SourceFactRef objects.
    expect(draft.revision.evidenceSupport).toEqual([
      { kind: "transaction", id: "transaction:101", revision: "parse_run:11" },
      { kind: "transaction", id: "transaction:100", revision: "parse_run:10" },
    ]);
    // The captured total is unchanged; the authorisation is no longer apart.
    expect(captured([draft])).toEqual({ captured: "1234", authorized: "0", unresolved: 0 });
    // A reviewed merge is keyed by its operation, never the rule's decision.
    const reviewed = await cardPurchaseMerge({
      survivor: live(pending),
      absorbed: live(posted),
      operationId: "op-1",
    });
    expect(reviewed!.draft.contentDigest).toBe(draft.contentDigest);
    expect(reviewed!.draft.decisionRevisionId).not.toBe(draft.decisionRevisionId);
  });

  test("a retired pending event merges unknown → captured", async () => {
    const pending = await retired(await recognised(PENDING));
    const posted = await recognised(POSTED);
    const merge = await cardPurchaseMerge({ survivor: live(pending), absorbed: live(posted) });
    expect(merge?.draft.revision).toMatchObject({ revision: 3, state: "captured" });
    expect(captured([merge!.draft])).toEqual({ captured: "1234", authorized: "0", unresolved: 0 });
  });

  test("what cannot be one purchase is never merged", async () => {
    const pending = await recognised(PENDING);
    const posted = await recognised(POSTED);
    const refund = await cardPurchaseRevision({
      action: "recognize",
      eventId: await cardPurchaseEventId("refund", recognitionKey(REFUND)!),
      revision: 1,
      fact: REFUND,
    });
    expect(refund).not.toBeNull();
    const otherAccount = await recognised(
      row({ externalId: "other-row", accountId: "acct-other" }),
    );
    const pendingAsPosted = await recognised(row({ externalId: "posted-2" }));
    for (const [survivor, absorbed] of [
      // A purchase and a refund.
      [pending, refund!],
      // Two card accounts.
      [pending, otherAccount],
      // The survivor must be the pending row's event, the absorbed the posted one's.
      [posted, pending],
      [pendingAsPosted, posted],
      // One event with itself.
      [pending, pending],
    ] as const)
      expect(
        await cardPurchaseMerge({ survivor: live(survivor), absorbed: live(absorbed) }),
      ).toBeNull();
    // A posted event that is no longer captured.
    expect(
      await cardPurchaseMerge({ survivor: live(pending), absorbed: live(await retired(posted)) }),
    ).toBeNull();
    // A side that already holds a link.
    const merged = (await cardPurchaseMerge({ survivor: live(pending), absorbed: live(posted) }))!;
    expect(
      await cardPurchaseMerge({ survivor: live(merged.draft), absorbed: live(otherAccount) }),
    ).toBeNull();
  });

  test("the linked revision of a merged event from its posted row has the merge's content", async () => {
    const pending = await recognised(PENDING);
    const posted = await recognised(POSTED);
    const { draft } = (await cardPurchaseMerge({
      survivor: live(pending),
      absorbed: live(posted),
    }))!;
    const pendingKeys = draft.keys.filter((key) => key.role === "pending");
    const same = await cardPurchaseLinkedRevision({
      action: "revise",
      eventId: draft.revision.eventId,
      revision: 3,
      fact: row({ observationId: 201, parseRunId: 21 }),
      pendingKeys,
    });
    // A re-fetch of the posted row is no revision: the content digest agrees.
    expect(same?.contentDigest).toBe(draft.contentDigest);
    const corrected = await cardPurchaseLinkedRevision({
      action: "revise",
      eventId: draft.revision.eventId,
      revision: 3,
      fact: row({ accountId: "acct-corrected" }),
      pendingKeys,
    });
    expect(corrected?.contentDigest).not.toBe(draft.contentDigest);
    expect(corrected?.keys.map((key) => key.role)).toEqual(["posted", "pending"]);
    // The pending row itself never drives a merged event.
    expect(
      await cardPurchaseLinkedRevision({
        action: "revise",
        eventId: draft.revision.eventId,
        revision: 3,
        fact: PENDING,
        pendingKeys,
      }),
    ).toBeNull();
  });
});

describe("split", () => {
  test("a withdrawn link retires the merged event to its pending row and restores the posted event", async () => {
    const pending = await recognised(PENDING);
    const posted = await recognised(POSTED);
    const { draft: merged } = (await cardPurchaseMerge({
      survivor: live(pending),
      absorbed: live(posted),
    }))!;
    const split = await cardPurchaseSplit({
      merged: live(merged),
      pendingSidecar: pending.sidecar,
      absorbed: { eventId: posted.revision.eventId, revision: 1 },
    });
    expect(split).not.toBeNull();
    const { retire, restore } = split!;
    expect(retire).toMatchObject({
      action: "retire",
      revision: {
        eventId: pending.revision.eventId,
        revision: 3,
        state: "unknown",
        unknownReason: "conflicting_evidence",
        legs: [],
        effectiveTime: pending.revision.effectiveTime,
      },
      sidecar: pending.sidecar,
    });
    expect(retire.keys.map((key) => key.role)).toEqual(["pending"]);
    expect(eventTransition("purchase", "captured", "unknown")).toEqual({ ok: true });
    expect(restore).toMatchObject({
      action: "split",
      revision: { eventId: posted.revision.eventId, revision: 2, state: "captured" },
      sidecar: posted.sidecar,
    });
    expect(restore.keys.map((key) => key.role)).toEqual(["posted"]);
    expect(restore.revision.legs).toEqual([
      { ...merged.revision.legs[0]!, eventId: posted.revision.eventId, revision: 2 },
    ]);
    // The captured total is unchanged; the authorisation is unresolved, never a refund.
    expect(captured([retire, restore])).toEqual({
      captured: "1234",
      authorized: "0",
      unresolved: 1,
    });
  });

  test("a merged event already unknown splits into two retired events", async () => {
    const pending = await recognised(PENDING);
    const posted = await recognised(POSTED);
    const { draft: merged } = (await cardPurchaseMerge({
      survivor: live(pending),
      absorbed: live(posted),
    }))!;
    const gone = await retired(merged);
    const split = await cardPurchaseSplit({
      merged: live(gone),
      pendingSidecar: pending.sidecar,
      absorbed: { eventId: posted.revision.eventId, revision: 1 },
    });
    expect(split?.retire.revision).toMatchObject({
      state: "unknown",
      unknownReason: "conflicting_evidence",
    });
    expect(split?.restore).toMatchObject({
      action: "retire",
      revision: { state: "unknown", unknownReason: "provider_status_absent", legs: [] },
    });
  });

  test("only a merged event with its own pending facts splits", async () => {
    const pending = await recognised(PENDING);
    const posted = await recognised(POSTED);
    const { draft: merged } = (await cardPurchaseMerge({
      survivor: live(pending),
      absorbed: live(posted),
    }))!;
    const absorbed = { eventId: posted.revision.eventId, revision: 1 };
    // A single-key event is not a link.
    expect(
      await cardPurchaseSplit({ merged: live(posted), pendingSidecar: pending.sidecar, absorbed }),
    ).toBeNull();
    // The sidecar to retire to must be a pending row's.
    expect(
      await cardPurchaseSplit({ merged: live(merged), pendingSidecar: posted.sidecar, absorbed }),
    ).toBeNull();
    // The absorbed event is another purchase event, never the survivor.
    expect(
      await cardPurchaseSplit({
        merged: live(merged),
        pendingSidecar: pending.sidecar,
        absorbed: { eventId: pending.revision.eventId, revision: 1 },
      }),
    ).toBeNull();
  });
});

describe("review", () => {
  const pendingRef: SourceFactRef = {
    kind: "transaction",
    id: "transaction:100",
    revision: "parse_run:10",
  };
  const postedRef: SourceFactRef = {
    kind: "transaction",
    id: "transaction:101",
    revision: "parse_run:11",
  };
  const holder = (overrides: Partial<PendingPostedHolder> = {}): PendingPostedHolder => ({
    eventId: "purchase_a",
    revision: 2,
    kind: "purchase",
    state: "unknown",
    accountId: "acct-card",
    sourceId: "vpass",
    keys: [{ key: "k-pending", role: "pending" }],
    ...overrides,
  });
  const pendingSide = (h: PendingPostedHolder | null = holder()): PendingPostedTarget => ({
    ref: pendingRef,
    recognitionKey: "k-pending",
    role: "pending",
    holder: h,
  });
  const postedSide = (
    h: PendingPostedHolder | null = holder({
      eventId: "purchase_b",
      revision: 1,
      state: "captured",
      keys: [{ key: "k-posted", role: "posted" }],
    }),
  ): PendingPostedTarget => ({
    ref: postedRef,
    recognitionKey: "k-posted",
    role: "posted",
    holder: h,
  });

  test("the marker, the canonical ends and the exact evidence", () => {
    const marker = pendingPostedMarker("rp_1");
    expect(marker).toBe("reconciliation-proposal:rp_1");
    expect(pendingPostedReviewRequested([marker])).toBe(true);
    expect(pendingPostedReviewRequested(["card-settlement:x"])).toBe(false);
    expect(pendingPostedProposalId([marker, "transaction:1@parse_run:1"])).toBe("rp_1");
    expect(pendingPostedProposalId([marker, pendingPostedMarker("rp_2")])).toBeNull();
    expect(proposalSubjectRef("rp_1")).toBe("proposal:rp_1");
    expect(cardPurchaseSubjectRef("purchase_a")).toBe("card-purchase:purchase_a");
    expect(canonicalRelationEnd(pendingRef)).toBe("transaction:100");
    // The historical double prefix, a bare id or an unpinned row is no end.
    for (const ref of [
      { ...pendingRef, id: "transaction:transaction:100" },
      { ...pendingRef, id: "100" },
      { ...pendingRef, revision: "1" },
      { ...pendingRef, kind: "balance" as const },
    ])
      expect(canonicalRelationEnd(ref)).toBeNull();
    expect(pendingPostedEvidenceRefs("rp_1", pendingRef, postedRef)).toEqual([
      marker,
      "transaction:100@parse_run:10",
      "transaction:101@parse_run:11",
    ]);
    expect(pendingPostedRelation("rp_1", pendingRef, postedRef)).toEqual({
      relationKind: "pending_to_posted",
      fromRef: "transaction:100",
      toRef: "transaction:101",
      validFrom: null,
      validTo: null,
      evidenceRefs: pendingPostedEvidenceRefs("rp_1", pendingRef, postedRef),
    });
    expect(pendingPostedRelation("rp_1", pendingRef, pendingRef)).toBeNull();
  });

  test("an open candidate may be accepted and rejected; what blocks acceptance never blocks rejection", () => {
    const open = { proposalStatus: "proposed" as const, relationStatus: null };
    expect(pendingPostedReview({ ...open, pending: pendingSide(), posted: postedSide() })).toEqual({
      actions: ["accept", "reject"],
      blockers: [],
      merged: false,
    });
    const blocked = (pending: PendingPostedTarget, posted: PendingPostedTarget) =>
      pendingPostedReview({ ...open, pending, posted });
    expect(blocked(pendingSide(null), postedSide())).toEqual({
      actions: ["reject"],
      blockers: ["row_not_recognized"],
      merged: false,
    });
    expect(blocked(pendingSide(holder({ kind: "refund" })), postedSide()).blockers).toEqual([
      "kind_differs",
    ]);
    expect(
      blocked(pendingSide(holder({ accountId: "acct-other" })), postedSide()).blockers,
    ).toEqual(["account_differs"]);
    expect(
      blocked(
        pendingSide(),
        postedSide(
          holder({
            eventId: "purchase_b",
            state: "unknown",
            keys: [{ key: "k-posted", role: "posted" }],
          }),
        ),
      ).blockers,
    ).toEqual(["posted_not_captured"]);
    const both = holder({
      state: "captured",
      keys: [
        { key: "k-posted", role: "posted" },
        { key: "k-pending", role: "pending" },
      ],
    });
    expect(blocked(pendingSide(both), postedSide(both)).blockers).toEqual(["already_linked"]);
    expect(blocked({ ...pendingSide(), role: "posted" }, postedSide()).blockers).toEqual([
      "proposal_shape_unsupported",
    ]);
  });

  test("an accepted link may be withdrawn, splitting it only when it is merged", () => {
    const linked = { proposalStatus: "accepted" as const, relationStatus: "accepted" };
    const both = holder({
      state: "captured",
      revision: 3,
      keys: [
        { key: "k-posted", role: "posted" },
        { key: "k-pending", role: "pending" },
      ],
    });
    expect(
      pendingPostedReview({ ...linked, pending: pendingSide(both), posted: postedSide(both) }),
    ).toEqual({ actions: ["withdraw"], blockers: [], merged: true });
    expect(
      pendingPostedReview({ ...linked, pending: pendingSide(), posted: postedSide() }),
    ).toEqual({ actions: ["withdraw"], blockers: [], merged: false });
    // Withdrawn or rejected: closed.
    for (const closed of [
      { proposalStatus: "accepted" as const, relationStatus: "rejected" },
      { proposalStatus: "rejected" as const, relationStatus: "rejected" },
      { proposalStatus: "rejected" as const, relationStatus: null },
    ])
      expect(
        pendingPostedReview({ ...closed, pending: pendingSide(), posted: postedSide() }),
      ).toEqual({ actions: [], blockers: ["proposal_closed"], merged: false });
  });

  test("a proposal cites its rows canonically", () => {
    const fact = (ref: SourceFactRef, state: "pending" | "posted"): MatchFact => ({
      ref,
      scope: { sourceId: "vpass", credentialEpoch: "p/ns", accountNamespace: "vpass:card-001" },
      sourceAccount: "vpass:card-001",
      externalId: null,
      identifierOrigin: "collector-fingerprint",
      providerLinkId: null,
      settlementState: state,
      quantity: exactQuantity("JPY", integerDecimal(-1200)),
      occurred: { kind: "local-date", value: "2026-08-20", zone: null, basis: "provider" },
      counterparty: null,
      statementPeriod: "2026-09",
      ownerRef: null,
    });
    const [proposal] = stageBProposals([fact(pendingRef, "pending"), fact(postedRef, "posted")]);
    expect(proposal?.evidenceRefs).toEqual(["transaction:100", "transaction:101"]);
    expect(proposal?.targetRefs).toEqual([pendingRef, postedRef]);
  });
});
