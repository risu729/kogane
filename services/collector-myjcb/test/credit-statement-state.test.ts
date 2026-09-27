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
  settlementMonth,
} from "../src/parsers";
import { HumanRequiredError, StopConditionError } from "../src/types";
import worker from "../src/worker";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/index";

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
    expect(whole.withheldMonthCount).toBe(0);
    // Rows at an older position without the heading: the page is kept as
    // `unknown` evidence with no ledger, so its rows reach no parser and the
    // month is not captured whole.
    const withheld = await collectCredit(
      client({
        0: mutable,
        1: closedWithoutExports,
        7: page({ rows: [confirmedRow] }),
        8: page({ head: UNCONFIRMED_HEAD, rows: [pendingRow] }),
      }),
      "x",
    );
    expect(withheld.withheldMonthCount).toBe(2);
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
    // position 0.
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
    ]);
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

  test("a failed export drops its whole month: the page and ledger read before it too", async () => {
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
    );
    expect(run.stop).toEqual({ code: "export_fetch", position: 2, capturedMonthCount: 2 });
    expect(filenames(run.artifacts).filter((name) => /-0[23]\./u.test(name))).toEqual([]);
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
    const menu = `<!doctype html><html><body>${Object.keys(pages)
      .map(
        (month) =>
          `<a href="/iss-pc/member/details_inquiry/detail.html?detailMonth=${month}&amp;output=web">明細</a>`,
      )
      .join("")}</body></html>`;
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
  const menu = `<!doctype html><html><body>${[0, 1, 2]
    .map(
      (month) =>
        `<a href="/iss-pc/member/details_inquiry/detail.html?detailMonth=${month}&amp;output=web">明細</a>`,
    )
    .join("")}</body></html>`;
  const html = (text: string) =>
    new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } });

  /**
   * Run the manual trigger with `fail` deciding, per request, whether the
   * provider misbehaves; return every byte stored, every log line and the
   * HTTP response.
   */
  async function run(
    fail: (url: URL) => Response | "throw" | undefined,
  ): Promise<{ stored: string; logs: string; response: string; status: number }> {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const failure = fail(url);
      if (failure === "throw") throw new Error(leak);
      if (failure !== undefined) return failure;
      if (url.pathname.endsWith("/mypage.html")) return html(mypage);
      if (url.pathname.endsWith("/detailMenu.html")) return html(menu);
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
        ADMIN_TRIGGER_TOKEN: "synthetic-token",
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
      const response = await worker.fetch!(
        new Request("https://collector.invalid/trigger", {
          method: "POST",
          headers: { authorization: "Bearer synthetic-token" },
        }) as unknown as Parameters<NonNullable<typeof worker.fetch>>[0],
        env,
        {} as ExecutionContext,
      );
      const decoder = new TextDecoder();
      const stored = [...data.entries.entries()]
        .map(([key, entry]) => `${key}\n${decoder.decode(entry.bytes)}`)
        .join("\n");
      return {
        stored,
        logs: lines.join("\n"),
        response: await response.text(),
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
    expect(result.status).toBe(200);
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

  test("a stop before the first month or at login leaves codes only", async () => {
    const menuStop = await run((url) =>
      url.pathname.endsWith("/detailMenu.html") ? "throw" : undefined,
    );
    expect(menuStop.status).toBe(502);
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
