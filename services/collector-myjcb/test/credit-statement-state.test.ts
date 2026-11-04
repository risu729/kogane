// The statement state of a credit month is decided from the page, not from
// export links. Every page, merchant, date and amount here is synthetic.
import { describe, expect, spyOn, test } from "bun:test";
import type { ReadResponse } from "../src/client";
import { collectCredit, connectionStopCode, type CreditReadClient } from "../src/collector";
import {
  CONFIRMED_STATEMENT_HEADING,
  creditStatementPeriod,
  creditStatementState,
  parseCreditLedger,
  scheduledLedgerRowCount,
  schedulePageKind,
  settlementMonth,
} from "../src/parsers";
import { myJcbRunPlan } from "../src/shared-collection";
import { HumanRequiredError, StopConditionError } from "../src/types";
import worker, { runSharedCollection } from "../src/worker";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/index";
import { creditMenu } from "./synthetic-myjcb";

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
  /** The export links as observed on a confirmed month: relative, no month. */
  readonly observedExports?: boolean;
}): string {
  const headings = [
    ...(options.headings ?? []).map((heading) => `<h1>${heading}</h1>`),
    ...(options.months ?? []).map((month) => `<h2>${month}お支払い分のカードご利用明細</h2>`),
  ].join("");
  const exports =
    options.exportMonth === undefined
      ? ""
      : `<a href="/iss-pc/member/details_inquiry/detail.html?detailMonth=${options.exportMonth}&amp;output=csv">CSV</a>`;
  const observedExports = options.observedExports
    ? '<a href="detailDbPdf.html?output=pdf">PDF</a><a href="detail.html?output=csv">CSV</a><a href="detail.html?output=money">OFX</a>'
    : "";
  const ledger =
    options.head === null
      ? ""
      : `<div class="detail-list-01"><div class="head">${options.head ?? CONFIRMED_HEAD}</div>${(options.rows ?? []).join("")}</div>`;
  return `<!doctype html><html lang="ja"><body><h1>MyJCB</h1>${headings}<input type="hidden" name="generalJsonShikibetuId" value="synthetic-discriminator">${exports}${observedExports}${ledger}</body></html>`;
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
 * A credit menu listing `pages` as months and `schedules` under the schedule
 * heading, their pages, and an older-month API that lists `past` (by default
 * nothing available).
 */
function client(
  pages: Readonly<Record<number, string>>,
  past: readonly Record<string, unknown>[] = [],
  schedules: Readonly<Record<number, string>> = {},
): CreditReadClient {
  const menu = creditMenu(Object.keys(pages), Object.keys(schedules));
  return {
    get: async (operation, query) => {
      if (operation === "credit-menu") return response(menu);
      const position = Number(query?.get("detailMonth"));
      const html =
        operation === "credit-detail" ? (pages[position] ?? schedules[position]) : undefined;
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
    // Two pending cycles show different rows; the same page at both
    // positions is a repeated page (amendment (h)), tested on its own.
    const closedPending = page({
      head: UNCONFIRMED_HEAD,
      rows: [
        row("今回のお支払い金額", ["2026/01/20", "架空予約B", "一回払い", "4,000円"], "4,000円"),
      ],
    });
    const { artifacts } = await collectCredit(client({ 0: mutable, 1: closedPending }), "x");
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

  test("ADR 0026: an empty unknown page withholds nothing; an unknown page with rows is counted", async () => {
    const olderEmpty = page({
      head: UNCONFIRMED_HEAD,
      rows: [
        '<div class="content"><div class="item-cell"><div class="cell w-100per">ご利用明細はありません</div></div></div>',
      ],
    });
    const whole = await collectCredit(
      client({ 0: mutable, 1: closedWithoutExports, 7: olderEmpty }),
      "x",
    );
    expect(whole.unreadMonths).toEqual([]);
    // Rows at an older position without the heading: the page is kept as
    // `unknown` evidence with no ledger, so its rows reach no parser and the
    // month is not captured whole.
    const withheld = await collectCredit(
      client({
        0: mutable,
        1: closedWithoutExports,
        7: page({ rows: [confirmedRow] }),
        8: page({
          head: UNCONFIRMED_HEAD,
          rows: [
            row("今回のお支払い金額", ["2025/08/03", "架空旧店", "一回払い", "700円"], "700円"),
          ],
        }),
      }),
      "x",
    );
    expect(withheld.unreadMonths).toEqual([
      { position: 7, code: "rows_unstated" },
      { position: 8, code: "rows_unstated" },
    ]);
    expect(
      withheld.artifacts
        .filter((artifact) => artifact.statementState === "unknown")
        .map((artifact) => artifact.filename),
    ).toEqual(["credit-detail-07.html", "credit-detail-08.html"]);
  });

  test("a page whose heading and headers disagree stops the collection", async () => {
    const conflicting = page({ headings: [CONFIRMED_STATEMENT_HEADING], head: UNCONFIRMED_HEAD });
    const run = await collectCredit(client({ 0: mutable, 1: conflicting }), "x");
    // ADR 0005's amendment: the connection stops at position 1 and keeps
    // position 0. The second amendment keeps the page it stopped on as
    // `unknown` evidence with no ledger.
    expect(run.stop).toEqual({
      code: "credit_statement_state",
      position: 1,
      capturedMonthCount: 1,
    });
    expect(filenames(run.artifacts)).toEqual([
      "credit-menu.html",
      "credit-past-months.json",
      "credit-detail-00.html",
      "credit-ledger-00.json",
      "credit-detail-01.html",
    ]);
    // An `unknown` page states no period (amendment (h)).
    expect(run.artifacts.at(-1)).toMatchObject({ statementState: "unknown" });
    expect(run.artifacts.at(-1)?.period).toBeUndefined();
  });

  test("export links on a page that is not a confirmed statement stop the collection", async () => {
    const exporting = page({ head: UNCONFIRMED_HEAD, rows: [pendingRow], exportMonth: 1 });
    const run = await collectCredit(client({ 0: mutable, 1: exporting }), "x");
    expect(run.stop).toEqual({
      code: "credit_statement_state",
      position: 1,
      capturedMonthCount: 1,
    });
  });
});

function filenames(artifacts: readonly { filename: string }[]): string[] {
  return artifacts.map((artifact) => artifact.filename);
}

describe("ADR 0005 amendment: a stopped connection keeps the months before the stop", () => {
  const closed = (month: string) =>
    page({ headings: [CONFIRMED_STATEMENT_HEADING], months: [month], rows: [confirmedRow] });
  const pages = {
    0: mutable,
    1: closed("2026年3月"),
    2: closed("2026年2月"),
    3: closed("2026年1月"),
  };

  /** `client(pages)` whose read of one operation and month fails. */
  function failing(operation: string, month: number): CreditReadClient {
    const inner = client(pages);
    return {
      ...inner,
      get: async (op, query) => {
        if (op === operation && Number(query?.get("detailMonth")) === month) {
          throw new StopConditionError("synthetic upstream failure");
        }
        return await inner.get(op, query);
      },
    };
  }

  test("a month fetch failing at position k keeps positions < k and nothing from k on", async () => {
    const run = await collectCredit(failing("credit-detail", 2), "x");
    expect(run.stop).toEqual({ code: "month_fetch", position: 2, capturedMonthCount: 2 });
    expect(run.periodCount).toBe(4);
    expect(filenames(run.artifacts)).toEqual([
      "credit-menu.html",
      "credit-past-months.json",
      "credit-detail-00.html",
      "credit-ledger-00.json",
      "credit-detail-01.html",
      "credit-ledger-01.json",
    ]);
  });

  test("in fetch mode a failed export drops its whole month: the page and ledger read before it too", async () => {
    const exporting = page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      months: ["2026年2月"],
      rows: [confirmedRow],
      exportMonth: 2,
    });
    const inner = client({ ...pages, 2: exporting });
    const run = await collectCredit(
      {
        ...inner,
        get: async (op, query) =>
          op === "credit-csv" ? response("not a statement export") : await inner.get(op, query),
      },
      "x",
      { exports: "fetch" },
    );
    expect(run.stop).toEqual({ code: "export_fetch", position: 2, capturedMonthCount: 2 });
    // The page itself was read: an export stop keeps no stop page.
    expect(filenames(run.artifacts).filter((name) => /-0[23]\./u.test(name))).toEqual([]);
  });

  test("by default an offered export is recorded and not fetched (ADR 0005's second amendment)", async () => {
    const exporting = page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      months: ["2026年2月"],
      rows: [confirmedRow],
      exportMonth: 2,
    });
    const inner = client({ ...pages, 2: exporting });
    const reads: string[] = [];
    const run = await collectCredit(
      {
        ...inner,
        get: async (op, query) => {
          reads.push(op);
          return await inner.get(op, query);
        },
      },
      "x",
    );
    expect(run.stop).toBeUndefined();
    expect(run.exportOffers).toEqual([{ position: 2, kinds: ["csv"] }]);
    expect(reads.filter((op) => op.startsWith("credit-") && op !== "credit-detail")).toEqual([
      "credit-menu",
    ]);
    expect(filenames(run.artifacts).filter((name) => !/\.(?:html|json)$/u.test(name))).toEqual([]);
  });

  test("the observed month-less relative export links are recorded for their page's month", async () => {
    const exporting = page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      months: ["2026年2月"],
      rows: [confirmedRow],
      observedExports: true,
    });
    const run = await collectCredit(client({ ...pages, 2: exporting }), "x");
    expect(run.stop).toBeUndefined();
    expect(run.exportOffers).toEqual([{ position: 2, kinds: ["pdf", "csv", "ofx"] }]);
    // The same links on a page that is not a confirmed statement still stop it.
    const unconfirmed = page({ head: UNCONFIRMED_HEAD, rows: [pendingRow], observedExports: true });
    expect((await collectCredit(client({ 0: unconfirmed }), "x")).stop).toMatchObject({
      code: "credit_statement_state",
      position: 0,
    });
  });

  test("a period or ledger failure names its own stage", async () => {
    const unnamed = page({ headings: [CONFIRMED_STATEMENT_HEADING], rows: [confirmedRow] });
    expect((await collectCredit(client({ ...pages, 3: unnamed }), "x")).stop).toEqual({
      code: "credit_statement_period",
      position: 3,
      capturedMonthCount: 3,
    });
    const headless = page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      months: ["2026年1月"],
      head: "ご利用日 ご利用先など 支払区分",
      rows: [confirmedRow],
    });
    expect((await collectCredit(client({ ...pages, 3: headless }), "x")).stop).toEqual({
      code: "ledger_parse",
      position: 3,
      capturedMonthCount: 3,
    });
  });

  test("the stop log carries codes and counts only", async () => {
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      warnings.push(String(value));
    });
    try {
      await collectCredit(failing("credit-detail", 2), "x");
    } finally {
      spy.mockRestore();
    }
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: "myjcb-credit-month-failed",
        detailMonth: 2,
        code: "collect-credit-month-fetch",
        stopCode: "month_fetch",
        capturedMonthCount: 2,
        stopPageKept: false,
      },
    ]);
    expect(warnings.join("")).not.toContain("synthetic upstream failure");
  });

  test("a failure before the first month is thrown: the connection keeps nothing", async () => {
    const inner = client(pages);
    const menuFails: CreditReadClient = {
      ...inner,
      get: async (op, query) => {
        if (op === "credit-menu") throw new StopConditionError("synthetic upstream failure");
        return await inner.get(op, query);
      },
    };
    const stopped = collectCredit(menuFails, "x");
    await expect(stopped).rejects.toBeInstanceOf(StopConditionError);
    await expect(stopped).rejects.toMatchObject({ code: "collect-credit-menu" });
    const pastFails: CreditReadClient = {
      ...inner,
      postCreditPastJson: async () => {
        throw new StopConditionError("synthetic upstream failure");
      },
    };
    await expect(collectCredit(pastFails, "x")).rejects.toMatchObject({
      code: "collect-credit-past-months",
    });
  });

  test("every stop condition maps to a closed stage code", () => {
    expect(connectionStopCode(new HumanRequiredError("synthetic"))).toBe("human_required");
    expect(connectionStopCode(new StopConditionError("x", "passkey-assertion"))).toBe("login");
    expect(connectionStopCode(new StopConditionError("x", "login"))).toBe("login");
    expect(connectionStopCode(new StopConditionError("x", "collect-credit-menu"))).toBe(
      "credit_menu",
    );
    expect(connectionStopCode(new StopConditionError("x", "credit-ledger-cell-count"))).toBe(
      "ledger_parse",
    );
    expect(connectionStopCode(new StopConditionError("x", "collect-route"))).toBe("no_route");
    expect(connectionStopCode(new StopConditionError("x"))).toBe("unclassified");
    expect(connectionStopCode(new TypeError("x"))).toBe("unclassified");
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
    expect((await collectCredit(client({ 0: mutable, 1: march, 2: unnamed }), "x")).stop).toEqual({
      code: "credit_statement_period",
      position: 2,
      capturedMonthCount: 2,
    });
  });
});

