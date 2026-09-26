// The statement state of a credit month is decided from the page, not from
// export links. Every page, merchant, date and amount here is synthetic.
import { describe, expect, test } from "bun:test";
import type { ReadResponse } from "../src/client";
import { collectCredit, type CreditReadClient } from "../src/collector";
import {
  CONFIRMED_STATEMENT_HEADING,
  creditStatementPeriod,
  creditStatementState,
  parseCreditLedger,
  settlementMonth,
} from "../src/parsers";
import { StopConditionError } from "../src/types";

const CONFIRMED_HEAD = "ご利用日 ご利用先など 支払区分 今回のお支払い金額";
const UNCONFIRMED_HEAD = "ご利用日 ご利用先など 支払区分 ご利用金額";

function row(amountLabel: string, cells: readonly string[], amount: string): string {
  return `<div class="content"><div class="item-cell">${cells
    .map((cell) => `<div class="cell">${cell}</div>`)
    .join(
      "",
    )}</div><div class="item-more"><ul class="list"><li><span>${amountLabel}</span><span>${amount}</span></li><li><span>摘要</span><span>架空摘要</span></li><li><span>今回回数</span><span>1</span></li></ul></div></div>`;
}

/**
 * A detail page: optional headings, the payment months its `h2` names, an
 * optional ledger head, rows, export links.
 */
function page(options: {
  readonly headings?: readonly string[];
  readonly months?: readonly string[];
  readonly head?: string | null;
  readonly rows?: readonly string[];
  readonly exportMonth?: number;
}): string {
  const headings = [
    ...(options.headings ?? []).map((heading) => `<h1>${heading}</h1>`),
    ...(options.months ?? []).map((month) => `<h2>${month}お支払い分のカードご利用明細</h2>`),
  ].join("");
  const exports =
    options.exportMonth === undefined
      ? ""
      : `<a href="/iss-pc/member/details_inquiry/detail.html?detailMonth=${options.exportMonth}&amp;output=csv">CSV</a>`;
  const ledger =
    options.head === null
      ? ""
      : `<div class="detail-list-01"><div class="head">${options.head ?? CONFIRMED_HEAD}</div>${(options.rows ?? []).join("")}</div>`;
  return `<!doctype html><html lang="ja"><body><h1>MyJCB</h1>${headings}<input type="hidden" name="generalJsonShikibetuId" value="synthetic-discriminator">${exports}${ledger}</body></html>`;
}

const confirmedRow = row(
  "ご利用金額",
  ["2026/01/05", "架空商店", "一回払い", "1,000円"],
  "1,000円",
);
const pendingRow = row(
  "今回のお支払い金額",
  ["2026/02/03", "架空予約", "一回払い", "2,000円"],
  "2,000円",
);
/** Position 1 as the surveyed connection shows it: a closed statement, no export links. */
const closedWithoutExports = page({
  headings: [CONFIRMED_STATEMENT_HEADING],
  months: ["2026年2月"],
  rows: [confirmedRow],
});
const mutable = page({ head: UNCONFIRMED_HEAD, rows: [pendingRow] });

function stopCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof StopConditionError ? error.code : "not-a-stop-condition";
  }
  return undefined;
}

