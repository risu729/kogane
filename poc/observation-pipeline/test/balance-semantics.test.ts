import { expect, test } from "bun:test";
import {
  classifyBalance,
  projectBalanceRows,
  validBalanceInterpretation,
  type BalanceProjectionInput,
} from "../shared/balance-semantics";
import { resolveFinancialProduct } from "../shared/financial-products";

function row(
  id: number,
  section = id === 1 ? "debitAccountDetails" : "savingsDetails",
): BalanceProjectionInput {
  const origin = {
    id,
    parseRunId: 10,
    artifactId: 20,
    asOf: "2026-09-08T00:00:00Z",
    observedAt: "2026-09-08T00:00:00Z",
    rawLocator: `json:$.responseParam.${section}[0].balance`,
    parserName: "sbi-shinsei-yen-deposit-account",
  };
  return {
    ...origin,
    sourceId: "sbi-shinsei-bank",
    sourceAccount: "sbi-shinsei:SYNTHETIC",
    metric:
      section === "debitAccountDetails"
        ? "yen_deposit_account_balance"
        : "yen_deposit_savings_balance",
    accountReference: "source-ref:synthetic",
    accountTarget: null,
    currency: "JPY",
    amountMinor: "900719925474099300",
    amountText: "900719925474099300",
    product: resolveFinancialProduct({
      ...origin,
      kind: "balance",
      sourceId: "sbi-shinsei-bank",
      dataset: "yen-deposit-account",
      sourceAccount: "sbi-shinsei:SYNTHETIC",
      currency: "JPY",
      subject: null,
      extra: {
        accountNo: "SYNTHETIC",
        productCode: "601",
        currency: "JPY",
        _kogane: { sourceView: section, productCode: "601" },
      },
    }),
  };
}
test("billing amounts are statements, never unpaid debt or summable assets", () => {
  expect(
    classifyBalance({
      sourceId: "myjcb",
      parserName: "myjcb-credit-past-month-balances",
      metric: "credit_statement_payment_amount",
      sourceAccount: "myjcb:synthetic:root",
    }),
  ).toMatchObject({ kind: "statement", label: "請求額", netAssetEligible: false });
  expect(
    classifyBalance({
      sourceId: "other",
      parserName: "myjcb-credit-past-month-balances",
      metric: "credit_statement_payment_amount",
      sourceAccount: "unknown",
    }).kind,
  ).toBe("other");
});
test("source audit separates explicit deposits, gross totals, rewards, limits and unsupported sources", () => {
  const cases = [
    ["sbi-shinsei-bank", "sbi-shinsei-yen-deposit-account", "yen_deposit_account_balance", "asset"],
    ["smbc-bank", "smbc-direct-balance", "account_balance", "asset"],
    ["sony-bank", "sony-bank-history-json", "available_after_transaction", "asset"],
    ["sony-bank", "sony-bank-gross-balance", "gross_asset_balance", "aggregate"],
    ["sony-bank", "sony-bank-gross-balance", "gross_loan_balance", "aggregate"],
    ["sbi-securities", "sbi-foreign-cash-balances", "keep_cash", "asset"],
    ["sbi-securities", "sbi-foreign-cash-balances", "buy_possible_amount", "other"],
    ["sbi-vc-trade", "sbi-vc-cash-balances", "cash_balance", "asset"],
    ["sbi-vc-trade", "sbi-vc-account-margin", "withdrawal_limit", "other"],
    ["v-point", "v-point-balance-info", "available_point_bucket", "asset"],
    ["v-point", "v-point-smfg-point", "displayed_point_balance", "period_total"],
    ["v-point-pay", "v-point-pay-notification-event", "prepaid_balance_after_event", "asset"],
    ["moneyforward", "moneyforward-monthly", "balance", "other"],
    ["vpass", "vpass", "balance", "other"],
    ["global-pass", "global-pass-activity", "balance", "other"],
  ];
  for (const [sourceId, parserName, metric, kind] of cases)
    expect(
      classifyBalance({
        sourceId: sourceId!,
        parserName: parserName!,
        metric: metric!,
        sourceAccount: "synthetic",
      }),
    ).toMatchObject({ kind, netAssetEligible: false });
  expect(
    classifyBalance({
      sourceId: "mobile-suica",
      parserName: "mobile-suica-sf-history",
      metric: "sf_balance_after_transaction",
      sourceAccount: "mobile-suica:sf",
    }),
  ).toMatchObject({ kind: "asset", netAssetEligible: false });
});
test("exact complementary Shinsei rows project once and retain both B observations without mutation", () => {
  const rows = [row(1), row(2)];
  const before = JSON.stringify(rows);
  const groups = projectBalanceRows(rows);
  expect(groups.length).toBe(1);
  expect(groups[0]!.members).toEqual(rows);
  expect(groups[0]!.evidence.map((e) => [e.id, e.metric])).toEqual([
    [1, "yen_deposit_account_balance"],
    [2, "yen_deposit_savings_balance"],
  ]);
  expect(groups[0]!.duplicateCount).toBe(1);
  expect(groups[0]!.conflict).toBe(false);
  expect(JSON.stringify(rows)).toBe(before);
});
test("exact BigInt comparison never merges distinct large values, nulls, malformed or disagreeing texts", () => {
  for (const patch of [
    { amountMinor: "900719925474099301" },
    { amountMinor: null },
    { amountMinor: "9e17" },
    { amountMinor: "9".repeat(129) },
    { amountText: "different" },
  ]) {
    const groups = projectBalanceRows([row(1), { ...row(2), ...patch }]);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g.conflict && g.duplicateCount === 0)).toBe(true);
  }
  expect(
    projectBalanceRows([row(1), { ...row(2), amountMinor: "0900719925474099300" }]).length,
  ).toBe(1);
});
test("scope, time, lineage, current product and identity mismatches never merge", () => {
  const original = row(2);
  for (const patch of [
    { accountReference: "another" },
    { accountReference: null },
    { accountTarget: "another" },
    { sourceAccount: "another" },
    { sourceId: "sony-bank" },
    { currency: "USD" },
    { artifactId: 21 },
    { parseRunId: 11 },
    { observedAt: null },
    { asOf: null },
    { rawLocator: "json:$.responseParam.productDetails[0].balance" },
    { product: null },
    { product: { ...original.product!, resolverVersion: "future" } },
    { product: { ...original.product!, origin: { ...original.product!.origin, id: 77 } } },
  ]) {
    const groups = projectBalanceRows([row(1), { ...original, ...patch }]);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => !g.conflict)).toBe(true);
  }
  expect(projectBalanceRows([row(1), row(2, "debitAccountDetails")]).length).toBe(2);
  const ambiguous = projectBalanceRows([row(1), row(2), row(3)]);
  expect(ambiguous.length).toBe(3);
  expect(ambiguous.every((g) => g.conflict)).toBe(true);
});
test("interpretation wire bounds preserve exact evidence and conflict invariants", () => {
  const value = {
    policyVersion: "balance-view-v1",
    semantic: classifyBalance(row(1)),
    evidence: [
      { id: 1, metric: "yen_deposit_account_balance" },
      { id: 2, metric: "yen_deposit_savings_balance" },
    ],
    duplicateCount: 1,
    conflict: false,
  };
  expect(validBalanceInterpretation(value)).toBe(true);
  for (const invalid of [
    null,
    {},
    { ...value, policyVersion: "future" },
    { ...value, policyVersion: ["financial-measures-v2"] },
    { ...value, semantic: { ...value.semantic, measurementKind: ["balance"] } },
    { ...value, semantic: { ...value.semantic, assetClass: {} } },
    { ...value, conflict: true },
    { ...value, duplicateCount: 0 },
    { ...value, semantic: { ...value.semantic, netAssetEligible: true } },
    { ...value, evidence: [value.evidence[0], value.evidence[0]] },
    { ...value, evidence: [] },
    { ...value, evidence: [...value.evidence, { id: 3, metric: "third" }] },
  ])
    expect(validBalanceInterpretation(invalid)).toBe(false);
  expect(() => projectBalanceRows(Array.from({ length: 10001 }, () => row(1)))).toThrow(
    "balance_projection_row_limit",
  );
});
