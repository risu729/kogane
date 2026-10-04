// The GLOBAL PASS half of the read-only replay diagnostics
// (scripts/parser-rejection.ts): one closed code per `global-pass-activity`
// throw site, and the counts-only shape of a stored activity page. Every page
// here is the repository's synthetic fixture or a mutation of it; SENTINEL
// strings stand in for provider text so the test can prove none of it is
// printed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalPassActivity } from "../../../packages/parsers/src/parsers/global-pass-activity-parser.ts";
import type { ArtifactMeta } from "../../../packages/parsers/src/types.ts";
import {
  classifyGlobalPassMessage,
  classifyParserRejection,
  GLOBAL_PASS_REJECTIONS,
  globalPassActivityShape,
  globalPassReplaySelectionSql,
  type RejectionCategory,
} from "../scripts/parser-rejection.ts";

const PARSER = "global-pass-activity";
const FIXTURE = readFileSync(
  new URL(
    "../../../tests/fixtures/observation-pipeline/global-pass/activity-2099-02.html",
    import.meta.url,
  ),
  "utf8",
);
const SOURCE = readFileSync(
  new URL("../../../packages/parsers/src/parsers/global-pass-activity.ts", import.meta.url),
  "utf8",
);
const encode = (html: string) => new TextEncoder().encode(html);
function meta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "global-pass",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "globalpass-activity",
    artifactKey: "activity-2099-02.html",
    url: null,
    mime: "text/html",
    fetchedAt: "2099-03-01T00:00:00Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}