describe("creditStatementState", () => {
  test("a closed statement without export links is confirmed", () => {
    expect(creditStatementState(closedWithoutExports, 1)).toBe("confirmed");
    // Whitespace inside the heading is not part of it.
    const spaced = closedWithoutExports.replace(
      CONFIRMED_STATEMENT_HEADING,
      "カードご利用代金明細 <span>(確定分)</span>\n",
    );
    expect(creditStatementState(spaced, 1)).toBe("confirmed");
    // A closed statement with no ledger is still stated by its heading.
    expect(
      creditStatementState(page({ headings: [CONFIRMED_STATEMENT_HEADING], head: null }), 3),
    ).toBe("confirmed");
  });

  test("month 0 and an unconfirmed-header page without the heading are unconfirmed", () => {
    expect(creditStatementState(mutable, 0)).toBe("unconfirmed");
    expect(creditStatementState(mutable, 1)).toBe("unconfirmed");
    // An older position cannot be the mutable month: its page is kept as evidence only.
    expect(creditStatementState(mutable, 2)).toBe("unknown");
    // Month 0 stays unconfirmed even when its empty ledger shows no amount label.
    expect(creditStatementState(page({ head: "ご利用日 ご利用先など" }), 0)).toBe("unconfirmed");
    // A page with neither the heading nor a ledger states nothing, as before.
    expect(creditStatementState(page({ head: null }), 2)).toBe("unknown");
  });

  test("a heading and a header shape that disagree stop the collection", () => {
    for (const [html, detailMonth] of [
      // (確定分) over an unconfirmed ledger header.
      [page({ headings: [CONFIRMED_STATEMENT_HEADING], head: UNCONFIRMED_HEAD }), 1],
      // A confirmed ledger header without the heading.
      [page({ rows: [confirmedRow] }), 1],
      // More than one heading.
      [page({ headings: [CONFIRMED_STATEMENT_HEADING, CONFIRMED_STATEMENT_HEADING] }), 1],
      // Both amount labels in one header.
      [page({ headings: [CONFIRMED_STATEMENT_HEADING], head: `${CONFIRMED_HEAD} ご利用金額` }), 1],
      // Month 0 stating a closed statement.
      [page({ headings: [CONFIRMED_STATEMENT_HEADING] }), 0],
      // Position-1 rows whose page states no state at all.
      [page({ head: "ご利用日 ご利用先など", rows: [confirmedRow] }), 1],
    ] as const)
      expect(stopCode(() => creditStatementState(html, detailMonth))).toBe(
        "credit-statement-state",
      );
    // A heading that only mentions the state is not the heading.
    expect(
      stopCode(() =>
        creditStatementState(
          page({ headings: ["カードご利用代金明細(確定分)のご案内"], rows: [confirmedRow] }),
          1,
        ),
      ),
    ).toBe("credit-statement-state");
  });

  test("an older page without the heading is unknown, never a stop", () => {
    const emptyRow =
      '<div class="content"><div class="item-cell"><div class="cell w-100per">ご利用明細はありません</div></div></div>';
    // An empty ledger without the heading, as older closed months show it, at
    // any position but 0, whatever its header label.
    for (const head of [UNCONFIRMED_HEAD, CONFIRMED_HEAD, "ご利用日 ご利用先など"])
      for (const detailMonth of [1, 7])
        expect(creditStatementState(page({ head, rows: [emptyRow] }), detailMonth)).toBe("unknown");
    // Rows without the heading at an older position: unknown, not a stop.
    expect(creditStatementState(page({ rows: [confirmedRow] }), 7)).toBe("unknown");
    expect(
      creditStatementState(page({ head: "ご利用日 ご利用先など", rows: [confirmedRow] }), 7),
    ).toBe("unknown");
    // Month 0 keeps its empty ledger as the unconfirmed snapshot.
    expect(creditStatementState(page({ head: UNCONFIRMED_HEAD, rows: [emptyRow] }), 0)).toBe(
      "unconfirmed",
    );
  });

  test("a ledger with rows must display its state's whole header set", () => {
    const withoutAmountLabel = page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      head: "ご利用日 ご利用先など 支払区分",
      rows: [confirmedRow],
    });
    expect(creditStatementState(withoutAmountLabel, 1)).toBe("confirmed");
    expect(stopCode(() => parseCreditLedger(withoutAmountLabel, "confirmed"))).toBe(
      "credit-ledger-headers",
    );
  });
});

const encoder = new TextEncoder();
function response(text: string, contentType = "text/html; charset=utf-8"): ReadResponse {
  const bytes = encoder.encode(text);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return { url: new URL("https://my.jcb.co.jp/"), status: 200, contentType, body };
}

/**
 * A credit menu listing `months`, their pages, and an older-month API that
 * lists `past` (by default nothing available).
 */
function client(
  pages: Readonly<Record<number, string>>,
  past: readonly Record<string, unknown>[] = [],
): CreditReadClient {
  const menu = `<!doctype html><html><body>${Object.keys(pages)
    .map(
      (month) =>
        `<a href="/iss-pc/member/details_inquiry/detail.html?detailMonth=${month}&amp;output=web">明細</a>`,
    )
    .join("")}</body></html>`;
  return {
    get: async (operation, query) => {
      if (operation === "credit-menu") return response(menu);
      const html =
        operation === "credit-detail" ? pages[Number(query?.get("detailMonth"))] : undefined;
      if (html === undefined) throw new Error(`unexpected synthetic read ${operation}`);
      return response(html);
    },
    postCreditPastJson: async () =>
      response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: { errId: "0", errMessage: "", detailPastJsonInfo: past },
          id: "030100601",
        }),
        "application/json",
      ),
  };
}