describe("ADR 0005 amendment: the Worker keeps a stopped connection's months", () => {
  test("a session connection whose month 2 fails persists months 0 and 1 as a partial unit", async () => {
    const mypage =
      '<!doctype html><html><body><a href="/iss-pc/member/details_inquiry/detailMenu.html?link_id=synthetic">明細</a><a href="#">ログアウト</a></body></html>';
    const closed = (month: string) =>
      page({ headings: [CONFIRMED_STATEMENT_HEADING], months: [month], rows: [confirmedRow] });
    const pages: Record<number, string> = {
      0: mutable,
      1: closed("2026年3月"),
      2: closed("2026年2月"),
    };
    const menu = creditMenu(Object.keys(pages));
    const html = (text: string) =>
      new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/mypage.html")) return html(mypage);
      if (url.pathname.endsWith("/detailMenu.html")) return html(menu);
      if (url.pathname.endsWith("/detailPastJson.json")) {
        return Response.json({
          jsonrpc: "2.0",
          result: { errId: "0", errMessage: "", detailPastJsonInfo: [] },
          id: "030100601",
        });
      }
      const month = Number(url.searchParams.get("detailMonth"));
      // Month 2 fails at the provider.
      if (month === 2) return new Response("synthetic upstream error body", { status: 500 });
      return html(pages[month]!);
    }) as unknown as typeof fetch);
    const logs = [
      spyOn(console, "log").mockImplementation(() => {}),
      spyOn(console, "warn").mockImplementation(() => {}),
      spyOn(console, "error").mockImplementation(() => {}),
    ];
    const data = new FakeR2Bucket();
    try {
      const env = {
        COLLECTOR_SCHEMA_VERSION: "myjcb-worker-poc-v1",
        MYJCB_CONNECTIONS_JSON: JSON.stringify([
          {
            connectionId: "account-one",
            bootstrapMode: "session",
            userAgent: "synthetic-agent",
            cookies: [{ name: "synthetic", value: "synthetic-cookie" }],
          },
        ]),
        DATA: data,
      } as unknown as Env;
      // A partial run is a finished run: the cron does not throw.
      await worker.scheduled?.(
        { scheduledTime: Date.now(), cron: "0 21 * * *", noRetry: () => {} },
        env,
        { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
      );
    } finally {
      fetchSpy.mockRestore();
      logs.forEach((spy) => spy.mockRestore());
    }
    const terminal = [...data.entries.keys()].find((key) => key.startsWith("runs/myjcb/"))!;
    const runId = terminal.split("/")[2]!;
    const read = await readTerminal(data, "myjcb", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.safeErrorCode).toBe("month_fetch");
    expect(read.manifest.units).toEqual([
      {
        unitKey: "account-one",
        unitKind: "connection",
        artifactCount: 7,
        coverageStatus: "partial",
        safeErrorCode: "month_fetch",
      },
    ]);
    expect(read.manifest.artifacts.map((entry) => entry.artifactKey)).toEqual([
      "account-one/credit-detail-00.html",
      "account-one/credit-detail-01.html",
      "account-one/credit-ledger-00.json",
      "account-one/credit-ledger-01.json",
      "account-one/credit-menu.html",
      "account-one/credit-past-months.json",
      "account-one/discovery.json",
      "manifest.json",
    ]);
    const stored = read.manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!;
    const body = await data.get(stored.storageRef.key);
    const text = new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer()));
    const manifest = JSON.parse(text);
    expect(manifest.status).toBe("partial");
    expect(manifest.connections).toEqual([
      {
        jpointCode: "unsupported",
        connectionId: "account-one",
        bootstrapMode: "session",
        status: "partial",
        cardCount: 1,
        periodCount: 3,
        artifactCount: 7,
        stopCode: "month_fetch",
        stopPosition: 2,
        capturedMonthCount: 2,
      },
    ]);
    expect(manifest.failures).toEqual([
      { connectionId: "account-one", operation: "collect", code: "month_fetch", position: 2 },
    ]);
    expect(text).not.toContain("synthetic upstream error body");
    expect(text).not.toContain("HTTP 500");
  });
});

