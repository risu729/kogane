// Fail-closed pins for the Sony Bank history and WALLET parsers (ADR 0004:
// refuse rather than guess). Inputs are synthetic mutations of the anonymous
// fixtures under tests/fixtures/observation-pipeline/sony-bank-parser-boundaries.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sonyBankHistoryCsv,
  sonyBankHistoryJson,
  sonyBankWalletHistory,
} from "../src/parsers/sony-bank.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const DIR = join(FIXTURES_ROOT, "sony-bank-parser-boundaries");
const text = (name: string): string => readFileSync(join(DIR, name), "utf8");
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function meta(dataset: string, overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "sony-bank",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-30T00:00:00.000Z",
    sha256: "0".repeat(64),
    runWindow: { from: "2026-09-01", to: "2026-09-30" },
    ...overrides,
  };
}

describe("sony-bank history JSON pages", () => {
  type Page = Record<string, unknown> & { transactionHistInfo: Record<string, unknown>[] };
  const page = (): Page => JSON.parse(text("yen-history-page-0001.json")) as Page;
  const parse = (value: unknown, dataset = "yen-history-page-0001", overrides = {}) =>
    sonyBankHistoryJson.parse(encode(JSON.stringify(value)), meta(dataset, overrides));
  const withRow = (change: Record<string, unknown>) => {
    const value = page();
    value.transactionHistInfo[0] = { ...value.transactionHistInfo[0]!, ...change };
    return value;
  };

  test("run, media type, dataset and window preconditions", () => {
    expect(parse(page()).observations).toHaveLength(4);
    expect(() => parse(page(), undefined, { runFailureCount: 1 })).toThrow(
      "requires a successful failure-free fetch run",
    );
    expect(() => parse(page(), undefined, { mime: "text/json" })).toThrow(
      "Sony JSON media type drift",
    );
    expect(() => parse(page(), "yen-history-page-0000")).toThrow("history page is out of range");
    expect(() => parse(page(), "foreign-history-jpy-page-0001")).toThrow(
      "history dataset currency is invalid",
    );
    expect(() => parse(page(), "foreign-history-xyz-page-0001")).toThrow(
      "history dataset currency is invalid",
    );
    expect(() => parse(page(), undefined, { runWindow: undefined })).toThrow(
      "history fetch window is missing",
    );
    expect(() =>
      parse(page(), undefined, { runWindow: { from: "2026-09-30", to: "2026-09-01" } }),
    ).toThrow("history fetch window is reversed");
    expect(() =>
      parse(page(), undefined, { runWindow: { from: "2026-09-02", to: "2026-09-30" } }),
    ).toThrow("transactionDt is outside the fetch window");
  });

  test("envelope, provider errors and master data", () => {
    expect(() => parse({ ...page(), errors: [{}] })).toThrow("errors cardinality drift");
    expect(() =>
      parse({ ...page(), responseBizCommon: { bizResult: "1", exceptionRsn: [] } }),
    ).toThrow("bizResult enum drift");
    expect(() => parse({ ...page(), extra: true })).toThrow("schema drift");
    const currencies = page();
    (currencies["currencyMst"] as unknown[]).pop();
    expect(() => parse(currencies)).toThrow("currencyMst cardinality drift");
    const duplicate = page();
    const master = currencies["currencyMst"] as Record<string, unknown>[];
    (duplicate["currencyMst"] as Record<string, unknown>[])[1] = { ...master[0]! };
    expect(() => parse(duplicate)).toThrow("currencyCd duplicated");
    const accounts = page();
    const account = (accounts["ordinaryDepAcInfo"] as Record<string, unknown>[])[0]!;
    account["accountStat"] = "9";
    expect(() => parse(accounts)).toThrow("accountStat enum drift");
  });

  test("row-count drift and truncated pages are refused", () => {
    expect(() => parse({ ...page(), returnCnt: 1 })).toThrow(
      "transactionHistInfo cardinality drift",
    );
    expect(() => parse({ ...page(), countCnt: 3 })).toThrow("history pagination is incomplete");
    expect(() => parse({ ...page(), countCnt: 3_001 })).toThrow(
      "countCnt is above its supported range",
    );
  });

  test("rows: schema, enums, unsigned amounts and dates", () => {
    expect(() => parse(withRow({ memo: "" }))).toThrow("history row schema drift");
    expect(() => parse(withRow({ currencyCd: "XYZ" }))).toThrow("currencyCd enum drift");
    expect(() => parse(withRow({ currencyCd: "USD" }))).toThrow("dataset currency mismatch");
    expect(() => parse(withRow({ additionAndSubtractionSegment: "3" }))).toThrow(
      "additionAndSubtractionSegment enum drift",
    );
    for (const amount of ["-1000", "+1000"]) {
      expect(() => parse(withRow({ transactionAmt: amount }))).toThrow(
        "transactionAmt must be unsigned",
      );
    }
    expect(() => parse(withRow({ transactionAmt: -1000 }))).toThrow(
      "transactionAmt must be unsigned",
    );
    expect(() => parse(withRow({ transactionAmt: "1000.5" }))).toThrow(
      "transactionAmt is not exactly representable in JPY minor units",
    );
    expect(() => parse(withRow({ transactionAftBal: "2,50" }))).toThrow(
      "transactionAftBal must be an exact decimal",
    );
    expect(() => parse(withRow({ transactionDt: "2026/09/31" }))).toThrow(
      "transactionDt is not a calendar date",
    );
    const second = page();
    second.transactionHistInfo[1]!["applicationExchRt"] = "n/a";
    expect(() => parse(second)).toThrow("applicationExchRt must be an exact decimal");
  });
});

