// The provider-displayed expiry and the computed expiry, kept apart per bucket
// (ADR 0049). Every rule, date, quantity and reference here is synthetic: the
// rules carry their own `verification` flag and assert nothing about a real
// programme's terms.
import { describe, expect, test } from "bun:test";
import {
  COMPUTED_EXPIRY_REASONS,
  estimateExpiry,
  EXPIRY_DERIVATION_RELEASE,
  validBucketExpiryBasis,
  type ActivityHistory,
  type BucketKind,
  type ComputedExpiryReason,
  type ExpiringBucket,
  type ExpiryEstimateState,
  type ExpiryRule,
  type MembershipState,
  type RewardBucket,
  type RewardHolding,
} from "../src/rewards.ts";
import type { LocalDateValue, PeriodValue, TemporalValue } from "../src/time.ts";
import type { Quantity } from "../src/values.ts";
import { q } from "./helpers.ts";

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
const period = (start: string, end: string): PeriodValue => ({
  kind: "period",
  start,
  end,
  endExclusive: false,
  zone: TOKYO,
  granularity: "day",
});
const OBSERVED_AT = day("2026-09-01");

function bucket(
  ref: string,
  kind: BucketKind,
  overrides: Partial<RewardBucket> = {},
): RewardBucket {
  return {
    bucketRef: ref,
    programId: "program:a",
    holdingRef: "holding:member-1",
    kind,
    restrictionRefs: [],
    quantity: q("points:a", "1000"),
    observedExpiry: null,
    observedAt: OBSERVED_AT,
    sourceFactRefs: [`fact:${ref}`],
    ...overrides,
  };
}

function holding(...buckets: RewardBucket[]): RewardHolding {
  return { holdingRef: "holding:member-1", programId: "program:a", unitRef: "points:a", buckets };
}

