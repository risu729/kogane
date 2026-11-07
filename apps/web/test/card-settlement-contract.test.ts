import { describe, expect, test } from "bun:test";
import {
  validApiResponse,
  validApiCapabilities,
} from "../../../packages/observation-shared/src/api-validation.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { settlementReview } from "../../../packages/application/test/card-settlement-fixture.ts";
import { clientFeatures } from "../src/capabilities.ts";
import { matchRoute } from "../src/router.tsx";

const path = "/api/v2/reconciliation/card-settlements";
const page = () => ({
  items: [settlementReview()],
  nextOffset: null,
  coverage: {
    scope: "card-statement-bank-debit-candidates",
    completeTransactionHistory: false,
    netAssets: "unknown",
    limit: 50,
  },
});
describe("card settlement HTTP contract", () => {
  test("accepts typed partial figures and rejects missing or invented totals", () => {
    expect(validApiResponse(path, page())).toBe(true);
    const invalid = page();
    Object.assign(invalid.items[0]!.impact, { netWorthDelta: 0 });
    expect(validApiResponse(path, invalid)).toBe(false);
    expect(
      validApiResponse(path, {
        ...page(),
        coverage: { ...page().coverage, completeTransactionHistory: true },
      }),
    ).toBe(false);
    const badAmount = page();
    Object.assign(badAmount.items[0]!.facts.bankDebit.amount, {
      value: { status: "exact", value: { coefficient: "NaN", scale: 0 } },
    });
    expect(validApiResponse(path, badAmount)).toBe(false);
  });
  test("old metadata does not imply the feature and a nonboolean capability is rejected", () => {
    expect(clientFeatures(CENTRAL_STORE_CAPABILITIES).cardSettlementReconciliation).toBe(false);
    expect(
      clientFeatures({ ...CENTRAL_STORE_CAPABILITIES, cardSettlementReconciliation: true })
        .cardSettlementReconciliation,
    ).toBe(true);
    expect(
      validApiCapabilities({ ...CENTRAL_STORE_CAPABILITIES, cardSettlementReconciliation: "true" }),
    ).toBe(false);
    const old = { ...CENTRAL_STORE_CAPABILITIES } as Record<string, unknown>;
    delete old.cardSettlementReconciliation;
    expect(validApiCapabilities(old)).toBe(true);
  });
  test("only the named UI routes open the candidate review", () => {
    expect(matchRoute("/reconciliation")).toEqual({ name: "reconciliation" });
    // One candidate's page takes an id in the API's own `proposalId` rule, nothing else.
    expect(matchRoute("/reconciliation/cs_synthetic-1")).toEqual({
      name: "reconciliationReview",
      proposalId: "cs_synthetic-1",
    });
    for (const path of [
      "/reconciliation/a.b",
      "/reconciliation/a%2Fb",
      `/reconciliation/${"a".repeat(129)}`,
      "/reconciliation/a/b",
    ])
      expect(matchRoute(path)).toMatchObject({ name: "notFound" });
  });
});
