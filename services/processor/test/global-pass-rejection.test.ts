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
  GLOBAL_PASS_AMOUNT_CELL,
  GLOBAL_PASS_DATE_CELL,
  GLOBAL_PASS_REJECTIONS,
  globalPassActivityShape,
  globalPassCellPattern,
  globalPassLatestOkComparison,
  globalPassLatestOkSql,
  globalPassPageText,
  globalPassReplaySelectionSql,
  type GlobalPassCellPattern,
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
    // The whole argument must be one literal, so a message built another way
    // (a variable, a concatenation, another error class) is a `throw` this
    // pattern does not match, and the count below fails.
    const templates = [...SOURCE.matchAll(/throw new Error\(\s*(`[^`]*`|"[^"]*")\s*,?\s*\)/gu)].map(
      (match) => match[1]!.slice(1, -1),
    );
    // 32 sites, 31 messages: the key/month disagreement is thrown at two.
    expect(templates).toHaveLength(32);
    expect(SOURCE.match(/\bthrow\b/gu)).toHaveLength(templates.length);
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
      byteMagnitude: String(encode(FIXTURE).byteLength).length,
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
      // The comparisons of ADR 0026's amendment of 2026-10-08: the fixture's
      // three tables are children of body, and its one record is carried by
      // its one pair.
      detailTables: {
        compactHeadersUniform: true,
        expandedHeadersUniform: true,
        compactClassTokensUniform: true,
        expandedClassTokensUniform: true,
      },
      detailContainer: {
        childCount: 5,
        children: [
          { tag: "h1", th: null, wrapped: false, known: false, tables: 0 },
          { tag: "select", th: null, wrapped: false, known: false, tables: 0 },
          { tag: "table", th: 4, wrapped: false, known: true, tables: 1 },
          { tag: "table", th: 10, wrapped: false, known: true, tables: 1 },
          { tag: "table", th: 12, wrapped: false, known: true, tables: 1 },
        ],
        pairsInOrder: 1,
      },
      otherTables: [],
      recordDetailAlignment: {
        compact: [{ table: 0, valueCells: 4, records: [0], matchedCells: 4, best: 0 }],
        // Nine non-empty values; the rate is in neither activity row.
        expanded: [{ table: 0, valueCells: 9, records: [0], matchedCells: 8, best: 0 }],
        unmatchedRecords: [],
        monotonic: true,
        pairsAgree: true,
        indexAligned: true,
      },
      unmatchedRecords: [],
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
      byteMagnitude: 1,
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
    // Every word of the line is a field name, a closed tag name, a boolean,
    // null or a count.
    const words = printed.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [];
    const allowed = new Set([
      ...fieldNames(shapeOf(FIXTURE)),
      "h1",
      "select",
      "table",
      "div",
      "p",
      "true",
      "false",
      "null",
    ]);
    expect(words.filter((word) => !allowed.has(word))).toEqual([]);
  });
});

// ── a synthetic month in the observed layout ─────────────────────────────────
//
// The layout the owner observed in one refused page (counts only): the
// detail tables share one parent div (ancestors div, form, div, div, body),
// whose children are a compact table and a div wrapping an expanded table
// per record, and the activity table lies outside it. Every text below is
// synthetic, and none of it may reach the shape.

const ACTIVITY_HEADERS = [
  "Transaction Date",
  "Transaction Detail",
  "Transaction Currency and Amount",
  "Transaction Fee",
  "ATM Fee",
  "FX Fee",
  "Status",
  "Approval Number",
  "Remarks",
  "Local Currency and Amount",
  "Applicable Rate",
  "Funded Currency and Amount",
];
const COMPACT_LABELS = [
  "Transaction Currency and Amount",
  "Transaction Detail",
  "Local Currency and Amount",
  "Funded Currency and Amount",
];
const EXPANDED_LABELS = [
  "Transaction Currency and Amount",
  "Transaction Fee",
  "ATM Fee",
  "FX Fee",
  "Status",
  "Approval Number",
  "Remarks",
  "Local Currency and Amount",
  "Applicable Rate",
  "Funded Currency and Amount",
];
const MONTH_SELECT = FIXTURE.match(/<select[\s\S]*?<\/select>/u)![0];

/** Record i of the synthetic month: distinct texts, except the shared fee, status and remarks. */
function syntheticRecord(index: number) {
  const letter = String.fromCharCode(65 + index);
  const yen = `JPY ${index + 1},${index}50`;
  return {
    date: `2099/02/${String(index + 1).padStart(2, "0")}`,
    merchant: `SYNTHETIC SHOP ${letter}`,
    amount: `USD ${index + 1}1.25`,
    fee: "JPY 0",
    status: "SYNTHETIC STATUS",
    approval: `SYN-APPROVAL-${letter}`,
    remarks: "",
    local: yen,
    rate: `15${index}.1234`,
    funded: yen,
  };
}
type SyntheticRecord = ReturnType<typeof syntheticRecord>;
const th = (labels: readonly string[]) => labels.map((label) => `<th>${label}</th>`).join("");
const td = (values: readonly string[]) => values.map((value) => `<td>${value}</td>`).join("");
const compactTable = (record: SyntheticRecord, index: number) =>
  `<table class="synthetic-compact" id="compactTable${index}"><thead><tr>${th(COMPACT_LABELS)}</tr></thead><tbody>` +
  `<tr>${td([record.amount])}</tr><tr>${td([record.merchant])}</tr><tr>${td([record.local, record.funded])}</tr></tbody></table>`;
const expandedTable = (record: SyntheticRecord, index: number) =>
  `<div class="synthetic-wrap" id="expandedWrap${index}"><table class="synthetic-expanded"><thead><tr>${th(EXPANDED_LABELS)}</tr></thead><tbody>` +
  [
    record.amount,
    record.fee,
    record.fee,
    record.fee,
    record.status,
    record.approval,
    record.remarks,
    record.local,
    record.rate,
    record.funded,
  ]
    .map((value) => `<tr>${td([value])}</tr>`)
    .join("") +
  "</tbody></table></div>";
const desktopCells = (record: SyntheticRecord) => [
  record.date,
  record.merchant,
  record.amount,
  record.fee,
  record.fee,
  record.fee,
  record.status,
  record.approval,
  record.remarks,
];
const responsiveCells = (record: SyntheticRecord) => [
  record.amount,
  record.merchant,
  record.local,
  record.funded,
];
/** A third kind of table: two headers, one body row of one cell, in the detail parent after the pairs. */
const otherTable = (headers: readonly string[], cell: string, id = "") =>
  `<table class="synthetic-compact"${id === "" ? "" : ` id="${id}"`}><thead><tr>${th(headers)}</tr></thead><tbody><tr>${td([cell])}</tr></tbody></table>`;

/** `records` activity records, the first `pairs` with their detail pair, then `extra` in the detail parent. */
function syntheticMonth(records: number, pairs: number, extra = ""): string {
  const all = Array.from({ length: records }, (_, index) => syntheticRecord(index));
  const details = all
    .slice(0, pairs)
    .map((record, index) => compactTable(record, index) + expandedTable(record, index))
    .join("\n");
  const rows = all
    .map(
      (record) => `<tr>${td(desktopCells(record))}</tr>\n<tr>${td(responsiveCells(record))}</tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Synthetic month</title></head>
<body><div class="synthetic-frame"><div class="synthetic-body">
<form action="/synthetic" method="post">
${MONTH_SELECT}
<div class="synthetic-details">
${details}
${extra}
</div>
</form>
<table class="synthetic-activity"><thead><tr>${th(ACTIVITY_HEADERS)}</tr></thead><tbody>
${rows}
</tbody></table>
</div></div></body></html>`;
}
const RECORDS = 4;
const LAST = syntheticRecord(RECORDS - 1);
const WHOLE = syntheticMonth(RECORDS, RECORDS);
const ONE_SHORT = syntheticMonth(
  RECORDS,
  RECORDS - 1,
  otherTable(
    ["SYNTHETIC HEADER ONE", "SYNTHETIC HEADER TWO"],
    LAST.amount,
    `compactTable${RECORDS - 1}`,
  ),
);
const pattern = (overrides: Partial<GlobalPassCellPattern>): GlobalPassCellPattern => ({
  empty: false,
  digitsOnly: false,
  dateLike: false,
  amountLike: false,
  asciiOnly: true,
  hasJapanese: false,
  lengthBucket: "5-16",
  ...overrides,
});

describe("global-pass-activity: detail tables, unclassified tables and records compared", () => {
  const shapeOf = (html: string) => globalPassActivityShape(encode(html), "activity-2099-02.html");

  test("a whole month: every record carried by its pair, in order, nothing unclassified", () => {
    expect(globalPassActivity.parse(encode(WHOLE), meta()).observations).toHaveLength(RECORDS);
    const shape = shapeOf(WHOLE);
    expect(shape.tables).toEqual({ total: 9, th12: 1, th4: 4, th10: 4, other: 0 });
    expect(shape.detailTables).toEqual({
      compactHeadersUniform: true,
      expandedHeadersUniform: true,
      compactClassTokensUniform: true,
      expandedClassTokensUniform: true,
    });
    const compactChild = { tag: "table", th: 4, wrapped: false, known: true, tables: 1 };
    const expandedChild = { tag: "div", th: 10, wrapped: true, known: true, tables: 1 };
    expect(shape.detailContainer).toEqual({
      childCount: 8,
      children: Array.from({ length: RECORDS }, () => [compactChild, expandedChild]).flat(),
      pairsInOrder: RECORDS,
    });
    expect(shape.otherTables).toEqual([]);
    const indices = Array.from({ length: RECORDS }, (_, index) => index);
    expect(shape.recordDetailAlignment).toEqual({
      // A compact table's four values are all its own record's.
      compact: indices.map((index) => ({
        table: index,
        valueCells: 4,
        records: [index],
        matchedCells: 4,
        best: index,
      })),
      // The shared fee and status reach every record; the rate is in no row.
      expanded: indices.map((index) => ({
        table: index,
        valueCells: 9,
        records: indices,
        matchedCells: 8,
        best: index,
      })),
      unmatchedRecords: [],
      monotonic: true,
      pairsAgree: true,
      indexAligned: true,
    });
    expect(shape.unmatchedRecords).toEqual([]);
  });

  test("one record short of a pair, with a third table last: the record and the table are named", () => {
    expect(refusal(ONE_SHORT)).toEqual({ reason: "unclassified_table" });
    const shape = shapeOf(ONE_SHORT);
    expect(shape.tables).toEqual({ total: 8, th12: 1, th4: 3, th10: 3, other: 1 });
    expect(shape.detailContainer!.childCount).toBe(2 * (RECORDS - 1) + 1);
    expect(shape.detailContainer!.children.at(-1)).toEqual({
      tag: "table",
      th: 2,
      wrapped: false,
      known: false,
      tables: 1,
    });
    expect(shape.detailContainer!.pairsInOrder).toBe(RECORDS - 1);
    expect(shape.otherTables).toEqual([
      {
        th: 2,
        td: 1,
        bodyRows: 1,
        cellsPerRow: [1],
        colspanMax: null,
        theadPresent: true,
        nestedTables: 0,
        positionInParent: 2 * (RECORDS - 1),
        parentIsDetailContainer: true,
        classTokenCount: 1,
        classTokensEqualCompact: true,
        classTokensEqualExpanded: false,
        attributeNames: ["class", "id"],
        // Its id's number is after the three compact tables' and the three wrappers'.
        idNumericSuffixRank: RECORDS - 1,
        idNumericSuffixDistinct: RECORDS,
        idNumericSuffixPeers: 2 * (RECORDS - 1),
        headerMatches: [
          { activity: null, compact: null, expanded: null, surveyed: false },
          { activity: null, compact: null, expanded: null, surveyed: false },
        ],
        cells: [
          {
            ...pattern({ amountLike: true }),
            equalsRecordCell: [
              { record: RECORDS - 1, row: "desktop", cell: 2 },
              { record: RECORDS - 1, row: "responsive", cell: 0 },
            ],
          },
        ],
      },
    ]);
    const alignment = shape.recordDetailAlignment!;
    expect(alignment.compact.map((match) => [match.records, match.best])).toEqual([
      [[0], 0],
      [[1], 1],
      [[2], 2],
    ]);
    expect(alignment.expanded.map((match) => match.best)).toEqual([0, 1, 2]);
    expect(alignment).toMatchObject({
      unmatchedRecords: [RECORDS - 1],
      monotonic: true,
      pairsAgree: true,
      indexAligned: true,
    });
    const [unmatched] = shape.unmatchedRecords!;
    expect(shape.unmatchedRecords).toHaveLength(1);
    expect(unmatched!.record).toBe(RECORDS - 1);
    expect(unmatched!.desktop).toHaveLength(9);
    expect(unmatched!.responsive).toHaveLength(4);
    // Each cell has the pattern the carried records have there.
    expect(
      [...unmatched!.desktop, ...unmatched!.responsive].map((cell) => cell.patternEqualsMajority),
    ).toEqual(Array(13).fill(true));
    expect(unmatched!.desktop[0]).toMatchObject(pattern({ dateLike: true }));
    expect(unmatched!.desktop[8]).toMatchObject(pattern({ empty: true, lengthBucket: "0" }));
    // The third table's cell is this record's amount, in both views.
    expect(unmatched!.desktop.map((cell) => cell.equalsOtherTableCell)).toEqual([
      [],
      [],
      [{ table: 0, cell: 0 }],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
    expect(unmatched!.responsive.map((cell) => cell.equalsOtherTableCell)).toEqual([
      [{ table: 0, cell: 0 }],
      [],
      [],
      [],
    ]);
  });

  test("a third table's header equal to a compact header is located in each header list", () => {
    const page = syntheticMonth(
      RECORDS,
      RECORDS - 1,
      otherTable(["Transaction Detail", "SYNTHETIC HEADER TWO"], "SYNTHETIC CELL"),
    );
    const [table] = globalPassActivityShape(encode(page), "activity-2099-02.html").otherTables!;
    expect(table!.headerMatches).toEqual([
      { activity: 1, compact: 1, expanded: null, surveyed: true },
      { activity: null, compact: null, expanded: null, surveyed: false },
    ]);
    // No id: no rank. A cell no record has: no match.
    expect(table).toMatchObject({
      attributeNames: ["class"],
      idNumericSuffixRank: null,
      idNumericSuffixDistinct: null,
      cells: [{ ...pattern({ lengthBucket: "5-16" }), equalsRecordCell: [] }],
    });
  });

  test("pairs out of order, ties and a nested table are visible", () => {
    // Swap the first two pairs: the parser's index pairing no longer holds.
    const [first, second] = [0, 1].map(
      (index) =>
        compactTable(syntheticRecord(index), index) + expandedTable(syntheticRecord(index), index),
    );
    const swapped = WHOLE.replace(first!, "FIRST")
      .replace(second!, first!)
      .replace("FIRST", second!);
    expect(shapeOf(swapped).recordDetailAlignment).toMatchObject({
      monotonic: false,
      pairsAgree: true,
      indexAligned: false,
      unmatchedRecords: [],
    });
    // Two records with the same texts: their tables tie, so no record is carried.
    const twins = WHOLE.replaceAll("SYNTHETIC SHOP B", "SYNTHETIC SHOP A")
      .replaceAll("USD 21.25", "USD 11.25")
      .replaceAll("JPY 2,150", "JPY 1,050")
      .replaceAll("SYN-APPROVAL-B", "SYN-APPROVAL-A")
      .replaceAll("2099/02/02", "2099/02/01");
    const tied = shapeOf(twins).recordDetailAlignment!;
    expect(tied.compact.slice(0, 2).map((match) => [match.records, match.best])).toEqual([
      [[0, 1], null],
      [[0, 1], null],
    ]);
    expect(tied).toMatchObject({ unmatchedRecords: [0, 1], monotonic: false });
    // A table nested in a third table, with a colspan.
    const nested = shapeOf(
      syntheticMonth(
        RECORDS,
        RECORDS - 1,
        '<table class="synthetic-outer"><tr><th colspan="3">SYNTHETIC HEADER</th></tr><tr><td><table><tr><td>SYNTHETIC CELL</td></tr></table></td></tr></table>',
      ),
    );
    expect(
      nested.otherTables!.map((table) => [table.th, table.nestedTables, table.colspanMax]),
    ).toEqual([
      [1, 1, 3],
      [0, 0, null],
    ]);
    expect(nested.otherTables![1]!.parentIsDetailContainer).toBe(false);
  });

  test("the cell patterns are the parser's date and amount forms, character classes and length buckets", () => {
    expect(globalPassCellPattern("")).toEqual(
      pattern({ empty: true, asciiOnly: true, lengthBucket: "0" }),
    );
    expect(globalPassCellPattern("0123")).toEqual(
      pattern({ digitsOnly: true, lengthBucket: "1-4" }),
    );
    expect(globalPassCellPattern("2099-02-03").dateLike).toBe(true);
    expect(globalPassCellPattern("2099.02.03").dateLike).toBe(false);
    expect(globalPassCellPattern("JPY -1,234.5").amountLike).toBe(true);
    expect(globalPassCellPattern("1,234 JPY").amountLike).toBe(false);
    expect(globalPassCellPattern("お取引 X")).toMatchObject({
      asciiOnly: false,
      hasJapanese: true,
      lengthBucket: "5-16",
    });
    expect(globalPassCellPattern("Ｘ".repeat(17))).toMatchObject({
      hasJapanese: true,
      lengthBucket: "17-64",
    });
    expect(globalPassCellPattern("x".repeat(65)).lengthBucket).toBe("65+");
    // The two patterns are the parser's own literals: a change there fails
    // here. The transpiler may write a non-ASCII character of a literal as a
    // `\uXXXX` escape, so both sides are compared with escapes read back.
    const unescaped = (source: string) =>
      source.replaceAll(/\\u([0-9A-Fa-f]{4})/gu, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    const literals = [...SOURCE.matchAll(/\/(\^[^\n]*?\$)\/u/gu)].map((match) => match[1]!);
    expect(literals).toContain(unescaped(GLOBAL_PASS_DATE_CELL.source));
    expect(literals).toContain(unescaped(GLOBAL_PASS_AMOUNT_CELL.source));
    expect([GLOBAL_PASS_DATE_CELL.flags, GLOBAL_PASS_AMOUNT_CELL.flags]).toEqual(["u", "u"]);
  });

  test("on pages the parser accepts, the comparisons read the records, headers and values it emits", () => {
    for (const page of [FIXTURE, WHOLE, syntheticMonth(1, 1)]) {
      const parsed = globalPassActivity.parse(encode(page), meta()).observations;
      const read = globalPassPageText(encode(page));
      const extra = parsed.map((observation) => observation.extra as Record<string, any>);
      expect(read.records).toEqual(
        extra.map((item) => ({
          desktop: item["sourceViews"].desktopCells,
          responsive: item["sourceViews"].responsiveCells,
        })),
      );
      for (const [kind, fields] of [
        ["compact", "compactFields"],
        ["expanded", "expandedFields"],
      ] as const)
        expect(read[kind]).toEqual(
          extra.map((item) => ({
            headers: Object.keys(item[fields]),
            values: Object.values(item[fields]),
          })),
        );
    }
  });

  test("the newest published capture of the key is compared by desktop row, in counts", () => {
    const refused = encode(ONE_SHORT);
    expect(globalPassLatestOkComparison(refused, null)).toEqual({
      found: false,
      artifact: null,
      intact: null,
      records: null,
      recordsAlsoPresent: null,
      unmatchedRecordPresent: null,
    });
    expect(
      globalPassLatestOkComparison(refused, { artifact: 7, bytes: encode(WHOLE), intact: false }),
    ).toEqual({
      found: true,
      artifact: 7,
      intact: false,
      records: null,
      recordsAlsoPresent: null,
      unmatchedRecordPresent: null,
    });
    // An accepted capture with every record: the unmatched one is among them.
    expect(
      globalPassLatestOkComparison(refused, { artifact: 7, bytes: encode(WHOLE), intact: true }),
    ).toEqual({
      found: true,
      artifact: 7,
      intact: true,
      records: RECORDS,
      recordsAlsoPresent: RECORDS,
      unmatchedRecordPresent: true,
    });
    // An accepted capture without the last record: it is not.
    expect(
      globalPassLatestOkComparison(refused, {
        artifact: 8,
        bytes: encode(syntheticMonth(RECORDS - 1, RECORDS - 1)),
        intact: true,
      }),
    ).toMatchObject({
      records: RECORDS - 1,
      recordsAlsoPresent: RECORDS - 1,
      unmatchedRecordPresent: false,
    });
    // An accepted empty month: nothing to compare with; a whole refused page has no unmatched record.
    const empty = FIXTURE.replace(/<table[\s\S]*<\/table>/u, "");
    expect(
      globalPassLatestOkComparison(encode(WHOLE), {
        artifact: 9,
        bytes: encode(empty),
        intact: true,
      }),
    ).toMatchObject({ records: 0, recordsAlsoPresent: 0, unmatchedRecordPresent: null });
  });

  test("the lookup names only a key of the parser's form and another artifact", () => {
    const sql = globalPassLatestOkSql({ id: 679, artifactKey: "activity-2099-02.html" })!;
    expect(sql).toContain("a.artifact_key='activity-2099-02.html' AND a.id<>679");
    expect(sql).toContain("FROM published_parse_runs p");
    for (const artifactKey of [null, "", "activity-2099-02.html' OR '1'='1", "SENTINEL.html"])
      expect(globalPassLatestOkSql({ id: 1, artifactKey })).toBeNull();
    for (const id of [0, -1, 1.5, Number.NaN])
      expect(globalPassLatestOkSql({ id, artifactKey: "activity-2099-02.html" })).toBeNull();
  });

  test("no synthetic text, attribute value, id or number of the page reaches the line", () => {
    const pages = [
      ONE_SHORT,
      syntheticMonth(
        RECORDS,
        RECORDS - 1,
        otherTable(["Transaction Detail", "SYNTHETIC HEADER TWO"], LAST.approval, "sentinelTable9"),
      ),
    ];
    const forbidden = new Set<string>([
      "SYNTHETIC",
      "SYN-",
      "2099",
      "USD",
      "JPY",
      "Transaction",
      ".1234",
      "synthetic-",
      "compactTable",
      "expandedWrap",
      "sentinelTable",
      "/synthetic",
    ]);
    for (let index = 0; index < RECORDS; index++)
      for (const value of Object.values(syntheticRecord(index)))
        if (value !== "") forbidden.add(value);
    for (const page of pages) {
      const printed = JSON.stringify({
        shape: shapeOf(page),
        latestOkCapture: globalPassLatestOkComparison(encode(page), {
          artifact: 1,
          bytes: encode(WHOLE),
          intact: true,
        }),
      });
      for (const text of forbidden) expect(printed, text).not.toContain(text);
      // Every word is a field name, a closed tag or attribute name, a row kind, a boolean or null.
      const closed = new Set([
        ...fieldNames(shapeOf(FIXTURE)),
        ...fieldNames(shapeOf(ONE_SHORT)),
        "found",
        "artifact",
        "intact",
        "records",
        "recordsAlsoPresent",
        "unmatchedRecordPresent",
        "latestOkCapture",
        "shape",
        "table",
        "div",
        "class",
        "id",
        "desktop",
        "responsive",
        "true",
        "false",
        "null",
      ]);
      const words = printed.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [];
      expect(words.filter((word) => !closed.has(word))).toEqual([]);
    }
  });
});

/** Every object key in a value, at any depth. */
function fieldNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(fieldNames);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...fieldNames(item)]);
}

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