describe("ADR 0005 amendment: no stop path carries provider or error text", () => {
  // A digit string, a merchant-like word and a URL, as an upstream error or
  // body could carry them. Every value is synthetic.
  const LEAK_DIGITS = "4829173";
  const LEAK_WORD = "架空テスト商店";
  const leak = `synthetic ${LEAK_DIGITS} ${LEAK_WORD} https://example.invalid/${LEAK_DIGITS}`;
  const mypage =
    '<!doctype html><html><body><a href="/iss-pc/member/details_inquiry/detailMenu.html?link_id=synthetic">明細</a><a href="#">ログアウト</a></body></html>';
  const closed = (month: string) =>
    page({ headings: [CONFIRMED_STATEMENT_HEADING], months: [month], rows: [confirmedRow] });
  const pages: Record<number, string> = { 0: mutable, 1: closed("2026年3月") };
  const menu = creditMenu([0, 1, 2]);
  const html = (text: string) =>
    new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });

  /**
   * Run the manual trigger with `fail` deciding, per request, whether the
   * provider misbehaves; return every byte stored, every log line and the
   * HTTP response. `menuHtml` replaces the three-month menu.
   */
  async function run(
    fail: (url: URL) => Response | "throw" | undefined,
    menuHtml = menu,
  ): Promise<{ stored: string; logs: string; response: string; status: number }> {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const failure = fail(url);
      if (failure === "throw") throw new Error(leak);
      if (failure !== undefined) return failure;
      if (url.pathname.endsWith("/mypage.html")) return html(mypage);
      if (url.pathname.endsWith("/detailMenu.html")) return html(menuHtml);
      if (url.pathname.endsWith("/detailPastJson.json")) {
        return Response.json({
          jsonrpc: "2.0",
          result: { errId: "0", errMessage: "", detailPastJsonInfo: [] },
          id: "030100601",
        });
      }
      return html(pages[Number(url.searchParams.get("detailMonth"))]!);
    }) as unknown as typeof fetch);
    const lines: string[] = [];
    const capture = (...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    };
    const logs = [
      spyOn(console, "log").mockImplementation(capture),
      spyOn(console, "warn").mockImplementation(capture),
      spyOn(console, "error").mockImplementation(capture),
      spyOn(console, "info").mockImplementation(capture),
    ];
    // Bun lacks the Workers-only timing-safe comparison the trigger uses.
    const hadTimingSafeEqual = Reflect.has(crypto.subtle, "timingSafeEqual");
    if (!hadTimingSafeEqual) {
      Object.defineProperty(crypto.subtle, "timingSafeEqual", {
        configurable: true,
        value: (left: ArrayBuffer, right: ArrayBuffer) =>
          Buffer.from(left).equals(Buffer.from(right)),
      });
    }
    const data = new FakeR2Bucket();
    try {
      const env = {
        COLLECTOR_SCHEMA_VERSION: "myjcb-worker-poc-v1",
        MYJCB_CONNECTIONS_JSON: JSON.stringify([
          {
            connectionId: "account-one",
            bootstrapMode: "session",
            userAgent: "synthetic-agent",
            cookies: [{ name: "synthetic", value: "synthetic-cookie" }],
          },
        ]),
        DATA: data,
      } as unknown as Env;
      const response = await runSharedCollection(env, "scheduled");
      const decoder = new TextDecoder();
      const stored = [...data.entries.entries()]
        .map(([key, entry]) => `${key}\n${decoder.decode(entry.bytes)}`)
        .join("\n");
      return {
        stored,
        logs: lines.join("\n"),
        response: JSON.stringify(response),
        status: response.status,
      };
    } finally {
      fetchSpy.mockRestore();
      logs.forEach((spy) => spy.mockRestore());
      if (!hadTimingSafeEqual) Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
    }
  }

  function expectNoLeak(result: Awaited<ReturnType<typeof run>>): void {
    for (const text of [result.stored, result.logs, result.response]) {
      expect(text).not.toContain(LEAK_DIGITS);
      expect(text).not.toContain(LEAK_WORD);
      expect(text).not.toContain("example.invalid");
    }
  }

  const detail = (month: number) => (url: URL) =>
    url.pathname.endsWith("/detail.html") && url.searchParams.get("detailMonth") === String(month);
  const blockers = (result: Awaited<ReturnType<typeof run>>) =>
    (JSON.parse(result.response) as { blockers: unknown }).blockers;

  test("a thrown fetch at a month stops the connection with a code only", async () => {
    const result = await run((url) => (detail(2)(url) ? "throw" : undefined));
    expect(result.status).not.toBe("failed");
    expect(blockers(result)).toEqual([{ connectionId: "account-one", code: "month_fetch" }]);
    expect(result.stored).toContain('"safeErrorCode":"month_fetch"');
    // The capture sees the stop log and the diagnostics, so the check below reads them.
    expect(result.logs).toContain('"event":"myjcb-credit-month-failed"');
    expect(result.logs).toContain('"event":"collector-diagnostic"');
    expectNoLeak(result);
  });

  test("an error body or an unparsable page at a month never reaches a stored byte", async () => {
    const status = await run((url) =>
      detail(2)(url) ? new Response(leak, { status: 500 }) : undefined,
    );
    expect(blockers(status)).toEqual([{ connectionId: "account-one", code: "month_fetch" }]);
    expectNoLeak(status);
    // A page whose empty marker contradicts it: the month is dropped whole.
    const unparsable = await run((url) =>
      detail(2)(url)
        ? html(`<html><body><p>ご利用明細はありません</p><p>${leak}</p></body></html>`)
        : undefined,
    );
    expect(blockers(unparsable)).toEqual([{ connectionId: "account-one", code: "month_parse" }]);
    expectNoLeak(unparsable);
  });

  test("a month under the third ledger header is kept unread and the Worker persists the rest (ADR 0005's second amendment)", async () => {
    const scheduled = page({
      head: '<div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div>',
      rows: [row("お支払日", ["2026/03/10", LEAK_WORD, "2026/04/10", `${LEAK_DIGITS}円`], "1円")],
    });
    const result = await run((url) => (detail(2)(url) ? html(scheduled) : undefined));
    expect(result.status).not.toBe("failed");
    expect(blockers(result)).toEqual([
      { connectionId: "account-one", code: "scheduled_payments_page" },
    ]);
    // The terminal's unit and the manifest carry the closed code and the
    // position; no failure is recorded, because the connection did not stop.
    expect(result.stored).toContain('"safeErrorCode":"scheduled_payments_page"');
    expect(result.stored).toContain(
      '"unreadMonths":[{"position":2,"code":"scheduled_payments_page"}]',
    );
    expect(result.stored).toContain('"failures":[]');
    expect(result.stored).toContain('"coverageStatus":"partial"');
    // The unread month's page is stored as evidence (it carries the synthetic
    // row text, as every stored page carries its rows); no ledger is derived.
    expect(result.stored).not.toContain('"detailMonth":2');
    expect(result.logs).toContain(
      '{"event":"myjcb-credit-month-unread","detailMonth":2,"code":"scheduled_payments_page"}',
    );
    expect(result.logs).not.toContain(LEAK_DIGITS);
    expect(result.logs).not.toContain(LEAK_WORD);
    expect(result.response).not.toContain(LEAK_DIGITS);
  });

  test("a skip page with rows leaves the unit complete: stored unread, recorded beside the months (ADR 0005's amendment (c))", async () => {
    // Months 0 and 1 under their headings, positions 7 and 8 under the
    // schedule heading: 8 shows rows under the third header, 7 fails with an
    // error body that must reach nothing.
    const skipPage = page({
      headings: ["ショッピングスキップ払いご利用明細(未確定分)"],
      head: '<div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div>',
      rows: [row("お支払日", ["2026/03/10", "架空分割店", "2026/04/10", "3,000円"], "1円")],
    });
    const result = await run(
      (url) =>
        detail(8)(url)
          ? html(skipPage)
          : detail(7)(url)
            ? new Response(leak, { status: 500 })
            : undefined,
      creditMenu([0, 1], [7, 8]),
    );
    expect(result.status).not.toBe("failed");
    expect(blockers(result)).toEqual([]);
    // The unit covers the months, which were read whole.
    expect(result.stored).toContain('"coverageStatus":"complete"');
    expect(result.stored).not.toContain("safeErrorCode");
    expect(result.stored).not.toContain("unreadMonths");
    expect(result.stored).toContain('"failures":[]');
    // The schedule pages are recorded with closed codes, and only the one
    // that was fetched is stored.
    expect(result.stored).toContain(
      '"schedulePages":[{"position":7,"code":"schedule_page_fetch"},{"position":8,"code":"scheduled_payments_page"}],"schedulePageCount":1',
    );
    expect(result.stored).toContain('"periodCount":2');
    // The skip page is named by its h1, the name registration reads
    // (amendment (e)).
    expect(result.stored).toContain("account-one/credit-skip-payment-08.html");
    expect(result.stored).not.toContain("credit-schedule-08");
    expect(result.stored).not.toContain("credit-schedule-07");
    expect(result.stored).not.toContain("credit-detail-08");
    expect(result.stored).toContain('"dataset":"credit-schedule"');
    expect(result.logs).toContain(
      '{"event":"myjcb-credit-schedule-page-failed","detailMonth":7,"code":"schedule_page_fetch"}',
    );
    expectNoLeak(result);
  });

  test("a menu heading nobody observed stops before any month, with a code only", async () => {
    const result = await run(
      () => undefined,
      creditMenu([0, 1]).replace(
        "</body>",
        `<h2>${LEAK_WORD}</h2><a href="detail.html?detailMonth=2">x</a></body>`,
      ),
    );
    expect(result.status).toBe("failed");
    expect(blockers(result)).toEqual([
      { connectionId: "account-one", code: "credit_menu_group_unrecognized" },
    ]);
    expect(result.stored).toContain('"safeErrorCode":"credit_menu_group_unrecognized"');
    expect(result.logs).toContain('"event":"myjcb-credit-menu-groups"');
    expectNoLeak(result);
  });

  test("a stop before the first month or at login leaves codes only", async () => {
    const menuStop = await run((url) =>
      url.pathname.endsWith("/detailMenu.html") ? "throw" : undefined,
    );
    expect(menuStop.status).toBe("failed");
    expect(blockers(menuStop)).toEqual([{ connectionId: "account-one", code: "credit_menu" }]);
    expect(menuStop.stored).toContain('"safeErrorCode":"credit_menu"');
    expectNoLeak(menuStop);
    const loginStop = await run((url) =>
      url.pathname.endsWith("/mypage.html") ? "throw" : undefined,
    );
    expect(blockers(loginStop)).toEqual([{ connectionId: "account-one", code: "login" }]);
    expectNoLeak(loginStop);
    const pastStop = await run((url) =>
      url.pathname.endsWith("/detailPastJson.json") ? new Response(leak) : undefined,
    );
    expect(blockers(pastStop)).toEqual([
      { connectionId: "account-one", code: "credit_past_months" },
    ]);
    expectNoLeak(pastStop);
  });
});

