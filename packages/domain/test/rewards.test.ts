// SC11-SC14 and AT43-AT54 driven through packages/domain/src/rewards.ts.
// Every number is synthetic and comes from packages/domain/fixtures/v3 or from
// the minimal input variants of addendum 14 §3. No real programme rule is
// asserted here: the synthetic rules carry their own `verification` flag.
import { describe, expect, test } from "bun:test";
import {
  availableForOffer,
  cashLikeRedemptionEstimate,
  estimateExpiry,
  findConversionPaths,
  providerDisplayedValue,
  qualificationMeasures,
  redemptionPositions,
  simulateConversion,
  summarizeHolding,
  validConversionOffer,
  validExpiryRule,
  validMembershipState,
  validQualificationMeasure,
  validRewardBucket,
  validRewardProgram,
  type ActivityHistory,
  type BucketKind,
  type ConversionOffer,
  type ExpiryRule,
  type MembershipState,
  type RewardBucket,
  type RewardHolding,
  type SearchBudget,
} from "../src/rewards.ts";
import { addQuantities, decimalLiteral, type ExactRatio, type Quantity } from "../src/values.ts";
import { addMonths, formatLocalDate, parseLocalDate, type LocalDateValue } from "../src/time.ts";
import { loadFixture, q, quantityText } from "./helpers.ts";

const TOKYO = "Asia/Tokyo";
const day = (value: string): LocalDateValue => ({
  kind: "local-date",
  value,
  zone: TOKYO,
  basis: "provider",
});
const derived = (value: string): LocalDateValue => ({
  kind: "local-date",
  value,
  zone: TOKYO,
  basis: "derived",
});

function bucket(
  ref: string,
  kind: BucketKind,
  unitRef: string,
  amount: string,
  overrides: Partial<RewardBucket> = {},
): RewardBucket {
  return {
    bucketRef: ref,
    programId: "program:a",
    holdingRef: "holding:member-1",
    kind,
    restrictionRefs: [],
    quantity: q(unitRef, amount),
    observedExpiry: null,
    observedAt: day("2026-09-01"),
    sourceFactRefs: [`fact:${ref}`],
    ...overrides,
  };
}

function holding(unitRef: string, buckets: RewardBucket[]): RewardHolding {
  return { holdingRef: "holding:member-1", programId: "program:a", unitRef, buckets };
}

const inactivityRule: ExpiryRule = {
  ruleId: "rule:program-a:inactivity-expiry",
  version: "v1",
  family: "inactivity",
  programId: "program:a",
  applicability: {
    bucketKinds: ["regular", "restricted", "time-limited"],
    tiers: null,
    validPeriod: null,
  },
  qualifyingActivity: {
    policyRef: "policy:program-a:qualifying-activity:v1",
    kinds: ["earn", "redeem"],
    excludedKinds: ["family-transfer-in", "family-transfer-out"],
    extensionMonths: 12,
    endOfMonthPolicy: "clamp",
    dateBasis: "provider-posted",
  },
  deadlineCalendar: { zone: TOKYO, dayBoundary: "end-of-day", zoneBasis: "documented" },
  priorityPolicyRef: "policy:program-a:consumption-order:v1",
  evidenceRefs: ["evidence:synthetic-terms:1"],
  verification: "verified",
};

const history: ActivityHistory = {
  windowRef: "window:program-a:2026",
  completeness: "complete",
  earliestObserved: day("2026-01-01"),
  activities: [
    { activityRef: "act:1", kind: "earn", postedDate: day("2026-03-01"), usedDate: null },
    {
      activityRef: "act:2",
      kind: "family-transfer-in",
      postedDate: day("2026-08-01"),
      usedDate: null,
    },
  ],
};

function offer(overrides: Partial<ConversionOffer> = {}): ConversionOffer {
  return {
    offerId: "offer:a-to-b:standard",
    version: "v1",
    sourceProgramRef: "program:a",
    destinationProgramRef: "program:b",
    fromUnitRef: "points:a",
    toUnitRef: "points:b",
    ratio: { numerator: "1", denominator: "2" },
    minimum: decimalLiteral("1000"),
    increment: decimalLiteral("1000"),
    maximumPerRequest: decimalLiteral("3000"),
    sharedQuotaRef: null,
    fixedFees: [q("JPY", "100")],
    variableFeePolicyRef: null,
    eligibilityPolicyRef: "policy:offer:eligibility:v1",
    eligibleBucketKinds: ["regular"],
    eligibleRestrictionRefs: [],
    eligibleTiers: null,
    validTime: {
      kind: "period",
      start: "2026-01-01",
      end: "2026-12-31",
      endExclusive: false,
      zone: TOKYO,
      granularity: "day",
    },
    applicationDeadline: day("2026-12-31"),
    processingPolicyRef: "policy:offer:processing:v1",
    processingDays: 3,
    roundingPolicyRef: "policy:offer:rounding:v1",
    rounding: { scale: 0, mode: "down" },
    cancellationPolicyRef: "policy:offer:cancellation:v1",
    evidenceRefs: ["evidence:synthetic-offer:1"],
    verification: "verified",
    ...overrides,
  };
}

