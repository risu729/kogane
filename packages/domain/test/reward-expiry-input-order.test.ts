// Input order and duplicate refs for the expiry basis (ADR 0049).
//
// The same-day tie (activity ref, both orders of one pair) already lives in
// reward-expiry-basis.test.ts. This file adds the case that tie does not
// cover: a smaller activity ref on an older day must not win, in either
// order. It also locks the stored-shape refusal of a repeated ref. Every
// rule, date and reference is synthetic.
import { describe, expect, test } from "bun:test";
import {
  estimateExpiry,
  validBucketExpiryBasis,
  type ActivityHistory,
  type BucketExpiryBasis,
  type ExpiryRule,
  type MembershipState,
  type RewardActivity,
  type RewardBucket,
  type RewardHolding,
} from "../src/rewards.ts";
import type { LocalDateValue, PeriodValue } from "../src/time.ts";
import { q } from "./helpers.ts";

const TOKYO = "Asia/Tokyo";
const day = (value: string): LocalDateValue => ({
  kind: "local-date",
  value,
  zone: TOKYO,
  basis: "provider",
});
const derived = (value: string): LocalDateValue => ({ ...day(value), basis: "derived" });
const period = (start: string, end: string): PeriodValue => ({
  kind: "period",
  start,
  end,
  endExclusive: false,
  zone: TOKYO,
  granularity: "day",
});

const inactivity: ExpiryRule = {
  ruleId: "rule:program-a:inactivity-expiry",
  version: "v1",
  family: "inactivity",
  programId: "program:a",
  applicability: {
    bucketKinds: ["regular"],
    tiers: null,
    validPeriod: null,
  },
  qualifyingActivity: {
    policyRef: "policy:program-a:qualifying-activity:v1",
    kinds: ["earn", "redeem"],
    excludedKinds: ["family-transfer-in"],
    extensionMonths: 12,
    endOfMonthPolicy: "clamp",
    dateBasis: "provider-posted",
  },
  deadlineCalendar: { zone: TOKYO, dayBoundary: "end-of-day", zoneBasis: "documented" },
  priorityPolicyRef: null,
  evidenceRefs: ["evidence:synthetic-terms:1"],
  verification: "verified",
};

const bucket: RewardBucket = {
  bucketRef: "bucket:regular",
  programId: "program:a",
  holdingRef: "holding:member-1",
  kind: "regular",
  restrictionRefs: [],
  quantity: q("points:a", "1000"),
  observedExpiry: null,
  observedAt: day("2026-09-01"),
  sourceFactRefs: ["fact:bucket:regular"],
};
const holding: RewardHolding = {
  holdingRef: "holding:member-1",
  programId: "program:a",
  unitRef: "points:a",
  buckets: [bucket],
};

function history(activities: RewardActivity[]): ActivityHistory {
  return {
    windowRef: "window:program-a:synthetic",
    completeness: "complete",
    earliestObserved: day("2026-01-01"),
    activities,
  };
}

/** Both permutations of a two-row list. n = 2 is the whole set. */
function bothOrders<T>(items: readonly T[]): T[][] {
  return [[...items], [...items].reverse()];
}

describe("anchor selection follows the documented order rule", () => {
  test("a newer qualifying day stays the anchor when the older day has the smaller ref", () => {
    // act:a is the smaller ref and the older day. A choice by ref alone, or
    // by whichever row is first or last, picks it in one of these orders.
    const activities: RewardActivity[] = [
      { activityRef: "act:a", kind: "earn", postedDate: day("2026-01-01"), usedDate: null },
      { activityRef: "act:m", kind: "redeem", postedDate: day("2026-06-01"), usedDate: null },
    ];
    const bases = bothOrders(activities).map(
      (order) =>
        estimateExpiry(inactivity, holding, history(order), [], day("2026-09-09"))
          .expiringBuckets[0]!.expiryBasis,
    );
    expect(bases[0]).toEqual(bases[1]);
    const computed = bases[0]!.computed;
    expect(computed.status).toBe("date");
    expect(computed.activity?.anchorActivityRef).toBe("act:m");
    expect(computed.activity?.anchorDate).toEqual(derived("2026-06-01"));
    expect(computed.value).toEqual(derived("2027-06-01"));
  });
});

describe("a stored basis refuses a repeated reference", () => {
  const tiered: ExpiryRule = {
    ...inactivity,
    ruleId: "rule:program-a:tiered",
    applicability: { ...inactivity.applicability, tiers: ["elite"] },
    deadlineCalendar: { ...inactivity.deadlineCalendar, zoneBasis: "assumed" },
  };
  const claim: MembershipState = {
    programId: "program:a",
    holdingRef: "holding:member-1",
    tier: "elite",
    valid: period("2026-01-01", "2026-12-31"),
    source: "provider",
    evidenceRefs: ["evidence:tier:1"],
  };
  const shown: RewardBucket = { ...bucket, observedExpiry: day("2027-03-01") };

  function basis(): BucketExpiryBasis {
    return estimateExpiry(
      tiered,
      { ...holding, buckets: [shown] },
      history([
        { activityRef: "act:earn-1", kind: "earn", postedDate: day("2026-03-01"), usedDate: null },
      ]),
      [claim],
      day("2026-09-09"),
    ).expiringBuckets[0]!.expiryBasis;
  }

  test("each ref list the basis stores is a set: one repeated entry is refused", () => {
    const original = basis();
    expect(validBucketExpiryBasis(original)).toBe(true);
    const displayed = original.displayed;
    const membership = original.computed.membership;
    const claimBasis = membership?.claims[0];
    if (displayed === null || membership === null || claimBasis === undefined)
      throw new Error("fixture did not record a display, a tier and a claim");
    expect(original.computed.uncertaintyCodes.length).toBeGreaterThan(0);
    expect(displayed.sourceFactRefs.length).toBeGreaterThan(0);
    expect(original.computed.rule.evidenceRefs.length).toBeGreaterThan(0);
    expect(membership.requiredTiers.length).toBeGreaterThan(0);
    expect(claimBasis.evidenceRefs.length).toBeGreaterThan(0);

    const repeat = <T>(items: readonly T[]): T[] => [items[0]!, ...items];
    const copies: BucketExpiryBasis[] = [
      {
        ...original,
        displayed: { ...displayed, sourceFactRefs: repeat(displayed.sourceFactRefs) },
      },
      {
        ...original,
        computed: {
          ...original.computed,
          rule: {
            ...original.computed.rule,
            evidenceRefs: repeat(original.computed.rule.evidenceRefs),
          },
        },
      },
      {
        ...original,
        computed: {
          ...original.computed,
          uncertaintyCodes: repeat(original.computed.uncertaintyCodes),
        },
      },
      {
        ...original,
        computed: {
          ...original.computed,
          membership: { ...membership, requiredTiers: repeat(membership.requiredTiers) },
        },
      },
      {
        ...original,
        computed: {
          ...original.computed,
          membership: {
            ...membership,
            claims: [{ ...claimBasis, evidenceRefs: repeat(claimBasis.evidenceRefs) }],
          },
        },
      },
    ];
    for (const copy of copies) expect(validBucketExpiryBasis(copy)).toBe(false);
  });
});
