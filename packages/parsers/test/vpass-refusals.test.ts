// Fail-closed pins for the Vpass statement-page parser (ADR 0004: refuse
// rather than guess). Inputs are synthetic mutations of the anonymous
// fixtures under tests/fixtures/observation-pipeline/vpass-parser-boundaries.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vpassStatementPage } from "../src/parsers/vpass.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

type Root = {
  header: Record<string, unknown>;
  body: { content: Record<string, Record<string, unknown>> };
};
const fixture = (name: "web" | "customized"): Root =>
  JSON.parse(
    readFileSync(join(FIXTURES_ROOT, "vpass-parser-boundaries", `${name}.json`), "utf8"),
  ) as Root;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function meta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "vpass",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "statement-page",
    url: null,
    mime: "application/json",
    artifactKey: "months/202608/top-000.json",
    fetchUnitKey: "card-001",
    fetchedAt: "2026-08-30T00:00:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

const parse = (value: unknown, overrides: Partial<ArtifactMeta> = {}) =>
  vpassStatementPage.parse(encode(value), meta(overrides));
const webBean = (root: Root) => root.body.content["WebMeisaiTopDisplayServiceBean"]!;
const customizedBean = (root: Root) => root.body.content["CustomizedMeisaiAnsDisplayServiceBean"]!;

// A web row whose metadata agrees with its data cells.
const webRow = (data: string[]) => ({
  columnsSize: data.length,
  columnsSizeS: String(data.length),
  data,
  maxIndex: String(data.length - 1),
  rowType: data[0],
  shiharaiPatternFlag: 0,
});
const withWebRows = (...rows: unknown[]) => {
  const root = fixture("web");
  webBean(root)["meisaiList"] = rows;
  return root;
};
const purchase = (amount: string, subtype = "005") =>
  webRow([
    "4K",
    subtype,
    "",
    "26/08/15",
    "架空商店",
    amount,
    "１",
    ...Array<string>(subtype === "007" ? 7 : 4).fill(""),
  ]);
const withCustomizedRow = (change: Record<string, unknown>) => {
  const root = fixture("customized");
  const rows = customizedBean(root)["meisaiList"] as Record<string, unknown>[];
  customizedBean(root)["meisaiList"] = [{ ...rows[0]!, ...change }];
  return root;
};

describe("vpass statement page envelope and scope", () => {
  test("run, key, card and month preconditions", () => {
    expect(() => parse(fixture("web"), { runStatus: "partial" })).toThrow(
      "successful failure-free fetch run",
    );
    expect(() => parse(fixture("web"), { artifactKey: "months/202608/top-0.json" })).toThrow(
      "artifact key is invalid",
    );
    expect(() => parse(fixture("web"), { fetchUnitKey: "card-1" })).toThrow(
      "fetch unit key is missing or invalid",
    );
    expect(() => parse(fixture("web"), { fetchUnitKey: null })).toThrow(
      "fetch unit key is missing or invalid",
    );
    expect(() =>
      parse(fixture("web"), { artifactKey: "cards/card-002/months/202608/top-000.json" }),
    ).toThrow("card identity does not match its fetch unit");
    for (const month of ["199912", "220001", "202600", "202613"]) {
      expect(() => parse(fixture("web"), { artifactKey: `months/${month}/top-000.json` })).toThrow(
        "statement month is invalid",
      );
    }
    expect(() => parse(fixture("web"), { fetchedAt: "2026-08-30T00:00:00Z" })).toThrow(
      "artifact.fetchedAt must be a canonical UTC instant",
    );
  });

  test("JSON, header and family drift", () => {
    expect(() => vpassStatementPage.parse(new TextEncoder().encode("{"), meta())).toThrow(
      "vpass statement page must be valid JSON",
    );
    expect(() => parse([])).toThrow("vpass statement page must be an object");
    expect(() => parse({ ...fixture("web"), trailer: {} })).toThrow(
      "vpass statement page has schema drift",
    );
    for (const resultCode of [1, "1", "", null]) {
      const root = fixture("web");
      root.header["resultCode"] = resultCode;
      expect(() => parse(root)).toThrow("header.resultCode is not successful");
    }
    for (const resultCode of [0, "0000"]) {
      const root = fixture("web");
      root.header["resultCode"] = resultCode;
      expect(parse(root).observations).toHaveLength(1);
    }
    const root = fixture("web");
    root.header["transitTo"] = "";
    expect(() => parse(root)).toThrow("header.transitTo must be a bounded non-empty string");
    const both = fixture("web");
    both.body.content["CustomizedMeisaiAnsDisplayServiceBean"] = {};
    expect(() => parse(both)).toThrow("exactly one supported family");
    const neither = fixture("web");
    delete neither.body.content["WebMeisaiTopDisplayServiceBean"];
    expect(() => parse(neither)).toThrow("exactly one supported family");
    expect(() => parse(fixture("web"), { artifactKey: "months/202608/answer-001.json" })).toThrow(
      "vpass web page must use a top artifact key",
    );
  });
});