describe("ADR 0005 second amendment: the three observed ledger headers", () => {
  // The third header as the live DOM shows it on the ショッピングスキップ払い
  // page (observed 2026-09-27, position 8): three cells, the second holding
  // 「ご利用先など」 and 「お支払日」 on two lines. Every value below is synthetic.
  const SCHEDULED_HEAD =
    '<div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div>';
  // The same labels as four cells, as the first survey wrote them down.
  const FOUR_CELL_SCHEDULED_HEAD = "ご利用日 ご利用先など お支払日 今後のお支払い金額";
  const emptyRow =
    '<div class="content"><div class="item-cell"><div class="cell w-100per">ご利用明細はありません</div></div></div>';
  const scheduledRow = row(
    "お支払日",
    ["2026/03/10", "架空分割店", "2026/04/10", "3,000円"],
    "2026/04/10",
  );
  const closed = (month: string) =>
    page({ headings: [CONFIRMED_STATEMENT_HEADING], months: [month], rows: [confirmedRow] });

  test("only the third header's ledgers are counted as scheduled", () => {
    expect(scheduledLedgerRowCount(closed("2026年2月"))).toBeUndefined();
    expect(scheduledLedgerRowCount(mutable)).toBeUndefined();
    expect(scheduledLedgerRowCount(page({ head: null }))).toBeUndefined();
    expect(scheduledLedgerRowCount(page({ head: SCHEDULED_HEAD, rows: [emptyRow] }))).toBe(0);
    expect(scheduledLedgerRowCount(page({ head: SCHEDULED_HEAD, rows: [scheduledRow] }))).toBe(1);
    // The four-cell form is the same header: its rows are counted as
    // scheduled, so they are kept unread, never read as a statement.
    expect(
      scheduledLedgerRowCount(page({ head: FOUR_CELL_SCHEDULED_HEAD, rows: [scheduledRow] })),
    ).toBe(1);
    // Whitespace and markup inside the header are not part of it.
    expect(
      scheduledLedgerRowCount(
        page({
          head: "<span>ご利用日</span>\n<span>ご利用先 など</span><span>お支払日</span><span>今後の お支払い金額</span>",
          rows: [scheduledRow],
        }),
      ),
    ).toBe(1);
    // A header that also shows a label of a read header set, or lacks one of
    // the third header's labels, is not the third header.
    expect(
      scheduledLedgerRowCount(page({ head: `${SCHEDULED_HEAD} 支払区分`, rows: [scheduledRow] })),
    ).toBeUndefined();
    expect(
      scheduledLedgerRowCount(
        page({ head: "ご利用日 ご利用先など 今後のお支払い金額", rows: [scheduledRow] }),
      ),
    ).toBeUndefined();
  });

  test("the page reading alone would stop on third-header rows, which is why they are read first", () => {
    // Without the heading at position 1: rows under no read amount label.
    expect(
      stopCode(() => creditStatementState(page({ head: SCHEDULED_HEAD, rows: [scheduledRow] }), 1)),
    ).toBe("credit-statement-state");
    // Under the heading: confirmed, and then the ledger's header set is missing.
    const headed = page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      months: ["2026年2月"],
      head: SCHEDULED_HEAD,
      rows: [scheduledRow],
    });
    expect(creditStatementState(headed, 1)).toBe("confirmed");
    expect(stopCode(() => parseCreditLedger(headed, "confirmed"))).toBe("credit-ledger-headers");
  });

  test("all three headers in one connection: the third is kept unread and the connection goes on", async () => {
    const run = await collectCredit(
      client({
        // The unconfirmed header, rows.
        0: mutable,
        // The confirmed header, rows.
        1: closed("2026年3月"),
        // The third header with rows, under the heading: captured unread.
        2: page({
          headings: [CONFIRMED_STATEMENT_HEADING],
          months: ["2026年2月"],
          head: SCHEDULED_HEAD,
          rows: [scheduledRow],
        }),
        // A later month is still read.
        3: closed("2026年1月"),
        // No ledger at all, as months 3 to 6 of the surveyed connection.
        5: page({ head: null }),
        // The unconfirmed header, empty, as position 7 was observed.
        7: page({ head: UNCONFIRMED_HEAD, rows: [emptyRow] }),
        // The third header, empty, as position 8 was observed: nothing withheld.
        8: page({ head: SCHEDULED_HEAD, rows: [emptyRow] }),
      }),
      "x",
    );
    expect(run.stop).toBeUndefined();
    expect(run.unreadMonths).toEqual([{ position: 2, code: "scheduled_payments_page" }]);
    const states = Object.fromEntries(
      run.artifacts.map((artifact) => [artifact.filename, artifact.statementState ?? null]),
    );
    expect(states).toEqual({
      "credit-menu.html": null,
      "credit-past-months.json": null,
      "credit-detail-00.html": "unconfirmed",
      "credit-ledger-00.json": "unconfirmed",
      "credit-detail-01.html": "confirmed",
      "credit-ledger-01.json": "confirmed",
      // The page is kept; no ledger is derived from its rows.
      "credit-detail-02.html": "unknown",
      "credit-detail-03.html": "confirmed",
      "credit-ledger-03.json": "confirmed",
      "credit-detail-05.html": "unknown",
      "credit-detail-07.html": "unknown",
      "credit-detail-08.html": "unknown",
    });
    // The unread month is read as `unknown`: it states no period
    // (amendment (h)); its position stays in its file name.
    expect(
      run.artifacts.find((artifact) => artifact.filename === "credit-detail-02.html")?.period,
    ).toBeUndefined();
  });

  test("third-header rows in the four-cell form are kept unread, never read", async () => {
    const run = await collectCredit(
      client({
        0: mutable,
        1: closed("2026年3月"),
        8: page({ head: FOUR_CELL_SCHEDULED_HEAD, rows: [scheduledRow] }),
      }),
      "x",
    );
    expect(run.stop).toBeUndefined();
    expect(run.unreadMonths).toEqual([{ position: 8, code: "scheduled_payments_page" }]);
    expect(filenames(run.artifacts).filter((name) => name.endsWith("-08.json"))).toEqual([]);
  });

  test("third-header rows at positions 0 and 1 are kept unread too", async () => {
    const scheduled = page({ head: SCHEDULED_HEAD, rows: [scheduledRow] });
    const run = await collectCredit(
      client({ 0: scheduled, 1: scheduled, 2: closed("2026年2月") }),
      "x",
    );
    expect(run.stop).toBeUndefined();
    expect(run.unreadMonths).toEqual([
      { position: 0, code: "scheduled_payments_page" },
      { position: 1, code: "scheduled_payments_page" },
    ]);
    expect(filenames(run.artifacts).filter((name) => name.startsWith("credit-ledger"))).toEqual([
      "credit-ledger-02.json",
    ]);
  });

  test("an unobserved header with rows still stops, and the page it stopped on is kept", async () => {
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      warnings.push(String(value));
    });
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      run = await collectCredit(
        client({
          0: mutable,
          1: page({
            headings: [CONFIRMED_STATEMENT_HEADING],
            months: ["2026年3月"],
            head: "ご利用日 ご利用先など 架空の見出し",
            rows: [confirmedRow],
          }),
          2: closed("2026年2月"),
        }),
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(run.stop).toEqual({ code: "ledger_parse", position: 1, capturedMonthCount: 1 });
    expect(filenames(run.artifacts)).toEqual([
      "credit-menu.html",
      "credit-past-months.json",
      "credit-detail-00.html",
      "credit-ledger-00.json",
      "credit-detail-01.html",
    ]);
    expect(run.artifacts.at(-1)).toMatchObject({
      dataset: "credit-detail",
      statementState: "unknown",
    });
    expect(run.artifacts.at(-1)?.period).toBeUndefined();
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: "myjcb-credit-month-failed",
        detailMonth: 1,
        code: "credit-ledger-headers",
        stopCode: "ledger_parse",
        capturedMonthCount: 1,
        stopPageKept: true,
      },
    ]);
  });

  test("the credit menu is read before any detail page, once", async () => {
    const inner = client({ 0: mutable, 1: closed("2026年3月"), 2: closed("2026年2月") });
    const reads: string[] = [];
    await collectCredit(
      {
        get: async (op, query) => {
          reads.push(op);
          return await inner.get(op, query);
        },
        postCreditPastJson: async (input) => {
          reads.push("credit-past-json");
          return await inner.postCreditPastJson(input);
        },
      },
      "x",
    );
    expect(reads).toEqual([
      "credit-menu",
      "credit-detail",
      "credit-past-json",
      "credit-detail",
      "credit-detail",
    ]);
  });
});

