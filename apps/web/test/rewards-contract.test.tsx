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

// ADR 0049: each READ row also carries the provider's display and the computed
// answer apart. The shared response check still accepts the row; the screen
// renders the basis only after its own exact-key check.
const basisRow = {
  ...page.rows[1]!,
  bucketRef: "bucket:regular",
  bucketKind: "regular",
  state: "partial" as const,
  basis: "provider-observed" as const,
  expiryBasis: {
    displayed: {
      value: { kind: "local-date", value: "2026-12-31", zone: "Asia/Tokyo", basis: "provider" },
      observedAt: {
        kind: "instant",
        value: "2026-09-01T00:00:00.000Z",
        zone: "UTC",
        basis: "collector",
      },
      sourceFactRefs: ["balance:41"],
    },
    computed: {
      status: "unavailable",
      value: null,
      reasonCode: "no_qualifying_activity_observed",
      rule: {
        ruleRef: "rule:synthetic:inactivity@v2",
        ruleId: "rule:synthetic:inactivity",
        version: "v2",
        family: "inactivity",
        verification: "verified",
        validPeriod: {
          kind: "period",
          start: "2026-01-01",
          end: "2030-12-31",
          endExclusive: false,
          zone: "Asia/Tokyo",
          granularity: "day",
        },
        evidenceRefs: ["docs/sources/synthetic.md#terms"],
        qualifyingActivityPolicyRef: "policy:synthetic:qualifying-activity:v1",
        deadlineCalendar: { zone: "Asia/Tokyo", dayBoundary: "end-of-day", zoneBasis: "assumed" },
      },
      activity: {
        windowRef: "window:synthetic:unclassified",
        completeness: "unknown",
        earliestObserved: null,
        anchorActivityRef: null,
        anchorDate: null,
      },
      membership: null,
      uncertaintyCodes: ["deadline_zone_assumed", "history_completeness_unknown"],
      release: "reward-expiry-v1",
    },
    agreement: "not-comparable",
  },
};

test("READ expiry shows the displayed and the computed expiry apart, each with its basis", () => {
  const data = { ...page, rows: [basisRow] } as RewardReadExpiryPage;
  expect(validApiResponse("/api/v2/rewards/expiry", data)).toBe(true);
  const html = renderToStaticMarkup(<RewardExpiryResults data={data} />);
  for (const text of [
    "取得元が表示した期限（観測）",
    "balance:41",
    "規約からの算定（導出）",
    "算定できません",
    "期限延長の対象になる活動を観測できていません",
    "rule:synthetic:inactivity@v2",
    "規約の確認済み",
    "2026-01-01 〜 2030-12-31",
    "docs/sources/synthetic.md#terms",
    "window:synthetic:unclassified",
    "完全性は未確認",
    "対象になる活動なし",
    "照合できません",
    "期限のタイムゾーンは規約に明記がなく、仮置きです",
  ])
    expect(html).toContain(text);
});

test("the shared response check enforces expiryBasis: a malformed basis is refused, null and an older response pass", () => {
  const withBasis = (expiryBasis: unknown) => ({
    ...page,
    rows: [{ ...basisRow, expiryBasis }],
  });
  expect(validApiResponse("/api/v2/rewards/expiry", withBasis(basisRow.expiryBasis))).toBe(true);
  // Not recorded by the build that wrote the row.
  expect(validApiResponse("/api/v2/rewards/expiry", withBasis(null))).toBe(true);
  // A response from an App build before the field existed has no key at all.
  expect(page.rows.every((row) => !("expiryBasis" in row))).toBe(true);
  expect(validApiResponse("/api/v2/rewards/expiry", page)).toBe(true);
  for (const malformed of [
    { ...basisRow.expiryBasis, agreement: "agree", displayed: null },
    { ...basisRow.expiryBasis, computed: { ...basisRow.expiryBasis.computed, reasonCode: null } },
    { ...basisRow.expiryBasis, total: "0" },
    "not-a-basis",
  ])
    expect(validApiResponse("/api/v2/rewards/expiry", withBasis(malformed))).toBe(false);
});