describe("vpass web rows", () => {
  test("row metadata must agree with its data cells", () => {
    for (const change of [
      { rowType: "4C" },
      { columnsSize: 10 },
      { columnsSizeS: "10" },
      { maxIndex: "11" },
    ]) {
      expect(() => parse(withWebRows({ ...purchase("1,234"), ...change }))).toThrow(
        "metadata conflicts with data",
      );
    }
    expect(() => parse(withWebRows({ ...purchase("1,234"), shiharaiPatternFlag: -1 }))).toThrow(
      "shiharaiPatternFlag must be a bounded safe integer",
    );
    expect(() => parse(withWebRows({ ...purchase("1,234"), data: ["4K", 5] }))).toThrow(
      "must contain only bounded strings",
    );
    expect(() => parse(withWebRows({ ...purchase("1,234"), note: "" }))).toThrow(
      "vpass web row 0 has schema drift",
    );
  });

  test("the audited non-transaction subtypes are validated and emit nothing", () => {
    const result = parse(
      withWebRows(
        webRow(["45", "label", "", "", ""]),
        webRow(["4C", "", "label", ""]),
        webRow(["4K", "002", "", "label"]),
      ),
    );
    expect(result.observations).toEqual([]);
    expect(() => parse(withWebRows(webRow(["45", "label", "", ""])))).toThrow(
      "data has schema drift",
    );
    expect(() => parse(withWebRows(webRow(["45", "", "", "", ""])))).toThrow(
      "data[1] must be a bounded non-empty string",
    );
    expect(() => parse(withWebRows(webRow(["4C", "x", "label", ""])))).toThrow(
      "data[1] has schema drift",
    );
    expect(() => parse(withWebRows(webRow(["4C", "", "", ""])))).toThrow(
      "data[2] must be a bounded non-empty string",
    );
    expect(() => parse(withWebRows(webRow(["4K", "002", "", ""])))).toThrow(
      "data[3] must be a bounded non-empty string",
    );
  });

  test("unknown provider subtypes and lengths are refused", () => {
    for (const data of [
      ["4K", "006", "", "", ""],
      ["4L", "005", "", "", ""],
    ]) {
      expect(() => parse(withWebRows(webRow(data)))).toThrow("has an unsupported provider subtype");
    }
    expect(() =>
      parse(withWebRows({ ...purchase("1,234"), ...webRow([...purchase("1").data, ""]) })),
    ).toThrow("vpass web row 0.data has schema drift");
  });

  test("amounts, dates and the installment amount requirement", () => {
    for (const amount of ["1,23", "1.5", "+1", "--1", "1 000"]) {
      expect(() => parse(withWebRows(purchase(amount)))).toThrow("is not an exact JPY integer");
    }
    expect(() => parse(withWebRows(purchase("9007199254740993")))).toThrow(
      "exceeds the safe integer range",
    );
    // An installment row (007) must state its amount; a 005 row may omit it,
    // and the omission is flagged rather than recorded as zero.
    expect(() => parse(withWebRows(purchase("", "007")))).toThrow("data[5] must contain an amount");
    const missing = parse(withWebRows(purchase("")));
    expect(missing.observations[0]).not.toHaveProperty("amountMinor");
    expect(missing.warnings).toEqual([
      "json:$.body.content.WebMeisaiTopDisplayServiceBean.meisaiList[0].data[5] has no provider amount",
    ]);
    // A refund (negative liability) becomes an inflow; zero stays zero.
    const refund = parse(withWebRows(purchase("-1,234"))).observations[0];
    expect(refund?.kind === "transaction" && refund.amountMinor).toBe(1234);
    const zero = parse(withWebRows(purchase("0"))).observations[0];
    expect(zero?.kind === "transaction" && Object.is(zero.amountMinor, 0)).toBe(true);
    for (const date of ["2026/08/15", "26/02/30", "26-08-15"]) {
      const row = purchase("1");
      row.data[3] = date;
      expect(() => parse(withWebRows(row))).toThrow(
        /data\[3\] is not a (provider YY\/MM\/DD|calendar) date/u,
      );
    }
  });
});

