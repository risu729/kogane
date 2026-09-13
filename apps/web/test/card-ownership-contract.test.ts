import { expect, test } from "bun:test";
import { ownershipReview } from "../../../packages/application/test/card-ownership-fixture.ts";
import { validCardOwnershipReview } from "../../../packages/observation-shared/src/card-ownership-contract.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import { matchRoute } from "../src/router.tsx";
test("ownership review wire preserves null mappings and bounded known claims", () => {
  const value = ownershipReview();
  expect(validCardOwnershipReview(value)).toBe(true);
  expect(validApiResponse("/api/v2/reconciliation/card-settlements/ownership", value)).toBe(true);
  expect(validCardOwnershipReview({ ...value, sides: [] })).toBe(false);
  expect(
    validCardOwnershipReview({
      ...value,
      sides: value.sides.map((s) => ({ ...s, ownershipRevision: -1 })),
    }),
  ).toBe(false);
  expect(matchRoute("/reconciliation/card-settlement-synthetic/ownership")).toEqual({
    name: "cardOwnership",
    proposalId: "card-settlement-synthetic",
  });
  expect(matchRoute("/reconciliation/x/ownership/extra").name).toBe("notFound");
});
