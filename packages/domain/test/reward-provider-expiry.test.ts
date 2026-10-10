import { expect, test } from "bun:test";
import {
  validRewardProviderExpiryDisplayMetadata,
  validRewardProviderExpirySection,
  type RewardProviderExpirySection,
} from "../src/reward-expiry-observations.ts";
import { summarizeHolding } from "../src/rewards.ts";
const quantity = (coefficient: string) => ({
  unitRef: "points:j-point",
  value: {
    status: "exact" as const,
    value: { coefficient, scale: 0 },
    normalizationVersion: "decimal-v1",
  },
});
const section: RewardProviderExpirySection = {
  programId: "program:j-point",
  holdingRef: "member",
  parentBucketRef: "total",
  unitRef: "points:j-point",
  coverage: "observed",
  reasonCode: null,
  observedAt: {
    kind: "instant",
    value: "2099-01-01T00:00:00.000Z",
    zone: "UTC",
    basis: "collector",
  },
  sourceFactRefs: ["balance:1"],
  displays: [
    {
      displayRef: "part",
      scope: "holding-subset",
      quantity: quantity("200"),
      expires: { kind: "local-date", value: "2099-12-31", zone: "Asia/Tokyo", basis: "provider" },
      rawLocator: "json:$.total.expiry",
    },
  ],
};
test("provider portion never becomes a second holding bucket or the total deadline", () => {
  expect(validRewardProviderExpirySection(section)).toBe(true);
  const summary = summarizeHolding({
    holdingRef: "member",
    programId: "program:j-point",
    unitRef: "points:j-point",
    buckets: [
      {
        bucketRef: "total",
        programId: "program:j-point",
        holdingRef: "member",
        kind: "unclassified",
        restrictionRefs: [],
        quantity: quantity("1000"),
        observedExpiry: null,
        observedAt: section.observedAt,
        sourceFactRefs: ["balance:1"],
      },
    ],
  });
  expect(
    summary.byKind.map((x) =>
      x.quantity.value.status === "exact" ? x.quantity.value.value : null,
    ),
  ).toEqual([{ coefficient: "1000", scale: 0 }]);
  expect(summary.consumable.value.status).toBe("missing");
  expect(section.displays[0]!.quantity).toEqual(quantity("200"));
});
test("false and unavailable sections do not assert zero or no expiry", () => {
  for (const coverage of ["not-displayed", "unknown"] as const)
    expect(
      validRewardProviderExpiryDisplayMetadata({
        coverage,
        reasonCode:
          coverage === "not-displayed"
            ? "provider_expiry_not_displayed"
            : "provider_expiry_unavailable",
        displays: [],
      }),
    ).toBe(true);
  expect(
    validRewardProviderExpiryDisplayMetadata({
      coverage: "not-displayed",
      reasonCode: null,
      displays: [],
    }),
  ).toBe(false);
  expect(
    validRewardProviderExpiryDisplayMetadata({
      coverage: "unknown",
      reasonCode: "provider_expiry_unavailable",
      displays: section.displays,
    }),
  ).toBe(false);
});
test("closed fields, scope, units, duplicate slots, invalid dates and policy dates are refused", () => {
  expect(validRewardProviderExpirySection({ ...section, unexpected: true })).toBe(false);
  expect(
    validRewardProviderExpirySection({
      ...section,
      displays: [...section.displays, ...section.displays],
    }),
  ).toBe(false);
  for (const patch of [
    { scope: "whole-holding" },
    { quantity: { ...quantity("2"), unitRef: "JPY" } },
    { expires: { kind: "local-date", value: "2099-02-30", zone: "Asia/Tokyo", basis: "provider" } },
    { expires: { kind: "local-date", value: "2099-12-31", zone: "Asia/Tokyo", basis: "assumed" } },
  ])
    expect(
      validRewardProviderExpirySection({
        ...section,
        displays: [{ ...section.displays[0], ...patch }],
      }),
    ).toBe(false);
});
test("unknown expiry and missing quantity remain typed unknown and missing", () =>
  expect(
    validRewardProviderExpirySection({
      ...section,
      displays: [
        {
          ...section.displays[0],
          quantity: {
            unitRef: "points:j-point",
            value: { status: "missing", reasonCode: "provider_quantity_unavailable" },
          },
          expires: { kind: "unknown", reasonCode: "provider_expiry_unparsed" },
        },
      ],
    }),
  ).toBe(true));