describe("vpass customized rows", () => {
  test("page scope, bean and paging fields", () => {
    expect(() =>
      parse(fixture("customized"), { artifactKey: "months/202608/answer-000.json" }),
    ).toThrow("customized page kind conflicts with page index");
    expect(() =>
      parse(fixture("customized"), { artifactKey: "months/202608/top-001.json" }),
    ).toThrow("customized page kind conflicts with page index");
    expect(
      parse(fixture("customized"), { artifactKey: "months/202608/answer-001.json" }).observations,
    ).toHaveLength(2);
    for (const [field, value, message] of [
      ["pageFlg", "1", "customized pageFlg is unsupported"],
      ["pageSize", 0, "customized pageSize must be positive"],
      ["pageSize", "100", "customized pageSize must be a bounded safe integer"],
      ["responseCnt", "02", "responseCnt must be an exact non-negative integer string"],
      ["responseCnt", "10001", "responseCnt must be a bounded exact non-negative integer string"],
      ["total", 10_001, "customized total must be a bounded safe integer"],
      ["seikyuYM", "202607", "statement month conflicts with artifact key"],
      ["meisaiList", {}, "customized meisaiList must be a bounded array"],
      ["unknownFlag", "", "customized bean has schema drift"],
    ] as const) {
      const root = fixture("customized");
      customizedBean(root)[field] = value;
      expect(() => parse(root)).toThrow(message);
    }
    // The audited bean variant without rows is an empty page.
    const empty = fixture("customized");
    delete customizedBean(empty)["meisaiList"];
    expect(parse(empty).observations).toEqual([]);
  });

  test("sale codes must agree with the amount sign", () => {
    expect(() => parse(withCustomizedRow({ uriageKbn: "7" }))).toThrow("uriageKbn is unsupported");
    expect(() => parse(withCustomizedRow({ riyouKin: "-2,000" }))).toThrow(
      "amount conflicts with uriageKbn",
    );
    expect(() => parse(withCustomizedRow({ riyouKin: "0" }))).toThrow(
      "amount conflicts with uriageKbn",
    );
    expect(() => parse(withCustomizedRow({ uriageKbn: "6" }))).toThrow(
      "amount conflicts with uriageKbn",
    );
    expect(() => parse(withCustomizedRow({ riyouKin: "2000.0" }))).toThrow(
      "riyouKin is not an exact JPY integer",
    );
    expect(() => parse(withCustomizedRow({ kmName: "" }))).toThrow(
      "kmName must be a bounded non-empty string",
    );
    expect(() => parse(withCustomizedRow({ zokugara: 0 }))).toThrow(
      "zokugara must be a bounded string",
    );
    expect(() => parse(withCustomizedRow({ riyouDate: "26/13/01" }))).toThrow(
      "riyouDate is not a calendar date",
    );
  });
});
