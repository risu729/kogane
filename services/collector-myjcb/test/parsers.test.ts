import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  discoverCreditExports,
  extractCreditMenuLinkId,
  extractGeneralJsonDiscriminator,
  parseCardInventory,
  parseCreditLedger,
  parsePastMonthAvailability,
  parseStatementPeriods,
  readCreditMenuGroups,
  redactedStatementHtml,
  schedulePageKind,
} from "../src/parsers";
import { StopConditionError } from "../src/types";
import { creditMenu, MENU_SCHEDULE_HEADING } from "./synthetic-myjcb";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("MyJCB synthetic parsers", () => {
  test("enumerates pseudonymous cards and statement periods", () => {
    const html = fixture("debit-menu.html");
    expect(parseCardInventory(html).map((card) => card.productHint)).toEqual([
      "JCB W",
      "京銀JCBデビット",
    ]);
    expect(parseStatementPeriods(html).map((period) => period.sequence)).toEqual([0, 1]);
  });

  test("redacts synthetic tokens and card numbers before preservation", () => {
    const redacted = redactedStatementHtml(fixture("debit-detail.html"));
    expect(redacted).not.toContain("synthetic-secret-token");
    expect(redacted).not.toContain("3540 0000 0000 0000");
    expect(redacted).toContain("[redacted]");
    expect(redacted).toContain("架空商店");
  });

  test("removes active and navigational HTML surfaces before R2 preservation", () => {
    const redacted = redactedStatementHtml(`
      <html><head>
        <script>window.sessionToken="script-secret"</script>
        <meta name="csrf-token" content="meta-secret">
      </head><body>
        <div data-token="data-secret" onclick="sendSecret()">
          <a href="/next?token=href-secret">next</a>
          <form action="/submit?session=action-secret">
            <input value=unquoted-secret>
            <textarea>textarea-secret</textarea>
          </form>
        </div>
      </body></html>
    `);
    for (const sentinel of [
      "script-secret",
      "meta-secret",
      "data-secret",
      "sendSecret",
      "href-secret",
      "action-secret",
      "unquoted-secret",
      "textarea-secret",
    ]) {
      expect(redacted).not.toContain(sentinel);
    }
    expect(redacted).not.toMatch(/<(?:script|meta)\b|\s(?:data-token|onclick|href|action)\s*=/iu);
    expect(redacted).toContain('value="[redacted]"');
  });

  test("enumerates only API-reported available older credit months", () => {
    expect(extractCreditMenuLinkId(fixture("credit-mypage.html"))).toBe("synthetic_credit_menu");
    expect(readCreditMenuGroups(fixture("credit-menu.html")).months).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const past = parsePastMonthAvailability(fixture("credit-past.json"));
    expect(past.filter((month) => month.available).map((month) => month.detailMonth)).toEqual([
      10, 13,
    ]);
    expect(past.find((month) => month.detailMonth === 10)?.settlementYM).toBe(
      "2025年10月お支払い分",
    );
  });

  test("extracts the hidden discriminator and excludes the notice PDF", () => {
    const html = fixture("credit-detail.html");
    expect(extractGeneralJsonDiscriminator(html)).toBe("synthetic-discriminator");
    expect(discoverCreditExports(html, 10)).toEqual(["csv", "pdf", "ofx"]);
  });

  test("resolves export links against the detail page's own URL (ADR 0005's second amendment)", () => {
    const links = (...hrefs: readonly string[]) =>
      `<html><body>${hrefs.map((href) => `<a href="${href}">export</a>`).join("")}</body></html>`;
    // Relative and without a month, as confirmed months link them (observed
    // 2026-09-27): a link on a month's page is that month's export, at month
    // 0 as at any other.
    const observed = links(
      "detailDbPdf.html?output=pdf",
      "detail.html?output=csv",
      "detail.html?output=money",
    );
    expect(discoverCreditExports(observed, 1)).toEqual(["pdf", "csv", "ofx"]);
    expect(discoverCreditExports(observed, 0)).toEqual(["pdf", "csv", "ofx"]);
    // A link that names this month is read alike.
    expect(
      discoverCreditExports(
        links(
          "detailDbPdf.html?output=pdf&amp;detailMonth=1",
          "detail.html?output=csv&amp;detailMonth=1",
          "detail.html?output=money&amp;detailMonth=1",
        ),
        1,
      ),
    ).toEqual(["pdf", "csv", "ofx"]);
    // `./` and root-relative forms name the same URLs.
    expect(
      discoverCreditExports(
        links(
          "./detail.html?detailMonth=2&amp;output=csv",
          "/iss-pc/member/details_inquiry/detailDbPdf.html?detailMonth=2&amp;output=pdf",
        ),
        2,
      ),
    ).toEqual(["csv", "pdf"]);
    // Absolute on the MyJCB origin still works; another origin does not.
    expect(
      discoverCreditExports(
        links(
          "https://my.jcb.co.jp/iss-pc/member/details_inquiry/detail.html?detailMonth=2&amp;output=money",
          "https://example.invalid/iss-pc/member/details_inquiry/detail.html?detailMonth=2&amp;output=csv",
        ),
        2,
      ),
    ).toEqual(["ofx"]);
    // Another month's link, a malformed month, a link one directory away, a
    // link with no or another `output`, and the notice PDF are not this
    // month's exports.
    const others = links(
      "detail.html?output=csv&amp;detailMonth=2",
      "detailDbPdf.html?output=pdf&amp;detailMonth=01x",
      "detail.html?output=money&amp;detailMonth=",
      "../detail.html?output=csv",
      "detail.html?detailMonth=1",
      "detail.html?output=xls",
      "detailNewspdf.html",
      "detailNewspdf.html?detailMonth=1",
    );
    expect(discoverCreditExports(others, 1)).toEqual([]);
    // At month 0 another month's link is not this month's either.
    expect(discoverCreditExports(links("detail.html?output=csv&amp;detailMonth=1"), 0)).toEqual([]);
  });

  test("parses confirmed and mutable unconfirmed ledger components", () => {
    const confirmed = parseCreditLedger(fixture("credit-detail.html"), "confirmed");
    expect(confirmed?.rows).toHaveLength(1);
    expect(confirmed?.rows[0]?.summaryCells).toEqual([
      "2026/01/01",
      "架空商店",
      "一回払い",
      "1,000円",
    ]);
    expect(confirmed?.rows[0]?.expanded["ご利用金額"]).toBe("1,000円");

    const unconfirmed = parseCreditLedger(fixture("credit-unconfirmed.html"), "unconfirmed");
    expect(unconfirmed?.rows).toHaveLength(1);
    expect(unconfirmed?.rows[0]?.expanded["今回のお支払い金額"]).toBe("2,000円");
  });

  test("accepts a structurally known empty ledger row", () => {
    const empty = parseCreditLedger(
      `
      <div class="detail-list-01">
        <div class="head">ご利用日 ご利用先など 支払区分 ご利用金額</div>
        <div class="content"><div class="item"><div class="item-cell">
          <div class="cell w-100per">ご利用明細はありません</div>
        </div></div></div>
      </div>
    `,
      "confirmed",
    );
    expect(empty?.rows).toEqual([]);
  });
});