const budget: SearchBudget = {
  maxDepth: 2,
  maxCandidates: 8,
  maxExpansions: 200,
  requiredCompletionBy: null,
};

describe("contracts validate", () => {
  test("program, bucket, qualification measure, membership, rule and offer round-trip their validators", () => {
    expect(
      validRewardProgram({
        programId: "program:a",
        institutionRef: "institution:synthetic",
        programRef: "program-ref:a",
        unitRef: "points:a",
        termsEvidenceRefs: ["evidence:synthetic-terms:1"],
        release: "reward-model-v1",
      }),
    ).toBe(true);
    expect(validRewardBucket(bucket("bucket:regular", "regular", "points:a", "300"))).toBe(true);
    expect(validExpiryRule(inactivityRule)).toBe(true);
    expect(validConversionOffer(offer())).toBe(true);
    expect(
      validMembershipState({
        programId: "program:a",
        holdingRef: "holding:member-1",
        tier: "gold",
        valid: {
          kind: "period",
          start: "2026-04-01",
          end: "2027-03-31",
          endExclusive: false,
          zone: TOKYO,
          granularity: "day",
        },
        source: "provider",
        evidenceRefs: ["evidence:tier:1"],
      }),
    ).toBe(true);
    expect(
      validQualificationMeasure({
        measureRef: "measure:status",
        programId: "program:a",
        metricRef: "program.status-indicator",
        quantity: q("status-points:program-a", "100"),
        period: day("2026-09-01"),
        consumable: false,
        sourceFactRefs: ["fact:status"],
      }),
    ).toBe(true);
    // An unknown key is a contract change, never a free extension.
    expect(validExpiryRule({ ...inactivityRule, extra: 1 })).toBe(false);
  });
});

describe("SC11 / AT37 / AT43 / AT47 / AT48 — quantity, eligibility and qualification are separate", () => {
  const fixture = loadFixture<{
    measures: { ref: string; metricId: string; quantity: Quantity }[];
    expected: {
      nominalJpy: string;
      withdrawableJpy: string;
      pointsNominalWithBuckets: string;
      statusIndicator: string;
      jpyPlusPointsRejected: "unit_mismatch";
    };
  }>("v3/sc11-wallet-points.json");
  const measure = (ref: string): Quantity => {
    const found = fixture.measures.find((m) => m.ref === ref);
    if (!found) throw new Error(`missing measure ${ref}`);
    return found.quantity;
  };

  test("points are bucketed and summed in their own unit; the status indicator stays outside", () => {
    const points = holding("points:program-a", [
      bucket("bucket:regular", "regular", "points:program-a", "300"),
      bucket("bucket:restricted", "restricted", "points:program-a", "500", {
        restrictionRefs: ["restriction:store-limited"],
      }),
      bucket("bucket:status", "qualification", "status-points:program-a", "100"),
    ]);
    const summary = summarizeHolding(points);
    expect(quantityText(summary.consumable)).toBe(fixture.expected.pointsNominalWithBuckets);
    expect(summary.byKind.map((entry) => [entry.kind, quantityText(entry.quantity)])).toEqual([
      ["regular", "300"],
      ["restricted", "500"],
    ]);
    // The status bucket is in another unit and is excluded from every subtotal.
    expect(summary.excluded).toEqual([
      { bucketRef: "bucket:status", kind: "qualification", reasonCode: "unit_mismatch" },
    ]);
    const measures = qualificationMeasures(points, []);
    expect(measures).toHaveLength(1);
    expect(quantityText(measures[0]!.quantity)).toBe(fixture.expected.statusIndicator);
    expect(measures[0]!.consumable).toBe(false);
  });

  test("SYN19 the wallet's JPY and the programme's points are never added", () => {
    const points = holding("points:program-a", [
      bucket("bucket:regular", "regular", "points:program-a", "300"),
      bucket("bucket:restricted", "restricted", "points:program-a", "500"),
    ]);
    const consumable = summarizeHolding(points).consumable;
    expect(quantityText(measure("m-wallet-nominal"))).toBe(fixture.expected.nominalJpy);
    expect(quantityText(measure("m-wallet-withdrawable"))).toBe(fixture.expected.withdrawableJpy);
    const sum = addQuantities(measure("m-wallet-nominal"), consumable);
    expect(sum.ok).toBe(false);
    if (!sum.ok) expect(sum.error.code).toBe(fixture.expected.jpyPlusPointsRejected);
    expect(addQuantities(measure("m-wallet-nominal"), measure("m-status-indicator")).ok).toBe(
      false,
    );
  });

  test("AT48 a pending award and last month's earnings are not part of the holding", () => {
    const points = holding("points:program-a", [
      bucket("bucket:regular", "regular", "points:program-a", "300"),
      bucket("bucket:pending", "pending-award", "points:program-a", "1200"),
    ]);
    const summary = summarizeHolding(points);
    expect(quantityText(summary.consumable)).toBe("300");
    expect(summary.excluded).toEqual([
      { bucketRef: "bucket:pending", kind: "pending-award", reasonCode: "award_not_yet_held" },
    ]);
  });

  test("an unparsed bucket makes the subtotal an error, never a smaller number", () => {
    const points = holding("points:program-a", [
      bucket("bucket:regular", "regular", "points:program-a", "300"),
      {
        ...bucket("bucket:broken", "regular", "points:program-a", "0"),
        quantity: { unitRef: "points:program-a", value: { status: "unparsed", reasonCode: "x" } },
      },
    ]);
    const summary = summarizeHolding(points);
    expect(summary.error?.code).toBe("value_not_exact");
    expect(summary.consumable.value.status).toBe("conflict");
  });
});