const inactivity: ExpiryRule = {
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
const fixedLot: ExpiryRule = {
  ...inactivity,
  ruleId: "rule:program-a:fixed-lot",
  family: "fixed-lot",
  qualifyingActivity: null,
};
const noExpiry: ExpiryRule = {
  ...inactivity,
  ruleId: "rule:program-a:no-expiry",
  family: "none",
  qualifyingActivity: null,
};

const history: ActivityHistory = {
  windowRef: "window:program-a:synthetic",
  completeness: "complete",
  earliestObserved: day("2026-01-01"),
  activities: [
    { activityRef: "act:earn-1", kind: "earn", postedDate: day("2026-03-01"), usedDate: null },
    // Newer, but excluded by the rule: it must not become the anchor.
    {
      activityRef: "act:transfer-1",
      kind: "family-transfer-in",
      postedDate: day("2026-08-01"),
      usedDate: null,
    },
  ],
};
const CLOCK = day("2026-09-09");

function only(rule: ExpiryRule, input: RewardBucket, options: Partial<Inputs> = {}): Result {
  const estimate = estimateExpiry(
    rule,
    holding(input),
    options.activity ?? history,
    options.membership ?? [],
    options.clock ?? CLOCK,
  );
  return { estimate, row: estimate.expiringBuckets[0]! };
}
interface Inputs {
  activity: ActivityHistory;
  membership: MembershipState[];
  clock: TemporalValue;
}
type Result = { estimate: ReturnType<typeof estimateExpiry>; row: ExpiringBucket };

describe("displayed and computed expiry are two answers with their own basis", () => {
  test("agreeing: both sides kept, the computed side names its rule version, activity and release", () => {
    const { estimate, row } = only(
      inactivity,
      bucket("bucket:regular", "regular", { observedExpiry: day("2027-03-01") }),
    );
    expect(estimate.state).toBe("computed");
    expect(row.expiryBasis.agreement).toBe("agree");
    expect(row.expiryBasis.displayed).toEqual({
      value: day("2027-03-01"),
      observedAt: OBSERVED_AT,
      sourceFactRefs: ["fact:bucket:regular"],
    });
    const computed = row.expiryBasis.computed;
    expect(computed.status).toBe("date");
    expect(computed.value).toEqual(derived("2027-03-01"));
    expect(computed.reasonCode).toBeNull();
    expect(computed.rule).toEqual({
      ruleRef: "rule:program-a:inactivity-expiry@v1",
      ruleId: "rule:program-a:inactivity-expiry",
      version: "v1",
      family: "inactivity",
      verification: "verified",
      validPeriod: null,
      evidenceRefs: ["evidence:synthetic-terms:1"],
      qualifyingActivityPolicyRef: "policy:program-a:qualifying-activity:v1",
      deadlineCalendar: { zone: TOKYO, dayBoundary: "end-of-day", zoneBasis: "documented" },
    });
    // The anchor is the newest *qualifying* activity, not the newer transfer.
    expect(computed.activity).toEqual({
      windowRef: "window:program-a:synthetic",
      completeness: "complete",
      earliestObserved: day("2026-01-01"),
      anchorActivityRef: "act:earn-1",
      anchorDate: derived("2026-03-01"),
    });
    expect(computed.membership).toBeNull();
    expect(computed.release).toBe(EXPIRY_DERIVATION_RELEASE);
    // The list's deadline is the display, and the computed date stays visible.
    expect(row.deadline).toEqual(day("2027-03-01"));
    expect(row.basis).toBe("provider-observed");
    expect(row.policyEstimated).toEqual(computed.value);
    expect(row.reasonCodes).toEqual([]);
    expect(validBucketExpiryBasis(row.expiryBasis)).toBe(true);
  });

  test("disagreeing: a conflict, both dates returned, neither silently chosen as the truth", () => {
    const { estimate, row } = only(
      inactivity,
      bucket("bucket:regular", "regular", { observedExpiry: day("2027-02-28") }),
    );
    expect(estimate.state).toBe("conflict");
    expect(row.expiryBasis.agreement).toBe("disagree");
    expect(row.expiryBasis.displayed?.value).toEqual(day("2027-02-28"));
    expect(row.expiryBasis.computed.value).toEqual(derived("2027-03-01"));
    expect(row.reasonCodes).toContain("provider_and_policy_differ");
    expect(estimate.uncertaintyCodes).toContain("provider_and_policy_differ");
    expect(row.providerObserved).toEqual(day("2027-02-28"));
    expect(row.policyEstimated).toEqual(derived("2027-03-01"));
  });

  test("an unreadable display is not a disagreement and does not hide the computed date", () => {
    const unreadable: TemporalValue = { kind: "unknown", reasonCode: "provider_expiry_unparsed" };
    const { estimate, row } = only(
      inactivity,
      bucket("bucket:regular", "regular", { observedExpiry: unreadable }),
    );
    expect(row.expiryBasis.agreement).toBe("not-comparable");
    expect(estimate.state).toBe("computed");
    expect(row.expiryBasis.displayed?.value).toEqual(unreadable);
    expect(row.deadline).toEqual(derived("2027-03-01"));
    expect(row.basis).toBe("policy-estimated");
    expect(row.reasonCodes).not.toContain("provider_and_policy_differ");
  });

  test("a display under a fixed-lot rule is only an observation: nothing is computed beside it", () => {
    const { estimate, row } = only(
      fixedLot,
      bucket("bucket:lot", "time-limited", { observedExpiry: day("2026-12-31") }),
    );
    expect(estimate.state).toBe("computed");
    expect(row.expiryBasis.computed.status).toBe("unavailable");
    expect(row.expiryBasis.computed.reasonCode).toBe("fixed_deadline_not_derivable");
    expect(row.expiryBasis.computed.activity).toBeNull();
    expect(row.expiryBasis.agreement).toBe("not-comparable");
    expect(row.deadline).toEqual(day("2026-12-31"));
    expect(row.basis).toBe("provider-observed");
    expect(row.reasonCodes).toEqual(["fixed_deadline_not_derivable", "provider_expiry_only"]);
  });

  test("verified, open-ended terms of family none are 'no expiry'; a display beside them is a conflict", () => {
    const plain = only(noExpiry, bucket("bucket:regular", "regular"));
    expect(plain.estimate.state).toBe("computed");
    expect(plain.row.expiryBasis.computed.status).toBe("no-expiry");
    expect(plain.row.expiryBasis.computed.value).toBeNull();
    expect(plain.row.expiryBasis.computed.reasonCode).toBeNull();
    expect(plain.row.deadline).toEqual({
      kind: "unknown",
      reasonCode: "no_expiry_under_verified_terms",
    });
    expect(plain.row.reasonCodes).toEqual(["no_expiry_under_verified_terms"]);
    expect(plain.estimate.uncertaintyCodes).toContain("no_expiry_under_verified_terms");

    const shown = only(
      noExpiry,
      bucket("bucket:regular", "regular", { observedExpiry: day("2027-01-31") }),
    );
    expect(shown.row.expiryBasis.agreement).toBe("disagree");
    expect(shown.estimate.state).toBe("conflict");

    // A version with an end says nothing about the time after it.
    const bounded = only(
      {
        ...noExpiry,
        applicability: {
          ...noExpiry.applicability,
          validPeriod: period("2026-01-01", "2026-12-31"),
        },
      },
      bucket("bucket:regular", "regular"),
    );
    expect(bounded.row.expiryBasis.computed.status).toBe("unavailable");
    expect(bounded.row.expiryBasis.computed.reasonCode).toBe("rule_transition_unconfirmed");
    expect(bounded.estimate.state).toBe("partial");
    // No bucket got "no expiry", so the estimate does not say it either.
    expect(bounded.estimate.uncertaintyCodes).not.toContain("no_expiry_under_verified_terms");
  });

  test("a tier-gated 'no expiry' needs a required tier on the evaluation day", () => {
    const tieredNone: ExpiryRule = {
      ...noExpiry,
      ruleId: "rule:program-a:tiered-no-expiry",
      applicability: { ...noExpiry.applicability, tiers: ["elite"] },
    };
    const claim: MembershipState = {
      programId: "program:a",
      holdingRef: "holding:member-1",
      tier: "elite",
      valid: period("2026-01-01", "2026-12-31"),
      source: "provider",
      evidenceRefs: ["evidence:tier:1"],
    };
    const current = only(tieredNone, bucket("bucket:regular", "regular"), { membership: [claim] });
    expect(current.row.expiryBasis.computed.status).toBe("no-expiry");
    expect(current.estimate.state).toBe("computed");

    // The same tier, ended before the evaluation day: "no expiry" is not claimed.
    const ended = only(tieredNone, bucket("bucket:regular", "regular"), {
      membership: [{ ...claim, valid: period("2024-01-01", "2024-12-31") }],
    });
    expect(ended.row.expiryBasis.computed.status).toBe("unavailable");
    expect(ended.row.expiryBasis.computed.reasonCode).toBe("membership_not_retroactive");
    expect(ended.row.expiryBasis.computed.membership?.claims).toHaveLength(1);
    expect(ended.row.reasonCodes).not.toContain("no_expiry_under_verified_terms");
    expect(ended.estimate.uncertaintyCodes).not.toContain("no_expiry_under_verified_terms");
    expect(ended.row.deadline.kind).toBe("unknown");
    expect(ended.estimate.state).toBe("partial");
    expect(validBucketExpiryBasis(ended.row.expiryBasis)).toBe(true);
  });

  test("a tier-gated rule records the membership claims it consumed", () => {
    const tiered: ExpiryRule = {
      ...inactivity,
      ruleId: "rule:program-a:tiered",
      applicability: { ...inactivity.applicability, tiers: ["elite"] },
    };
    const claim: MembershipState = {
      programId: "program:a",
      holdingRef: "holding:member-1",
      tier: "elite",
      valid: period("2026-01-01", "2026-12-31"),
      source: "self-reported",
      evidenceRefs: ["evidence:tier:1"],
    };
    const { row } = only(tiered, bucket("bucket:regular", "regular"), { membership: [claim] });
    expect(row.expiryBasis.computed.status).toBe("date");
    expect(row.expiryBasis.computed.membership).toEqual({
      requiredTiers: ["elite"],
      claims: [
        {
          tier: "elite",
          source: "self-reported",
          valid: period("2026-01-01", "2026-12-31"),
          evidenceRefs: ["evidence:tier:1"],
        },
      ],
    });
    expect(row.expiryBasis.computed.uncertaintyCodes).toContain("membership_self_reported");
    // Another programme's claim with the same holding reference is not this one's.
    const foreign = only(tiered, bucket("bucket:regular", "regular"), {
      membership: [{ ...claim, programId: "program:other" }],
    });
    expect(foreign.row.expiryBasis.computed.reasonCode).toBe("membership_out_of_scope");
  });

  test("same-day qualifying activities choose one anchor regardless of input order", () => {
    const sameDay = (order: "forward" | "reverse"): ActivityHistory => {
      const activities = [
        { activityRef: "act:b", kind: "earn", postedDate: day("2026-04-01"), usedDate: null },
        { activityRef: "act:a", kind: "redeem", postedDate: day("2026-04-01"), usedDate: null },
      ];
      return { ...history, activities: order === "forward" ? activities : activities.reverse() };
    };
    for (const order of ["forward", "reverse"] as const) {
      const { row } = only(inactivity, bucket("bucket:regular", "regular"), {
        activity: sameDay(order),
      });
      expect(row.expiryBasis.computed.activity?.anchorActivityRef).toBe("act:a");
    }
  });
});

describe("every unavailable computed expiry carries exactly one closed reason", () => {
  const tiered: ExpiryRule = {
    ...inactivity,
    ruleId: "rule:program-a:tiered",
    applicability: { ...inactivity.applicability, tiers: ["elite"] },
  };
  const laterTier: MembershipState = {
    programId: "program:a",
    holdingRef: "holding:member-1",
    tier: "elite",
    valid: period("2026-07-01", "2027-06-30"),
    source: "provider",
    evidenceRefs: ["evidence:tier:1"],
  };
  const cases: {
    reason: ComputedExpiryReason;
    rule: ExpiryRule;
    kind?: BucketKind;
    inputs?: Partial<Inputs>;
    state: ExpiryEstimateState;
  }[] = [
    {
      reason: "bucket_kind_unclassified",
      rule: inactivity,
      kind: "unclassified",
      state: "partial",
    },
    {
      reason: "rule_not_verified",
      rule: { ...inactivity, verification: "needs-rule-verification" },
      state: "needs-rule-verification",
    },
    {
      reason: "rule_family_unsupported",
      rule: { ...inactivity, family: "unsupported" },
      state: "needs-rule-verification",
    },
    {
      reason: "rule_out_of_force",
      rule: {
        ...inactivity,
        applicability: {
          ...inactivity.applicability,
          validPeriod: period("2020-01-01", "2020-12-31"),
        },
      },
      state: "needs-rule-verification",
    },
    {
      reason: "rule_transition_unconfirmed",
      // In force on the evaluation day, but the deadline it would produce
      // (2027-03-01) lies after the version's own end.
      rule: {
        ...inactivity,
        applicability: {
          ...inactivity.applicability,
          validPeriod: period("2026-01-01", "2026-12-31"),
        },
      },
      state: "partial",
    },
    {
      reason: "rule_bucket_kind_not_covered",
      rule: inactivity,
      kind: "pending-award",
      state: "computed",
    },
    {
      reason: "fixed_deadline_not_derivable",
      rule: fixedLot,
      kind: "time-limited",
      state: "partial",
    },
    {
      reason: "qualifying_activity_policy_missing",
      rule: { ...inactivity, qualifyingActivity: null },
      state: "needs-rule-verification",
    },
    { reason: "membership_out_of_scope", rule: tiered, state: "partial" },
    {
      reason: "membership_not_retroactive",
      rule: tiered,
      inputs: { membership: [laterTier] },
      state: "partial",
    },
    {
      reason: "activity_date_unknown",
      rule: inactivity,
      inputs: {
        activity: {
          ...history,
          activities: [
            ...history.activities,
            {
              activityRef: "act:undated",
              kind: "earn",
              postedDate: { kind: "unknown", reasonCode: "synthetic_unreadable_date" },
              usedDate: null,
            },
          ],
        },
      },
      state: "partial",
    },
    {
      reason: "no_qualifying_activity_observed",
      rule: inactivity,
      inputs: { activity: { ...history, activities: [history.activities[1]!] } },
      state: "partial",
    },
    {
      reason: "history_completeness_unknown",
      // A qualifying activity is visible, but whether a newer one is missing is not.
      rule: inactivity,
      inputs: { activity: { ...history, completeness: "unknown", earliestObserved: null } },
      state: "partial",
    },
  ];

  test("the cases below reach every code of the closed list", () => {
    expect(cases.map((entry) => entry.reason).sort()).toEqual([...COMPUTED_EXPIRY_REASONS].sort());
  });

  for (const entry of cases)
    test(`${entry.reason}: no date, no zero, no 'expired', the reason travels with the row`, () => {
      const input = bucket("bucket:subject", entry.kind ?? "regular");
      const { estimate, row } = only(entry.rule, input, entry.inputs);
      const computed = row.expiryBasis.computed;
      expect(computed.status).toBe("unavailable");
      expect(computed.reasonCode).toBe(entry.reason);
      expect(computed.value).toBeNull();
      expect(computed.uncertaintyCodes).not.toContain(entry.reason);
      expect(row.policyEstimated).toBeNull();
      expect(row.expiryBasis.displayed).toBeNull();
      expect(row.expiryBasis.agreement).toBe("not-comparable");
      expect(row.deadline.kind).toBe("unknown");
      expect(row.basis).toBe("unknown");
      expect(row.reasonCodes).toContain(entry.reason);
      expect(row.reasonCodes).not.toContain("deadline_passed");
      expect(row.quantity).toEqual(input.quantity);
      expect(estimate.state).toBe(entry.state);
      expect(validBucketExpiryBasis(row.expiryBasis)).toBe(true);
    });
});

describe("rule versions across an applicable-period boundary", () => {
  // Two synthetic versions of one rule: v1 in force through 2026-12-31 with a
  // 12-month extension, v2 from 2027-01-01 with a 24-month one. Neither says
  // what happens to a deadline that crosses from one into the other.
  const v1: ExpiryRule = {
    ...inactivity,
    version: "v1",
    applicability: { ...inactivity.applicability, validPeriod: period("2025-01-01", "2026-12-31") },
  };
  const v2: ExpiryRule = {
    ...inactivity,
    version: "v2",
    applicability: { ...inactivity.applicability, validPeriod: period("2027-01-01", "2030-12-31") },
    qualifyingActivity: { ...inactivity.qualifyingActivity!, extensionMonths: 24 },
    evidenceRefs: ["evidence:synthetic-terms:2"],
  };
  const earnedOn = (date: string): ActivityHistory => ({
    ...history,
    earliestObserved: day("2024-01-01"),
    activities: [
      { activityRef: `act:${date}`, kind: "earn", postedDate: day(date), usedDate: null },
    ],
  });
  const computed = (rule: ExpiryRule, anchor: string, clock: string) =>
    only(rule, bucket("bucket:regular", "regular"), {
      activity: earnedOn(anchor),
      clock: day(clock),
    }).row.expiryBasis.computed;

  test("before the boundary only v1 computes, and only for a deadline inside its own period", () => {
    const inside = computed(v1, "2025-09-01", "2026-06-01");
    expect(inside.status).toBe("date");
    expect(inside.value).toEqual(derived("2026-09-01"));
    expect(inside.rule.version).toBe("v1");
    expect(inside.rule.validPeriod).toEqual(period("2025-01-01", "2026-12-31"));
    expect(inside.rule.evidenceRefs).toEqual(["evidence:synthetic-terms:1"]);

    const crossing = computed(v1, "2026-01-15", "2026-06-01");
    expect(crossing.status).toBe("unavailable");
    expect(crossing.reasonCode).toBe("rule_transition_unconfirmed");

    expect(computed(v2, "2025-09-01", "2026-06-01").reasonCode).toBe("rule_out_of_force");
  });

  test("the last day of v1 and the first day of v2 each have exactly one version in force", () => {
    expect(computed(v1, "2025-09-01", "2026-12-31").reasonCode).not.toBe("rule_out_of_force");
    expect(computed(v2, "2025-09-01", "2026-12-31").reasonCode).toBe("rule_out_of_force");
    expect(computed(v1, "2027-01-01", "2027-01-01").reasonCode).toBe("rule_out_of_force");
    expect(computed(v2, "2027-01-01", "2027-01-01").status).toBe("date");
  });

  test("after the boundary v2 computes from an anchor inside its period and refuses one before it", () => {
    const after = computed(v2, "2027-01-10", "2027-02-01");
    expect(after.status).toBe("date");
    expect(after.value).toEqual(derived("2029-01-10"));
    expect(after.rule.version).toBe("v2");
    expect(after.rule.evidenceRefs).toEqual(["evidence:synthetic-terms:2"]);

    const anchoredUnderV1 = computed(v2, "2026-12-20", "2027-02-01");
    expect(anchoredUnderV1.status).toBe("unavailable");
    expect(anchoredUnderV1.reasonCode).toBe("rule_transition_unconfirmed");

    expect(computed(v1, "2026-12-20", "2027-02-01").reasonCode).toBe("rule_out_of_force");
  });

  test("an unreadable period is never read as 'always in force'", () => {
    const unreadable: ExpiryRule = {
      ...inactivity,
      applicability: {
        ...inactivity.applicability,
        validPeriod: { kind: "unknown", reasonCode: "stored_rule_period_invalid" },
      },
    };
    expect(computed(unreadable, "2026-03-01", "2026-09-09").reasonCode).toBe("rule_out_of_force");
  });
});

describe("no bucket is shown as zero or expired without a basis", () => {
  const quantities: Quantity[] = [
    q("points:a", "1000"),
    { unitRef: "points:a", value: { status: "unparsed", reasonCode: "synthetic_unparsed" } },
    { unitRef: "points:a", value: { status: "missing", reasonCode: "synthetic_missing" } },
  ];
  const displays: (TemporalValue | null)[] = [
    null,
    { kind: "unknown", reasonCode: "provider_expiry_unparsed" },
    day("2026-01-31"),
    day("2027-12-31"),
  ];
  const rules: ExpiryRule[] = [
    inactivity,
    fixedLot,
    noExpiry,
    { ...inactivity, verification: "needs-rule-verification" },
    { ...inactivity, applicability: { ...inactivity.applicability, tiers: ["elite"] } },
    {
      ...inactivity,
      applicability: {
        ...inactivity.applicability,
        validPeriod: period("2026-01-01", "2026-12-31"),
      },
    },
  ];
  const histories: ActivityHistory[] = [
    // A qualifying activity old enough that its computed deadline has passed.
    {
      ...history,
      earliestObserved: day("2024-01-01"),
      activities: [
        { activityRef: "act:old", kind: "earn", postedDate: day("2025-01-10"), usedDate: null },
      ],
    },
    // Nothing classified: the shape every stored programme has today.
    {
      windowRef: "window:unclassified",
      completeness: "unknown",
      earliestObserved: null,
      activities: [],
    },
  ];
  const kinds: BucketKind[] = ["regular", "restricted", "time-limited", "pending-award"];

  test("every combination keeps every bucket, its quantity as observed, and 'passed' only on a based date", () => {
    let checked = 0;
    const passed = { "provider-observed": 0, "policy-estimated": 0 };
    for (const rule of rules)
      for (const activity of histories) {
        const buckets: RewardBucket[] = [];
        let index = 0;
        for (const kind of kinds)
          for (const quantity of quantities)
            for (const observedExpiry of displays)
              buckets.push(bucket(`bucket:${(index += 1)}`, kind, { quantity, observedExpiry }));
        buckets.push(bucket("bucket:measure", "qualification"));
        const estimate = estimateExpiry(rule, holding(...buckets), activity, [], CLOCK);
        // Qualification measures are not balances; every other bucket is listed.
        expect(estimate.expiringBuckets.map((row) => row.bucketRef)).toEqual(
          buckets.filter((entry) => entry.kind !== "qualification").map((entry) => entry.bucketRef),
        );
        for (const row of estimate.expiringBuckets) {
          checked += 1;
          const source = buckets.find((entry) => entry.bucketRef === row.bucketRef)!;
          const { displayed, computed } = row.expiryBasis;
          expect(validBucketExpiryBasis(row.expiryBasis)).toBe(true);
          // The quantity is the observation, never replaced by a zero.
          expect(row.quantity).toEqual(source.quantity);
          // The computed side is a date only with a date; otherwise one closed reason.
          if (computed.status !== "date") expect(row.policyEstimated).toBeNull();
          if (computed.status === "unavailable")
            expect(COMPUTED_EXPIRY_REASONS).toContain(computed.reasonCode!);
          if (computed.status === "no-expiry") {
            expect(rule.family).toBe("none");
            expect(rule.verification).toBe("verified");
            expect(rule.applicability.validPeriod).toBeNull();
          }
          // The displayed side is the claim, untouched.
          expect(displayed?.value ?? null).toEqual(source.observedExpiry);
          // "Passed" needs a calendar date that a display or a computation established.
          if (row.reasonCodes.includes("deadline_passed")) {
            expect(row.deadline.kind).toBe("local-date");
            passed[row.basis as keyof typeof passed] += 1;
            if (row.basis === "provider-observed") expect(row.deadline).toEqual(displayed!.value);
            else {
              expect(row.basis).toBe("policy-estimated");
              expect(computed.status).toBe("date");
              expect(row.deadline).toEqual(computed.value!);
            }
          }
          if (
            (displayed === null || displayed.value.kind === "unknown") &&
            computed.status !== "date"
          ) {
            expect(row.deadline.kind).toBe("unknown");
            expect(row.reasonCodes).not.toContain("deadline_passed");
          }
        }
      }
    expect(checked).toBe(
      rules.length * histories.length * kinds.length * quantities.length * displays.length,
    );
    // Both kinds of basis did reach "passed", so the checks above were exercised.
    expect(passed["provider-observed"]).toBeGreaterThan(0);
    expect(passed["policy-estimated"]).toBeGreaterThan(0);
  });
});

describe("the stored basis shape refuses contradictions", () => {
  const { row } = only(
    inactivity,
    bucket("bucket:regular", "regular", { observedExpiry: day("2027-03-01") }),
  );
  const basis = row.expiryBasis;

  test("a date with a reason, a reason without a date and 'no expiry' with a date are refused", () => {
    expect(validBucketExpiryBasis(basis)).toBe(true);
    expect(
      validBucketExpiryBasis({
        ...basis,
        computed: { ...basis.computed, reasonCode: "rule_not_verified" },
      }),
    ).toBe(false);
    expect(
      validBucketExpiryBasis({
        ...basis,
        computed: { ...basis.computed, status: "unavailable", value: null, reasonCode: null },
      }),
    ).toBe(false);
    expect(
      validBucketExpiryBasis({ ...basis, computed: { ...basis.computed, status: "no-expiry" } }),
    ).toBe(false);
    expect(
      validBucketExpiryBasis({
        ...basis,
        computed: {
          ...basis.computed,
          status: "unavailable",
          value: null,
          reasonCode: "made_up_reason",
        },
      }),
    ).toBe(false);
  });

  test("a date or 'no expiry' from a version that cannot give one is refused", () => {
    const unverified = { ...basis.computed.rule, verification: "needs-rule-verification" };
    expect(
      validBucketExpiryBasis({ ...basis, computed: { ...basis.computed, rule: unverified } }),
    ).toBe(false);
    const noneRule = { ...basis.computed.rule, family: "none" };
    const noExpiryAnswer = { ...basis.computed, status: "no-expiry", value: null, activity: null };
    const withRule = (rule: object, agreement = "disagree") => ({
      ...basis,
      computed: { ...noExpiryAnswer, rule },
      agreement,
    });
    expect(validBucketExpiryBasis(withRule(noneRule))).toBe(true);
    expect(
      validBucketExpiryBasis(withRule({ ...noneRule, verification: "needs-rule-verification" })),
    ).toBe(false);
    expect(
      validBucketExpiryBasis(
        withRule({ ...noneRule, validPeriod: period("2026-01-01", "2026-12-31") }),
      ),
    ).toBe(false);
    // "No expiry" from an inactivity rule, and "agree" with "no expiry".
    expect(validBucketExpiryBasis(withRule(basis.computed.rule))).toBe(false);
    expect(validBucketExpiryBasis(withRule(noneRule, "agree"))).toBe(false);
  });

  test("an unreadable display neither agrees nor disagrees", () => {
    const unreadable = { kind: "unknown", reasonCode: "provider_expiry_unparsed" };
    const displayed = { ...basis.displayed!, value: unreadable };
    expect(validBucketExpiryBasis({ ...basis, displayed })).toBe(false);
    expect(validBucketExpiryBasis({ ...basis, displayed, agreement: "disagree" })).toBe(false);
    expect(validBucketExpiryBasis({ ...basis, displayed, agreement: "not-comparable" })).toBe(true);
  });

  test("agreement needs two sides, unknown keys are refused and the rule reference must match", () => {
    expect(validBucketExpiryBasis({ ...basis, displayed: null })).toBe(false);
    expect(validBucketExpiryBasis({ ...basis, displayed: null, agreement: "not-comparable" })).toBe(
      true,
    );
    expect(validBucketExpiryBasis({ ...basis, total: "0" })).toBe(false);
    expect(
      validBucketExpiryBasis({
        ...basis,
        computed: { ...basis.computed, rule: { ...basis.computed.rule, ruleRef: "rule:other@v9" } },
      }),
    ).toBe(false);
  });
});

test("unclassified dated and undated quantities remain visible but cannot yield a computed expiry", () => {
  for (const rule of [inactivity, noExpiry, fixedLot]) {
    const explicit = {
      ...rule,
      applicability: { ...rule.applicability, bucketKinds: ["unclassified"] as BucketKind[] },
    };
    const dated = bucket("bucket:unclassified:dated", "unclassified", {
      quantity: q("points:a", "123.45"),
      observedExpiry: day("2026-12-31"),
    });
    const undated = bucket("bucket:unclassified:undated", "unclassified");
    const result = estimateExpiry(explicit, holding(dated, undated), history, [], CLOCK);
    expect(result.state).toBe("partial");
    expect(result.expiringBuckets).toHaveLength(2);
    for (const row of result.expiringBuckets) {
      expect(row.expiryBasis.computed).toMatchObject({
        status: "unavailable",
        value: null,
        reasonCode: "bucket_kind_unclassified",
        activity: null,
        membership: null,
        uncertaintyCodes: [],
      });
      expect(row.expiryBasis.agreement).toBe("not-comparable");
      expect(row.policyEstimated).toBeNull();
      expect(validBucketExpiryBasis(row.expiryBasis)).toBe(true);
    }
    const datedRow = result.expiringBuckets.find((row) => row.bucketRef === dated.bucketRef)!;
    expect(datedRow.quantity).toEqual(dated.quantity);
    expect(datedRow.deadline).toEqual(dated.observedExpiry!);
    expect(datedRow.expiryBasis.displayed!.sourceFactRefs).toEqual(dated.sourceFactRefs);
    const undatedRow = result.expiringBuckets.find((row) => row.bucketRef === undated.bucketRef)!;
    expect(undatedRow.quantity).toEqual(undated.quantity);
    expect(undatedRow.deadline).toEqual({
      kind: "unknown",
      reasonCode: "bucket_kind_unclassified",
    });
    expect(undatedRow.basis).toBe("unknown");
    expect(result.sourceExpiryRefs).toEqual(dated.sourceFactRefs);
  }
});
