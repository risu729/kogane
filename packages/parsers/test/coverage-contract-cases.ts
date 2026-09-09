// Synthetic inputs for the parser coverage contract (design review D01).
//
// Every case is built here from code, never from data/. The expected
// observations and warnings of each case were generated once from the parsers
// as they were before they emitted issues and coverage, and are stored in
// fixtures/coverage-contract/expected.json; coverage-contract.test.ts asserts
// that the converted parsers still produce exactly those observations and
// warning strings, and additionally the typed issues and coverage claims.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactMeta, Parser } from "../src/types.ts";
import { sbiAccountAssetsCurrent } from "../src/parsers/sbi-account-assets-current.ts";
import { sbiDomesticCashPositions } from "../src/parsers/sbi-domestic-cash-positions.ts";
import { sbiForeignCashBalances } from "../src/parsers/sbi-foreign-cash-balances.ts";
import { sbiForeignCashPositions } from "../src/parsers/sbi-foreign-cash-positions.ts";
import { sbiShinseiTopBalancesAndActivity } from "../src/parsers/sbi-shinsei-top-balances-and-activity.ts";
import { sbiShinseiYenDepositAccount } from "../src/parsers/sbi-shinsei-yen-deposit-account.ts";
import { sbiVcAccountMargin } from "../src/parsers/sbi-vc-account-margin.ts";
import { sbiVcCashBalances } from "../src/parsers/sbi-vc-cash-balances.ts";
import { sbiVcPositionSummary } from "../src/parsers/sbi-vc-position-summary.ts";
import { smbcDirectBalance } from "../src/parsers/smbc-direct.ts";
import { sonyBankGrossBalance } from "../src/parsers/sony-bank.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const FIXTURES = FIXTURES_ROOT;

export interface ContractCase {
  name: string;
  artifact: ArtifactMeta;
  bytes: Uint8Array;
}
export interface ContractParser {
  parser: Parser;
  cases: ContractCase[];
}

function meta(
  sourceId: string,
  dataset: string,
  overrides: Partial<ArtifactMeta> = {},
): ArtifactMeta {
  return {
    id: 1,
    sourceId,
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:00:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}
const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const fixture = (...path: string[]): Uint8Array => readFileSync(join(FIXTURES, ...path));
const fixtureJson = (...path: string[]): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(fixture(...path))) as Record<string, unknown>;

function cases(
  parser: Parser,
  artifact: ArtifactMeta,
  entries: Record<string, Uint8Array>,
): ContractParser {
  return {
    parser,
    cases: Object.entries(entries).map(([name, bytes]) => ({ name, artifact, bytes })),
  };
}

// ── SBI Securities ────────────────────────────────────────────────────

const page = { hasNextPage: false, pageNum: 1, pageSize: 999 };
const foreignPosition = (element: unknown, pageMeta: unknown = page) =>
  json({ listSecuritiesBalances: { page: pageMeta, securitiesBalances: [element] } });
const foreignBalances = (accounts: unknown[]) =>
  json({ listForeignScheduleCashBalances: { foreignCashBalances: accounts } });
const usdRow = (row: Record<string, unknown>) => ({
  accountKind: "GENERAL",
  currencyCashBalances: [
    {
      currencyCode: "USD",
      foreignScheduleCashBalances: [{ businessDate: "2026-09-07", daysLater: 0, ...row }],
    },
  ],
});

/** Wrapper of the fixed-width MTS payload; the payload itself is built per case. */
function mtsWrapper(payload: string): Record<string, unknown> {
  return {
    accountHash: "a".repeat(40),
    format: "sbi-mts-fixed-width-shift-jis",
    httpStatus: 200,
    payloadBase64: btoa(payload),
    resultCode: "000000",
    trCode: "F2631",
  };
}
// 24 bytes of account prefix/suffix, index 000, totalCount 000, recordCount
// 0000, then the 660-byte empty-result message block.
const MTS_EMPTY = `${" ".repeat(24)}0000000000${" ".repeat(660)}`;

const accountAssets = fixtureJson("sbi-parser-boundaries", "account-assets-current.json");

