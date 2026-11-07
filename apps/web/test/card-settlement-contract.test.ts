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
  test("the provider-stated debit account carries exactly its outcome's values (ADR 0032)", () => {
    const named = {
      outcome: "names_other_account",
      reason: null,
      policy: "card-debit-account-statement-v3",
      bankSourceId: "smbc-bank",
      bankSourceAccount: "synthetic-bank",
      visibleDigitCount: 4,
      recordedAt: "2026-09-12T00:00:00Z",
    };
    const unnamed = {
      policy: null,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
      recordedAt: null,
    };
    const with_ = (debitAccount: unknown, sourceId = "myjcb") => {
      const value = page();
      Object.assign(value.items[0]!, { debitAccount });
      Object.assign(value.items[0]!.facts.statement, { sourceId });
      return validApiResponse(path, value);
    };
    // The fixture is a MyJCB review the lanes have not reached.
    expect(page().items[0]!.debitAccount.outcome).toBe("not_recorded");
    for (const accepted of [
      named,
      { ...named, outcome: "supports" },
      {
        ...named,
        outcome: "not_proposed",
        reason: "ambiguous_accounts",
        bankSourceId: null,
        bankSourceAccount: null,
        visibleDigitCount: null,
      },
      { outcome: "statement_refused", reason: "card_information_absent", ...unnamed },
      { outcome: "statement_refused", reason: "raw_object_unreadable", ...unnamed },
      { outcome: "not_recorded", reason: null, ...unnamed },
    ])
      expect(with_(accepted)).toBe(true);
    expect(
      with_(
        { outcome: "not_stated_by_source", reason: "source_states_no_debit_account", ...unnamed },
        "vpass",
      ),
    ).toBe(true);
    for (const rejected of [
      undefined,
      { ...named, reason: "ambiguous_accounts" },
      { ...named, bankSourceId: null },
      { ...named, visibleDigitCount: 0 },
      { ...named, recordedAt: null },
      { ...named, extra: true },
      {
        outcome: "not_proposed",
        reason: "invented_reason",
        ...unnamed,
        policy: "p",
        recordedAt: "t",
      },
      { outcome: "statement_refused", reason: "ambiguous_accounts", ...unnamed },
      { outcome: "not_recorded", reason: "card_information_absent", ...unnamed },
      { outcome: "unknown", reason: null, ...unnamed },
      // Only a Vpass statement states no debit account, and a Vpass one never names one.
      { outcome: "not_stated_by_source", reason: "source_states_no_debit_account", ...unnamed },
    ])
      expect(with_(rejected)).toBe(false);
    expect(with_(named, "vpass")).toBe(false);
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
  test("only the named UI route opens the candidate review", () => {
    expect(matchRoute("/reconciliation")).toEqual({ name: "reconciliation" });
    expect(matchRoute("/reconciliation/arbitrary")).toMatchObject({ name: "notFound" });
  });
});
