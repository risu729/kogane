import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RewardExpiryResults } from "../src/pages/Rewards.tsx";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import type { RewardReadExpiryPage } from "../../../packages/observation-shared/src/reward-contract.ts";

const page: RewardReadExpiryPage = {
  rows: [
    {
      holdingRef: "holding:synthetic",
      programId: "program:synthetic",
      bucketRef: "bucket:unknown",
      bucketKind: "regular",
      ruleRef: "rule:synthetic@v1",
      state: "partial",
      basis: "unknown",
      expiresOn: null,
      quantity: {
        unitRef: "points:synthetic",
        value: { status: "missing", reasonCode: "not_observed" },
      },
      providerObserved: null,
      policyEstimated: null,
      reasonCodes: ["history_incomplete"],
      uncertaintyCodes: [],
      basisRefs: [],
    },
    {
      holdingRef: "holding:synthetic",
      programId: "program:synthetic",
      bucketRef: "bucket:dated",
      bucketKind: "time-limited",
      ruleRef: "rule:synthetic@v1",
      state: "computed",
      basis: "provider-observed",
      expiresOn: "2026-12-31",
      quantity: {
        unitRef: "points:synthetic",
        value: {
          status: "exact",
          value: { coefficient: "12345", scale: 2 },
          normalizationVersion: "decimal-v1",
        },
      },
      providerObserved: {
        kind: "local-date",
        value: "2026-12-31",
        zone: "Asia/Tokyo",
        basis: "provider",
      },
      policyEstimated: null,
      reasonCodes: [],
      uncertaintyCodes: [],
      basisRefs: [],
    },
  ],
  page: { limit: 2, hasMore: true, nextCursor: "opaque-cursor" },
  snapshot: {
    snapshotId: "a".repeat(64),
    evaluatedAt: "2026-09-12T00:00:00.000Z",
    evaluationCalendar: "Asia/Tokyo",
    ruleSetDigest: "b".repeat(64),
    ruleCount: 1,
    claimsRelease: "reward-promotion-v1",
    claimsHighWater: 2,
    release: "reward-policy-v1",
  },
};

test("READ expiry keeps undated buckets, native quantities, snapshot time and partial coverage visible", () => {
  expect(validApiResponse("/api/v2/rewards/expiry", page)).toBe(true);
  const html = renderToStaticMarkup(<RewardExpiryResults data={page} />);
  for (const text of [
    "期限未確認",
    "未確定",
    "123.45",
    "points:synthetic",
    "2026-12-31",
    "取得元の表示",
    "2026-09-12T00:00:00.000Z",
    "残りは取得していません",
    "取得できた履歴が途中から",
  ])
    expect(html).toContain(text);
});

test("reward transport rejects malformed values and dates rather than rendering them", () => {
  for (const change of [
    { expiresOn: "2026-02-30" },
    {
      quantity: {
        unitRef: "points:synthetic",
        value: {
          status: "exact",
          value: { coefficient: "1", scale: -1 },
          normalizationVersion: "decimal-v1",
        },
      },
    },
    { quantity: { unitRef: "points:synthetic", value: { status: "missing" } } },
  ])
    expect(
      validApiResponse("/api/v2/rewards/expiry", {
        ...page,
        rows: [{ ...page.rows[0], ...change }],
      }),
    ).toBe(false);
  expect(validApiResponse("/api/v2/rewards/expiry", { ...page, snapshot: undefined })).toBe(false);
  expect(
    validApiResponse("/api/v2/rewards/holdings", {
      rows: [{}],
      coverage: { limit: 1, truncated: false, nextOffset: null },
    }),
  ).toBe(false);
});

test("legacy expiry remains supported when the READ flag is off", () => {
  const legacy = { rows: [], coverage: { limit: 100, truncated: false, nextOffset: null } };
  expect(validApiResponse("/api/v2/rewards/expiry", legacy)).toBe(true);
  expect(renderToStaticMarkup(<RewardExpiryResults data={legacy} />)).toBe("");
});
