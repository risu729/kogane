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
  nextPage: "none",
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
  test("debit-account evidence is typed and a missing one is a reason, never absent", () => {
    const missing = page() as unknown as { items: Record<string, unknown>[] };
    delete missing.items[0]!.debitAccount;
    expect(validApiResponse(path, missing)).toBe(false);
    const statementRef = {
      kind: "typed-claim",
      id: "card_debit_account_statement:7",
      revision: "reader:myjcb-card-information-1.0.0",
    };
    const withEvidence = (debitAccount: Record<string, unknown>) => {
      const value = page();
      Object.assign(value.items[0]!, { debitAccount });
      return validApiResponse(path, value);
    };
    const supports = {
      outcome: "supports",
      reason: null,
      policy: "card-debit-account-statement-v3",
      statementRef,
      bankSourceId: "smbc-bank",
      bankSourceAccount: "smbc-bank:ordinary-yen",
      visibleDigitCount: 4,
      recordedAt: "2026-09-11T00:00:00Z",
    };
    expect(withEvidence(supports)).toBe(true);
    expect(withEvidence({ ...supports, visibleDigitCount: 0 })).toBe(false);
    expect(withEvidence({ ...supports, reason: "no_matching_account" })).toBe(false);
    const notProposed = {
      ...supports,
      outcome: "not_proposed",
      reason: "no_matching_account",
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
    };
    expect(withEvidence(notProposed)).toBe(true);
    expect(withEvidence({ ...notProposed, reason: "invented" })).toBe(false);
    expect(withEvidence({ ...notProposed, statementRef: null })).toBe(false);
    expect(
      withEvidence({
        ...notProposed,
        outcome: "absent",
        reason: "source_has_no_debit_account_statement",
        statementRef: null,
        recordedAt: null,
      }),
    ).toBe(true);
    expect(
      withEvidence({ ...notProposed, outcome: "absent", reason: "evidence_not_recorded" }),
    ).toBe(false);
    // A refused page is absent with the lane's closed refusal code, never a
    // rule reason or an invented code.
    const refused = {
      ...notProposed,
      outcome: "absent",
      reason: "card_information_table_invalid",
      statementRef: null,
      recordedAt: null,
    };
    expect(withEvidence(refused)).toBe(true);
    expect(withEvidence({ ...refused, reason: "raw_object_unreadable" })).toBe(true);
    expect(withEvidence({ ...refused, reason: "no_matching_account" })).toBe(false);
    expect(withEvidence({ ...refused, reason: "card_information_invented" })).toBe(false);
    expect(withEvidence({ ...notProposed, reason: "card_information_table_invalid" })).toBe(false);
  });
  test("the grouped list needs a judged candidate per statement and a count that covers it", () => {
    const grouped = "/api/v2/reconciliation/card-settlements/statements";
    const statements = () => ({
      statements: [
        {
          statementKey: "statement-synthetic",
          candidateCount: 3,
          candidates: [settlementReview()],
          leadSearch: "truncated",
        },
      ],
      nextOffset: null,
      nextPage: "none",
      coverage: {
        ...page().coverage,
        limit: 10,
        candidatesPerStatement: 5,
        olderCandidatesSearched: 200,
      },
    });
    expect(validApiResponse(grouped, statements())).toBe(true);
    for (const change of [
      (value: ReturnType<typeof statements>) => (value.statements[0]!.candidates = []),
      (value: ReturnType<typeof statements>) => (value.statements[0]!.candidateCount = 0),
      (value: ReturnType<typeof statements>) => (value.statements[0]!.statementKey = ""),
      (value: ReturnType<typeof statements>) =>
        Object.assign(value.statements[0]!.candidates[0]!.impact, {
          netWorthDelta: 0,
        }),
      (value: ReturnType<typeof statements>) => (value.coverage.limit = 50),
      (value: ReturnType<typeof statements>) =>
        Object.assign(value.statements[0]!, { leadSearch: "none" }),
      (value: ReturnType<typeof statements>) =>
        Reflect.deleteProperty(value.statements[0]!, "leadSearch"),
      (value: ReturnType<typeof statements>) =>
        Reflect.deleteProperty(value.coverage, "olderCandidatesSearched"),
    ]) {
      const invalid = statements();
      change(invalid);
      expect(validApiResponse(grouped, invalid)).toBe(false);
    }
    // The flat list's shape is not a grouped page, and the other way round.
    expect(validApiResponse(grouped, page())).toBe(false);
    expect(validApiResponse(path, statements())).toBe(false);
    // A page's end carries its closed reason, on either list.
    for (const [target, size, value] of [
      [path, 50, page()],
      [grouped, 10, statements()],
    ] as const)
      for (const [nextOffset, nextPage, valid] of [
        [null, "none", true],
        [null, "budget_exceeded", true],
        [size, "offered", true],
        [null, undefined, false],
        [null, "end", false],
        [null, "offered", false],
        [size, "none", false],
        [size, "budget_exceeded", false],
        [size - 1, "offered", false],
      ] as const)
        expect({
          target,
          nextOffset,
          nextPage,
          valid: validApiResponse(target, { ...value, nextOffset, nextPage }),
        }).toEqual({ target, nextOffset, nextPage, valid });
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
