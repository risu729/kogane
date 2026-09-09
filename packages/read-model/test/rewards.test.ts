// Reward read model mappers and reader (A11). Synthetic rows only.
import { describe, expect, test } from "bun:test";
import {
  conversionOffer,
  createRewardReader,
  CURRENT_REWARD_BUCKETS_SQL,
  expiryRule,
  membershipState,
  observedAtValue,
  QUALIFYING_ACTIVITY_POLICIES,
  rewardBucket,
  REWARD_PAGE_LIMIT,
  type ConversionOfferSqlRow,
  type ExpiryRuleSqlRow,
  type RewardBucketSqlRow,
} from "../src/rewards.ts";
import type { SqlExecutor } from "../src/reader.ts";

const bucketRow: RewardBucketSqlRow = {
  id: 1,
  program_id: "program:synthetic",
  holding_ref: "program:synthetic:member",
  bucket_ref: "program:synthetic:slot-0",
  bucket_kind: "restricted",
  restriction_refs_json: '["restriction:synthetic:store"]',
  unit_ref: "points:synthetic",
  quantity_coefficient: "300",
  quantity_scale: 0,
  quantity_status: "exact",
  observed_expiry_json: JSON.stringify({
    kind: "local-date",
    value: "2026-11-30",
    zone: "Asia/Tokyo",
    basis: "provider",
  }),
  observed_at: "2026-09-08T00:00:00.000Z",
  parse_run_id: 7,
  source_fact_kind: "balance",
  source_fact_id: 11,
  institution_ref: "institution:synthetic",
  program_ref: "synthetic",
  source_id: "synthetic-source",
  program_unit_ref: "points:synthetic",
  holding_kind: "reward-points",
  terms_evidence_refs_json: '["docs/sources/synthetic.md"]',
  release_id: "reward-model-v1",
};

const ruleRow: ExpiryRuleSqlRow = {
  rule_id: "rule:v-point:regular-inactivity",
  version: "v1",
  family: "inactivity",
  program_id: "program:v-point",
  applicability_json: '{"bucketKinds":["regular"],"tiers":null,"validPeriod":null}',
  qualifying_activity_policy_ref: "policy:v-point:qualifying-activity:v1",
  deadline_calendar_ref: "Asia/Tokyo:end-of-day:assumed",
  priority_policy_ref: null,
  evidence_refs_json: '["docs/sources/v-point.md#4.1"]',
  verification: "verified",
};