describe("SC12 / AT44 / AT45 / AT46 — expiry rules", () => {
  const fixture = loadFixture<{
    expected: {
      lastQualifyingDate: string;
      computedExpiry: string;
      naiveMaxDateExpiry: string;
      providerDisplayedExpiry: string;
    };
    edgeCases: {
      from: string;
      months: number;
      policy: "clamp" | "preserve-end-of-month";
      expect: string;
    }[];
  }>("v3/sc12-expiry-activities.json");

  const points = holding("points:a", [bucket("bucket:regular", "regular", "points:a", "1000")]);

  test("AT45 the anchor is the newest qualifying activity, not max(transaction_date)", () => {
    const estimate = estimateExpiry(inactivityRule, points, history, [], day("2026-09-09"));
    expect(estimate.state).toBe("computed");
    const row = estimate.expiringBuckets[0]!;
    expect(row.basis).toBe("policy-estimated");
    expect(row.policyEstimated).toEqual(derived(fixture.expected.computedExpiry));
    // The family transfer of 2026-08-01 would have produced this instead.
    expect(row.policyEstimated).not.toEqual(derived(fixture.expected.naiveMaxDateExpiry));
    expect(estimate.uncertaintyCodes).toEqual([]);
  });

  test("AT44 the provider's own expiry is kept and a disagreement is a conflict, not a choice", () => {
    const withObserved = holding("points:a", [
      bucket("bucket:regular", "regular", "points:a", "1000", {
        observedExpiry: day(fixture.expected.providerDisplayedExpiry),
      }),
    ]);
    const estimate = estimateExpiry(inactivityRule, withObserved, history, [], day("2026-09-09"));
    expect(estimate.state).toBe("conflict");
    const row = estimate.expiringBuckets[0]!;
    expect(row.providerObserved?.kind === "local-date" && row.providerObserved.value).toBe(
      fixture.expected.providerDisplayedExpiry,
    );
    expect(row.policyEstimated).toEqual(derived(fixture.expected.computedExpiry));
    expect(row.reasonCodes).toContain("provider_and_policy_differ");
    expect(estimate.sourceExpiryRefs).toEqual(["fact:bucket:regular"]);
  });

  test("AT44 lot-dated, bucket-only and unknown-acquisition inputs stay distinguishable", () => {
    const fixedLot: ExpiryRule = {
      ...inactivityRule,
      ruleId: "rule:program-a:fixed-lot",
      family: "fixed-lot",
      qualifyingActivity: null,
    };
    const lots = holding("points:a", [
      bucket("bucket:lot-a", "time-limited", "points:a", "300", {
        observedExpiry: day("2026-10-31"),
      }),
      bucket("bucket:lot-b", "time-limited", "points:a", "500", {
        observedExpiry: day("2027-01-31"),
      }),
      // Only a total: no lot, no expiry. It stays listed with an unknown deadline.
      bucket("bucket:unknown", "regular", "points:a", "200"),
    ]);
    const estimate = estimateExpiry(fixedLot, lots, history, [], day("2026-09-09"));
    expect(estimate.state).toBe("partial");
    expect(estimate.uncertaintyCodes).toContain("acquisition_date_unknown");
    expect(estimate.expiringBuckets.map((row) => [row.bucketRef, row.basis])).toEqual([
      ["bucket:lot-a", "provider-observed"],
      ["bucket:lot-b", "provider-observed"],
      ["bucket:unknown", "unknown"],
    ]);
    // Nothing was dropped from the deadline-ordered list.
    expect(estimate.expiringBuckets).toHaveLength(3);
  });

  test("AT45 an incomplete history window is partial, never proof that no activity happened", () => {
    const partial: ActivityHistory = {
      ...history,
      completeness: "partial",
      earliestObserved: day("2026-06-01"),
      activities: [],
    };
    const estimate = estimateExpiry(inactivityRule, points, partial, [], day("2026-09-09"));
    expect(estimate.state).toBe("partial");
    expect(estimate.uncertaintyCodes).toContain("history_incomplete");
    expect(estimate.uncertaintyCodes).toContain("no_qualifying_activity_observed");
    expect(estimate.expiringBuckets[0]!.deadline.kind).toBe("unknown");
  });

  test("AT45 excluded family transfers alone leave the deadline undetermined", () => {
    const transfersOnly: ActivityHistory = {
      ...history,
      activities: [history.activities[1]!],
    };
    const estimate = estimateExpiry(inactivityRule, points, transfersOnly, [], day("2026-09-09"));
    expect(estimate.uncertaintyCodes).toContain("no_qualifying_activity_observed");
    expect(estimate.expiringBuckets[0]!.policyEstimated).toBeNull();
  });

  test("an unverified or unsupported rule is needs-rule-verification, never 'no expiry'", () => {
    for (const rule of [
      { ...inactivityRule, verification: "needs-rule-verification" as const },
      { ...inactivityRule, family: "unsupported" as const },
    ]) {
      const estimate = estimateExpiry(rule, points, history, [], day("2026-09-09"));
      expect(estimate.state).toBe("needs-rule-verification");
      expect(estimate.expiringBuckets[0]!.deadline.kind).toBe("unknown");
      expect(estimate.uncertaintyCodes.join()).not.toContain("no_expiry_under_verified_terms");
    }
    // `none` is the opposite claim and is only reachable from verified terms.
    const none = estimateExpiry(
      { ...inactivityRule, family: "none", qualifyingActivity: null },
      points,
      history,
      [],
      day("2026-09-09"),
    );
    expect(none.state).toBe("computed");
    expect(none.uncertaintyCodes).toContain("no_expiry_under_verified_terms");
  });

  test("AT46 a tier granted later is not applied retroactively, and self-reported tiers are flagged", () => {
    const tiered: ExpiryRule = {
      ...inactivityRule,
      ruleId: "rule:program-a:elite-exception",
      applicability: { ...inactivityRule.applicability, tiers: ["elite"] },
      qualifyingActivity: { ...inactivityRule.qualifyingActivity!, extensionMonths: 60 },
    };
    const laterTier: MembershipState = {
      programId: "program:a",
      holdingRef: "holding:member-1",
      tier: "elite",
      valid: {
        kind: "period",
        start: "2026-07-01",
        end: "2027-06-30",
        endExclusive: false,
        zone: TOKYO,
        granularity: "day",
      },
      source: "provider",
      evidenceRefs: ["evidence:tier:1"],
    };
    const notRetroactive = estimateExpiry(tiered, points, history, [laterTier], day("2026-09-09"));
    // The anchor is 2026-03-01, before the tier period began.
    expect(notRetroactive.uncertaintyCodes).toContain("membership_not_retroactive");
    expect(notRetroactive.state).toBe("partial");

    const covering: MembershipState = {
      ...laterTier,
      valid: {
        kind: "period",
        start: "2026-01-01",
        end: "2027-06-30",
        endExclusive: false,
        zone: TOKYO,
        granularity: "day",
      },
    };
    const applied = estimateExpiry(tiered, points, history, [covering], day("2026-09-09"));
    expect(applied.state).toBe("computed");
    expect(applied.expiringBuckets[0]!.policyEstimated).toEqual(derived("2031-03-01"));

    const selfReported = estimateExpiry(
      tiered,
      points,
      history,
      [{ ...covering, source: "self-reported" }],
      day("2026-09-09"),
    );
    expect(selfReported.uncertaintyCodes).toContain("membership_self_reported");

    const noTier = estimateExpiry(tiered, points, history, [], day("2026-09-09"));
    expect(noTier.uncertaintyCodes).toContain("membership_out_of_scope");
    expect(noTier.state).toBe("partial");
  });

  test("month end, leap day and a date-only input follow the calendar, not a fixed number of seconds", () => {
    for (const edge of fixture.edgeCases) {
      const from = parseLocalDate(edge.from)!;
      expect(formatLocalDate(addMonths(from, edge.months, edge.policy))).toBe(edge.expect);
    }
    const leap: ActivityHistory = {
      ...history,
      activities: [
        { activityRef: "act:leap", kind: "earn", postedDate: day("2024-02-29"), usedDate: null },
      ],
    };
    const estimate = estimateExpiry(inactivityRule, points, leap, [], day("2024-03-01"));
    expect(estimate.expiringBuckets[0]!.policyEstimated).toEqual(derived("2025-02-28"));
  });

  test("the deadline zone is the programme's and an assumed zone is flagged, whatever the display zone", () => {
    const assumed: ExpiryRule = {
      ...inactivityRule,
      deadlineCalendar: {
        zone: "Australia/Sydney",
        dayBoundary: "end-of-day",
        zoneBasis: "assumed",
      },
    };
    const estimate = estimateExpiry(assumed, points, history, [], day("2026-09-09"));
    expect(estimate.uncertaintyCodes).toContain("deadline_zone_assumed");
    const row = estimate.expiringBuckets[0]!;
    expect(row.policyEstimated?.kind === "local-date" && row.policyEstimated.zone).toBe(
      "Australia/Sydney",
    );
  });

  test("the member-used date basis picks a different anchor from the posted date", () => {
    const usedBasis: ExpiryRule = {
      ...inactivityRule,
      qualifyingActivity: { ...inactivityRule.qualifyingActivity!, dateBasis: "member-used" },
    };
    const withUsed: ActivityHistory = {
      ...history,
      activities: [
        {
          activityRef: "act:1",
          kind: "earn",
          postedDate: day("2026-03-01"),
          usedDate: day("2026-02-15"),
        },
      ],
    };
    expect(
      estimateExpiry(usedBasis, points, withUsed, [], day("2026-09-09")).expiringBuckets[0]!
        .policyEstimated,
    ).toEqual(derived("2027-02-15"));
  });

  test("a deadline already in the past is reported, not hidden", () => {
    const expired = holding("points:a", [
      bucket("bucket:old", "time-limited", "points:a", "50", {
        observedExpiry: day("2026-01-31"),
      }),
    ]);
    const estimate = estimateExpiry(
      { ...inactivityRule, family: "fixed-lot", qualifyingActivity: null },
      expired,
      history,
      [],
      day("2026-09-09"),
    );
    expect(estimate.expiringBuckets[0]!.reasonCodes).toContain("deadline_passed");
  });
});

