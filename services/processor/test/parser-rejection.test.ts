// The read-only diagnostic scripts' rejection classifier and replay selection
// (scripts/parser-rejection.ts). Every payload here is synthetic, built from
// the repository's synthetic SBI Shinsei fixtures; SENTINEL strings stand in
// for values so the test can prove no value reaches a category.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { sbiShinseiExchangeRate } from "../../../packages/parsers/src/parsers/sbi-shinsei-exchange-rate.ts";
import { sbiShinseiTopBalancesAndActivity } from "../../../packages/parsers/src/parsers/sbi-shinsei-top-balances-and-activity.ts";
import { sbiShinseiYenDepositAccount } from "../../../packages/parsers/src/parsers/sbi-shinsei-yen-deposit-account.ts";
import type { ArtifactMeta, Parser } from "../../../packages/parsers/src/types.ts";
import {
  classifyParserRejection,
  classifySbiShinseiMessage,
  replaySelectionSql,
  throwSites,
  topActivityShape,
  type RejectionCategory,
} from "../scripts/parser-rejection.ts";
import { LAYER_A_SQL, applyMigration, layerBMigrations, publishParse } from "./harness.ts";

const FIXTURES = new URL(
  "../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/",
  import.meta.url,
);
type Json = Record<string, any>;
function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as Json;
}
function artifact(dataset: string): ArtifactMeta {
  return {
    id: 1,
    sourceId: "sbi-shinsei-bank",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:02:00.000Z",
    sha256: "0".repeat(64),
  };
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Parse, expect a refusal, and return the category the scripts would print. */
function refusal(
  parser: Parser,
  dataset: string,
  input: Uint8Array,
  meta: ArtifactMeta = artifact(dataset),
): RejectionCategory {
  let thrown: unknown;
  try {
    parser.parse(input, meta);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const category = classifyParserRejection(parser.name, thrown);
  // No value reaches a category: not the sentinels, not a digit of an
  // amount or date. (A reason that dropped a currency code is proved by the
  // cases' exact expectations.)
  // `UTF-8` is the one fixed reason text with a digit.
  expect(JSON.stringify(category).replaceAll("UTF-8", "")).not.toMatch(/SENTINEL|\d/u);
  return category;
}

const TOP = "top-accounts-balance-and-activity";
const T = `${TOP}`;
const OVERVIEW_ROWS = "json:$.responseParam.overview.responseParam.savingsDetails[]";
const ACTIVITY_ROWS = "json:$.responseParam.activity.responseParam.activityDetails[]";
function top(mutate: (root: Json) => void): RejectionCategory {
  const root = fixture(TOP);
  mutate(root);
  return refusal(sbiShinseiTopBalancesAndActivity, TOP, encode(root));
}
const activity = (root: Json): Json => root["responseParam"].activity.responseParam;
const overview = (root: Json): Json => root["responseParam"].overview.responseParam;
const rows = (root: Json): Json["activityDetails"] => activity(root)["activityDetails"];

// [case, mutation, expected category]
const TOP_CASES: [string, (root: Json) => void, RejectionCategory][] = [
  [
    "root key",
    (r) => (r["unexpectedKey"] = 1),
    { reason: "unknown field", label: T, field: "unexpectedKey" },
  ],
  [
    "root header missing",
    (r) => delete r["header"],
    { reason: "missing field", label: T, field: "header" },
  ],
  [
    "root header token",
    (r) => (r["header"].newToken = "SENTINEL"),
    { reason: "unknown field", label: `${T}.header`, field: "newToken" },
  ],
  [
    "result code",
    (r) => (r["header"].adapterResultCode = "SENTINEL"),
    { reason: "response was not successful", label: T },
  ],
  [
    "responseParam type",
    (r) => (r["responseParam"] = ["SENTINEL"]),
    { reason: "expected an object", label: `${T}.responseParam` },
  ],
  [
    "responseParam key",
    (r) => (r["responseParam"].extra = 1),
    { reason: "unknown field", label: `${T}.responseParam`, field: "extra" },
  ],
  [
    "responseParam scalar",
    (r) => (r["responseParam"].sbiHyperYokinFlg = ["SENTINEL"]),
    { reason: "expected a scalar", label: `${T}.responseParam`, field: "sbiHyperYokinFlg" },
  ],
  [
    "timestamp number",
    (r) => (r["responseParam"].systemResponseTime = 20260907090000),
    { reason: "provider timestamp must be a string" },
  ],
  [
    "timestamp format",
    (r) => (r["responseParam"].systemResponseTime = "2026-09-07T09:00:00"),
    { reason: "provider timestamp format is not recognized" },
  ],
  [
    "timestamp calendar",
    (r) => (r["responseParam"].systemResponseTime = "20260231090000"),
    { reason: "provider timestamp is invalid" },
  ],
  [
    "overview wrapper missing",
    (r) => (r["responseParam"].overview = {}),
    { reason: "missing field", label: `${T}.overview`, field: "responseParam" },
  ],
  [
    "overview requestParam",
    (r) => (r["responseParam"].overview.requestParam = "SENTINEL"),
    { reason: "expected an object", label: `${T}.overview.requestParam` },
  ],
  [
    "overview header key",
    (r) => (r["responseParam"].overview.header = { unexpectedKey: 1 }),
    { reason: "unknown field", label: `${T}.overview.header`, field: "unexpectedKey" },
  ],
  [
    "overview errorInfo code",
    (r) => (r["responseParam"].overview.errorInfo = { statusID: "SENTINEL" }),
    { reason: "successful wrapper contains an error", label: `${T}.overview.errorInfo.statusID` },
  ],
  [
    "overview errorInfo message",
    (r) => (r["responseParam"].overview.errorInfo = { statusID: "", statusMessage: "SENTINEL" }),
    {
      reason: "successful wrapper contains an error",
      label: `${T}.overview.errorInfo.statusMessage`,
    },
  ],
  [
    "overview key",
    (r) => (overview(r)["extra"] = "SENTINEL"),
    { reason: "unknown field", label: `${T}.overview.responseParam`, field: "extra" },
  ],
  [
    "overview scalar",
    (r) => (overview(r)["savingsBalance"] = { SENTINEL: 1 }),
    { reason: "expected a scalar", label: `${T}.overview.responseParam`, field: "savingsBalance" },
  ],
  [
    "savings type",
    (r) => (overview(r)["savingsDetails"] = "SENTINEL"),
    { reason: "expected an array", label: `${T}.overview.responseParam.savingsDetails` },
  ],
  [
    "savings bound",
    (r) => (overview(r)["savingsDetails"] = Array.from({ length: 101 }, () => ({}))),
    {
      reason: "cardinality exceeds audited bound",
      label: `${T}.overview.responseParam.savingsDetails`,
    },
  ],
  [
    "savings row type",
    (r) => (overview(r)["savingsDetails"][1] = "SENTINEL"),
    { reason: "expected an object", label: OVERVIEW_ROWS },
  ],
  [
    "savings row missing",
    (r) => delete overview(r)["savingsDetails"][0].productCode,
    { reason: "missing field", label: OVERVIEW_ROWS, field: "productCode" },
  ],
  [
    "savings row scalar",
    (r) => (overview(r)["savingsDetails"][0].yenEqui = ["SENTINEL"]),
    { reason: "expected a scalar", label: OVERVIEW_ROWS, field: "yenEqui" },
  ],
  [
    "savings accountNo",
    (r) => (overview(r)["savingsDetails"][0].accountNo = 12345),
    { reason: "expected a non-empty string", label: `${OVERVIEW_ROWS}.accountNo` },
  ],
  [
    "savings duplicate",
    (r) =>
      (overview(r)["savingsDetails"][1].accountNo = overview(r)["savingsDetails"][0].accountNo),
    { reason: "duplicate provider account identity", label: OVERVIEW_ROWS },
  ],
  [
    "savings currency",
    (r) => (overview(r)["savingsDetails"][0].currency = "jpy"),
    { reason: "invalid provider currency", label: `${OVERVIEW_ROWS}.currency` },
  ],
  [
    "savings productCode",
    (r) => (overview(r)["savingsDetails"][0].productCode = ""),
    { reason: "expected a non-empty string", label: `${OVERVIEW_ROWS}.productCode` },
  ],
  [
    "savings balance",
    (r) => (overview(r)["savingsDetails"][0].balance = "1,23"),
    { reason: "expected an exact decimal", label: `${OVERVIEW_ROWS}.balance` },
  ],
  [
    "savings balance scale",
    (r) => (overview(r)["savingsDetails"][0].balance = "10.5"),
    { reason: "not exactly representable in the currency", label: `${OVERVIEW_ROWS}.balance` },
  ],
  [
    "savings yen equivalent scale",
    (r) => (overview(r)["savingsDetails"][1].yenEqui = "9876.54"),
    { reason: "not exactly representable in the currency", label: `${OVERVIEW_ROWS}.yenEqui` },
  ],
  [
    "activity errorInfo",
    (r) =>
      (r["responseParam"].activity.errorInfo = { statusID: "SENTINEL", statusMessage: "SENTINEL" }),
    { reason: "successful wrapper contains an error", label: `${T}.activity.errorInfo.statusID` },
  ],
  [
    "activity key",
    (r) => (activity(r)["unexpectedKey"] = 1),
    { reason: "unknown field", label: `${T}.activity.responseParam`, field: "unexpectedKey" },
  ],
  [
    "activity missing details",
    (r) => delete activity(r)["activityDetails"],
    { reason: "missing field", label: `${T}.activity.responseParam`, field: "activityDetails" },
  ],
  [
    "activity scalar",
    (r) => (activity(r)["purgeflag"] = {}),
    { reason: "expected a scalar", label: `${T}.activity.responseParam`, field: "purgeflag" },
  ],
  [
    "activity bound",
    (r) => (activity(r)["activityDetails"] = Array.from({ length: 1001 }, () => ({}))),
    {
      reason: "cardinality exceeds audited bound",
      label: `${T}.activity.responseParam.activityDetails`,
    },
  ],
  [
    "window half",
    (r) => delete activity(r)["toDate"],
    { reason: "incomplete activity window", label: `${T}.activity.responseParam` },
  ],
  [
    "window absent with rows",
    (r) => {
      delete activity(r)["toDate"];
      delete activity(r)["fromDate"];
    },
    { reason: "incomplete activity window", label: `${T}.activity.responseParam` },
  ],
  [
    "window date format",
    (r) => (activity(r)["fromDate"] = "SENTINEL"),
    { reason: "invalid date", label: `${T}.activity.responseParam.fromDate` },
  ],
  [
    "window date calendar",
    (r) => (activity(r)["toDate"] = "20260931"),
    { reason: "invalid date", label: `${T}.activity.responseParam.toDate` },
  ],
  [
    "window date number",
    (r) => (activity(r)["fromDate"] = 20260901),
    { reason: "expected a non-empty string", label: `${T}.activity.responseParam.fromDate` },
  ],
  [
    "window reversed",
    (r) => (activity(r)["fromDate"] = "20260930"),
    { reason: "activity window is reversed", label: `${T}.activity.responseParam` },
  ],
  [
    "activity accountNo",
    (r) => delete activity(r)["accountNo"],
    { reason: "expected a non-empty string", label: `${T}.activity.responseParam.accountNo` },
  ],
  [
    "activity currency missing",
    (r) => delete activity(r)["currency"],
    { reason: "expected a non-empty string", label: `${T}.activity.responseParam.currency` },
  ],
  [
    "activity currency",
    (r) => (activity(r)["currency"] = "SENTINEL"),
    { reason: "invalid provider currency", label: `${T}.activity.responseParam.currency` },
  ],
  [
    "current balance",
    (r) => (activity(r)["currentBalance"] = "SENTINEL"),
    {
      reason: "expected an exact decimal",
      label: "json:$.responseParam.activity.responseParam.currentBalance",
    },
  ],
  [
    "row type",
    (r) => (rows(r)[0] = "SENTINEL"),
    { reason: "expected an object", label: ACTIVITY_ROWS },
  ],
  [
    "row key",
    (r) => (rows(r)[0].unexpectedKey = 1),
    { reason: "unknown field", label: ACTIVITY_ROWS, field: "unexpectedKey" },
  ],
  [
    "row missing",
    (r) => delete rows(r)[1].balance,
    { reason: "missing field", label: ACTIVITY_ROWS, field: "balance" },
  ],
  [
    "row scalar",
    (r) => (rows(r)[0].tradeTypeCode = { SENTINEL: 1 }),
    { reason: "expected a scalar", label: ACTIVITY_ROWS, field: "tradeTypeCode" },
  ],
  [
    "row reference",
    (r) => (rows(r)[0].txnReferenceNo = ""),
    { reason: "expected a non-empty string", label: `${ACTIVITY_ROWS}.txnReferenceNo` },
  ],
  [
    "row duplicate",
    (r) => (rows(r)[1].txnReferenceNo = rows(r)[0].txnReferenceNo),
    { reason: "duplicate transaction identity", label: ACTIVITY_ROWS },
  ],
  [
    "row description",
    (r) => (rows(r)[0].description = null),
    { reason: "expected a non-empty string", label: `${ACTIVITY_ROWS}.description` },
  ],
  [
    "row both sides, one zero",
    (r) => (rows(r)[0].credit = "0"),
    { reason: "expected exactly one debit or credit", label: ACTIVITY_ROWS },
  ],
  [
    "row neither side",
    (r) => delete rows(r)[1].credit,
    { reason: "expected exactly one debit or credit", label: ACTIVITY_ROWS },
  ],
  [
    "row signed side",
    (r) => (rows(r)[0].debit = "-1200"),
    { reason: "expected an unsigned side amount", label: `${ACTIVITY_ROWS}.debit` },
  ],
  [
    "row side decimal",
    (r) => (rows(r)[1].credit = "SENTINEL"),
    { reason: "expected an exact decimal", label: `${ACTIVITY_ROWS}.credit` },
  ],
  [
    "row side scale",
    (r) => (rows(r)[0].debit = "1200.5"),
    { reason: "not exactly representable in the currency", label: `${ACTIVITY_ROWS}.debit` },
  ],
  [
    "row side fractional number",
    (r) => (rows(r)[0].debit = 1200.5),
    { reason: "expected an exact decimal", label: `${ACTIVITY_ROWS}.debit` },
  ],
  [
    "row balance",
    (r) => (rows(r)[0].balance = "SENTINEL"),
    { reason: "expected an exact decimal", label: `${ACTIVITY_ROWS}.balance` },
  ],
  [
    "row posting date",
    (r) => (rows(r)[0].postingDate = "SENTINEL"),
    { reason: "invalid date", label: `${ACTIVITY_ROWS}.postingDate` },
  ],
  [
    "row posting date window",
    (r) => (rows(r)[0].postingDate = "20260831"),
    { reason: "outside declared activity window", label: `${ACTIVITY_ROWS}.postingDate` },
  ],
];

describe("SBI Shinsei top balances and activity: one closed category per throw site", () => {
  test("the synthetic fixture itself parses, so every case below isolates one check", () => {
    expect(
      sbiShinseiTopBalancesAndActivity.parse(encode(fixture(TOP)), artifact(TOP)).observations
        .length,
    ).toBeGreaterThan(0);
  });
  for (const [name, mutate, expected] of TOP_CASES)
    test(name, () => expect(top(mutate)).toEqual(expected));
  test("parent run and JSON syntax", () => {
    expect(
      refusal(sbiShinseiTopBalancesAndActivity, TOP, encode(fixture(TOP)), {
        ...artifact(TOP),
        runStatus: "partial",
        runFailureCount: 1,
      }),
    ).toEqual({ reason: "SBI Shinsei observations require a successful failure-free parent run" });
    expect(
      refusal(sbiShinseiTopBalancesAndActivity, TOP, new TextEncoder().encode("{SENTINEL")),
    ).toEqual({ reason: "invalid JSON", label: T });
    // The shared UTF-8 decoder (parsers/util.ts) runs before the parser's own
    // checks, so its refusal is a site of every SBI Shinsei parser.
    for (const [parser, dataset] of [
      [sbiShinseiTopBalancesAndActivity, TOP],
      [sbiShinseiYenDepositAccount, "yen-deposit-account"],
      [sbiShinseiExchangeRate, "exchange-rate"],
    ] as const)
      expect(refusal(parser, dataset, new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual({
        reason: "artifact bytes are not valid UTF-8",
      });
  });
});

describe("SBI Shinsei yen deposit and exchange-rate throw sites", () => {
  const Y = "yen-deposit-account";
  const yen = (mutate: (root: Json) => void) => {
    const root = fixture(Y);
    mutate(root);
    return refusal(sbiShinseiYenDepositAccount, Y, encode(root));
  };
  test("yen deposit", () => {
    expect(
      yen(
        (r) =>
          (r["responseParam"].debitAccountDetails[1] = r["responseParam"].debitAccountDetails[0]),
      ),
    ).toEqual({
      reason: "duplicate provider account identity",
      label: "json:$.responseParam.debitAccountDetails[]",
    });
    expect(yen((r) => (r["responseParam"].tdDetails = [{}]))).toEqual({
      reason: "cardinality exceeds audited bound",
      label: `${Y}.responseParam.tdDetails`,
    });
    expect(
      yen(
        (r) =>
          (r["responseParam"].productDetails[0].tdProductDetail = {
            customerCategoryDetails: [{ customerCategory: ["SENTINEL"], term: [] }],
          }),
      ),
    ).toEqual({
      reason: "expected a scalar",
      label: `${Y}.responseParam.productDetails[].tdProductDetail.customerCategoryDetails[]`,
      field: "customerCategory",
    });
    expect(yen((r) => (r["responseParam"].transactionTime = "SENTINEL"))).toEqual({
      reason: "provider timestamp format is not recognized",
    });
  });
  const X = "exchange-rate";
  const board = (mutate: (root: Json) => void) => {
    const root = fixture(X);
    mutate(root);
    return refusal(sbiShinseiExchangeRate, X, encode(root));
  };
  const RATES = "json:$.responseParam.exchangeRateInformation.responseParam.exchangeRates";
  test("exchange-rate board", () => {
    const info = (r: Json): Json => r["responseParam"].exchangeRateInformation.responseParam;
    expect(board((r) => (info(r)["exchangeRates"] = []))).toEqual({
      reason: "the exchange-rate board is empty",
      label: X,
    });
    // A JPY row is skipped with an issue (1.0.1, ADR 0028); a board left with
    // no quote row is refused, without naming the currency.
    expect(
      board((r) => {
        for (const row of info(r)["exchangeRates"]) row.currency = "JPY";
      }),
    ).toEqual({ reason: "the exchange-rate board has no quote row", label: X });
    // The pair (currency, customerCategory) listed twice; the code is dropped.
    expect(board((r) => (info(r)["exchangeRates"][1].currency = "USD"))).toEqual({
      reason: "the board lists a currency twice in one customerCategory",
      label: `${RATES}[].currency`,
    });
    // The two-digit suffix 1.0.1 assumed is refused by 1.0.2 (ADR 0028,
    // amended) under the category the stored boards showed, without the value.
    expect(board((r) => (info(r)["transactionTime"] = "2099/01/01 00:00:00 01"))).toEqual({
      reason: "provider timestamp format is not recognized",
    });
    expect(board((r) => (r["header"].adapterResultCode = "1"))).toEqual({
      reason: "response was not successful",
      label: X,
    });
    expect(refusal(sbiShinseiExchangeRate, X, new TextEncoder().encode("["))).toEqual({
      reason: "invalid JSON",
      label: X,
    });
  });
});

describe("classifier closure", () => {
  // Every `throw new Error(...)` in the SBI Shinsei parser sources, with each
  // interpolation replaced by a schema-shaped token, must land on a named
  // category: a new throw site without a category fails here.
  const sources = [
    "sbi-shinsei-common.ts",
    "sbi-shinsei-top-balances-and-activity.ts",
    "sbi-shinsei-yen-deposit-account.ts",
    "sbi-shinsei-exchange-rate.ts",
    "sbi-shinsei-balance-summary-and-stage.ts",
    // The shared helpers they import; its one throw is `decodeUtf8`.
    "util.ts",
  ].map((name) =>
    readFileSync(new URL(`../../../packages/parsers/src/parsers/${name}`, import.meta.url), "utf8"),
  );
  const templates = sources.flatMap((source) =>
    [...source.matchAll(/throw new Error\(\s*(`[^`]*`|"[^"]*")/gu)].map((match) => match[1]!),
  );
  test("the parser sources have the throw sites the PR table lists", () => {
    // 19 in common, 8 in the activity parser, 2 in yen deposit, 5 in the
    // board, 2 in the balance summary (ADR 0031), 1 in the shared UTF-8
    // decoder.
    expect(templates).toHaveLength(37);
  });
  test("each throw site maps to a named category, never unclassified", () => {
    for (const template of templates) {
      // A label interpolation becomes a dotted schema path, a text one a word.
      const body = template.slice(1, -1);
      const cut = body.indexOf(": ");
      const message =
        cut < 0
          ? body
          : body.slice(0, cut).replaceAll(/\$\{[^}]+\}/gu, "abc.abc") +
            body.slice(cut).replaceAll(/\$\{[^}]+\}/gu, "abc");
      const category = classifySbiShinseiMessage(message);
      expect(category.reason, template).not.toBe("unclassified");
      expect(category.reason, template).not.toBe("label_unrecognized");
    }
  });
  test("text outside the closed set is refused as a whole", () => {
    expect(classifySbiShinseiMessage("abc: SENTINEL")).toEqual({ reason: "unclassified" });
    expect(classifySbiShinseiMessage("SENTINEL 12,345: invalid date")).toEqual({
      reason: "label_unrecognized",
    });
    expect(classifySbiShinseiMessage("abc: unknown field SENTINEL value")).toEqual({
      reason: "unknown field (field name unrecognized)",
      label: "abc",
    });
    // A provider-chosen key that could carry a value never becomes a field or
    // a label segment: a digit (date, account number, hash) or a currency code.
    for (const key of ["USD", "a20260901", "acct1234567", `k${"0f".repeat(32)}`])
      expect(classifySbiShinseiMessage(`${T}: unknown field ${key}`)).toEqual({
        reason: "unknown field (field name unrecognized)",
        label: T,
      });
    for (const label of [`${T}.USD`, "json:$.a.b1234567", "json:$.rows[1234567].x", "2026-09-01"])
      expect(classifySbiShinseiMessage(`${label}: invalid date`)).toEqual({
        reason: "label_unrecognized",
      });
    expect(
      classifyParserRejection(
        "sony-bank-gross-balance",
        new Error("12,345 JPY: unknown field acct20260901"),
      ),
    ).toEqual({ reason: "unknown field" });
    expect(
      classifyParserRejection("sbi-shinsei-top-balances-and-activity", new TypeError("x")),
    ).toEqual({
      reason: "runtime_TypeError",
    });
    expect(classifyParserRejection("sbi-shinsei-top-balances-and-activity", "SENTINEL")).toEqual({
      reason: "non_error_throw",
    });
    // Other parsers keep the coarse reasons diagnose.ts printed before.
    expect(
      classifyParserRejection("sony-bank-gross-balance", new Error("x: unknown field y")),
    ).toEqual({
      reason: "unknown field",
      field: "y",
    });
  });
});

describe("throw sites", () => {
  test("stack frames only: a frame-shaped provider key in the message is not printed", () => {
    const root = fixture(TOP);
    root["parsers/k.ts:12345:678"] = 1;
    let thrown: unknown;
    try {
      sbiShinseiTopBalancesAndActivity.parse(encode(root), artifact(TOP));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const sites = throwSites(thrown);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(site).toMatch(/^sbi-shinsei-[a-z-]+\.ts:\d+:\d+$/u);
    expect(sites.join()).not.toContain("12345");
    expect(throwSites("SENTINEL")).toEqual([]);
  });
});

describe("top activity shape summary", () => {
  test("counts shape classes and never carries a value", () => {
    const root = fixture(TOP);
    rows(root)[0].credit = "0";
    rows(root)[1].txnReferenceNo = rows(root)[0].txnReferenceNo;
    overview(root)["savingsDetails"][1].accountNo = overview(root)["savingsDetails"][0].accountNo;
    overview(root)["savingsDetails"][1].balance = "1,234.50";
    root["responseParam"].overview.errorInfo = { statusID: "00000", statusMessage: "Success" };
    const shape = topActivityShape(encode(root));
    expect(shape).toEqual({
      json: true,
      systemResponseTime: "digits14",
      overviewErrorInfo: "explicit_success",
      activityErrorInfo: "absent",
      savings: {
        rows: 2,
        repeatedAccountNo: 1,
        repeatedAccountNoAndCurrency: 0,
        accountNo: { non_empty_string: 2 },
        currency: { iso3: 2 },
        productCode: { non_empty_string: 2 },
        balance: { plain_integer: 1, grouped: 1 },
        yenEqui: { plain_integer: 2 },
      },
      activity: {
        rows: 2,
        fromDate: "compact8",
        toDate: "compact8",
        currentBalance: "plain_integer",
        accountNo: "non_empty_string",
        currency: "iso3",
        sides: { both: 1, credit_only: 1 },
        bothSidesOneZero: 1,
        txnReferenceNo: { non_empty_string: 2 },
        repeatedTxnReferenceNo: 1,
        description: { non_empty_string: 2 },
        postingDate: { compact8: 2 },
        debit: { plain_integer: 1, absent: 1 },
        credit: { plain_integer: 2 },
        balance: { plain_integer: 2 },
      },
    });
    expect(JSON.stringify(shape)).not.toMatch(/SYNTHETIC|JPY|USD|\d{3}/u);
    expect(topActivityShape(new TextEncoder().encode("{"))).toEqual({ json: false });
  });
});

describe("replay selection against the migrated CORE schema", () => {
  let mf: Miniflare;
  let db: D1Database;
  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: "export default {fetch(){return new Response('local')}}",
        compatibilityDate: "2026-09-07",
        d1Databases: ["DB"],
      }),
    );
    const binding: unknown = await mf.getD1Database("DB");
    if (!binding || typeof binding !== "object" || !("prepare" in binding))
      throw new Error("missing DB");
    db = binding as D1Database;
    await db.exec(LAYER_A_SQL);
    for (const name of layerBMigrations()) await applyMigration(db, name);
    // id, source, dataset, sha: a sealed successful run with one artifact each.
    const artifacts: [number, string, string, string][] = [
      [1, "sbi-shinsei-bank", TOP, "a".repeat(64)],
      [2, "sbi-shinsei-bank", "yen-deposit-account", "b".repeat(64)],
      [3, "sbi-shinsei-bank", TOP, "a".repeat(64)], // the same bytes as 1
      [4, "sony-bank", "balance", "c".repeat(64)],
      [5, "smbc-bank", "balance", "d".repeat(64)],
      [6, "sbi-shinsei-bank", TOP, "e".repeat(64)],
    ];
    for (const [id, source, dataset, sha] of artifacts)
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO sources VALUES(?,?)").bind(source, source),
        db
          .prepare("INSERT INTO acquisition_sessions(id,external_session_id) VALUES(?,?)")
          .bind(id, `run-${id}`),
        db
          .prepare(
            "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,?,?,'collector-r2-importer',1)",
          )
          .bind(id, source, id),
        db.prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',1,1)").bind(id),
        db.prepare("INSERT OR IGNORE INTO raw_objects VALUES(?,10,?)").bind(sha, sha),
        db
          .prepare(
            "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role) VALUES(?,?,?,?,?,NULL,'application/json',1,1,?,'sanitized_provider_capture')",
          )
          .bind(id, id, source, dataset, `k${id}`, sha),
        db.prepare("INSERT INTO fetch_run_seals(fetch_run_id,sealed_at_ms) VALUES(?,1)").bind(id),
      ]);
    const run = (id: number, parser: string, version: string, status: string) =>
      db
        .prepare(
          "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,error) VALUES(?,?,?,'2026-09-10T00:00:00Z',?,?)",
        )
        .bind(id, parser, version, status, status === "error" ? "parser_rejected" : null)
        .run();
    await run(1, "sbi-shinsei-top-balances-and-activity", "0.1.0", "error");
    await run(1, "sbi-shinsei-top-balances-and-activity", "0.1.1", "error");
    await run(3, "sbi-shinsei-top-balances-and-activity", "0.1.1", "error");
    await run(6, "sbi-shinsei-top-balances-and-activity", "0.1.1", "error");
    await run(2, "sbi-shinsei-yen-deposit-account", "0.1.0", "error");
    const ok = await run(2, "sbi-shinsei-yen-deposit-account", "0.1.1", "ok");
    await publishParse(db, Number(ok.meta.last_row_id));
    await run(4, "sony-bank-gross-balance", "1.0.0", "error");
    await run(5, "smbc-direct-balance", "1.0.0", "error");
    // Starting Miniflare and applying every CORE migration in order is a
    // one-time cost that grows with each migration and crossed the 5 s default
    // hook budget; the budget matches every other schema hook in this suite.
  }, 30_000);
  afterAll(async () => {
    await mf?.dispose();
  });
  const select = async (filter: Parameters<typeof replaySelectionSql>[0]) =>
    (await db.prepare(replaySelectionSql(filter)).all<Record<string, unknown>>()).results;

  test("an exact parser name finds its unpublished failures, one per raw object, newest first", async () => {
    const found = await select({ parser: "sbi-shinsei-top-balances-and-activity" });
    expect(found.map((row) => row["id"])).toEqual([6, 3]);
    expect(found[0]).toMatchObject({
      source_id: "sbi-shinsei-bank",
      dataset: TOP,
      parser_name: "sbi-shinsei-top-balances-and-activity",
      mime: "application/json",
      run_status: "success",
      run_failure_count: 0,
      blob_key: "e".repeat(64),
      byte_size: 10,
    });
  });
  test("a published parse removes its failures; other sources stay out", async () => {
    expect(await select({ parser: "sbi-shinsei-yen-deposit-account" })).toEqual([]);
    expect((await select({})).map((row) => [row["id"], row["parser_name"]])).toEqual([
      [6, "sbi-shinsei-top-balances-and-activity"],
      [4, "sony-bank-gross-balance"],
      [3, "sbi-shinsei-top-balances-and-activity"],
    ]);
    expect((await select({ substring: "sony" })).map((row) => row["id"])).toEqual([4]);
  });
  test("the filter refuses anything but parser-name characters", () => {
    expect(() => replaySelectionSql({ parser: "x' OR '1'='1" })).toThrow(/parser name/u);
    expect(() => replaySelectionSql({ substring: "" })).toThrow(/parser name/u);
  });
});