describe("reward mappers", () => {
  test("a bucket keeps its unit, its exact decimal and the provider's own expiry", () => {
    const bucket = rewardBucket(bucketRow);
    expect(bucket.kind).toBe("restricted");
    expect(bucket.quantity).toEqual({
      unitRef: "points:synthetic",
      value: {
        status: "exact",
        value: { coefficient: "300", scale: 0 },
        normalizationVersion: "decimal-v1",
      },
    });
    expect(bucket.observedExpiry).toEqual({
      kind: "local-date",
      value: "2026-11-30",
      zone: "Asia/Tokyo",
      basis: "provider",
    });
    expect(bucket.sourceFactRefs).toEqual(["balance:11"]);
  });

  test("a non-exact quantity keeps its status and never becomes zero", () => {
    const bucket = rewardBucket({
      ...bucketRow,
      quantity_status: "unparsed",
      quantity_coefficient: null,
      quantity_scale: null,
    });
    expect(bucket.quantity.value).toEqual({
      status: "unparsed",
      reasonCode: "decimal-v1:unparsed",
    });
  });

  test("a stored expiry that no longer validates becomes unknown, not a guess", () => {
    const bucket = rewardBucket({ ...bucketRow, observed_expiry_json: '{"kind":"nonsense"}' });
    expect(bucket.observedExpiry).toEqual({
      kind: "unknown",
      reasonCode: "stored_expiry_invalid",
    });
    expect(rewardBucket({ ...bucketRow, observed_expiry_json: "not json" }).observedExpiry).toEqual(
      { kind: "unknown", reasonCode: "stored_expiry_invalid" },
    );
  });

  test("observed_at keeps its role: an instant stays an instant and a date never gains a time", () => {
    expect(observedAtValue("2026-09-08T00:00:00.000Z")).toEqual({
      kind: "instant",
      value: "2026-09-08T00:00:00.000Z",
      zone: "UTC",
      basis: "collector",
    });
    expect(observedAtValue("2026-09-08")).toEqual({
      kind: "local-date",
      value: "2026-09-08",
      zone: null,
      basis: "provider",
    });
    expect(observedAtValue("last week")).toEqual({
      kind: "unknown",
      reasonCode: "observed_at_unparsed",
    });
  });

  test("a rule resolves its qualifying-activity policy and keeps the deadline zone separate", () => {
    const rule = expiryRule(ruleRow);
    expect(rule.family).toBe("inactivity");
    expect(rule.deadlineCalendar).toEqual({
      zone: "Asia/Tokyo",
      dayBoundary: "end-of-day",
      zoneBasis: "assumed",
    });
    expect(rule.qualifyingActivity).toEqual(
      QUALIFYING_ACTIVITY_POLICIES["policy:v-point:qualifying-activity:v1"]!,
    );
    // The policy the terms record: store-limited movement does not extend it.
    expect(rule.qualifyingActivity!.excludedKinds).toContain("store-limited-redeem");
    expect(rule.qualifyingActivity!.extensionMonths).toBe(12);
  });

  test("an unresolved policy reference computes nothing rather than falling back", () => {
    const rule = expiryRule({ ...ruleRow, qualifying_activity_policy_ref: "policy:unknown:v1" });
    expect(rule.qualifyingActivity).toBeNull();
  });

  test("an unknown family or verification degrades to the safe value", () => {
    const rule = expiryRule({ ...ruleRow, family: "invented", verification: "maybe" });
    expect(rule.family).toBe("unsupported");
    expect(rule.verification).toBe("needs-rule-verification");
  });

  test("membership keeps its source and an invalid period becomes unknown", () => {
    expect(
      membershipState({
        program_id: "program:synthetic",
        holding_ref: "program:synthetic:member",
        tier: "synthetic-tier",
        valid_json: "{}",
        source: "self-reported",
        evidence_refs_json: "[]",
      }).valid,
    ).toEqual({ kind: "unknown", reasonCode: "stored_membership_period_invalid" });
  });

  test("an offer keeps its integer ratio and its policy references", () => {
    const row: ConversionOfferSqlRow = {
      offer_id: "offer:synthetic",
      version: "v1",
      source_program_ref: "program:a",
      destination_program_ref: "program:b",
      from_unit_ref: "points:a",
      to_unit_ref: "points:b",
      ratio_numerator: "1",
      ratio_denominator: "2",
      minimum_coefficient: "1000",
      minimum_scale: 0,
      increment_coefficient: "1000",
      increment_scale: 0,
      maximum_per_request_coefficient: null,
      maximum_per_request_scale: null,
      shared_quota_ref: "quota:synthetic",
      fixed_fees_json: "[]",
      variable_fee_policy_ref: null,
      eligibility_policy_ref: "policy:eligibility",
      eligible_bucket_kinds_json: '["regular","invented"]',
      eligible_restriction_refs_json: "[]",
      eligible_tiers_json: null,
      valid_time_json: "{}",
      application_deadline_json:
        '{"kind":"local-date","value":"2027-01-31","zone":null,"basis":"provider"}',
      processing_policy_ref: "policy:processing",
      processing_days: 3,
      rounding_policy_ref: "policy:rounding",
      rounding_scale: 0,
      rounding_mode: "down",
      cancellation_policy_ref: null,
      evidence_refs_json: "[]",
      verification: "verified",
    };
    const offer = conversionOffer(row);
    expect(offer.ratio).toEqual({ numerator: "1", denominator: "2" });
    expect(offer.maximumPerRequest).toBeNull();
    expect(offer.sharedQuotaRef).toBe("quota:synthetic");
    // An unknown bucket kind is dropped rather than widening eligibility.
    expect(offer.eligibleBucketKinds).toEqual(["regular"]);
    expect(offer.validTime).toEqual({ kind: "unknown", reasonCode: "stored_offer_time_invalid" });
  });
});

describe("reward reader", () => {
  const executor = (rows: unknown[]): SqlExecutor => ({
    all: <T>(_sql: string, _args: readonly unknown[]) => Promise.resolve(rows as T[]),
    first: <T>() => Promise.resolve(null as T | null),
  });

  test("only published claims are visible and only the newest per slot is current", () => {
    expect(CURRENT_REWARD_BUCKETS_SQL).toContain("JOIN published_parse_runs");
    expect(CURRENT_REWARD_BUCKETS_SQL).toContain("row_number() OVER(PARTITION BY");
    expect(CURRENT_REWARD_BUCKETS_SQL).toContain("WHERE r.rank=1");
  });

  test("buckets group into one holding and a qualification bucket stays outside it", async () => {
    const reader = createRewardReader(
      executor([
        bucketRow,
        {
          ...bucketRow,
          id: 2,
          bucket_ref: "program:synthetic:slot-1",
          bucket_kind: "qualification",
          quantity_coefficient: "100",
          observed_expiry_json: null,
        },
      ]),
    );
    const result = await reader.holdings({ offset: 0 });
    expect(result.rows).toHaveLength(1);
    const view = result.rows[0]!;
    expect(view.holding.buckets.map((bucket) => bucket.bucketRef)).toEqual([
      "program:synthetic:slot-0",
    ]);
    expect(view.qualification).toHaveLength(1);
    expect(view.qualification[0]!.consumable).toBe(false);
    expect(view.observedAt["program:synthetic:slot-0"]).toBe("2026-09-08T00:00:00.000Z");
    expect(result.coverage).toEqual({
      limit: REWARD_PAGE_LIMIT,
      truncated: false,
      nextOffset: null,
    });
  });

  test("a full page reports truncation and the next bucket-row offset", async () => {
    const rows = Array.from({ length: REWARD_PAGE_LIMIT + 1 }, (_, index) => ({
      ...bucketRow,
      id: index + 1,
      bucket_ref: `program:synthetic:slot-${index}`,
    }));
    const result = await createRewardReader(executor(rows)).holdings({ offset: 0 });
    expect(result.coverage).toEqual({
      limit: REWARD_PAGE_LIMIT,
      truncated: true,
      nextOffset: REWARD_PAGE_LIMIT,
    });
    expect(result.rows[0]!.holding.buckets).toHaveLength(REWARD_PAGE_LIMIT);
  });
});