describe("ADR 0005 amendment (c): the menu's schedule pages are not months", () => {
  const closed = (month: string) =>
    page({ headings: [CONFIRMED_STATEMENT_HEADING], months: [month], rows: [confirmedRow] });
  // The ショッピングスキップ払い page as observed at position 8: its own h1
  // and the third header with rows. Every value is synthetic.
  const skipPage = page({
    headings: ["ショッピングスキップ払いご利用明細(未確定分)"],
    head: '<div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div>',
    rows: [row("お支払日", ["2026/03/10", "架空分割店", "2026/04/10", "3,000円"], "2026/04/10")],
  });
  // Position 7 has not been observed with rows: any page is kept alike.
  const bonusPage = page({ head: UNCONFIRMED_HEAD });

  test("schedule pages are read after the months, stored unread, and never count as months", async () => {
    const inner = client({ 0: mutable, 1: closed("2026年3月") }, [], { 7: bonusPage, 8: skipPage });
    const reads: string[] = [];
    const run = await collectCredit(
      {
        get: async (op, query) => {
          reads.push(`${op}:${query?.get("detailMonth") ?? ""}`);
          return await inner.get(op, query);
        },
        postCreditPastJson: async (input) => {
          reads.push("credit-past-json");
          return await inner.postCreditPastJson(input);
        },
      },
      "x",
    );
    expect(reads).toEqual([
      "credit-menu:",
      "credit-detail:0",
      "credit-past-json",
      "credit-detail:1",
      "credit-detail:7",
      "credit-detail:8",
    ]);
    expect(run.stop).toBeUndefined();
    expect(run.unreadMonths).toEqual([]);
    expect(run.periodCount).toBe(2);
    expect(run.schedulePages).toEqual([
      { position: 7, code: "scheduled_payments_page" },
      { position: 8, code: "scheduled_payments_page" },
    ]);
    expect(
      run.artifacts.map((artifact) => [
        artifact.dataset,
        artifact.filename,
        artifact.statementState ?? null,
        artifact.period ?? null,
      ]),
    ).toEqual([
      ["credit-menu", "credit-menu.html", null, null],
      ["credit-past-months", "credit-past-months.json", null, null],
      ["credit-detail", "credit-detail-00.html", "unconfirmed", "detailMonth-0"],
      ["credit-ledger", "credit-ledger-00.json", "unconfirmed", "detailMonth-0"],
      ["credit-detail", "credit-detail-01.html", "confirmed", "2026-03"],
      ["credit-ledger", "credit-ledger-01.json", "confirmed", "2026-03"],
      // Stored whole and redacted, with the relative label no reader resolves.
      // The ショッピングスキップ払い page is named by its h1 (amendment (e));
      // the page without it stays unread under the old name.
      ["credit-schedule", "credit-schedule-07.html", "unknown", "detailMonth-7"],
      ["credit-schedule", "credit-skip-payment-08.html", "unknown", "detailMonth-8"],
    ]);
  });

  test("a schedule page that fails to fetch is recorded, not a stop, and the next one is read", async () => {
    const inner = client({ 0: mutable, 1: closed("2026年3月") }, [], { 7: bonusPage, 8: skipPage });
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      warnings.push(String(value));
    });
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      run = await collectCredit(
        {
          get: async (op, query) => {
            if (query?.get("detailMonth") === "7")
              throw new Error("synthetic upstream failure 4829173");
            return await inner.get(op, query);
          },
          postCreditPastJson: inner.postCreditPastJson,
        },
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(run.stop).toBeUndefined();
    expect(run.schedulePages).toEqual([
      { position: 7, code: "schedule_page_fetch" },
      { position: 8, code: "scheduled_payments_page" },
    ]);
    expect(
      filenames(run.artifacts).filter(
        (name) => name.startsWith("credit-schedule") || name.startsWith("credit-skip-payment"),
      ),
    ).toEqual(["credit-skip-payment-08.html"]);
    expect(warnings).toEqual([
      '{"event":"myjcb-credit-schedule-page-failed","detailMonth":7,"code":"schedule_page_fetch"}',
    ]);
  });

  test("a stopped month reads no schedule page", async () => {
    const reads: string[] = [];
    const inner = client({ 0: mutable, 1: page({ rows: [confirmedRow] }) }, [], { 8: skipPage });
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      run = await collectCredit(
        {
          get: async (op, query) => {
            reads.push(`${op}:${query?.get("detailMonth") ?? ""}`);
            return await inner.get(op, query);
          },
          postCreditPastJson: inner.postCreditPastJson,
        },
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(run.stop).toMatchObject({ code: "credit_statement_state", position: 1 });
    expect(run.schedulePages).toEqual([]);
    expect(reads).not.toContain("credit-detail:8");
  });

  test("an unrecognised menu heading, or a schedule position the past-months response offers, stops before any month", async () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unrecognized: CreditReadClient = {
        ...client({ 0: mutable }),
        get: async (op, query) =>
          op === "credit-menu"
            ? response(
                '<h2>最新のご利用明細</h2><a href="detail.html?detailMonth=0">明細を見る</a><h2>架空の明細</h2><a href="detail.html?detailMonth=8">明細を見る</a>',
              )
            : await client({ 0: mutable }).get(op, query),
      };
      const menuStop = collectCredit(unrecognized, "x");
      await expect(menuStop).rejects.toMatchObject({ code: "credit-menu-group" });
      expect(connectionStopCode(new StopConditionError("x", "credit-menu-group"))).toBe(
        "credit_menu_group_unrecognized",
      );
      const pastStop = collectCredit(
        client({ 0: mutable }, [{ detailMonth: "8", detailAvailableFlag: "1" }], { 8: skipPage }),
        "x",
      );
      await expect(pastStop).rejects.toMatchObject({ code: "collect-credit-past-months" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ADR 0005 amendment (d): a confirmed page under the usage header", () => {
  // The production row shape: the payment type inside the combined
  // ご利用先など／支払区分 cell (`1回払`), a two-character label, the amount.
  // Every value is synthetic.
  const usageRow = (merchantCell: string, amount: string) =>
    row("ご利用金額", ["2026/01/05", merchantCell, "架空", amount], amount);
  const total = (amount: string) =>
    `<div class="detail-box-price-01"><dl><dt>2026年2月10日(火)お支払い金額合計</dt><dd>${amount}</dd></dl></div>`;
  /** A closed page whose ledger shows 「ご利用金額」, with the given rows and total blocks. */
  const usagePage = (rows: readonly string[], totals: readonly string[] = [total("3,500円")]) =>
    page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      months: ["2026年2月"],
      head: UNCONFIRMED_HEAD,
      rows,
    }).replace("</body>", `${totals.join("")}</body>`);
  const provenRows = [
    usageRow("架空商店A 1回払", "1,000円"),
    usageRow("架空商店B 1回払い", "3,000円"),
    // A refund row counts with its sign.
    usageRow("架空商店C 1回払", "-500円"),
  ];
  const proven = usagePage(provenRows);

  /** The stop code and the logged usage-header reason of one reading. */
  function refusal(html: string, detailMonth = 1): { code?: string; logs: unknown[] } {
    const lines: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      lines.push(String(value));
    });
    try {
      return {
        code: stopCode(() => creditStatementState(html, detailMonth)),
        logs: lines.map((line) => JSON.parse(line)),
      };
    } finally {
      spy.mockRestore();
    }
  }

  test("accepted when every row is one single payment and the exact sum is the page total", () => {
    for (const detailMonth of [1, 2, 5]) {
      expect(creditStatementState(proven, detailMonth)).toBe("confirmed");
    }
    // Whitespace and full-width digits in the total read as the ledger parser reads them.
    expect(creditStatementState(usagePage(provenRows, [total(" ３，５００ 円 ")]), 1)).toBe(
      "confirmed",
    );
    // A second ledger without rows leaves the stored first ledger complete.
    const secondEmpty = usagePage(provenRows, [
      `<div class="detail-list-01"><div class="head">${UNCONFIRMED_HEAD}</div></div>`,
      total("3,500円"),
    ]);
    expect(creditStatementState(secondEmpty, 1)).toBe("confirmed");
    expect(parseCreditLedger(secondEmpty, "confirmed")?.rows).toHaveLength(3);
    // The stored ledger carries the header the page shows, and the expanded
    // labels of a confirmed page; nothing records a row's 今回のお支払い金額.
    expect(parseCreditLedger(proven, "confirmed")).toEqual({
      state: "confirmed",
      headers: ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"],
      rows: [
        {
          summaryCells: ["2026/01/05", "架空商店A 1回払", "架空", "1,000円"],
          expanded: { ご利用金額: "1,000円", 摘要: "架空摘要", 今回回数: "1" },
        },
        {
          summaryCells: ["2026/01/05", "架空商店B 1回払い", "架空", "3,000円"],
          expanded: { ご利用金額: "3,000円", 摘要: "架空摘要", 今回回数: "1" },
        },
        {
          summaryCells: ["2026/01/05", "架空商店C 1回払", "架空", "-500円"],
          expanded: { ご利用金額: "-500円", 摘要: "架空摘要", 今回回数: "1" },
        },
      ],
    });
  });

  test("refused, and stopped as before, unless the page proves it; the log names the closed reason", () => {
    for (const [html, reason] of [
      // One installment row, even when the sum still matches.
      [
        usagePage([usageRow("架空商店A 分割払い", "1,000円"), ...provenRows.slice(1)]),
        "usage_header_payment_type_unproven",
      ],
      [
        usagePage([usageRow("架空商店A 2回払", "1,000円"), ...provenRows.slice(1)]),
        "usage_header_payment_type_unproven",
      ],
      [
        usagePage([usageRow("架空商店A リボ払", "1,000円"), ...provenRows.slice(1)]),
        "usage_header_payment_type_unproven",
      ],
      // A cell with no payment type at all, or an empty one.
      [
        usagePage([usageRow("架空商店A", "1,000円"), ...provenRows.slice(1)]),
        "usage_header_payment_type_unproven",
      ],
      [
        usagePage([usageRow("", "1,000円"), ...provenRows.slice(1)]),
        "usage_header_payment_type_unproven",
      ],
      // A row whose cells cannot be read.
      [
        usagePage([
          row("ご利用金額", ["2026/01/05", "架空商店A 1回払", "1,000円"], "1,000円"),
          ...provenRows.slice(1),
        ]),
        "usage_header_payment_type_unproven",
      ],
      // No total, two totals, an unreadable total.
      [usagePage(provenRows, []), "usage_header_total_missing"],
      [usagePage(provenRows, [total("3,500円"), total("3,500円")]), "usage_header_total_missing"],
      [usagePage(provenRows, [total("3,50円")]), "usage_header_total_missing"],
      [usagePage(provenRows, [total("")]), "usage_header_total_missing"],
      // A sum that is not the total, by one yen.
      [usagePage(provenRows, [total("3,501円")]), "usage_header_total_mismatch"],
      // A row amount that does not read.
      [
        usagePage([usageRow("架空商店A 1回払", "1,0円"), ...provenRows.slice(1)]),
        "usage_header_total_mismatch",
      ],
      // An empty usage-header ledger proves only a zero total.
      [usagePage([]), "usage_header_total_mismatch"],
      // Rows in a second ledger, even ones that complete the sum: the
      // collector stores the first ledger only, so the stored rows would be
      // incomplete.
      [
        usagePage(provenRows.slice(0, 2), [
          `<div class="detail-list-01"><div class="head">${UNCONFIRMED_HEAD}</div>${provenRows[2]}</div>`,
          total("3,500円"),
        ]),
        "usage_header_rows_outside_first_ledger",
      ],
      [
        usagePage(provenRows, [
          `<div class="detail-list-01"><div class="head">架空見出し</div>${provenRows[2]}</div>`,
          total("3,500円"),
        ]),
        "usage_header_rows_outside_first_ledger",
      ],
    ] as const) {
      const { code, logs } = refusal(html);
      expect(code).toBe("credit-statement-state");
      expect(logs).toEqual([
        expect.objectContaining({ event: "myjcb-credit-statement-state", usageHeader: reason }),
      ]);
      // Codes and counts only: no amount and no provider text reaches the log.
      expect(JSON.stringify(logs)).not.toMatch(/円|架空|[0-9],[0-9]/u);
      // Called directly, the ledger reader still refuses the unproven page.
      expect(stopCode(() => parseCreditLedger(html, "confirmed"))).toBe("credit-ledger-headers");
    }
  });

  test("the rules outside the proof are unchanged", () => {
    // Position 0 never states a closed statement, proven or not.
    expect(refusal(proven, 0).code).toBe("credit-statement-state");
    // Without the heading the same rows are the mutable statement.
    const withoutHeading = proven.replace(`<h1>${CONFIRMED_STATEMENT_HEADING}</h1>`, "");
    expect(creditStatementState(withoutHeading, 0)).toBe("unconfirmed");
    expect(creditStatementState(withoutHeading, 1)).toBe("unconfirmed");
    expect(parseCreditLedger(withoutHeading, "unconfirmed")?.headers).toEqual([
      "ご利用日",
      "ご利用先など",
      "支払区分",
      "ご利用金額",
    ]);
    // The confirmed header needs no proof, and is stored as before.
    expect(parseCreditLedger(closedWithoutExports, "confirmed")?.headers).toEqual([
      "ご利用日",
      "ご利用先など",
      "支払区分",
      "今回のお支払い金額",
    ]);
    // A second heading or a second ledger header is a conflict whatever the rows prove.
    expect(
      refusal(proven.replace("<h2>", `<h1>${CONFIRMED_STATEMENT_HEADING}</h1><h2>`)).code,
    ).toBe("credit-statement-state");
    expect(
      refusal(
        proven.replace(
          "</body>",
          `<div class="detail-list-01"><div class="head">${CONFIRMED_HEAD}</div></div></body>`,
        ),
      ).logs,
    ).toEqual([expect.objectContaining({ usageHeader: null })]);
  });

  test("collectCredit stores the proven month as confirmed under the header it shows", async () => {
    const { artifacts, stop } = await collectCredit(client({ 0: mutable, 1: proven }), "x");
    expect(stop).toBeUndefined();
    const states = Object.fromEntries(
      artifacts.map((artifact) => [artifact.filename, artifact.statementState ?? null]),
    );
    expect(states).toMatchObject({
      "credit-detail-01.html": "confirmed",
      "credit-ledger-01.json": "confirmed",
    });
    const ledger = artifacts.find((artifact) => artifact.filename === "credit-ledger-01.json");
    expect(JSON.parse(String(ledger?.body))).toMatchObject({
      period: "2026-02",
      state: "confirmed",
      headers: ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"],
    });
    // Unproven, the month stops the connection as before and keeps its page.
    const refused = await collectCredit(
      client({ 0: mutable, 1: usagePage(provenRows, [total("3,501円")]) }),
      "x",
    );
    expect(refused.stop).toMatchObject({ code: "credit_statement_state", position: 1 });
  });
});