describe("readCreditMenuGroups (ADR 0005's amendment (c))", () => {
  /** The stop code, and every warning logged, when reading `html`. */
  function read(html: string): { code: string | undefined; warnings: string[] } {
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((value) => {
      warnings.push(String(value));
    });
    try {
      readCreditMenuGroups(html);
      return { code: undefined, warnings };
    } catch (error) {
      return {
        code: error instanceof StopConditionError ? error.code : "not-a-stop-condition",
        warnings,
      };
    } finally {
      spy.mockRestore();
    }
  }
  const link = (position: number) =>
    `<a href="/iss-pc/member/details_inquiry/detail.html?detailMonth=${position}&amp;output=web">明細を見る</a>`;

  test("the observed menu: nine links in DOM order 0, 1, 7, 8, 2-6 under three headings", () => {
    // Round 9 (ADR 0005's amendment (j)): h2, h3 (the schedule heading), h2,
    // then guidance h2/h3 after every link.
    const menu = fixture("credit-menu.html");
    expect([...menu.matchAll(/<(h[23])\b/gu)].map((match) => match[1])).toEqual([
      "h2",
      "h3",
      "h2",
      "h2",
      "h3",
    ]);
    const positions = [...menu.matchAll(/detailMonth=(\d+)/gu)].map((match) => Number(match[1]));
    expect(positions).toEqual([0, 1, 7, 8, 2, 3, 4, 5, 6]);
    // Relative, root-relative and absolute hrefs are read alike; the menu's
    // own link is not a month.
    expect(readCreditMenuGroups(menu)).toEqual({
      months: [0, 1, 2, 3, 4, 5, 6],
      schedules: [7, 8],
    });
    expect(readCreditMenuGroups(creditMenu([0, 1, 2], [7, 8]))).toEqual({
      months: [0, 1, 2],
      schedules: [7, 8],
    });
  });

  test("the schedule heading as an h3 takes 7 and 8 from the h2 before it (amendment (j))", () => {
    const menu = (schedule: "h2" | "h3", guidance = "") =>
      `<h2>最新のご利用明細</h2>${link(0)}${link(1)}<${schedule}>${MENU_SCHEDULE_HEADING}</${schedule}>${link(7)}${link(8)}<h2>過去の明細</h2>${[2, 3, 4, 5, 6].map(link).join("")}${guidance}`;
    const expected = { months: [0, 1, 2, 3, 4, 5, 6], schedules: [7, 8] };
    // The observed levels, with unrecognised guidance headings after every
    // link: a heading with no link under it decides nothing.
    expect(
      readCreditMenuGroups(menu("h3", "<h2>架空の案内</h2><h3>架空の注意</h3><h2>架空の窓口</h2>")),
    ).toEqual(expected);
    // The all-h2 shape amendment (c) was written for still reads the same.
    expect(readCreditMenuGroups(menu("h2"))).toEqual(expected);
    // An h3 schedule heading matches after whitespace removal too.
    expect(
      readCreditMenuGroups(
        `<h2>最新のご利用明細</h2>${link(0)}<h3 class="hdg-H3">ボーナス２回払い・<br />ショッピングスキップ払い</h3>${link(8)}`,
      ),
    ).toEqual({ months: [0], schedules: [8] });
  });

  test("an unrecognised h3 before a link stops, as an unrecognised h2 does", () => {
    const { code, warnings } = read(
      `<h2>最新のご利用明細</h2>${link(0)}<h3>架空の小見出し</h3>${link(1)}`,
    );
    expect(code).toBe("credit-menu-group");
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: "myjcb-credit-menu-groups",
        monthLinks: 1,
        scheduleLinks: 0,
        unrecognizedHeadingLinks: 1,
        linksOutsideHeading: 0,
        positionsInBothGroups: 0,
      },
    ]);
    expect(warnings.join("")).not.toContain("架空");
    // A link before any h2 or h3 stops too; an h1 or h4 is not a section.
    expect(read(`<h1>カードご利用明細一覧</h1>${link(0)}`).code).toBe("credit-menu-group");
    expect(read(`<h4>最新のご利用明細</h4>${link(0)}`).code).toBe("credit-menu-group");
  });

  test("headings match after whitespace removal, with any digits in the bonus count", () => {
    for (const heading of [" 最新の\nご利用明細 ", "<span>過去の</span> 明細"])
      expect(readCreditMenuGroups(`<h2>${heading}</h2>${link(3)}`)).toEqual({
        months: [3],
        schedules: [],
      });
    for (const count of ["2", "12", "２"])
      expect(
        readCreditMenuGroups(
          `<h2>最新のご利用明細</h2>${link(0)}<h2>ボーナス${count}回払い・ショッピングスキップ払い</h2>${link(8)}`,
        ),
      ).toEqual({ months: [0], schedules: [8] });
  });

  test("an unrecognised heading stops with the closed code and logs counts only", () => {
    const { code, warnings } = read(
      `<h2>最新のご利用明細</h2>${link(0)}<h2>架空の明細グループ</h2>${link(9)}`,
    );
    expect(code).toBe("credit-menu-group");
    expect(warnings.map((line) => JSON.parse(line))).toEqual([
      {
        event: "myjcb-credit-menu-groups",
        monthLinks: 1,
        scheduleLinks: 0,
        unrecognizedHeadingLinks: 1,
        linksOutsideHeading: 0,
        positionsInBothGroups: 0,
      },
    ]);
    expect(warnings.join("")).not.toContain("架空");
    // Near misses are not the observed headings: no digit, a different word.
    for (const heading of [
      "ボーナス回払い・ショッピングスキップ払い",
      "ボーナス2回払い",
      "最新のご利用明細一覧",
    ])
      expect(read(`<h2>${heading}</h2>${link(8)}`).code).toBe("credit-menu-group");
  });

  test("a link outside any heading, or a position in both groups, stops", () => {
    expect(read(`${link(0)}<h2>最新のご利用明細</h2>${link(1)}`).code).toBe("credit-menu-group");
    expect(
      read(`<h2>最新のご利用明細</h2>${link(0)}<h2>${MENU_SCHEDULE_HEADING}</h2>${link(0)}`).code,
    ).toBe("credit-menu-group");
    // A link inside an unobserved heading is not skipped: it stops too.
    expect(read(`<h2>架空の見出し${link(3)}</h2>`).code).toBe("credit-menu-group");
    // A link that opens no detail page is not grouped and stops nothing.
    expect(
      readCreditMenuGroups(
        `<a href="/iss-pc/member/mypage.html">戻る</a><a href="https://example.invalid/iss-pc/member/details_inquiry/detail.html?detailMonth=1">x</a><h2>最新のご利用明細</h2>${link(0)}`,
      ),
    ).toEqual({ months: [0], schedules: [] });
  });

  test("other headings inside a card box never move a link to another group", () => {
    // Each observed box has a `p.hdg` before it, and other elements beside
    // the link; only `h2` and `h3` decide the group, so the link stays under
    // its section's heading.
    const box = (position: number) =>
      `<p class="hdg">お支払い分</p><div class="box"><h4>明細</h4><p>明細</p>${link(position)}</div>`;
    expect(
      readCreditMenuGroups(
        `<h1>カードご利用明細</h1><h2>最新のご利用明細</h2>${box(0)}${box(1)}<h3>${MENU_SCHEDULE_HEADING}</h3>${box(7)}${box(8)}<h2>過去の明細</h2>${box(2)}${box(3)}`,
      ),
    ).toEqual({ months: [0, 1, 2, 3], schedules: [7, 8] });
    // An `h2` or `h3` inside a box that is not one of the observed three is
    // not taken as a sub-heading of the section: the link under it stops the
    // reading.
    for (const level of ["h2", "h3"])
      expect(
        read(
          `<h3>${MENU_SCHEDULE_HEADING}</h3><div class="box"><${level}>お支払い分</${level}>${link(8)}</div>`,
        ).code,
      ).toBe("credit-menu-group");
  });

  test("the bonus count accepts half- and full-width digits only", () => {
    for (const count of ["二", "Ⅱ", "2.5", "x", "２回"])
      expect(read(`<h2>ボーナス${count}回払い・ショッピングスキップ払い</h2>${link(8)}`).code).toBe(
        "credit-menu-group",
      );
  });
});