test("a row without a recorded basis, or with a malformed one, says so instead of inventing one", () => {
  for (const expiryBasis of [
    null,
    { ...basisRow.expiryBasis, agreement: "agree", displayed: null },
    { ...basisRow.expiryBasis, computed: { ...basisRow.expiryBasis.computed, reasonCode: null } },
  ]) {
    const data = { ...page, rows: [{ ...basisRow, expiryBasis }] } as RewardReadExpiryPage;
    const html = renderToStaticMarkup(<RewardExpiryResults data={data} />);
    expect(html).toContain("根拠の記録がありません");
    expect(html).not.toContain("規約からの算定（導出）");
  }
  const computed = {
    ...basisRow.expiryBasis.computed,
    status: "date",
    reasonCode: null,
    value: {
      kind: "local-date",
      value: "2027-03-01",
      zone: "Asia/Tokyo",
      basis: "derived",
    },
  };
  const dated = {
    ...page,
    rows: [
      { ...basisRow, expiryBasis: { ...basisRow.expiryBasis, computed, agreement: "disagree" } },
    ],
  } as RewardReadExpiryPage;
  const html = renderToStaticMarkup(<RewardExpiryResults data={dated} />);
  expect(html).toContain("2027-03-01");
  expect(html).toContain("取得元の表示期限と規約からの算定が異なります。両方を表示しています");
});

test("READ expiry displays unclassified dated and undated quantities with the computation block", () => {
  const computed = {
    ...basisRow.expiryBasis.computed,
    reasonCode: "bucket_kind_unclassified",
    activity: null,
    membership: null,
    uncertaintyCodes: [],
  };
  const data: RewardReadExpiryPage = {
    ...page,
    rows: page.rows.map((row) => ({
      ...row,
      bucketKind: "unclassified",
      state: "partial",
      quantity: page.rows[1]!.quantity,
      reasonCodes: ["bucket_kind_unclassified"],
      expiryBasis: {
        ...basisRow.expiryBasis,
        displayed:
          row.providerObserved === null
            ? null
            : {
                ...basisRow.expiryBasis.displayed,
                value: row.providerObserved,
              },
        computed,
      } as RewardReadExpiryPage["rows"][number]["expiryBasis"],
    })),
  };
  expect(validApiResponse("/api/v2/rewards/expiry", data)).toBe(true);
  const html = renderToStaticMarkup(<RewardExpiryResults data={data} />);
  for (const text of [
    "種類未確認",
    "123.45",
    "points:synthetic",
    "2026-12-31",
    "期限未確認",
    "ポイントの種類が未確認",
    "算定できません",
    "balance:41",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("資格指標");
  expect(
    validApiResponse("/api/v2/rewards/expiry", {
      ...data,
      rows: [{ ...data.rows[0], bucketKind: "future-provider-enum" }],
    }),
  ).toBe(false);
});

test("provider subset sections render separately, including not-displayed and unknown state", () => {
  const section = {
    programId: "program:j-point",
    holdingRef: "holding:conn",
    parentBucketRef: "total",
    unitRef: "points:j-point",
    observedAt: { kind: "unknown" as const, reasonCode: "synthetic_time" },
    sourceFactRefs: ["balance:1"],
    coverage: "observed" as const,
    reasonCode: null,
    displays: [
      {
        displayRef: "portion",
        scope: "holding-subset" as const,
        quantity: {
          unitRef: "points:j-point",
          value: {
            status: "exact" as const,
            value: { coefficient: "200", scale: 0 },
            normalizationVersion: "decimal-v1",
          },
        },
        expires: {
          kind: "local-date" as const,
          value: "2099-12-31",
          zone: "Asia/Tokyo",
          basis: "provider" as const,
        },
        rawLocator: "json:$.total.expiry",
      },
    ],
  };
  const displayPage: RewardReadExpiryPage = {
    ...page,
    rows: [],
    providerDisplaySections: [section],
  };
  expect(validApiResponse("/api/v2/rewards/expiry", displayPage)).toBe(true);
  const html = renderToStaticMarkup(<RewardExpiryResults data={displayPage} />);
  expect(html).toContain("失効予定の部分量");
  expect(html).toContain("200");
  expect(html).toContain("2099-12-31");
  expect(html).toContain("保有ポイントのうち、取得元が失効予定として表示した分です");
  expect(html).toContain("合計残高へは加算しません");
  expect(html).toContain("J-POINT");
  expect(html).not.toContain("1200");
  for (const coverage of ["not-displayed", "unknown"] as const) {
    const response = {
      ...displayPage,
      providerDisplaySections: [
        {
          ...section,
          coverage,
          reasonCode:
            coverage === "not-displayed"
              ? ("provider_expiry_not_displayed" as const)
              : ("provider_expiry_unavailable" as const),
          displays: [],
        },
      ],
    };
    expect(validApiResponse("/api/v2/rewards/expiry", response)).toBe(true);
    const absent = renderToStaticMarkup(<RewardExpiryResults data={response} />);
    expect(absent).toContain("期限未確認");
    expect(absent).not.toContain("有効期限なし");
  }
});