describe("ADR 0005 amendment (f): ledger labels match across line breaks", () => {
  // The head as every stored confirmed page shows it (round-5 survey,
  // 2026-09-28, structure only): three cells, the middle one two `span.row`,
  // the amount label broken by a `br` that only narrow screens render.
  const OBSERVED_CONFIRMED_HEAD =
    '<div class="cell">ご利用日</div><div class="cell"><span class="row">ご利用先など</span><span class="row">支払区分</span></div><div class="cell">今回の<br class="pc-none">お支払い金額</div>';
  const observedRow =
    '<div class="content"><div class="item-cell"><div class="cell">2026/01/05</div><div class="cell"><span class="row wb-bw">架空商店</span><span class="row">1回払い</span></div><div class="cell">1,000円</div><button class="cell toggle" type="button">詳細</button></div><div class="item-more"><ul class="list"><li><span>ご利用金額</span><span>1,000円</span></li><li><span>摘要</span><span>架空摘要</span></li></ul></div></div>';
  const confirmedPage = (head: string) =>
    page({
      headings: [CONFIRMED_STATEMENT_HEADING],
      months: ["2026年2月"],
      head,
      rows: [observedRow],
    });

  test("a confirmed page whose amount label has a <br> is confirmed and its ledger is read", () => {
    const html = confirmedPage(OBSERVED_CONFIRMED_HEAD);
    expect(creditStatementState(html, 1)).toBe("confirmed");
    const ledger = parseCreditLedger(html, "confirmed");
    expect(ledger).toEqual({
      state: "confirmed",
      headers: ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"],
      rows: [
        {
          // Cell values keep their space-joined text: only labels are compacted.
          summaryCells: ["2026/01/05", "架空商店 1回払い", "1,000円", "詳細"],
          expanded: { ご利用金額: "1,000円", 摘要: "架空摘要" },
        },
      ],
    });
  });

  test("a <br> inside 「ご利用先など」 or 「支払区分」 is matched the same way", () => {
    for (const head of [
      OBSERVED_CONFIRMED_HEAD.replace("ご利用先など", "ご利用<br>先など"),
      OBSERVED_CONFIRMED_HEAD.replace("支払区分", '支払<br class="pc-none">区分'),
      OBSERVED_CONFIRMED_HEAD.replace("ご利用日", "ご利用<br>\n日"),
    ]) {
      expect(stopCode(() => parseCreditLedger(confirmedPage(head), "confirmed"))).toBeUndefined();
    }
  });

  test("only whitespace is ignored: a different label still stops", () => {
    for (const head of [
      OBSERVED_CONFIRMED_HEAD.replace("お支払い金額", "ご請求金額"),
      OBSERVED_CONFIRMED_HEAD.replace("今回の<br", "今回<br"),
      OBSERVED_CONFIRMED_HEAD.replace("支払区分", "支払<b>・</b>区分"),
    ]) {
      expect(stopCode(() => parseCreditLedger(confirmedPage(head), "confirmed"))).toBe(
        "credit-ledger-headers",
      );
    }
  });

  test("collectCredit stores the observed confirmed month instead of stopping at position 1", async () => {
    const { artifacts, stop } = await collectCredit(
      client({ 0: mutable, 1: confirmedPage(OBSERVED_CONFIRMED_HEAD) }),
      "x",
    );
    expect(stop).toBeUndefined();
    const states = Object.fromEntries(
      artifacts.map((artifact) => [artifact.filename, artifact.statementState ?? null]),
    );
    expect(states).toMatchObject({
      "credit-detail-01.html": "confirmed",
      "credit-ledger-01.json": "confirmed",
    });
  });

  // The empty schedule pages as stored (positions 7 and 8): the head, then
  // one row of one `w-100per` cell with the provider's empty marker.
  const OBSERVED_SKIP_HEAD =
    '<div class="cell">ご利用日</div><div class="cell"><span class="row">ご利用先など</span><span class="row">お支払日</span></div><div class="cell">今後のお支払い金額</div>';
  const markerRow =
    '<div class="content"><div class="item-cell"><div class="cell w-100per">ご利用明細はございません。</div></div></div>';
  const scheduledRow =
    '<div class="content"><div class="item-cell"><div class="cell">2026/03/10</div><div class="cell"><span class="row">架空分割店</span><span class="row">2026/04/10</span></div><div class="cell">3,000円</div></div></div>';

  test("an empty schedule ledger (the marker row alone) counts zero scheduled rows", () => {
    expect(scheduledLedgerRowCount(page({ head: OBSERVED_SKIP_HEAD, rows: [markerRow] }))).toBe(0);
    // The marker row never hides a real row next to it.
    expect(
      scheduledLedgerRowCount(page({ head: OBSERVED_SKIP_HEAD, rows: [markerRow, scheduledRow] })),
    ).toBe(1);
  });
});

