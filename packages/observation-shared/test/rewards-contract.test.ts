import { expect, test } from "bun:test";
import { validApiResponse } from "../src/api-validation.ts";
import { validRewardBucketKind } from "../src/reward-contract.ts";

test("unclassified holding quantities remain valid without claiming consumability or qualification", () => {
  const quantity = {
    unitRef: "points:synthetic",
    value: {
      status: "exact",
      value: { coefficient: "12345", scale: 2 },
      normalizationVersion: "decimal-v1",
    },
  };
  const bucket = {
    bucketRef: "bucket:synthetic",
    kind: "unclassified",
    restrictionRefs: [],
    unitRef: quantity.unitRef,
    quantity,
    observedExpiry: null,
    observedAt: {
      kind: "instant",
      value: "2026-01-01T00:00:00.000Z",
      zone: "UTC",
      basis: "collector",
    },
    sourceFactRefs: ["balance:11"],
  };
  const row = {
    programId: "program:synthetic",
    programRef: "synthetic",
    institutionRef: "institution:synthetic",
    sourceId: "source:synthetic",
    holdingRef: "holding:synthetic",
    holdingKind: "reward-points",
    unitRef: quantity.unitRef,
    termsEvidenceRefs: [],
    consumable: {
      unitRef: quantity.unitRef,
      value: { status: "missing", reasonCode: "bucket_kind_unclassified" },
    },
    byKind: [{ kind: "unclassified", quantity, bucketRefs: [bucket.bucketRef] }],
    excluded: [
      { bucketRef: bucket.bucketRef, kind: "unclassified", reasonCode: "bucket_kind_unclassified" },
    ],
    buckets: [bucket],
    qualificationMeasures: [],
    membership: [],
    valueModel: {
      netAssetEligible: false,
      cashLikeRedemptionEstimate: null,
      reasonCode: "offer_missing",
    },
  };
  const response = { rows: [row], coverage: { limit: 1, truncated: false, nextOffset: null } };
  expect(validApiResponse("/api/v2/rewards/holdings", response)).toBe(true);
  for (const kind of ["future-provider-enum", "", null]) {
    expect(validRewardBucketKind(kind)).toBe(false);
    expect(
      validApiResponse("/api/v2/rewards/holdings", {
        ...response,
        rows: [{ ...row, buckets: [{ ...bucket, kind }] }],
      }),
    ).toBe(false);
    expect(
      validApiResponse("/api/v2/rewards/holdings", {
        ...response,
        rows: [{ ...row, byKind: [{ ...row.byKind[0], kind }] }],
      }),
    ).toBe(false);
    expect(
      validApiResponse("/api/v2/rewards/holdings", {
        ...response,
        rows: [{ ...row, excluded: [{ ...row.excluded[0], kind }] }],
      }),
    ).toBe(false);
  }
  expect(validRewardBucketKind("unclassified")).toBe(true);
});