describe("SC13 / AT41 / AT49 — eligibility and the application-credit distinction", () => {
  const fixture = loadFixture<{
    pointUnit: string;
    walletUnit: string;
    buckets: { ref: string; quantity: string; eligibleForOffer: boolean }[];
    offer: { eligibleBuckets: string[]; ratio: ExactRatio };
    stages: { stage: string; pointsHeld: string; walletDelta: string; inTransit: string }[];
    expected: { requestable: string; walletIncreaseAtRequest: string };
  }>("v3/sc13-redemption-request.json");

  const transitOffer = offer({
    offerId: "offer:program-b:transit-charge",
    fromUnitRef: fixture.pointUnit,
    toUnitRef: fixture.walletUnit,
    ratio: fixture.offer.ratio,
    minimum: decimalLiteral("1000"),
    increment: decimalLiteral("1000"),
    maximumPerRequest: null,
    fixedFees: [],
  });
  const buckets: RewardBucket[] = fixture.buckets.map((row) =>
    bucket(
      row.ref,
      row.eligibleForOffer ? "regular" : "restricted",
      fixture.pointUnit,
      row.quantity,
      {
        restrictionRefs: row.eligibleForOffer ? [] : ["restriction:store-limited"],
      },
    ),
  );

  test("only the regular 5,000 is available to the offer; the restricted 3,000 is excluded with a reason", () => {
    const eligibility = availableForOffer(buckets, transitOffer, [], day("2026-09-09"));
    expect(eligibility.state).toBe("available");
    expect(quantityText(eligibility.eligible)).toBe(fixture.expected.requestable);
    expect(eligibility.eligibleBucketRefs).toEqual(["bucket:regular"]);
    expect(eligibility.excluded).toEqual([
      { bucketRef: "bucket:restricted", reasonCode: "bucket_kind_not_eligible" },
    ]);
  });

  test("an unverified offer is needs-rule-verification, not a refusal and not an approval", () => {
    const unverified = availableForOffer(
      buckets,
      { ...transitOffer, verification: "needs-rule-verification" },
      [],
      day("2026-09-09"),
    );
    expect(unverified.state).toBe("needs-rule-verification");
    expect(
      simulateConversion(
        { ...transitOffer, verification: "needs-rule-verification" },
        q(fixture.pointUnit, "5000"),
      ).feasible,
    ).toBe(false);
  });

  test("AT41 request, debit, credit and cancellation are separate; a request moves nothing", () => {
    const trace = redemptionPositions(
      q(fixture.pointUnit, "8000"),
      [
        {
          eventRef: "event:request",
          stage: "requested",
          quantity: q(fixture.pointUnit, "5000"),
          returnedToBucketRef: null,
          at: day("2026-09-01"),
          evidenceRefs: ["evidence:request"],
        },
        {
          eventRef: "event:debit",
          stage: "debited",
          quantity: q(fixture.pointUnit, "5000"),
          returnedToBucketRef: null,
          at: day("2026-09-02"),
          evidenceRefs: ["evidence:debit"],
        },
        {
          eventRef: "event:credit",
          stage: "credited",
          quantity: q(fixture.walletUnit, "5000"),
          returnedToBucketRef: null,
          at: day("2026-09-05"),
          evidenceRefs: ["evidence:credit"],
        },
      ],
      fixture.walletUnit,
    );
    expect(trace.violations).toEqual([]);
    const seen = trace.positions.map((position) => [
      position.stage,
      quantityText(position.sourceHeld),
      quantityText(position.inTransit),
      quantityText(position.destinationCredited),
    ]);
    expect(seen).toEqual([
      ["requested", "8000", "0", "0"],
      ["debited", "3000", "5000", "0"],
      ["credited", "3000", "0", "5000"],
    ]);
    expect(fixture.stages.map((s) => [s.pointsHeld, s.inTransit, s.walletDelta])).toEqual([
      ["8000", "0", fixture.expected.walletIncreaseAtRequest],
      ["3000", "5000", "0"],
      ["3000", "0", "5000"],
    ]);
    expect(trace.positions[0]!.uncertaintyCodes).toContain("application_is_not_a_credit");
  });

  test("a credit observed before any debit is a violation, not a balance", () => {
    const trace = redemptionPositions(
      q(fixture.pointUnit, "8000"),
      [
        {
          eventRef: "event:credit",
          stage: "credited",
          quantity: q(fixture.walletUnit, "5000"),
          returnedToBucketRef: null,
          at: day("2026-09-05"),
          evidenceRefs: [],
        },
      ],
      fixture.walletUnit,
    );
    expect(trace.violations).toEqual(["credit_before_debit"]);
  });

  test("AT54 a cancellation waits for the observed return, which lands in its own bucket", () => {
    const trace = redemptionPositions(
      q(fixture.pointUnit, "8000"),
      [
        {
          eventRef: "event:debit",
          stage: "debited",
          quantity: q(fixture.pointUnit, "5000"),
          returnedToBucketRef: null,
          at: day("2026-09-02"),
          evidenceRefs: [],
        },
        {
          eventRef: "event:cancel",
          stage: "cancelled",
          quantity: q(fixture.pointUnit, "5000"),
          returnedToBucketRef: null,
          at: day("2026-09-03"),
          evidenceRefs: [],
        },
        {
          eventRef: "event:return",
          stage: "returned",
          quantity: q(fixture.pointUnit, "5000"),
          // The provider returned them to a time-limited bucket with a new expiry.
          returnedToBucketRef: "bucket:returned-time-limited",
          at: day("2026-09-06"),
          evidenceRefs: ["evidence:return"],
        },
      ],
      fixture.walletUnit,
    );
    // Cancellation alone leaves the amount in transit; only the return restores it.
    expect(quantityText(trace.positions[1]!.inTransit)).toBe("5000");
    expect(trace.positions[1]!.uncertaintyCodes).toContain("return_awaits_observation");
    expect(quantityText(trace.positions[2]!.sourceHeld)).toBe("8000");
    expect(trace.returnedBuckets).toEqual([
      {
        bucketRef: "bucket:returned-time-limited",
        quantity: q(fixture.pointUnit, "5000"),
        eventRef: "event:return",
      },
    ]);
    // The returned bucket is a new claim with its own kind and observed expiry.
    const returned = bucket(
      "bucket:returned-time-limited",
      "time-limited",
      fixture.pointUnit,
      "5000",
      { observedExpiry: day("2026-12-31") },
    );
    expect(returned.observedExpiry).not.toEqual(day("2027-08-01"));
    expect(validRewardBucket(returned)).toBe(true);
  });
});

