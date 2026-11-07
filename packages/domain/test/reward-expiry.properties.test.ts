// Seeded property tests of the expiry basis (ADR 0049): random rules,
// buckets, activity histories and membership claims. Every rule, date and
// reference is synthetic; each property lists the seeds that break it.
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/context.ts";
import {
  estimateExpiry,
  validBucketExpiryBasis,
  type ActivityHistory,
  type ExpiryRule,
  type MembershipState,
  type RewardActivity,
  type RewardBucket,
  type RewardHolding,
} from "../src/rewards.ts";
import {
  addMonths,
  formatLocalDate,
  parseLocalDate,
  type LocalDateValue,
  type PeriodValue,
} from "../src/time.ts";
import { q } from "./helpers.ts";
import { between, pad2, pick, seededRandom, seeds, shuffled, type Random } from "./property.ts";

const TOKYO = "Asia/Tokyo";
const day = (value: string): LocalDateValue => ({
  kind: "local-date",
  value,
  zone: TOKYO,
  basis: "provider",
});
const period = (start: string, end: string): PeriodValue => ({
  kind: "period",
  start,
  end,
  endExclusive: false,
  zone: TOKYO,
  granularity: "day",
});

interface Case {
  rule: ExpiryRule;
  holding: RewardHolding;
  history: ActivityHistory;
  membership: MembershipState[];
  clock: LocalDateValue;
}

function randomCase(random: Random): Case {
  const tiered = random() < 0.3;
  const rule: ExpiryRule = {
    ruleId: "rule:program-p:property",
    version: "v1",
    family: pick(random, ["inactivity", "inactivity", "none", "fixed-lot"] as const),
    programId: "program:p",
    applicability: {
      bucketKinds: ["regular"],
      tiers: tiered ? ["gold", "elite"] : null,
      validPeriod:
        random() < 0.3 ? period("2025-06-01", pick(random, ["2027-05-31", "2026-12-31"])) : null,
    },
    qualifyingActivity: {
      policyRef: "policy:program-p:qualifying:v1",
      kinds: ["earn", "redeem"],
      excludedKinds: ["family-transfer-in"],
      extensionMonths: pick(random, [1, 6, 12]),
      endOfMonthPolicy: pick(random, ["clamp", "preserve-end-of-month"] as const),
      dateBasis: pick(random, ["provider-posted", "member-used"] as const),
    },
    deadlineCalendar: { zone: TOKYO, dayBoundary: "end-of-day", zoneBasis: "documented" },
    priorityPolicyRef: null,
    evidenceRefs: ["evidence:synthetic-terms:1"],
    verification: random() < 0.9 ? "verified" : "needs-rule-verification",
  };
  const buckets: RewardBucket[] = Array.from({ length: between(random, 1, 3) }, (_, index) => ({
    bucketRef: `bucket:${index}`,
    programId: "program:p",
    holdingRef: "holding:member-1",
    kind: pick(random, ["regular", "regular", "time-limited", "unclassified"] as const),
    restrictionRefs: [],
    quantity: q("points:p", "100"),
    observedExpiry:
      random() < 0.3 ? day(`2027-0${between(random, 1, 9)}-${pad2(between(random, 1, 28))}`) : null,
    observedAt: day("2026-09-01"),
    sourceFactRefs: [`fact:bucket:${index}`],
  }));
  const activities: RewardActivity[] = Array.from({ length: between(random, 0, 4) }, (_, index) => {
    const text = `2026-0${between(random, 1, 8)}-${pad2(pick(random, [1, 15, 28, 30, 31]))}`;
    const date = day(parseLocalDate(text) === null ? "2026-02-28" : text);
    return {
      activityRef: `act:${pick(random, ["a", "b", "c"])}${index}`,
      kind: pick(random, ["earn", "redeem", "family-transfer-in", "other"]),
      postedDate: date,
      usedDate: random() < 0.7 ? date : null,
    };
  });
  const claim = (
    tier: string,
    source: MembershipState["source"],
    start: string,
  ): MembershipState => ({
    programId: "program:p",
    holdingRef: "holding:member-1",
    tier,
    valid: period(start, "2027-12-31"),
    source,
    evidenceRefs: [`evidence:tier:${tier}`],
  });
  return {
    rule,
    holding: {
      holdingRef: "holding:member-1",
      programId: "program:p",
      unitRef: "points:p",
      buckets,
    },
    history: {
      windowRef: "window:property",
      completeness: pick(random, ["complete", "complete", "partial", "unknown"] as const),
      earliestObserved: day("2026-01-01"),
      activities,
    },
    membership: tiered
      ? [
          claim("elite", "provider", "2026-01-01"),
          claim("gold", "self-reported", "2026-04-01"),
        ].filter(() => random() < 0.7)
      : [],
    clock: day(`2026-${pad2(between(random, 9, 12))}-${pad2(between(random, 1, 28))}`),
  };
}

const SEEDS = seeds(1, 1500);

describe("estimateExpiry over random inputs", () => {
  test("activity and membership order never change the estimate", () => {
    const broken: number[] = [];
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const { rule, holding, history, membership, clock } = randomCase(random);
      const once = canonicalJson(estimateExpiry(rule, holding, history, membership, clock));
      const again = estimateExpiry(
        rule,
        holding,
        { ...history, activities: shuffled(random, history.activities) },
        shuffled(random, membership),
        clock,
      );
      if (canonicalJson(again) !== once) broken.push(seed);
    }
    expect(broken).toEqual([]);
  });

  test("a computed date is the newest qualifying day plus the extension, and passed only before today", () => {
    const broken: string[] = [];
    let dated = 0;
    for (const seed of SEEDS) {
      const { rule, holding, history, membership, clock } = randomCase(seededRandom(seed));
      const estimate = estimateExpiry(rule, holding, history, membership, clock);
      for (const bucket of estimate.expiringBuckets) {
        if (!validBucketExpiryBasis(bucket.expiryBasis))
          broken.push(`${seed}: basis does not validate`);
        const computed = bucket.expiryBasis.computed;
        if (computed.status === "date") {
          dated += 1;
          const policy = rule.qualifyingActivity!;
          const days = history.activities
            .filter((activity) => policy.kinds.includes(activity.kind))
            .map((activity) =>
              policy.dateBasis === "provider-posted" ? activity.postedDate : activity.usedDate,
            )
            .map((value) => (value?.kind === "local-date" ? value.value : ""))
            .sort();
          const newest = days.at(-1)!;
          if (computed.activity?.anchorDate?.value !== newest) broken.push(`${seed}: anchor`);
          const expected = formatLocalDate(
            addMonths(parseLocalDate(newest)!, policy.extensionMonths, policy.endOfMonthPolicy),
          );
          if (computed.value?.value !== expected) broken.push(`${seed}: deadline`);
        }
        const passed = bucket.reasonCodes.includes("deadline_passed");
        const before = bucket.deadline.kind === "local-date" && bucket.deadline.value < clock.value;
        if (passed !== before) broken.push(`${seed}: deadline_passed`);
        if (bucket.deadline.kind === "local-date" && bucket.basis === "unknown")
          broken.push(`${seed}: dated without a basis`);
      }
    }
    expect(broken).toEqual([]);
    expect(dated).toBeGreaterThan(50);
  });
});