describe("schedulePageKind (ADR 0005 amendment e)", () => {
  const doc = (body: string) => `<!doctype html><html><body><h1>MyJCB</h1>${body}</body></html>`;
  test("only exactly one h1 with the observed skip heading is the skip-payment page", () => {
    expect(schedulePageKind(doc("<h1>ショッピングスキップ払いご利用明細(未確定分)</h1>"))).toBe(
      "skip-payment",
    );
    // Whitespace and inline markup inside the heading do not matter.
    expect(
      schedulePageKind(doc("<h1> ショッピングスキップ払い<span>ご利用明細</span>(未確定分) </h1>")),
    ).toBe("skip-payment");
  });
  test("any other page is unobserved: a bonus heading, none, two, a near miss, or not an h1", () => {
    for (const body of [
      "<h1>ボーナス払いご利用明細(未確定分)</h1>",
      "",
      "<h1>ショッピングスキップ払いご利用明細(未確定分)</h1><h1>ショッピングスキップ払いご利用明細(未確定分)</h1>",
      "<h1>ショッピングスキップ払いご利用明細（未確定分）</h1>",
      "<h1>ショッピングスキップ払いご利用明細</h1>",
      "<h2>ショッピングスキップ払いご利用明細(未確定分)</h2>",
    ])
      expect(schedulePageKind(doc(body)), body).toBe("unobserved");
  });
});