describe("SC14 / AT49-AT54 — conversion simulation and bounded search", () => {
  const fixture = loadFixture<{
    offer: { minimum: string; increment: string; cap: string; ratio: ExactRatio; fee: Quantity };
    eligibleBalance: string;
    expected: {
      used: string;
      received: string;
      remaining: string;
      fee: string;
      naiveReceive: string;
    };
    chained: {
      hops: {
        fromUnit: string;
        toUnit: string;
        ratio: ExactRatio;
        minimum: string;
        increment: string;
        cap: string;
      }[];
      expected: { receivedB: string; remainingA: string };
    };
  }>("v3/sc14-conversion-offer.json");

  const standard = offer({
    minimum: decimalLiteral(fixture.offer.minimum),
    increment: decimalLiteral(fixture.offer.increment),
    maximumPerRequest: decimalLiteral(fixture.offer.cap),
    ratio: fixture.offer.ratio,
    fixedFees: [fixture.offer.fee],
  });

  test("SYN20/SYN21 2,500 eligible yields 2,000 used, 1,000 received, 500 left and a 100 JPY fee", () => {
    const plan = simulateConversion(standard, q("points:a", fixture.eligibleBalance));
    expect(plan.feasible).toBe(true);
    expect(quantityText(plan.use)).toBe(fixture.expected.used);
    expect(quantityText(plan.receive)).toBe(fixture.expected.received);
    expect(quantityText(plan.remainder)).toBe(fixture.expected.remaining);
    expect(plan.fees.map(quantityText)).toEqual([fixture.expected.fee]);
    expect(plan.reasonCodes).toContain("rounded_down_to_increment");
    expect(plan.reasonCodes).toContain("credit_is_not_the_application");
    expect(plan.basis).toBe("policy-estimated");
    // 2,500 × 1/2 = 1,250 is never returned as an executable amount.
    expect(quantityText(plan.receive)).not.toBe(fixture.expected.naiveReceive);
  });

  test("AT49 minimum, increment and cap each bind on their own", () => {
    expect(simulateConversion(standard, q("points:a", "900")).reasonCodes).toContain(
      "below_minimum",
    );
    expect(simulateConversion(standard, q("points:a", "900")).feasible).toBe(false);
    const capped = simulateConversion(standard, q("points:a", "9999"));
    expect(capped.reasonCodes).toContain("capped_by_maximum");
    expect(quantityText(capped.use)).toBe("3000");
    expect(quantityText(capped.remainder)).toBe("6999");
    const exactMultiple = simulateConversion(standard, q("points:a", "2000"));
    expect(exactMultiple.reasonCodes).not.toContain("rounded_down_to_increment");
    // Another unit is refused rather than converted.
    expect(simulateConversion(standard, q("points:z", "2000")).reasonCodes).toEqual([
      "unit_mismatch",
    ]);
  });

  test("a cash-like estimate exists only with an offer, and never joins an asset subtotal", () => {
    const plan = simulateConversion(standard, q("points:a", "2500"));
    const estimate = cashLikeRedemptionEstimate(standard, plan)!;
    expect(estimate.kind).toBe("cash-like-redemption-estimate");
    expect(estimate.netAssetEligible).toBe(false);
    expect(estimate.conditionRefs).toContain("policy:offer:rounding:v1");
    expect(estimate.offerRef).toBe("offer:a-to-b:standard@v1");
    expect(
      cashLikeRedemptionEstimate(standard, simulateConversion(standard, q("points:a", "900"))),
    ).toBeNull();
    const displayed = providerDisplayedValue(q("JPY", "800"), "evidence:provider-display:1");
    expect(displayed.sourceAuthority).toBe("provider-reported");
    expect(displayed.netAssetEligible).toBe(false);
  });

  test("AT53 the A→C→B chain is checked hop by hop and reported as bounded, never optimal", () => {
    const [first, second] = fixture.chained.hops;
    const hopOffers = [
      offer({
        offerId: "offer:a-to-c",
        fromUnitRef: first!.fromUnit,
        toUnitRef: first!.toUnit,
        ratio: first!.ratio,
        minimum: decimalLiteral(first!.minimum),
        increment: decimalLiteral(first!.increment),
        maximumPerRequest: decimalLiteral(first!.cap),
        fixedFees: [],
      }),
      offer({
        offerId: "offer:c-to-b",
        fromUnitRef: second!.fromUnit,
        toUnitRef: second!.toUnit,
        ratio: second!.ratio,
        minimum: decimalLiteral(second!.minimum),
        increment: decimalLiteral(second!.increment),
        maximumPerRequest: decimalLiteral(second!.cap),
        fixedFees: [],
      }),
    ];
    const result = findConversionPaths(
      hopOffers,
      { quantity: q("points:a", fixture.eligibleBalance), clock: day("2026-09-09") },
      "points:b",
      budget,
    );
    expect(result.searchCoverage).toBe("bounded");
    expect(result.paths).toHaveLength(1);
    const path = result.paths[0]!;
    expect(path.optimality).toBe("not-determined");
    expect(quantityText(path.received)).toBe(fixture.chained.expected.receivedB);
    expect(quantityText(path.hops[0]!.plan.remainder)).toBe(fixture.chained.expected.remainingA);
    // Time is part of the state: the second application waits for the first credit.
    expect(path.hops[0]!.creditExpectedOn).toBe("2026-09-12");
    expect(path.hops[1]!.appliedOn).toBe("2026-09-12");
  });

  test("AT53 a cycle, a re-used offer, a shared quota and the depth cap are all rejected", () => {
    const cyclic = [
      offer({ offerId: "offer:a-to-b", fromUnitRef: "points:a", toUnitRef: "points:b" }),
      offer({
        offerId: "offer:b-to-a",
        fromUnitRef: "points:b",
        toUnitRef: "points:a",
        ratio: { numerator: "4", denominator: "1" },
        maximumPerRequest: null,
      }),
    ];
    const result = findConversionPaths(
      cyclic,
      { quantity: q("points:a", "4000"), clock: day("2026-09-09") },
      "points:a",
      budget,
    );
    // A 1:2 then 4:1 round trip looks profitable and is still not returned.
    expect(result.paths).toEqual([]);
    expect(result.rejected.map((r) => r.reasonCode)).toContain("cycle_rejected");

    const quota = [
      offer({ offerId: "offer:a-to-c", toUnitRef: "points:c", sharedQuotaRef: "quota:campaign-1" }),
      offer({
        offerId: "offer:c-to-b",
        fromUnitRef: "points:c",
        toUnitRef: "points:b",
        sharedQuotaRef: "quota:campaign-1",
        maximumPerRequest: null,
      }),
    ];
    const quotaResult = findConversionPaths(
      quota,
      { quantity: q("points:a", "4000"), clock: day("2026-09-09") },
      "points:b",
      budget,
    );
    expect(quotaResult.paths).toEqual([]);
    expect(quotaResult.rejected.map((r) => r.reasonCode)).toContain("shared_quota_reuse");

    // Depth 1 cannot reach a two-hop goal, and says so by returning nothing.
    const shallow = findConversionPaths(
      [
        offer({ offerId: "offer:a-to-c", toUnitRef: "points:c" }),
        offer({
          offerId: "offer:c-to-b",
          fromUnitRef: "points:c",
          toUnitRef: "points:b",
          maximumPerRequest: null,
        }),
      ],
      { quantity: q("points:a", "4000"), clock: day("2026-09-09") },
      "points:b",
      { ...budget, maxDepth: 1 },
    );
    expect(shallow.paths).toEqual([]);
    expect(shallow.searchCoverage).toBe("bounded");
  });

  test("AT53 a hop that would have to be applied before the previous credit arrives is rejected", () => {
    const offers = [
      offer({ offerId: "offer:a-to-c", toUnitRef: "points:c", processingDays: 10 }),
      offer({
        offerId: "offer:c-to-b",
        fromUnitRef: "points:c",
        toUnitRef: "points:b",
        maximumPerRequest: null,
        // The campaign closes before the first hop's points can arrive.
        applicationDeadline: day("2026-09-12"),
      }),
    ];
    const result = findConversionPaths(
      offers,
      { quantity: q("points:a", "4000"), clock: day("2026-09-09") },
      "points:b",
      budget,
    );
    expect(result.paths).toEqual([]);
    expect(result.rejected.map((r) => r.reasonCode)).toContain("reuse_before_credit");
  });

  test("AT51 a plan whose completion crosses the required date is rejected, not called 'in time'", () => {
    const slow = offer({ processingDays: 30 });
    const result = findConversionPaths(
      [slow],
      { quantity: q("points:a", "2500"), clock: day("2026-09-09") },
      "points:b",
      { ...budget, requiredCompletionBy: day("2026-09-20") },
    );
    expect(result.paths).toEqual([]);
    expect(result.rejected.map((r) => r.reasonCode)).toContain("completion_after_required_by");
    const inTime = findConversionPaths(
      [slow],
      { quantity: q("points:a", "2500"), clock: day("2026-09-09") },
      "points:b",
      { ...budget, requiredCompletionBy: day("2026-10-20") },
    );
    expect(inTime.paths).toHaveLength(1);
    expect(inTime.paths[0]!.hops[0]!.creditExpectedOn).toBe("2026-10-09");
  });

  test("AT50 campaign and member-limited offers between the same pair stay separate candidates", () => {
    const gold: MembershipState = {
      programId: "program:a",
      holdingRef: "holding:member-1",
      tier: "gold",
      valid: day("2026-09-09"),
      source: "provider",
      evidenceRefs: ["evidence:tier"],
    };
    const campaign = offer({
      offerId: "offer:a-to-b:campaign",
      ratio: { numerator: "3", denominator: "4" },
      eligibleTiers: ["gold"],
      // The campaign has already ended at the clock below.
      applicationDeadline: day("2026-08-31"),
    });
    const memberOnly = offer({
      offerId: "offer:a-to-b:member",
      ratio: { numerator: "2", denominator: "3" },
      eligibleTiers: ["platinum"],
    });
    const buckets = [bucket("bucket:regular", "regular", "points:a", "2500")];
    expect(
      availableForOffer(buckets, campaign, [gold], day("2026-09-09")).uncertaintyCodes,
    ).toContain("application_deadline_passed");
    expect(availableForOffer(buckets, memberOnly, [gold], day("2026-09-09")).state).toBe(
      "needs-rule-verification",
    );
    expect(availableForOffer(buckets, standard, [gold], day("2026-09-09")).state).toBe("available");
    // Three offers between the same pair are three candidates, not one rate.
    const result = findConversionPaths(
      [standard, campaign, memberOnly],
      { quantity: q("points:a", "2500"), clock: day("2026-09-09") },
      "points:b",
      budget,
    );
    expect(result.paths.map((path) => path.hops[0]!.offerRef).sort()).toEqual([
      "offer:a-to-b:member@v1",
      "offer:a-to-b:standard@v1",
    ]);
    expect(result.rejected.map((r) => r.reasonCode)).toContain("application_deadline_passed");
  });

  test("an unverified offer becomes a separate candidate to check, never a proven impossibility", () => {
    const result = findConversionPaths(
      [offer({ verification: "needs-rule-verification" })],
      { quantity: q("points:a", "2500"), clock: day("2026-09-09") },
      "points:b",
      budget,
    );
    expect(result.paths).toEqual([]);
    expect(result.rejected).toEqual([
      { offerRef: "offer:a-to-b:standard@v1", reasonCode: "needs_rule_verification" },
    ]);
  });
});