describe("ADR 0005 amendment (g): the statement heading may carry its payment day", () => {
  // The confirmed page's h2 as the round-5 survey shows it (structure only):
  // 「YYYY年MM月DD日(曜)お支払い分のカードご利用明細」. Earlier stored pages show
  // the undated 「YYYY年M月お支払い分のカードご利用明細」; both are read.
  const closed = (months: readonly string[]) =>
    page({ headings: [CONFIRMED_STATEMENT_HEADING], months, rows: [confirmedRow] });
  const period = (html: string, detailMonth: number, settlementYM?: string) =>
    creditStatementPeriod({
      html,
      detailMonth,
      state: creditStatementState(html, detailMonth),
      settlementYM,
    });

  test("a dated heading names its payment month", () => {
    expect(period(closed(["2026年02月27日(金)"]), 1)).toBe("2026-02");
    expect(period(closed(["2026年2月27日(金)"]), 3)).toBe("2026-02");
    expect(period(closed(["2026年 10月 <span>5日</span>\n(月) "]), 1)).toBe("2026-10");
    // The undated heading is read as before.
    expect(period(closed(["2026年2月"]), 1)).toBe("2026-02");
    // A labelled month must agree with the dated heading's month.
    expect(period(closed(["2026年2月27日(金)"]), 10, "202602")).toBe("202602");
    expect(stopCode(() => period(closed(["2026年2月27日(金)"]), 10, "202603"))).toBe(
      "credit-statement-period",
    );
  });

  test("any other shape names no month, and a confirmed page stops", () => {
    for (const months of [
      ["2026年2月27日(祝)"],
      ["2026年2月27日(金曜)"],
      ["2026年2月27日金"],
      ["2026年2月27日(金"],
      ["2026年2月27日（金）"],
      ["2026年2月27日"],
      ["2026年2月30日(金)"],
      ["2026年2月0日(金)"],
      ["2026年2月123日(金)"],
      ["2026年13月1日(金)"],
      ["2026年2月27日(金)", "2026年2月"],
      ["2026年2月27日(金)", "2026年3月27日(金)"],
    ])
      expect(stopCode(() => period(closed(months), 1))).toBe("credit-statement-period");
  });

  test("collectCredit stores a dated confirmed month at position 1 instead of stopping", async () => {
    const { artifacts, stop } = await collectCredit(
      client({ 0: mutable, 1: closed(["2026年02月27日(金)"]) }),
      "x",
    );
    expect(stop).toBeUndefined();
    const ledger = artifacts.find((artifact) => artifact.filename === "credit-ledger-01.json");
    expect(ledger?.statementState).toBe("confirmed");
    expect(JSON.parse(String(ledger?.body))).toMatchObject({ detailMonth: 1, period: "2026-02" });
  });
});

describe("ADR 0005 amendment (h): a stored page states only what the page states", () => {
  const closed = (month: string) =>
    page({ headings: [CONFIRMED_STATEMENT_HEADING], months: [month], rows: [confirmedRow] });
  // A past position with no bill, in the shape a production run showed at
  // four positions: no heading, no ledger, no month, the same bytes at each.
  // Every value is synthetic.
  const noBill = page({ head: null });
  // The past-months response labels each position, available or not.
  const labels = [3, 4, 5, 6].map((position) => ({
    detailMonth: String(position),
    detailAvailableFlag: "0",
    settlementYM: `2026年${9 - position}月お支払い分`,
  }));
  const skipPage = page({
    headings: ["ショッピングスキップ払いご利用明細(未確定分)"],
    head: '<div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div>',
    rows: [row("お支払日", ["2026/03/10", "架空分割店", "2026/04/10", "3,000円"], "2026/04/10")],
  });

  test("one page at several positions is kept at each, stating one state and no period", async () => {
    const run = await collectCredit(
      client(
        {
          0: mutable,
          1: closed("2026年3月"),
          2: closed("2026年2月"),
          3: noBill,
          4: noBill,
          5: noBill,
          6: noBill,
        },
        labels,
      ),
      "x",
    );
    expect(run.stop).toBeUndefined();
    expect(run.unreadMonths).toEqual([]);
    expect(run.periodCount).toBe(7);
    const repeated = run.artifacts.filter((artifact) =>
      /^credit-detail-0[3-6]\.html$/u.test(artifact.filename),
    );
    expect(repeated.map((artifact) => artifact.filename)).toEqual([
      "credit-detail-03.html",
      "credit-detail-04.html",
      "credit-detail-05.html",
      "credit-detail-06.html",
    ]);
    expect(new Set(repeated.map((artifact) => artifact.body)).size).toBe(1);
    for (const artifact of repeated) {
      expect(artifact.statementState).toBe("unknown");
      // Neither the position's label nor the past-months label is the page's.
      expect(artifact.period).toBeUndefined();
    }
    // A page with a state keeps its period as before.
    expect(
      run.artifacts
        .filter((artifact) => artifact.dataset === "credit-detail")
        .slice(0, 3)
        .map((artifact) => artifact.period),
    ).toEqual(["detailMonth-0", "2026-03", "2026-02"]);

    // The shared manifest names the page by its bytes: its four entries state
    // the same, so the metadata extractor has one reading to use.
    const plan = await myJcbRunPlan({
      schemaVersion: "myjcb-worker-poc-v1",
      runId: "00000000-0000-4000-8000-0000000000a8",
      startedAt: "2026-09-29T21:00:00.000Z",
      completedAt: "2026-09-29T21:05:00.000Z",
      status: "success",
      trigger: "scheduled",
      connections: [
        {
          summary: {
            connectionId: "synthetic-conn",
            bootstrapMode: "password",
            status: "success",
            cardCount: 1,
            periodCount: run.periodCount,
            artifactCount: run.artifacts.length,
          },
          artifacts: run.artifacts,
        },
      ],
      failures: [],
    });
    const manifest = plan.artifacts.find((artifact) => artifact.artifactKey === "manifest.json");
    const body = manifest?.body;
    if (body?.kind !== "bytes") throw new Error("manifest bytes expected");
    const entries = (
      JSON.parse(new TextDecoder().decode(body.bytes)) as {
        artifacts: Record<string, unknown>[];
      }
    ).artifacts;
    const sha = plan.artifacts.find(
      (artifact) => artifact.artifactKey === "synthetic-conn/credit-detail-03.html",
    )?.sha256;
    const named = entries.filter((entry) => entry["sha256"] === sha);
    expect(named).toHaveLength(4);
    expect(new Set(named.map((entry) => JSON.stringify(entry))).size).toBe(1);
    expect(named[0]).toMatchObject({ dataset: "credit-detail", statementState: "unknown" });
    expect(named[0]).not.toHaveProperty("period");
  });

  test("one page read as two different things stops the connection and is not kept again", async () => {
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      warnings.push(String(value));
    });
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      // The same pending page at positions 0 and 1 would be two pending
      // statements, `detailMonth-0` and `detailMonth-1`: not observed, and
      // which one it is is not chosen (ADR 0004).
      run = await collectCredit(client({ 0: mutable, 1: mutable, 2: closed("2026年2月") }), "x");
    } finally {
      spy.mockRestore();
    }
    expect(run.stop).toEqual({ code: "credit_page_repeated", position: 1, capturedMonthCount: 1 });
    expect(filenames(run.artifacts)).toEqual([
      "credit-menu.html",
      "credit-past-months.json",
      "credit-detail-00.html",
      "credit-ledger-00.json",
    ]);
    expect(connectionStopCode(new StopConditionError("x", "credit-page-repeated"))).toBe(
      "credit_page_repeated",
    );
    // Counts and codes only.
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: "myjcb-credit-month-failed",
        detailMonth: 1,
        code: "credit-page-repeated",
        stopCode: "credit_page_repeated",
        capturedMonthCount: 1,
        stopPageKept: false,
      },
    ]);
  });

  test("a month position showing the ショッピングスキップ払い page is stored as that schedule page, not a month", async () => {
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      warnings.push(String(value));
    });
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      // The menu lists positions 7 and 8 as months (the synthetic client puts
      // every page under a month heading); the page's own h1 says what it is.
      run = await collectCredit(
        client({ 0: mutable, 1: closed("2026年3月"), 7: page({ head: null }), 8: skipPage }),
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(run.stop).toBeUndefined();
    expect(run.unreadMonths).toEqual([]);
    expect(run.periodCount).toBe(3);
    expect(run.schedulePages).toEqual([{ position: 8, code: "scheduled_payments_page" }]);
    expect(
      run.artifacts
        .filter((artifact) => artifact.filename.endsWith("-08.html"))
        .map((artifact) => [
          artifact.dataset,
          artifact.filename,
          artifact.statementState ?? null,
          artifact.period ?? null,
        ]),
    ).toEqual([["credit-schedule", "credit-skip-payment-08.html", "unknown", "detailMonth-8"]]);
    expect(filenames(run.artifacts)).not.toContain("credit-detail-08.html");
    expect(warnings).toContain(
      '{"event":"myjcb-credit-month-schedule-page","detailMonth":8,"code":"scheduled_payments_page"}',
    );
  });

  test("a schedule page found at a month position is listed beside the menu's, and kept after a later stop", async () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    let whole: Awaited<ReturnType<typeof collectCredit>>;
    let stopped: Awaited<ReturnType<typeof collectCredit>>;
    try {
      whole = await collectCredit(
        client({ 0: mutable, 1: closed("2026年3月"), 6: skipPage }, [], {
          7: page({ head: null }),
        }),
        "x",
      );
      // Position 3 stops the connection by its own shape (a heading over an
      // unproven usage header), after the skip page at position 2.
      stopped = await collectCredit(
        client({
          0: mutable,
          1: closed("2026年3月"),
          2: skipPage,
          3: page({ headings: [CONFIRMED_STATEMENT_HEADING], head: UNCONFIRMED_HEAD }),
        }),
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(whole.stop).toBeUndefined();
    expect(whole.periodCount).toBe(2);
    expect(whole.schedulePages).toEqual([
      { position: 6, code: "scheduled_payments_page" },
      { position: 7, code: "scheduled_payments_page" },
    ]);
    expect(
      filenames(whole.artifacts).filter(
        (name) => name.startsWith("credit-schedule") || name.startsWith("credit-skip-payment"),
      ),
    ).toEqual(["credit-skip-payment-06.html", "credit-schedule-07.html"]);
    expect(stopped.stop).toEqual({
      code: "credit_statement_state",
      position: 3,
      capturedMonthCount: 2,
    });
    expect(stopped.periodCount).toBe(3);
    expect(stopped.schedulePages).toEqual([{ position: 2, code: "scheduled_payments_page" }]);
    expect(filenames(stopped.artifacts)).toContain("credit-skip-payment-02.html");
  });

  test("a stop page is not kept when an earlier position kept its bytes stating something else", async () => {
    // A confirmed page naming no month: position 2 has a past-months label
    // and is kept as that month; position 3 shows the same bytes without a
    // label and stops (`credit_statement_period`). Keeping it as `unknown`
    // would give the one object two readings. Every value is synthetic.
    const unnamed = page({ headings: [CONFIRMED_STATEMENT_HEADING], rows: [confirmedRow] });
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      run = await collectCredit(
        client({ 0: mutable, 1: closed("2026年3月"), 2: unnamed, 3: unnamed }, [
          { detailMonth: "2", detailAvailableFlag: "1", settlementYM: "2026年2月お支払い分" },
        ]),
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(run.stop).toEqual({
      code: "credit_statement_period",
      position: 3,
      capturedMonthCount: 3,
    });
    const pages = run.artifacts.filter((artifact) => artifact.dataset === "credit-detail");
    expect(pages.map((artifact) => [artifact.filename, artifact.statementState])).toEqual([
      ["credit-detail-00.html", "unconfirmed"],
      ["credit-detail-01.html", "confirmed"],
      ["credit-detail-02.html", "confirmed"],
    ]);
  });
});