function mutate(search: string | RegExp, replacement: string, html = FIXTURE): string {
  const changed = html.replace(search, replacement);
  if (changed === html) throw new Error("test mutation target missing");
  return changed;
}
/** Parse, expect a refusal, and return the category the replay would print. */
function refusal(html: string | Uint8Array, artifact: ArtifactMeta = meta()): RejectionCategory {
  let thrown: unknown;
  try {
    globalPassActivity.parse(typeof html === "string" ? encode(html) : html, artifact);
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error("the parser accepted the page");
  return classifyParserRejection(PARSER, thrown);
}

const PAGER = (text: string) =>
  `<div class="nablarch_paging"><div class="nablarch_currentPageNumber">${text}</div></div>`;
const withPager = (text: string, html = FIXTURE) =>
  mutate("<h1>ご利用明細</h1>", `<h1>ご利用明細</h1>${PAGER(text)}`, html);
const ROW_PAIR =
  "<tr><td>2099/02/03</td><td>ANONYMOUS MERCHANT</td><td>USD 12.34</td><td>JPY 0</td><td>JPY 0</td><td>JPY 0</td><td>ANONYMOUS STATUS</td><td>ANON-001</td><td></td></tr>\n" +
  "<tr><td>USD 12.34</td><td>ANONYMOUS MERCHANT</td><td>JPY 1,900</td><td>JPY 1,900</td></tr>";
const COMPACT_HEADERS = "<th>Transaction Currency and Amount</th><th>Transaction Detail</th>";

/** One synthetic refusal per throw site the fixture can reach, with its category. */
const CASES: readonly (readonly [string, () => RejectionCategory, RejectionCategory])[] = [
  [
    "metadata",
    () => refusal(FIXTURE, meta({ mime: "text/plain" })),
    { reason: "artifact_metadata_unsupported" },
  ],
  [
    "run",
    () => refusal(FIXTURE, meta({ runStatus: "partial", runFailureCount: 1 })),
    { reason: "run_not_admitted" },
  ],
  ["size", () => refusal(new Uint8Array()), { reason: "html_size_out_of_range" }],
  ["utf8", () => refusal(new Uint8Array([0x3c, 0xff, 0x3e])), { reason: "utf8_invalid" }],
  ["doctype", () => refusal(mutate("<!doctype html>", "")), { reason: "doctype_drift" }],
  [
    "key form",
    () => refusal(FIXTURE, meta({ artifactKey: "SENTINEL.html" })),
    { reason: "artifact_key_month_mismatch" },
  ],
  [
    "key month",
    () => refusal(FIXTURE, meta({ artifactKey: "activity-2099-01.html" })),
    { reason: "artifact_key_month_mismatch" },
  ],
  ["pager text", () => refusal(withPager("SENTINEL 1/1")), { reason: "pager_unreadable" }],
  [
    "later page without pager",
    () => refusal(FIXTURE, meta({ artifactKey: "activity-2099-02-p2.html" })),
    { reason: "pager_missing_on_later_page" },
  ],
  ["pager page", () => refusal(withPager("[2/2page]")), { reason: "pager_page_mismatch" }],
  [
    "two month selects",
    () =>
      refusal(mutate("</select>", '</select><select><option value="20990299">x</option></select>')),
    { reason: "month_selector_cardinality" },
  ],
  [
    "two placeholders",
    () => refusal(mutate('<option value="">', '<option value="x">a</option><option value="">')),
    { reason: "month_selector_range" },
  ],
  [
    "duplicate month",
    () => refusal(mutate('<option value="20990199">', '<option value="20990299">')),
    { reason: "month_selector_duplicates" },
  ],
  [
    "invalid month",
    () => refusal(mutate('<option value="20990199">', '<option value="20991399">')),
    { reason: "month_option_invalid" },
  ],
  [
    "gap",
    () => refusal(mutate('<option value="20990199">', '<option value="20970199">')),
    { reason: "month_selector_not_contiguous" },
  ],
  [
    "no selected month",
    () => refusal(mutate('value="20990299" selected', 'value="20990299"')),
    { reason: "month_selector_selected_cardinality" },
  ],
  [
    "two activity tables",
    () =>
      refusal(
        mutate(
          "</body>",
          `${FIXTURE.slice(FIXTURE.indexOf('<table data-view="activity">'), FIXTURE.lastIndexOf("</table>") + 8)}</body>`,
        ),
      ),
    { reason: "table_cardinality" },
  ],
  [
    "unclassified table",
    () => refusal(mutate("</body>", "<table><tr><td>SENTINEL</td></tr></table></body>")),
    { reason: "unclassified_table" },
  ],
  [
    "duplicate header",
    () =>
      refusal(
        mutate(
          "<th>Approval Number</th>\n<th>Remarks</th>",
          "<th>Approval Number</th>\n<th>Status</th>",
        ),
      ),
    { reason: "header_schema", label: "activity" },
  ],
  [
    "missing date header",
    () => refusal(mutate("<th>Transaction Date</th>", "<th>SENTINEL</th>")),
    { reason: "header_missing", label: "activity", field: "Transaction Date" },
  ],
  [
    "fee count",
    () => refusal(mutate("<th>FX Fee</th>\n<th>Status</th>", "<th>FX</th>\n<th>Status</th>")),
    { reason: "fee_schema", label: "expanded" },
  ],
  [
    "row count",
    () =>
      refusal(mutate("</tbody></table>\n</body>", "<tr><td>x</td></tr></tbody></table>\n</body>")),
    { reason: "row_cardinality" },
  ],
  [
    "row view count",
    () =>
      refusal(
        mutate(
          "<tr><td>USD 12.34</td><td>ANONYMOUS MERCHANT</td><td>JPY 1,900</td><td>JPY 1,900</td></tr>\n</tbody></table>\n</body>",
          "<tr><td>a</td><td>b</td><td>c</td></tr>\n</tbody></table>\n</body>",
        ),
      ),
    { reason: "source_view_row_cardinality" },
  ],
  [
    "two dates in a row",
    () =>
      refusal(
        mutate(
          "<td>ANONYMOUS MERCHANT</td><td>USD 12.34</td><td>JPY 0</td>",
          "<td>2099/02/04</td><td>USD 12.34</td><td>JPY 0</td>",
        ),
      ),
    { reason: "date_cardinality" },
  ],
  [
    "not a calendar date",
    () => refusal(mutate("<td>2099/02/03</td>", "<td>2099/02/31</td>")),
    { reason: "date_invalid" },
  ],
  [
    "date outside the month",
    () => refusal(mutate("<td>2099/02/03</td>", "<td>2099/01/03</td>")),
    { reason: "date_outside_month" },
  ],
  [
    "compact values",
    () =>
      refusal(
        mutate(
          "<tr><td>ANONYMOUS MERCHANT</td></tr>",
          "<tr><td>ANONYMOUS MERCHANT</td><td>x</td></tr>",
        ),
      ),
    { reason: "value_cardinality", label: "compact" },
  ],
  [
    "long field",
    () =>
      refusal(
        mutate("<tr><td>ANONYMOUS MERCHANT</td></tr>", `<tr><td>${"S".repeat(2_049)}</td></tr>`),
      ),
    { reason: "field_too_long", label: "compact" },
  ],
  [
    "views disagree",
    () =>
      refusal(
        mutate(
          "<tr><td>USD 12.34</td></tr><tr><td>JPY 0</td></tr>",
          "<tr><td>USD 12.35</td></tr><tr><td>JPY 0</td></tr>",
        ),
      ),
    { reason: "source_view_amount_mismatch" },
  ],
  [
    "amount format",
    () => refusal(FIXTURE.replaceAll("USD 12.34", "12.34 SENTINEL")),
    { reason: "amount_format" },
  ],
  [
    "signed amount",
    () => refusal(FIXTURE.replaceAll("USD 12.34", "JPY -12.34")),
    { reason: "amount_inexact" },
  ],
];

describe("global-pass-activity: one closed code per throw site", () => {
  test("the synthetic fixture itself parses, so every case isolates one check", () => {
    expect(globalPassActivity.parse(encode(FIXTURE), meta()).observations).toHaveLength(1);
  });
  for (const [name, run, expected] of CASES) test(name, () => expect(run()).toEqual(expected));

  test("date order and a second outer pair", () => {
    // Two records whose desktop dates run backwards.
    const second = FIXTURE.match(
      /<table data-view="compact">[\s\S]*?<\/table>\n<table data-view="expanded">[\s\S]*?<\/table>\n/u,
    )![0];
    const two = mutate(
      '<table data-view="activity">',
      `${second}<table data-view="activity">`,
    ).replace("</tbody></table>\n</body>", `${ROW_PAIR}\n</tbody></table>\n</body>`);
    expect(globalPassActivity.parse(encode(two), meta()).observations).toHaveLength(2);
    expect(refusal(two.replace("<td>2099/02/03</td>", "<td>2099/02/09</td>"))).toEqual({
      reason: "date_order",
    });
    // A compact table missing its detail header names the compact view.
    expect(
      refusal(mutate(COMPACT_HEADERS, "<th>Transaction Currency and Amount</th><th>SENTINEL</th>")),
    ).toEqual({
      reason: "header_missing",
      label: "compact",
      field: "Transaction Detail",
    });
  });

  test("every throw in the parser source maps to a named code, never other", () => {
    // Each `throw new Error(...)` of global-pass-activity.ts, with its
    // interpolations given the values the parser builds them from.
    const templates = [...SOURCE.matchAll(/throw new Error\(\s*(`[^`]*`|"[^"]*")/gu)].map((match) =>
      match[1]!.slice(1, -1),
    );
    // 32 sites, 31 messages: the key/month disagreement is thrown at two.
    expect(templates).toHaveLength(32);
    expect(new Set(templates).size).toBe(31);
    const values: Record<string, string> = {
      "index + 1": "7",
      label: "expanded 3",
      header: "Transaction Date",
      'alternatives.join(" or ")': "ATM Fee",
    };
    for (const template of templates) {
      const message = template.replaceAll(/\$\{([^}]+)\}/gu, (_, name: string) => {
        const value = values[name];
        if (value === undefined) throw new Error(`unhandled interpolation ${name}`);
        return value;
      });
      expect(classifyGlobalPassMessage(message).reason, template).not.toBe("other");
    }
    // The helpers the parser calls on the page.
    expect(classifyGlobalPassMessage("global-pass row 2 date is not a calendar date")).toEqual({
      reason: "date_invalid",
    });
    // Every code in the table is reached by some message above or by CASES.
    const reached = new Set(CASES.map(([, , category]) => category.reason));
    for (const reason of ["header_value_cardinality", "date_order"]) reached.add(reason);
    expect(
      GLOBAL_PASS_REJECTIONS.map(([code]) => code).filter((code) => !reached.has(code)),
    ).toEqual([]);
  });

  test("text outside the table is other, and a header outside the parser's constants is dropped", () => {
    expect(classifyGlobalPassMessage("global-pass SENTINEL 12,345 drift")).toEqual({
      reason: "other",
    });
    expect(classifyGlobalPassMessage("global-pass row 2 SENTINEL date cardinality drift")).toEqual({
      reason: "other",
    });
    expect(classifyGlobalPassMessage("global-pass activity schema is missing SENTINEL")).toEqual({
      reason: "header_missing",
      label: "activity",
    });
    expect(classifyGlobalPassMessage("global-pass SENTINEL header schema drift")).toEqual({
      reason: "other",
    });
    expect(classifyParserRejection(PARSER, new TypeError("SENTINEL"))).toEqual({
      reason: "runtime_TypeError",
    });
    expect(classifyParserRejection(PARSER, "SENTINEL")).toEqual({ reason: "non_error_throw" });
  });
});

describe("global-pass-activity: the stored page's shape in counts and booleans", () => {
  const shapeOf = (html: string, key: string | null = "activity-2099-02.html") =>
    globalPassActivityShape(encode(html), key);

  test("the synthetic page reads as the parser reads it", () => {
    expect(shapeOf(FIXTURE)).toEqual({
      utf8: true,
      byteLength: encode(FIXTURE).byteLength,
      doctype: true,
      select: 1,
      option: 16,
      optionSelected: 1,
      optionEightDigit: 15,
      monthSelects: 1,
      monthSelect: {
        options: 16,
        eightDigit: 15,
        other: 1,
        selected: 1,
        selectedEightDigit: 1,
        selectedOther: 0,
      },
      tables: { total: 3, th12: 1, th4: 1, th10: 1, other: 0 },
      activityTable: {
        trOwned: 3,
        bodyRows: 2,
        headerRowInBody: false,
        bodyRowsByCells: { cells9: 1, cells4: 1, cells5: 0, other: 0 },
        nineCellRowsByDateCells: { one: 1, none: 0, several: 0 },
        headers: {
          empty: 0,
          unique: true,
          parserRequired: 7,
          feeSuffixed: 3,
          surveyedEnglish: 10,
          surveyedJapanese: 0,
        },
      },
      pager: { blocks: 0, readable: 0, english: 0, japanese: 0, agreesWithKey: true },
    });
  });

  test("each admission check's input is visible", () => {
    // A header row moved out of thead becomes a body row.
    const noThead = shapeOf(
      FIXTURE.replace(
        /<table data-view="activity"><thead>([\s\S]*?)<\/thead><tbody>/u,
        '<table data-view="activity"><tbody>$1',
      ),
    );
    expect(noThead.activityTable).toMatchObject({ bodyRows: 3, headerRowInBody: true });
    // The selected attribute gone; a pager in Japanese naming page 2 of a page-1 key.
    const shape = shapeOf(
      withPager("[2/2ページ]", mutate('value="20990299" selected', 'value="20990299"')),
    );
    expect(shape.monthSelect).toMatchObject({ selected: 0, selectedEightDigit: 0 });
    expect(shape.pager).toEqual({
      blocks: 1,
      readable: 1,
      english: 0,
      japanese: 1,
      agreesWithKey: false,
    });
    expect(shapeOf(withPager("SENTINEL"), "SENTINEL").pager).toEqual({
      blocks: 1,
      readable: 0,
      english: 0,
      japanese: 0,
      agreesWithKey: null,
    });
    // Japanese labels in a twelve-th table.
    const japanese = [
      "お取引日",
      "お取引内容",
      "お取引通貨<br>金額",
      "お取引手数料",
      "ATM手数料",
      "為替手数料",
      "確定状態",
      "承認番号",
      "備考",
      "ご利用通貨<br>金額",
      "ご利用手数料",
      "換算レート",
    ];
    const table = `<table><thead><tr>${japanese.map((label) => `<th>${label}</th>`).join("")}</tr></thead><tbody></tbody></table>`;
    const ja = shapeOf(`<!DOCTYPE html><html><body>${table}</body></html>`);
    expect(ja.activityTable!.headers).toMatchObject({ parserRequired: 0, surveyedJapanese: 12 });
    expect(ja).toMatchObject({ doctype: true, select: 0, monthSelects: 0 });
    expect(ja.monthSelect).toBeUndefined();
    expect(globalPassActivityShape(new Uint8Array([0xff]), null)).toEqual({
      utf8: false,
      byteLength: 1,
    });
  });

  test("provider text, option values, dates and amounts never reach the line", () => {
    const marker = "SENTINEL";
    const page = FIXTURE.replaceAll("ANONYMOUS MERCHANT", `${marker} MERCHANT`)
      .replaceAll("ANON-001", `${marker}-001`)
      .replace("<th>Remarks</th>", `<th>${marker}</th>`)
      .replace("Select month", marker)
      .replace("</body>", `${PAGER(`${marker} [1/1page]`)}<p>${marker}</p></body>`);
    const printed = JSON.stringify(shapeOf(page, `activity-2099-02.html${marker}`));
    for (const forbidden of [
      marker,
      "2099",
      "12.34",
      "1,900",
      "20990299",
      "USD",
      "JPY",
      "Transaction",
    ])
      expect(printed).not.toContain(forbidden);
    // Every word of the line is a field name, a boolean, null or a count.
    const words = printed.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [];
    const allowed = new Set([
      ...Object.keys(shapeOf(FIXTURE)),
      ...Object.keys(shapeOf(FIXTURE).monthSelect!),
      ...Object.keys(shapeOf(FIXTURE).tables!),
      ...Object.keys(shapeOf(FIXTURE).activityTable!),
      ...Object.keys(shapeOf(FIXTURE).activityTable!.bodyRowsByCells),
      ...Object.keys(shapeOf(FIXTURE).activityTable!.nineCellRowsByDateCells),
      ...Object.keys(shapeOf(FIXTURE).activityTable!.headers),
      ...Object.keys(shapeOf(FIXTURE).pager!),
      "true",
      "false",
      "null",
    ]);
    expect(words.filter((word) => !allowed.has(word))).toEqual([]);
  });
});

describe("globalpass-activity selection text", () => {
  test("a version filter is a semantic version or nothing", () => {
    expect(globalPassReplaySelectionSql()).not.toContain("parser_version='");
    expect(globalPassReplaySelectionSql({ version: "1.1.0" })).toContain(
      "p.parser_version='1.1.0'",
    );
    for (const version of ["", "1.1", "1.1.0' OR '1'='1", "x.y.z"])
      expect(() => globalPassReplaySelectionSql({ version })).toThrow(/MAJOR\.MINOR\.PATCH/u);
  });
});