export const SBI_SECURITIES: ContractParser[] = [
  cases(sbiForeignCashBalances, meta("sbi-securities", "foreign-cash-balances"), {
    "complete-empty": foreignBalances([]),
    "complete-rows": foreignBalances([usdRow({ keepCash: "100.25", buyPossibleAmount: "50" })]),
    "unreadable-container": foreignBalances([
      { accountKind: "GENERAL", currencyCashBalances: { notAn: "array" } },
      null,
    ]),
    "partial-empty": foreignBalances([
      { accountKind: "GENERAL", currencyCashBalances: "missing" },
      {
        accountKind: "NISA",
        currencyCashBalances: [{ currencyCode: "USD", foreignScheduleCashBalances: [] }],
      },
    ]),
    "unknown-fields": foreignBalances([usdRow({ keepCash: "10.00", totalBalance: "999.99" })]),
    "minor-units": foreignBalances([usdRow({ keepCash: "1.001" })]),
    "unreadable-field": foreignBalances([usdRow({ keepCash: "abc", buyPossibleAmount: "5" })]),
  }),
  cases(sbiForeignCashPositions, meta("sbi-securities", "foreign-cash-positions"), {
    "complete-empty": json({ listSecuritiesBalances: { page, securitiesBalances: [] } }),
    "complete-rows": foreignPosition({
      securities: { securitiesCode: "SYN", securitiesName: "Synthetic" },
      market: { marketCode: "XSYN" },
      securitiesQuantity: "3",
      currencyCode: "USD",
      evaluationProfitLoss: { evaluationAmount: "1500", frnEvaluationAmount: "10.50" },
    }),
    "missing-page": foreignPosition(
      { securities: { securitiesCode: "SYN" }, securitiesQuantity: "3", evaluationProfitLoss: {} },
      { ...page, hasNextPage: true },
    ),
    "minor-units": foreignPosition({
      securities: { securitiesCode: "SYN" },
      securitiesQuantity: "1",
      currencyCode: "USD",
      evaluationProfitLoss: { evaluationAmount: "1.5" },
    }),
    "unreadable-row": foreignPosition("not-an-object"),
    "unreadable-quantity": foreignPosition({
      securities: { securitiesCode: "FRAC" },
      securitiesQuantity: 1.5,
      currencyCode: "USD",
      evaluationProfitLoss: {},
    }),
    "missing-code": foreignPosition({
      securitiesQuantity: 1,
      securities: {},
      evaluationProfitLoss: {},
    }),
    "missing-currency": foreignPosition({
      securities: { securitiesCode: "NOCUR" },
      securitiesQuantity: 3,
      evaluationProfitLoss: { frnEvaluationAmount: "1568.40" },
    }),
  }),
  cases(sbiDomesticCashPositions, meta("sbi-securities", "domestic-cash-positions"), {
    "complete-empty": json(mtsWrapper(MTS_EMPTY)),
    "complete-rows": fixture("sbi-parser-boundaries", "domestic-cash-positions.json"),
    "unreadable-container": json(mtsWrapper(MTS_EMPTY.slice(0, 40))),
    "unknown-fields": json({ ...mtsWrapper(MTS_EMPTY), unexpected: true }),
  }),
  cases(sbiAccountAssetsCurrent, meta("sbi-securities", "account-assets-current"), {
    "complete-empty": json({
      summary: null,
      summaryWithoutDeposit: null,
      summaryWithoutIdeco: null,
      summaryWithoutDepositAndIdeco: null,
      summaryDetails: [],
      summaryDetailsWithoutDeposit: [],
      summaryDetailsWithoutIdeco: [],
      summaryDetailsWithoutDepositAndIdeco: [],
    }),
    "complete-rows": fixture("sbi-parser-boundaries", "account-assets-current.json"),
    "unreadable-container": json({ ...accountAssets, summaryDetails: "missing" }),
    "unknown-fields": json({ ...accountAssets, unexpected: true }),
  }),
];

// ── SBI VC Trade ──────────────────────────────────────────────────────

const VC_RUN = ["sbi-vc-trade", "2026-09-07", "run-20260907-synthetic01"] as const;
const vcMeta = {
  sessUpdTime: "2026/09/07 09:00:00",
  status: "OK",
  timestamp: "2026/09/07 09:00:03",
};
const envelope = (body: unknown) => json({ meta: vcMeta, body });
const vcBody = (name: string) =>
  fixtureJson(...VC_RUN, `${name}.json`)["body"] as Record<string, unknown>;
const margin = vcBody("account-margin");