describe("sony-bank history CSV", () => {
  const csv = text("yen-history.csv");
  const parse = (value: string | Uint8Array, mime = "text/csv", dataset = "yen-history-csv") =>
    sonyBankHistoryCsv.parse(
      typeof value === "string" ? encode(value) : value,
      meta(dataset, { mime }),
    );

  test("media types and charsets are closed sets", () => {
    expect(parse(csv).observations).toHaveLength(4);
    for (const mime of ["text/html", "text/csv; charset=latin1", "text/csv;"]) {
      expect(() => parse(csv, mime)).toThrow(/media type drift|charset drift/u);
    }
    // A declared UTF-8 charset never falls back to Shift-JIS.
    const sjisHeader = new Uint8Array([0x8e, 0xe6]);
    expect(() => parse(sjisHeader, "text/csv; charset=utf-8")).toThrow("not valid UTF-8");
    // A declared Shift-JIS charset must decode as Shift-JIS.
    expect(() => parse(new Uint8Array([0xfd]), 'text/csv; charset="Shift_JIS"')).toThrow(
      "bytes do not match the declared charset",
    );
  });

  test("header, row width and direction must be exact", () => {
    expect(() => parse(csv.replace("差引残高", "残高"))).toThrow("history CSV header drift");
    expect(() => parse(`${csv}2026/09/03,x,y,JPY,1\n`)).toThrow("history CSV cardinality drift");
    expect(() => parse(`${csv}2026/09/03,x,y,JPY,1,1,2001\n`)).toThrow("direction is ambiguous");
    expect(() => parse(`${csv}2026/09/03,x,y,JPY,,,2001\n`)).toThrow("direction is ambiguous");
    expect(() => parse(`${csv}2026/09/03,x,y,JPY,-1,,2001\n`)).toThrow(
      "CSV amount must be unsigned",
    );
    expect(() => parse(`${csv}2026/09/03,x,y,USD,1,,2001\n`)).toThrow("dataset currency mismatch");
    expect(() => parse(`${csv}2026/09/03,,y,JPY,1,,2001\n`)).toThrow("CSV description is empty");
  });

  test("dates: Japanese and slash forms, never outside the window", () => {
    const result = parse(`${csv}2026年9月3日,x,y,JPY,1,,2001\n`);
    expect(
      result.observations.at(-2)?.kind === "transaction" && result.observations.at(-2)!.asOf,
    ).toBe("2026-09-03");
    expect(() => parse(`${csv}2026年9月31日,x,y,JPY,1,,2001\n`)).toThrow(
      "CSV date is not a calendar date",
    );
    expect(() => parse(`${csv}2026/10/01,x,y,JPY,1,,2001\n`)).toThrow(
      "CSV date is outside the fetch window",
    );
  });

  test("a foreign CSV validates a stated rate and preserves a blank one", () => {
    const foreign =
      "取引日,摘要,参考情報,通貨,預入額,引出額,差引残高,為替レート\n" +
      "2026/09/01,x,y,USD,1.25,,10.00,\n" +
      "2026/09/02,x,y,USD,,0.25,9.75,150.10\n";
    const result = parse(foreign, "text/csv", "foreign-history-usd-csv");
    expect(
      result.observations
        .filter((o) => o.kind === "transaction")
        .map((o) => o.kind === "transaction" && o.amountMinor),
    ).toEqual([125, -25]);
    expect(() =>
      parse(foreign.replace("150.10", "about 150"), "text/csv", "foreign-history-usd-csv"),
    ).toThrow("CSV exchange rate must be an exact decimal");
    expect(() =>
      parse(foreign.replace("1.25", "1.255"), "text/csv", "foreign-history-usd-csv"),
    ).toThrow("CSV amount is not exactly representable in USD minor units");
  });
});

