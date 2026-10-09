// `buildRewardProjection` numbers rows by rowKey, so the order of the bucket
// input does not change `rowSeq` (the comment on that function). The seeded
// projection test lists rows that happen to already be in rowKey order and
// never reads `rowSeq`. This file uses one synthetic rule and two buckets.
import { describe, expect, test } from "bun:test";
import {
  buildRewardProjection,
  REWARD_EVALUATION_CALENDAR,
  REWARD_PROJECTION_RELEASE,
  type RewardExpiryProjectionRow,
  type RewardProjectionInputContent,
} from "../src/reward-projection.ts";
import type { ExpiryRuleSqlRow, RewardBucketSqlRow } from "../src/rewards.ts";

const PROGRAM = "program:synthetic";
const HOLDING = "holding:synthetic";
const RULE_ID = "rule:synthetic:fixed-lot";
const RULE_VERSION = "v1";

const rule: ExpiryRuleSqlRow = {
  rule_id: RULE_ID,
  version: RULE_VERSION,
  family: "fixed-lot",
  program_id: PROGRAM,
  applicability_json: JSON.stringify({
    bucketKinds: ["regular"],
    tiers: null,
    validPeriod: null,
  }),
  qualifying_activity_policy_ref: null,
  deadline_calendar_ref: "Asia/Tokyo:end-of-day:assumed",
  priority_policy_ref: null,
  evidence_refs_json: '["docs/sources/synthetic.md"]',
  verification: "verified",
};

function bucket(slot: "a" | "b"): RewardBucketSqlRow {
  // id, amount and fact id run opposite to the bucket ref, so a sort on those
  // fields orders `b` before `a`. Only `rowKey` orders `a` before `b`.
  return {
    id: slot === "a" ? 2 : 1,
    program_id: PROGRAM,
    holding_ref: HOLDING,
    bucket_ref: `bucket:${slot}`,
    bucket_kind: "regular",
    restriction_refs_json: "[]",
    unit_ref: "points:synthetic",
    quantity_coefficient: slot === "a" ? "200" : "100",
    quantity_scale: 0,
    quantity_status: "exact",
    observed_expiry_json: null,
    observed_at: "2026-09-01T00:00:00.000Z",
    parse_run_id: 1,
    source_fact_kind: "balance",
    source_fact_id: slot === "a" ? 12 : 11,
    institution_ref: "institution:synthetic",
    program_ref: "synthetic-points",
    source_id: "synthetic",
    program_unit_ref: "points:synthetic",
    holding_kind: "reward-points",
    terms_evidence_refs_json: '["docs/sources/synthetic.md"]',
    release_id: "reward-model-v1",
  };
}

function project(buckets: RewardBucketSqlRow[]): RewardExpiryProjectionRow[] {
  const content: RewardProjectionInputContent = {
    manifest: {
      evaluatedAt: "2026-09-11T00:00:00.000Z",
      evaluationCalendar: REWARD_EVALUATION_CALENDAR,
      promotionRelease: "reward-promotion-v1",
      policyRelease: REWARD_PROJECTION_RELEASE,
      claimsHighWater: 2,
      ruleCount: 1,
      bucketCount: buckets.length,
      membershipCount: 0,
      offerCount: 0,
      simulationCount: 0,
    },
    rules: [rule],
    buckets,
    membership: [],
    offers: [],
    simulations: [],
  };
  return buildRewardProjection(content).estimates;
}

describe("reward projection row order", () => {
  test("rowSeq follows rowKey for either order of the same buckets", () => {
    const forward = project([bucket("a"), bucket("b")]);
    const reversed = project([bucket("b"), bucket("a")]);
    const key = (slot: "a" | "b") => `${HOLDING}|${RULE_ID}@${RULE_VERSION}|bucket:${slot}`;
    const order = (rows: RewardExpiryProjectionRow[]) =>
      rows.map((row) => [row.rowKey, row.rowSeq]);
    expect(order(forward)).toEqual([
      [key("a"), 0],
      [key("b"), 1],
    ]);
    expect(reversed).toEqual(forward);
  });
});