export const SBI_VC: ContractParser[] = [
  cases(sbiVcPositionSummary, meta("sbi-vc-trade", "position-summary"), {
    "complete-empty": envelope({}),
    "complete-rows": fixture(...VC_RUN, "position-summary.json"),
    "unknown-fields": envelope({
      BTC: { "0": { productId: "BTCJPY", totalAmount: "0.5", evaluationPl: "1", extraField: "x" } },
    }),
    "non-string-field": envelope({
      BTC: { "0": { productId: "BTCJPY", totalAmount: 5, evaluationPl: "1" } },
    }),
    "unreadable-container": envelope({ BTC: "missing" }),
  }),
  cases(sbiVcCashBalances, meta("sbi-vc-trade", "cash-balances"), {
    "complete-empty": envelope({ baseCurrencyTotalAmount: "0", list: [] }),
    "complete-rows": fixture(...VC_RUN, "cash-balances.json"),
    "unknown-fields": envelope({
      baseCurrencyTotalAmount: "1",
      list: [
        {
          amount: "1",
          baseCurrencyAmount: "1",
          currency: "JPY",
          fxAccountId: "0",
          noSettlingAmount: "1",
          settlingAmount: "0",
          extraField: "x",
        },
      ],
    }),
    "unreadable-container": envelope({ baseCurrencyTotalAmount: "0", list: "missing" }),
  }),
  cases(sbiVcAccountMargin, meta("sbi-vc-trade", "account-margin"), {
    "complete-empty": envelope({
      ...margin,
      lendingLimitList: [],
      receivedMarginList: [],
      restrictedCommissionList: [],
      restrictedWithdrawalAmountList: [],
      withdrawalLimitList: [],
      withdrawalList: [],
    }),
    "complete-rows": fixture(...VC_RUN, "account-margin.json"),
    "unknown-fields": envelope({ ...margin, extraField: "x" }),
    "unreadable-container": envelope({ ...margin, receivedMarginList: "missing" }),
  }),
];

// ── SBI Shinsei Bank ──────────────────────────────────────────────────

const shinseiTop = fixtureJson(
  "sbi-shinsei-parser-boundaries",
  "top-accounts-balance-and-activity.json",
);
const shinseiYen = fixtureJson("sbi-shinsei-parser-boundaries", "yen-deposit-account.json");
const shinseiTopParam = shinseiTop["responseParam"] as Record<string, unknown>;
const shinseiYenParam = shinseiYen["responseParam"] as Record<string, unknown>;

export const SBI_SHINSEI: ContractParser[] = [
  cases(
    sbiShinseiTopBalancesAndActivity,
    meta("sbi-shinsei-bank", "top-accounts-balance-and-activity"),
    {
      "complete-empty": json({
        header: { adapterResultCode: "0" },
        responseParam: {
          overview: { responseParam: { savingsDetails: [] } },
          activity: { responseParam: { activityDetails: [] } },
        },
      }),
      "complete-rows": fixture(
        "sbi-shinsei-parser-boundaries",
        "top-accounts-balance-and-activity.json",
      ),
      "unreadable-container": json({
        ...shinseiTop,
        responseParam: {
          ...shinseiTopParam,
          overview: { responseParam: { savingsDetails: "missing" } },
        },
      }),
      "unknown-fields": json({
        ...shinseiTop,
        responseParam: { ...shinseiTopParam, unexpected: true },
      }),
    },
  ),
  cases(sbiShinseiYenDepositAccount, meta("sbi-shinsei-bank", "yen-deposit-account"), {
    "complete-empty": json({
      header: { adapterResultCode: "0" },
      responseParam: {
        debitAccountDetails: [],
        productDetails: [],
        savingsDetails: [],
        moduleDetails: [],
      },
    }),
    "complete-rows": fixture("sbi-shinsei-parser-boundaries", "yen-deposit-account.json"),
    "unreadable-container": json({
      ...shinseiYen,
      responseParam: { ...shinseiYenParam, debitAccountDetails: "missing" },
    }),
    "unknown-fields": json({
      ...shinseiYen,
      responseParam: { ...shinseiYenParam, unexpected: true },
    }),
  }),
];

// ── Sony Bank and SMBC Direct ─────────────────────────────────────────

const gross = fixtureJson("sony-bank-parser-boundaries", "gross-balance.json");
const smbcBalance = { amount: 12345, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };

export const BANKS: ContractParser[] = [
  cases(sonyBankGrossBalance, meta("sony-bank", "gross-balance"), {
    "complete-rows": fixture("sony-bank-parser-boundaries", "gross-balance.json"),
    // The provider contract fixes the container at 11 asset and 4 loan rows;
    // an empty container is a schema drift, never a complete-empty snapshot.
    "empty-not-representable": json({ ...gross, assetBalAcTypTyp: [] }),
    "unknown-fields": json({ ...gross, unexpected: true }),
  }),
  cases(
    smbcDirectBalance,
    meta("smbc-bank", "balance-normalized", { artifactKey: "balance.normalized.json" }),
    {
      "complete-rows": json(smbcBalance),
      "unreadable-container": json({}),
      "unknown-fields": json({ ...smbcBalance, unexpected: true }),
    },
  ),
];

export const CONTRACT_PARSERS: ContractParser[] = [
  ...SBI_SECURITIES,
  ...SBI_VC,
  ...SBI_SHINSEI,
  ...BANKS,
];
