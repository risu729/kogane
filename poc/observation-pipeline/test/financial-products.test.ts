import { expect, test } from "bun:test";
test("Sony audited ordinary history paths identify currency variants without invented names", () => {
  for (const currency of ["JPY", "USD", "CNH", "SEK"])
    for (const csv of [false, true])
      for (const kind of ["transaction", "balance"] as const) {
        const value: FinancialProductInput = {
          ...input(),
          sourceId: "sony-bank",
          parserName: csv ? "sony-bank-history-csv" : "sony-bank-history-json",
          kind,
          dataset: `${currency === "JPY" ? "yen-history" : `foreign-history-${currency.toLowerCase()}`}-${csv ? "csv" : "page-0001"}`,
          sourceAccount: `sony-bank:deposit:${currency}`,
          currency,
          rawLocator: csv
            ? `csv:row=2${kind === "balance" ? ",column=差引残高" : ""}`
            : `json:$.transactionHistInfo[0]${kind === "balance" ? ".transactionAftBal" : ""}`,
          extra: {
            ...(csv
              ? { 通貨: currency }
              : kind === "balance"
                ? { transaction: { currencyCd: currency } }
                : { currencyCd: currency }),
            ...(kind === "transaction"
              ? { _kogane: { sourceView: csv ? "official-csv" : "provider-json" } }
              : {}),
          },
        };
        const claim = resolveFinancialProduct(value);
        expect(claim.status).toBe("identified");
        expect(claim.name).toBe(currency === "JPY" ? "円普通預金" : "外貨普通預金");
        expect(claim.nativeCurrency).toBe(currency);
        expect(validFinancialProductClaim(claim)).toBe(true);
        for (const bad of [
          { ...value, currency: "EUR" },
          { ...value, sourceAccount: "sony-bank:wallet" },
          { ...value, parserName: null },
          { ...value, extra: {} },
          { ...value, sourceAccount: "sony-bank:gross:asset:001" },
          { ...value, dataset: "foreign-history-cny-csv" },
        ])
          expect(resolveFinancialProduct(bad).status).not.toBe("identified");
      }
});
test("Sony WALLET is a debit service, never an underlying deposit or card variant", () => {
  const value: FinancialProductInput = {
    ...input(),
    sourceId: "sony-bank",
    parserName: "sony-bank-wallet-history",
    kind: "transaction",
    dataset: "wallet-history-202609",
    sourceAccount: "sony-bank:wallet",
    rawLocator: "html:table=0,row=1",
    extra: { _kogane: { sourceView: "wallet-monthly-html" } },
  };
  const claim = resolveFinancialProduct(value);
  expect(claim.name).toBe("Sony Bank WALLET");
  expect(claim.nativeCurrency).toBeNull();
  expect(claim.code).toBeNull();
  expect(validFinancialProductClaim(claim)).toBe(true);
  for (const bad of [
    { ...value, kind: "balance" as const },
    { ...value, sourceAccount: "sony-bank:deposit:JPY" },
    { ...value, dataset: "wallet-history-202613" },
    { ...value, extra: {} },
  ])
    expect(resolveFinancialProduct(bad).status).not.toBe("identified");
  expect(
    validFinancialProductClaim({
      ...claim,
      origin: { ...claim.origin, parserName: "sony-bank-history-json" },
    }),
  ).toBe(false);
});
import {
  FINANCIAL_PRODUCTS,
  FINANCIAL_PRODUCT_FAMILIES,
  FINANCIAL_PRODUCT_SOURCES,
  resolveFinancialProduct,
  validFinancialProductClaim,
  type FinancialProductInput,
} from "../shared/financial-products";
function input(
  code = "601",
  currency = "JPY",
  kind: "balance" | "valuation" = "balance",
): FinancialProductInput {
  return {
    parserName: "sbi-shinsei-top-balances-and-activity",
    kind,
    id: 1,
    parseRunId: 2,
    artifactId: 3,
    rawLocator: `json:$.responseParam.overview.responseParam.savingsDetails[0].${kind === "valuation" ? "yenEqui" : "balance"}`,
    sourceId: "sbi-shinsei-bank",
    dataset: "top-accounts-balance-and-activity",
    sourceAccount: "sbi-shinsei:SYNTHETIC_ACCOUNT",
    currency: kind === "valuation" ? "JPY" : currency,
    subject: kind === "valuation" ? currency : null,
    extra: {
      accountNo: "SYNTHETIC_ACCOUNT",
      productCode: code,
      currency,
      _kogane: {
        sourceView: "top_overview",
        productCode: code,
        ...(kind === "valuation" ? { subjectCurrency: currency } : {}),
      },
    },
  };
}
test("separates ordinary, securities-linked and bonus-interest products within the umbrella", () => {
  const claims = ["601", "603", "605"].map((code) => resolveFinancialProduct(input(code)));
  expect(claims.map((c) => c.name)).toEqual([
    "パワーフレックス円普通預金",
    "SBIハイパー預金",
    "ボーナス利息付特別預金（パワー預金）",
  ]);
  expect(new Set(claims.map((c) => c.productId)).size).toBe(3);
  expect(
    claims.every((c) => c.family?.id === "sbi-shinsei:powerflex" && validFinancialProductClaim(c)),
  ).toBe(true);
  expect(FINANCIAL_PRODUCTS.some((p) => p.id === "sbi-shinsei:powerflex")).toBe(false);
});
test("binds all thirteen exact code/currency pairs and retains native currency on yen valuation", () => {
  const currencies = [
    "USD",
    "EUR",
    "CAD",
    "AUD",
    "GBP",
    "NZD",
    "SGD",
    "HKD",
    "ZAR",
    "NOK",
    "CNY",
    "TRY",
    "BRL",
  ];
  for (const [i, currency] of currencies.entries()) {
    const balance = resolveFinancialProduct(input(String(621 + i), currency));
    const valuation = resolveFinancialProduct(input(String(621 + i), currency, "valuation"));
    expect(balance.status).toBe("identified");
    expect(valuation.productId).toBe(balance.productId);
    expect(valuation.nativeCurrency).toBe(currency);
    expect(valuation.family?.id).toBe("sbi-shinsei:powerflex-fx-ordinary");
    expect(validFinancialProductClaim(valuation)).toBe(true);
  }
  expect(resolveFinancialProduct(input("631", "CNH")).status).toBe("conflict");
});
test("never guesses unknown codes, product catalogues, transaction rows or aggregate products", () => {
  for (const value of [
    input("999"),
    { ...input(), dataset: "yen-deposit-account" },
    { ...input(), kind: "transaction" as const },
    { ...input(), sourceAccount: "sbi-shinsei:aggregate" },
    { ...input(), sourceId: "smbc-bank", sourceAccount: "smbc-bank:ordinary-yen" },
    { ...input(), sourceId: "sony-bank", sourceAccount: "sony-bank:gross" },
  ]) {
    const result = resolveFinancialProduct(value);
    expect(result.status).toBe("unresolved");
    expect(result.productId).toBeNull();
    expect(result.name).toBeNull();
    expect(validFinancialProductClaim(result)).toBe(true);
  }
});
test("requires own-row provenance and rejects contradictory duplicated fields", () => {
  const base = input();
  const extra = base.extra as Record<string, unknown>;
  for (const value of [
    { ...base, sourceAccount: "sbi-shinsei:OTHER_ACCOUNT" },
    { ...base, currency: "USD" },
    { ...base, rawLocator: "json:$.responseParam.activity.balance" },
    { ...base, extra: { ...extra, _kogane: { sourceView: "top_overview", productCode: "603" } } },
    {
      ...base,
      extra: { ...extra, _kogane: { sourceView: "top_overview", subjectCurrency: "USD" } },
    },
    { ...input("621", "USD", "valuation"), subject: "JPY" },
    { ...input("621", "USD", "valuation"), currency: "USD" },
  ]) {
    const claim = resolveFinancialProduct(value);
    expect(claim.status).toBe("conflict");
    expect(validFinancialProductClaim(claim)).toBe(true);
  }
  expect(
    resolveFinancialProduct({
      ...base,
      extra: {
        ...extra,
        productCode: undefined,
        _kogane: {
          sourceView: "top_overview",
          productCode: "601",
          providerContext: { productCode: "601" },
        },
      },
    }).status,
  ).toBe("unresolved");
  expect(
    resolveFinancialProduct({
      ...input("621", "USD", "valuation"),
      subject: null,
      extra: {
        accountNo: "SYNTHETIC_ACCOUNT",
        productCode: "621",
        currency: "USD",
        _kogane: { sourceView: "top_overview" },
      },
    }).status,
  ).toBe("unresolved");
});
test("metadata-only valuation subject is accepted only with matching own-row native currency", () => {
  expect(
    resolveFinancialProduct({ ...input("621", "USD", "valuation"), subject: null }),
  ).toMatchObject({ status: "identified", nativeCurrency: "USD" });
});
test("claims preserve origin and use current definitions without leaking extra financial fields", () => {
  const base = input();
  const original = {
    ...base,
    extra: { ...(base.extra as object), balance: "PRIVATE_AMOUNT", _unrelated: "PRIVATE_ACCOUNT" },
  };
  const before = JSON.stringify(original);
  const claim = resolveFinancialProduct(original);
  expect(claim.origin).toEqual({
    parserName: "sbi-shinsei-top-balances-and-activity",
    asOf: null,
    observedAt: null,
    kind: "balance",
    id: 1,
    parseRunId: 2,
    artifactId: 3,
    rawLocator: base.rawLocator,
  });
  expect(claim.temporalBasis).toBe("current-catalogue-no-historical-terms");
  expect(JSON.stringify(claim)).not.toContain("PRIVATE_");
  expect(JSON.stringify(original)).toBe(before);
});
test("network guard rejects invented identities, versions, origins, malformed unions and unbounded evidence", () => {
  const claim = resolveFinancialProduct(input());
  for (const invalid of [
    null,
    [],
    {},
    { ...claim, name: "銀行名だけ" },
    { ...claim, productId: "invented" },
    { ...claim, status: ["identified"] },
    { ...claim, status: "unresolved" },
    { ...claim, catalogueVersion: "old" },
    { ...claim, nativeCurrency: "USD" },
    { ...claim, code: "603" },
    { ...claim, institution: { id: "sbi-shinsei-bank", name: "wrong" } },
    { ...claim, family: null },
    { ...claim, origin: { ...claim.origin, id: -1 } },
    { ...claim, evidence: { ...claim.evidence, sourceIds: [] } },
    {
      ...claim,
      evidence: { ...claim.evidence, fields: Array.from({ length: 100 }, () => "rawLocator") },
    },
  ])
    expect(validFinancialProductClaim(invalid)).toBe(false);
  expect(new Set(FINANCIAL_PRODUCT_SOURCES.map((s) => s.id)).size).toBe(
    FINANCIAL_PRODUCT_SOURCES.length,
  );
  expect(
    FINANCIAL_PRODUCT_FAMILIES.every(
      (f) =>
        FINANCIAL_PRODUCT_FAMILIES.some((parent) => parent.id === f.parentId) ||
        f.parentId === null,
    ),
  ).toBe(true);
});