describe("collectCredit", () => {
  test("records a closed position-1 statement without export links as confirmed", async () => {
    const { artifacts } = await collectCredit(client({ 0: mutable, 1: closedWithoutExports }), "x");
    const states = Object.fromEntries(
      artifacts.map((artifact) => [artifact.filename, artifact.statementState ?? null]),
    );
    expect(states).toEqual({
      "credit-menu.html": null,
      "credit-past-months.json": null,
      "credit-detail-00.html": "unconfirmed",
      "credit-ledger-00.json": "unconfirmed",
      "credit-detail-01.html": "confirmed",
      "credit-ledger-01.json": "confirmed",
    });
    const ledger = artifacts.find((artifact) => artifact.filename === "credit-ledger-01.json");
    expect(JSON.parse(String(ledger?.body))).toEqual({
      schemaVersion: 1,
      detailMonth: 1,
      // The month the page names, not its position (creditStatementPeriod).
      period: "2026-02",
      state: "confirmed",
      headers: ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"],
      rows: [
        {
          summaryCells: ["2026/01/05", "架空商店", "一回払い", "1,000円"],
          // The confirmed labels are read, so the usage amount is kept.
          expanded: { ご利用金額: "1,000円", 摘要: "架空摘要", 今回回数: "1" },
        },
      ],
    });
    const pending = artifacts.find((artifact) => artifact.filename === "credit-ledger-00.json");
    expect(JSON.parse(String(pending?.body))).toMatchObject({
      state: "unconfirmed",
      rows: [{ expanded: { 今回のお支払い金額: "2,000円" } }],
    });
  });

  test("an unconfirmed position-1 page stays unconfirmed", async () => {
    const { artifacts } = await collectCredit(client({ 0: mutable, 1: mutable }), "x");
    expect(
      artifacts
        .filter((artifact) => artifact.filename.endsWith("-01.html"))
        .map((artifact) => artifact.statementState),
    ).toEqual(["unconfirmed"]);
  });

  test("an older empty page without the heading is kept as unknown evidence without a ledger", async () => {
    const olderEmpty = page({
      head: UNCONFIRMED_HEAD,
      rows: [
        '<div class="content"><div class="item-cell"><div class="cell w-100per">ご利用明細はありません</div></div></div>',
      ],
    });
    const { artifacts } = await collectCredit(
      client({ 0: mutable, 1: closedWithoutExports, 7: olderEmpty }),
      "x",
    );
    const states = Object.fromEntries(
      artifacts.map((artifact) => [artifact.filename, artifact.statementState ?? null]),
    );
    expect(states["credit-detail-07.html"]).toBe("unknown");
    expect(states["credit-ledger-07.json"]).toBeUndefined();
    // The only unconfirmed capture of the run stays position 0.
    expect(
      artifacts
        .filter((artifact) => artifact.statementState === "unconfirmed")
        .map((artifact) => artifact.filename),
    ).toEqual(["credit-detail-00.html", "credit-ledger-00.json"]);
  });

  test("a page whose heading and headers disagree stops the collection", async () => {
    const conflicting = page({ headings: [CONFIRMED_STATEMENT_HEADING], head: UNCONFIRMED_HEAD });
    const run = collectCredit(client({ 0: mutable, 1: conflicting }), "x");
    await expect(run).rejects.toBeInstanceOf(StopConditionError);
    await expect(run).rejects.toMatchObject({ code: "credit-statement-state" });
  });

  test("export links on a page that is not a confirmed statement stop the collection", async () => {
    const exporting = page({ head: UNCONFIRMED_HEAD, rows: [pendingRow], exportMonth: 1 });
    await expect(collectCredit(client({ 0: mutable, 1: exporting }), "x")).rejects.toMatchObject({
      code: "credit-statement-state",
    });
  });
});

