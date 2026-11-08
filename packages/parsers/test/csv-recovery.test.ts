import { describe, expect, test } from "bun:test";
import { paypayCsv } from "../src/parsers/paypay-csv.ts";
import { sonyBankHistoryCsv } from "../src/parsers/sony-bank.ts";
import { parseCsv, type CsvWarning } from "../src/parsers/util.ts";
import type { ArtifactMeta } from "../src/types.ts";

// All dates, amounts, descriptions and identifiers below are synthetic.
const common: ArtifactMeta = {
  id: 1,
  sourceId: "paypay",
  runStatus: "success",
  runFailureCount: 0,
  dataset: null,
  url: null,
  mime: "text/csv",
  fetchedAt: "2026-09-30T00:00:00Z",
  sha256: "0".repeat(64),
  runWindow: { from: "2026-09-01", to: "2026-09-30" },
};
const examples = [
  {
    parser: paypayCsv,
    meta: common,
    header:
      "取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号",
    row: [
      "2026/09/01 12:00:00",
      "100",
      "",
      "",
      "",
      "",
      "",
      "synthetic",
      "shop",
      "wallet",
      "single",
      "self",
      "id-1",
    ],
    columns: [0, 7, 12],
    followingColumn: 7,
  },
  {
    parser: sonyBankHistoryCsv,
    meta: { ...common, sourceId: "sony-bank", dataset: "yen-history-csv" },
    header: "取引日,摘要,参考情報,通貨,預入額,引出額,差引残高",
    row: ["2026-09-01", "synthetic", "reference", "JPY", "100", "", "200"],
    columns: [0, 2, 6],
    followingColumn: 1,
  },
  {
    parser: sonyBankHistoryCsv,
    meta: { ...common, sourceId: "sony-bank", dataset: "foreign-history-usd-csv" },
    header: "取引日,摘要,参考情報,通貨,預入額,引出額,差引残高,為替レート",
    row: ["2026-09-01", "synthetic", "reference", "USD", "1.00", "", "2.00", "150.00"],
    columns: [0, 2, 7],
    followingColumn: 1,
  },
];

for (const example of examples) {
  describe(`${example.parser.name} ${example.meta.dataset ?? "export"} quote recovery`, () => {
    for (const column of example.columns) {
      for (const finalRow of [false, true]) {
        for (const ending of ["", "\n", "\r\n", "\r"]) {
          test(`unclosed quote in column ${column + 1}, final=${finalRow}, ending=${JSON.stringify(ending)}`, () => {
            const broken = [...example.row];
            broken[column] = `"${broken[column]}`;
            const following = [...example.row];
            following[example.followingColumn] = '"following, ""quoted"" row"';
            const lines = [example.header, example.row.join(","), broken.join(",")];
            if (!finalRow) lines.push(following.join(","), example.row.join(","));
            const result = example.parser.parse(
              new TextEncoder().encode(lines.join("\n") + ending),
              example.meta,
            );
            const transactions = result.observations.filter((row) => row.kind === "transaction");
            expect(transactions.map((row) => row.rawLocator)).toEqual(
              finalRow
                ? ["csv:row=2", "csv:row=3"]
                : ["csv:row=2", "csv:row=3", "csv:row=4", "csv:row=5"],
            );
            expect(result.warnings).toContain(
              `row 3: column ${column + 1}: unclosed CSV quote read literally`,
            );
            const damaged = transactions[1]!;
            const cell =
              example.parser === paypayCsv
                ? (damaged.extra["cells"] as string[])[column]
                : damaged.extra[example.header.split(",")[column]!];
            expect(cell).toBe(`"${example.row[column]}`);
            if (!finalRow) {
              expect(transactions[2]?.description).toBe('following, "quoted" row');
              expect(transactions[3]?.amountMinor).toBe(example.parser === paypayCsv ? -100 : 100);
            }
            if (example.parser === sonyBankHistoryCsv && column !== 2) {
              expect(damaged.amountMinor).toBeUndefined();
              expect(damaged.asOf).toBeUndefined();
              expect(damaged.externalId).toBeUndefined();
              expect(result.warnings).toContain(
                "row 3: malformed CSV row has unreadable values; economics and identity left empty",
              );
            }
          });
        }
      }
      test(`text after a closing quote in column ${column + 1} keeps the row and following rows`, () => {
        const broken = [...example.row];
        broken[column] = '"ab"c';
        const result = example.parser.parse(
          new TextEncoder().encode(
            [example.header, broken.join(","), example.row.join(",")].join("\n"),
          ),
          example.meta,
        );
        const transactions = result.observations.filter((row) => row.kind === "transaction");
        expect(transactions.map((row) => row.rawLocator)).toEqual(["csv:row=2", "csv:row=3"]);
        expect(result.warnings).toContain(
          `row 2: column ${column + 1}: text after closing CSV quote joined to field`,
        );
        const cell =
          example.parser === paypayCsv
            ? (transactions[0]!.extra["cells"] as string[])[column]
            : transactions[0]!.extra[example.header.split(",")[column]!];
        expect(cell).toBe("abc");
      });
    }
  });
}

describe("shared CSV quote boundaries", () => {
  test("well-formed multiline, escaped quotes, commas and CRLF keep their exact values", () => {
    const warnings: CsvWarning[] = [];
    expect(parseCsv('\n"a\r\nb","c,""d""",\r\n"",x,y\r\n', warnings)).toEqual([
      ["a\r\nb", 'c,"d"', ""],
      ["", "x", "y"],
    ]);
    expect(warnings).toEqual([]);
  });
  test("an ambiguous but syntactically valid multiline field retains CSV meaning", () => {
    const warnings: CsvWarning[] = [];
    expect(parseCsv('"a\nb",c', warnings)).toEqual([["a\nb", "c"]]);
    expect(warnings).toEqual([]);
  });
  test("warnings follow logical row numbers even after empty lines and multiline fields", () => {
    const warnings: CsvWarning[] = [];
    expect(parseCsv('\n"a\nb",c\n\n"broken,d\nnext,row', warnings)).toEqual([
      ["a\nb", "c"],
      ['"broken', "d"],
      ["next", "row"],
    ]);
    expect(warnings).toEqual([{ row: 2, column: 1, code: "unclosed_quote" }]);
  });
});