describe("sony-bank WALLET monthly HTML", () => {
  const html = text("wallet-history-2026-09.html");
  const parse = (
    value: string,
    dataset = "wallet-history-202609",
    mime = "text/html; charset=UTF-8",
  ) => sonyBankWalletHistory.parse(encode(value), meta(dataset, { mime }));
  const replaced = (from: string, to: string) => {
    if (!html.includes(from)) throw new Error("mutation target missing");
    return html.replace(from, to);
  };

  test("media type and month selector", () => {
    expect(() => parse(html, undefined, "text/html")).toThrow("WALLET media type drift");
    expect(() => parse(html.replace("W131301.referenceDate", "other"))).toThrow(
      "WALLET month selector drift",
    );
    expect(() =>
      parse(replaced('<option value="20260930">', '<option value="" selected>')),
    ).toThrow("WALLET month placeholder drift");
    for (const option of ['<option value="2026093">', '<option value="20260901">']) {
      expect(() => parse(replaced('<option value="20260831">', option))).toThrow(
        "WALLET month options drift",
      );
    }
    expect(() => parse(replaced('<option value="20260831">', '<option value="20260231">'))).toThrow(
      "WALLET month option is not a calendar date",
    );
    expect(() =>
      parse(
        replaced(
          '<option value="20260930">対象月</option><option value="20260831">',
          '<option value="20260930" selected>対象月</option><option value="20260831" selected>',
        ),
      ),
    ).toThrow("WALLET selected month drift");
    expect(() => parse(html, "wallet-history-202608")).toThrow("WALLET selected month drift");
    // An explicit selection must name the artifact month.
    expect(
      parse(replaced('<option value="20260930">', '<option value="20260930" selected>'))
        .observations,
    ).toHaveLength(1);
    expect(() =>
      parse(replaced('<option value="20260831">', '<option value="20260831" selected>')),
    ).toThrow("WALLET selected month drift");
  });

  test("only the audited empty message counts as an empty month", () => {
    const tableStart = html.indexOf("<table");
    const tableEnd = html.indexOf("</table>") + "</table>".length;
    const without = (middle: string) => html.slice(0, tableStart) + middle + html.slice(tableEnd);
    expect(parse(without("<p>ご利用明細はありません。</p>"))).toEqual({
      observations: [],
      warnings: [],
    });
    expect(() => parse(without("<p>no statement</p>"))).toThrow("WALLET table schema drift");
    expect(() =>
      parse(without("<p>ご利用明細はありません。</p><p>ご利用明細はありません。</p>")),
    ).toThrow("WALLET table schema drift");
  });

  test("table schema, body and row pairing", () => {
    expect(() => parse(replaced("<th>備考</th>", "<th>メモ</th>"))).toThrow(
      "WALLET table schema drift",
    );
    expect(() => parse(replaced("</tbody>", "</tbody><tbody></tbody>"))).toThrow(
      "WALLET table body drift",
    );
    expect(() =>
      parse(replaced("<tr><td>JPY 1200</td>", "<tr><td>x</td><td>JPY 1200</td>")),
    ).toThrow("WALLET transaction cardinality drift");
    expect(() =>
      parse(replaced("<tr><td>JPY 1200</td><td>-</td><td>1</td><td>-</td></tr>", "")),
    ).toThrow("WALLET transaction cardinality drift");
  });

  test("dates, amounts, fees and rates are refused when not exact", () => {
    expect(() => parse(replaced("<td>2026/09/01</td>", "<td>2026/08/31</td>"))).toThrow(
      "WALLET transaction date is outside the selected month",
    );
    expect(() => parse(replaced("<td>2026/09/01</td>", "<td>2026/09/31</td>"))).toThrow(
      "WALLET transaction date is not a calendar date",
    );
    for (const [amount, message] of [
      ["1200", "WALLET transaction amount shape drift"],
      ["XYZ 1200", "WALLET transaction amount currency enum drift"],
      ["JPY 1200.5", "WALLET transaction amount is not exact"],
    ] as const) {
      expect(() =>
        parse(
          replaced(
            "<td>JPY 1200</td><td>-</td><td>-</td>",
            `<td>${amount}</td><td>-</td><td>-</td>`,
          ),
        ),
      ).toThrow(message);
    }
    expect(() =>
      parse(
        replaced(
          "<td>-</td><td>-</td><td>-</td><td>2026/09/02</td>",
          "<td>abc</td><td>-</td><td>-</td><td>2026/09/02</td>",
        ),
      ),
    ).toThrow("WALLET local fee shape drift");
    expect(() =>
      parse(
        replaced(
          "<td>-</td><td>-</td><td>-</td><td>2026/09/02</td>",
          "<td>1,0</td><td>-</td><td>-</td><td>2026/09/02</td>",
        ),
      ),
    ).toThrow("WALLET local fee must be an exact decimal");
    expect(() =>
      parse(replaced("<td>1</td><td>-</td></tr>", "<td>1.2.3</td><td>-</td></tr>")),
    ).toThrow("WALLET exchange rate must be an exact decimal");
    expect(() => parse(replaced("<td>2026/09/02</td>", "<td>確定</td>"))).toThrow(
      "WALLET settlement date has an unsupported value",
    );
  });

  test("an unsigned amount omits the signed value; an explicit sign is kept", () => {
    const unsigned = parse(html);
    expect(unsigned.observations[0]).not.toHaveProperty("amountMinor");
    expect(unsigned.warnings).toEqual([
      "html:table=0,row=0: WALLET amount has no explicit direction; signed amount omitted",
    ]);
    const signed = parse(
      replaced("<td>JPY 1200</td><td>-</td><td>-</td>", "<td>JPY -1,200</td><td>-</td><td>-</td>"),
    );
    expect(signed.warnings).toEqual([]);
    expect(signed.observations[0]).toMatchObject({ amountMinor: -1200, status: "posted" });
    expect(signed.observations[0]?.extra["_kogane"]).toMatchObject({
      direction: "outflow",
      directionOrigin: "provider-explicit-sign",
    });
    const pending = parse(replaced("<td>2026/09/02</td>", "<td>未確定</td>"));
    expect(pending.observations[0]).toMatchObject({ status: "pending" });
    // Without an approval number the identity falls back to the description.
    const noApproval = parse(replaced("<td>SYNTH001</td>", "<td>-</td>"));
    expect(noApproval.observations[0]?.extra["_kogane"]).toMatchObject({
      identityOrigin: "date+description+usage-amount+occurrence",
    });
  });
});