describe("ADR 0005 amendment (j): the menu's h3 schedule heading and the ボーナス払い page", () => {
  const closed = (month: string) =>
    page({ headings: [CONFIRMED_STATEMENT_HEADING], months: [month], rows: [confirmedRow] });
  // The ボーナス払い page in the round-9 shape: its own h1
  // 「ボーナス#回払いご利用代金明細(未確定分)」 (# a digit), an h2 in the dated
  // statement heading's exact form, and an empty ledger. Every value is
  // synthetic.
  const BONUS_H1 = "ボーナス2回払いご利用代金明細(未確定分)";
  const bonusPage = (h1 = BONUS_H1) =>
    page({ headings: [h1], months: ["2026年6月15日(月)"], head: UNCONFIRMED_HEAD });
  const skipPage = page({
    headings: ["ショッピングスキップ払いご利用明細(未確定分)"],
    head: '<div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div>',
  });
  const stored = (run: Awaited<ReturnType<typeof collectCredit>>) =>
    run.artifacts.map((artifact) => [
      artifact.dataset,
      artifact.filename,
      artifact.statementState ?? null,
      artifact.period ?? null,
    ]);

  test("the bonus h1 names a schedule page; the h2 alone does not", () => {
    expect(schedulePageKind(bonusPage())).toBe("bonus");
    for (const count of ["12", "２", "１２"])
      expect(schedulePageKind(bonusPage(`ボーナス${count}回払いご利用代金明細(未確定分)`))).toBe(
        "bonus",
      );
    expect(schedulePageKind(skipPage)).toBe("skip-payment");
    for (const h1 of [
      "ボーナス回払いご利用代金明細(未確定分)",
      "ボーナス二回払いご利用代金明細(未確定分)",
      "ボーナス2回払いご利用代金明細（未確定分）",
      "ボーナス2回払いご利用代金明細(確定分)",
      "カードご利用代金明細",
    ])
      expect(schedulePageKind(bonusPage(h1))).toBe("unobserved");
    // Two bonus h1s are not exactly one.
    expect(
      schedulePageKind(page({ headings: [BONUS_H1, BONUS_H1], months: ["2026年6月15日(月)"] })),
    ).toBe("unobserved");
    // A statement page is not a schedule page.
    expect(schedulePageKind(closed("2026年3月"))).toBe("unobserved");
  });

  test("the observed menu reads 7 and 8 as schedule pages: the bonus page is stored as one", async () => {
    // `client` builds the menu in the observed levels: the schedule heading
    // is an h3 between the two month h2s.
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      warnings.push(String(value));
    });
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      run = await collectCredit(
        client({ 0: mutable, 1: closed("2026年3月") }, [], { 7: bonusPage(), 8: skipPage }),
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(run.stop).toBeUndefined();
    expect(run.periodCount).toBe(2);
    expect(run.schedulePages).toEqual([
      { position: 7, code: "scheduled_payments_page" },
      { position: 8, code: "scheduled_payments_page" },
    ]);
    expect(stored(run).slice(-2)).toEqual([
      ["credit-schedule", "credit-schedule-07.html", "unknown", "detailMonth-7"],
      ["credit-schedule", "credit-skip-payment-08.html", "unknown", "detailMonth-8"],
    ]);
    expect(warnings).toEqual([]);
  });

  test("a month position showing the bonus page is stored as that schedule page, not a month", async () => {
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      warnings.push(String(value));
    });
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      // The synthetic menu lists 7 as a month, as the h2-only reading did;
      // the page's own h1 says what it is.
      run = await collectCredit(
        client({ 0: mutable, 1: closed("2026年3月"), 2: closed("2026年2月"), 7: bonusPage() }),
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(run.stop).toBeUndefined();
    expect(run.unreadMonths).toEqual([]);
    expect(run.periodCount).toBe(3);
    expect(run.schedulePages).toEqual([{ position: 7, code: "scheduled_payments_page" }]);
    expect(stored(run).filter(([, filename]) => String(filename).endsWith("-07.html"))).toEqual([
      ["credit-schedule", "credit-schedule-07.html", "unknown", "detailMonth-7"],
    ]);
    expect(filenames(run.artifacts)).not.toContain("credit-detail-07.html");
    expect(filenames(run.artifacts)).not.toContain("credit-ledger-07.json");
    // Counts and codes only.
    expect(warnings).toEqual([
      '{"event":"myjcb-credit-month-schedule-page","detailMonth":7,"code":"scheduled_payments_page"}',
    ]);
    expect(warnings.join("")).not.toContain("ボーナス");
  });

  test("without the bonus h1 the same page is a month read as unknown, as before", async () => {
    // The h2 alone has the dated statement heading's form; only the h1 tells
    // the schedule page apart. A near miss of the h1 is not recognised.
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    let run: Awaited<ReturnType<typeof collectCredit>>;
    try {
      run = await collectCredit(
        client({
          0: mutable,
          1: closed("2026年3月"),
          7: bonusPage("ボーナス回払いご利用代金明細(未確定分)"),
        }),
        "x",
      );
    } finally {
      spy.mockRestore();
    }
    expect(run.schedulePages).toEqual([]);
    expect(stored(run).filter(([, filename]) => String(filename).endsWith("-07.html"))).toEqual([
      ["credit-detail", "credit-detail-07.html", "unknown", null],
    ]);
  });

  test("the empty-month page at several past positions is still kept at each as unknown", async () => {
    // Round 9: positions 3–6 are one byte-identical page, h1
    // 「カードご利用代金明細」 (no 「(確定分)」), no h2, no ledger, no table, and
    // the phrase 「当該月の請求はございません」. It is not a schedule page.
    const emptyMonth =
      '<!doctype html><html lang="ja"><body><h1>MyJCB</h1><h1>カードご利用代金明細</h1><p>当該月の請求はございません</p></body></html>';
    expect(schedulePageKind(emptyMonth)).toBe("unobserved");
    const run = await collectCredit(
      client({
        0: mutable,
        1: closed("2026年3月"),
        2: closed("2026年2月"),
        3: emptyMonth,
        4: emptyMonth,
        5: emptyMonth,
        6: emptyMonth,
      }),
      "x",
    );
    expect(run.stop).toBeUndefined();
    expect(run.unreadMonths).toEqual([]);
    expect(run.periodCount).toBe(7);
    expect(stored(run).filter(([, filename]) => /-0[3-6]\./u.test(String(filename)))).toEqual(
      [3, 4, 5, 6].map((position) => [
        "credit-detail",
        `credit-detail-0${position}.html`,
        "unknown",
        null,
      ]),
    );
  });
});