describe("creditStatementPeriod", () => {
  const closed = (months: readonly string[]) =>
    page({ headings: [CONFIRMED_STATEMENT_HEADING], months, rows: [confirmedRow] });
  const period = (html: string, detailMonth: number, settlementYM?: string) =>
    creditStatementPeriod({
      html,
      detailMonth,
      state: creditStatementState(html, detailMonth),
      settlementYM,
    });

  test("a confirmed page records the payment month it names, whatever its position", () => {
    for (const detailMonth of [1, 2, 8])
      expect(period(closed(["2026年2月"]), detailMonth)).toBe("2026-02");
    // Whitespace and markup inside the heading are not part of it.
    const spaced = closed([]).replace(
      "</h1><input",
      "</h1><h2>2026年 <span>10月</span>お支払い分の\nカードご利用明細</h2><input",
    );
    expect(period(spaced, 1)).toBe("2026-10");
  });

  test("a page that is not a confirmed statement keeps its relative label or its API label", () => {
    expect(period(mutable, 0)).toBe("detailMonth-0");
    expect(period(mutable, 1)).toBe("detailMonth-1");
    // An unknown older page names no statement, even when an h2 names a month.
    expect(period(page({ months: ["2026年2月"], head: null }), 5)).toBe("detailMonth-5");
    expect(period(mutable, 1, "202601")).toBe("202601");
  });

  test("a month the past-months API labels keeps its label, which must agree with the page", () => {
    for (const label of ["202602", "2026年2月お支払い分", "２０２６年２月", "2026-02"]) {
      expect(settlementMonth(label)).toBe("2026-02");
      expect(period(closed(["2026年2月"]), 10, label)).toBe(label);
    }
    // A page that names no month keeps the API's label, as before.
    expect(period(closed([]), 10, "202602")).toBe("202602");
    expect(stopCode(() => period(closed(["2026年2月"]), 10, "202603"))).toBe(
      "credit-statement-period",
    );
    expect(settlementMonth("2026年13月")).toBeNull();
    expect(settlementMonth("detailMonth-3")).toBeNull();
  });

  test("a confirmed page that names no month, or more than one, stops the collection", () => {
    for (const months of [[], ["2026年2月", "2026年3月"], ["2026年13月"]])
      expect(stopCode(() => period(closed(months), 2))).toBe("credit-statement-period");
  });
});

describe("a statement moving down the list", () => {
  const closed = (month: string, cells: readonly string[]) =>
    page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      months: [month],
      rows: [row("ご利用金額", cells, cells[3]!)],
    });
  const february = closed("2026年2月", ["2026/01/05", "架空商店", "一回払い", "1,000円"]);
  const march = closed("2026年3月", ["2026/02/07", "架空書店", "一回払い", "500円"]);
  const ledger = (artifacts: readonly { filename: string; body: unknown }[], name: string) =>
    JSON.parse(String(artifacts.find((artifact) => artifact.filename === name)?.body)) as Record<
      string,
      unknown
    >;

  test("keeps its period from position 1 to position 2, with the position beside it", async () => {
    const before = await collectCredit(client({ 0: mutable, 1: february }), "x");
    const after = await collectCredit(client({ 0: mutable, 1: march, 2: february }), "x");
    const first = ledger(before.artifacts, "credit-ledger-01.json");
    const moved = ledger(after.artifacts, "credit-ledger-02.json");
    expect([first["detailMonth"], moved["detailMonth"]]).toEqual([1, 2]);
    expect([first["period"], moved["period"]]).toEqual(["2026-02", "2026-02"]);
    // The rows are the same, so the two ledgers differ only in the position.
    expect({ ...moved, detailMonth: 1 }).toEqual(first);
    expect(ledger(after.artifacts, "credit-ledger-01.json")["period"]).toBe("2026-03");
    // Position 0 names no month and keeps its relative label.
    expect(ledger(after.artifacts, "credit-ledger-00.json")["period"]).toBe("detailMonth-0");
    expect(
      after.artifacts
        .filter((artifact) => /-02\.(?:html|json)$/u.test(artifact.filename))
        .map((artifact) => [artifact.statementState, artifact.period]),
    ).toEqual([
      ["confirmed", "2026-02"],
      ["confirmed", "2026-02"],
    ]);
  });

  test("a month the past-months API labels keeps the API's label", async () => {
    const { artifacts } = await collectCredit(
      client({ 0: mutable, 1: march, 10: february }, [
        { detailMonth: "10", detailAvailableFlag: "1", settlementYM: "2026年2月お支払い分" },
      ]),
      "x",
    );
    expect(ledger(artifacts, "credit-ledger-10.json")["period"]).toBe("2026年2月お支払い分");
    expect(ledger(artifacts, "credit-ledger-01.json")["period"]).toBe("2026-03");
  });

  test("a confirmed page that names no month stops the collection", async () => {
    const unnamed = page({ headings: [CONFIRMED_STATEMENT_HEADING], rows: [confirmedRow] });
    await expect(
      collectCredit(client({ 0: mutable, 1: march, 2: unnamed }), "x"),
    ).rejects.toMatchObject({ code: "credit-statement-period" });
  });
});
