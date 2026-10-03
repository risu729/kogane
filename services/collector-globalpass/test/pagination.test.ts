import { describe, expect, test } from "bun:test";
import {
  activityPageState,
  monthCoverageCode,
  readActivityPage,
  statementBlockCount,
  type CapturedActivityPage,
} from "../src/pagination";

// Synthetic pages in the observed Nablarch pager shape (2026-10-04): two
// identical `div.nablarch_paging` per page, `Found N Result [p/Ppage] Back
// Next` in English and `検索結果 N件 [p/Pページ] 前へ 次へ` in Japanese, two
// `table.tableStyle4` per statement block. The counts are placeholders, not
// production values.
const page = (body: string) =>
  `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;

type Language = "en" | "ja";
function pager(total: number, index: number, count: number, language: Language = "en"): string {
  const labels =
    language === "en"
      ? { found: `Found ${total} Result`, page: `[${index}/${count}page]`, back: "Back", next: "Next" }
      : { found: `検索結果 ${total}件`, page: `[${index}/${count}ページ]`, back: "前へ", next: "次へ" };
  const link = (kind: "prev" | "next", label: string, enabled: boolean) =>
    enabled
      ? `<a class="nablarch_${kind}Submit" name="${kind}Submit" href="/p/statementInquiry/RW1313010201" onclick="return window.nablarch_submit(event, this);" tabindex="0">${label}</a>`
      : label;
  return (
    '<div class="nablarch_paging">' +
    `<div class="resultCountHeader">${labels.found}</div>` +
    `<div class="nablarch_currentPageNumber">${labels.page}</div>` +
    `<div class="nablarch_prevSubmit">${link("prev", labels.back, index > 1)}</div>` +
    `<div class="nablarch_nextSubmit">${link("next", labels.next, index < count)}</div>` +
    "</div>"
  );
}
const blocks = (count: number) =>
  '<table class="tableStyle4"><tr><td>a</td></tr></table><table class="tableStyle4 x"><tr><td>b</td></tr></table>'.repeat(
    count,
  );
function listPage(
  total: number,
  index: number,
  count: number,
  blockCount: number,
  language: Language = "en",
): string {
  const top = pager(total, index, count, language);
  return page(`<form name="nablarch_form5" method="post">${top}${blocks(blockCount)}${top}</form>`);
}
function captured(html: string, pageNumber: number, pageCount: number): CapturedActivityPage {
  return { page: pageNumber, pageCount, read: readActivityPage(html) };
}

describe("GLOBAL PASS activity page state", () => {
  test("reads the stated total and the pager, across markup and spacing", () => {
    expect(
      activityPageState(
        page(
          '<p>Found <b>16</b> Result</p><p>[ 1 / 2 <span>page</span> ] <a href="#">Back</a> <a href="#">Next</a></p>',
        ),
      ),
    ).toEqual({ statedTotal: 16, pageIndex: 1, pageCount: 2, conflicting: false });
    expect(activityPageState(page("Found 3 Results"))).toEqual({
      statedTotal: 3,
      pageIndex: null,
      pageCount: null,
      conflicting: false,
    });
  });

  test("reads the Japanese pager the same way", () => {
    expect(activityPageState(listPage(16, 1, 2, 10, "ja"))).toEqual({
      statedTotal: 16,
      pageIndex: 1,
      pageCount: 2,
      conflicting: false,
    });
    expect(activityPageState(page("検索結果16件 [ 2 / 2 ページ ]"))).toEqual({
      statedTotal: 16,
      pageIndex: 2,
      pageCount: 2,
      conflicting: false,
    });
    // Two languages stating different counts on one page conflict.
    expect(activityPageState(page("Found 16 Result 検索結果 17件")).conflicting).toBe(true);
    expect(activityPageState(page("[1/2page] [2/2ページ]")).conflicting).toBe(true);
  });

  test("a pager repeated above and below the list is one pager", () => {
    expect(activityPageState(listPage(20, 2, 2, 10))).toEqual({
      statedTotal: 20,
      pageIndex: 2,
      pageCount: 2,
      conflicting: false,
    });
  });

  test("ignores script, style and comments", () => {
    expect(
      activityPageState(
        page(
          "<script>var s='Found 99 Result [1/9page]';</script><style>/* [1/9page] */</style><!-- Found 99 Result 検索結果 9件 -->",
        ),
      ),
    ).toEqual({ statedTotal: null, pageIndex: null, pageCount: null, conflicting: false });
  });

  test("counts statement blocks as pairs of table.tableStyle4", () => {
    expect(statementBlockCount(listPage(16, 1, 2, 10))).toBe(10);
    expect(statementBlockCount(page("<table><tr><td>x</td></tr></table>"))).toBe(0);
    expect(statementBlockCount(page('<table class="tableStyle4"></table>'))).toBeNull();
    expect(statementBlockCount(page("<!-- <table class='tableStyle4'> -->"))).toBe(0);
    expect(statementBlockCount(page('<table class="tableStyle40"></table>'.repeat(2)))).toBe(0);
  });
});

describe("GLOBAL PASS month coverage", () => {
  for (const language of ["en", "ja"] as const) {
    test(`a two-page month walked whole is proven (${language})`, () => {
      expect(
        monthCoverageCode([
          captured(listPage(16, 1, 2, 10, language), 1, 2),
          captured(listPage(16, 2, 2, 6, language), 2, 2),
        ]),
      ).toBeUndefined();
    });
    test(`a [1/1] month is proven by its own blocks (${language})`, () => {
      expect(monthCoverageCode([captured(listPage(7, 1, 1, 7, language), 1, 1)])).toBeUndefined();
      expect(monthCoverageCode([captured(listPage(7, 1, 1, 6, language), 1, 1)])).toBe(
        "activity_total_mismatch",
      );
    });
  }

  test("an empty month: no Found line, no pager, no block", () => {
    expect(monthCoverageCode([captured(page("<h3>2099/02</h3>"), 1, 1)])).toBeUndefined();
    // Blocks without a pager, or a Found line without a pager, are unobserved.
    expect(monthCoverageCode([captured(page(blocks(1)), 1, 1)])).toBe(
      "activity_pager_unreadable",
    );
    expect(monthCoverageCode([captured(page("Found 1 Result"), 1, 1)])).toBe(
      "activity_pager_unreadable",
    );
    expect(monthCoverageCode([captured(page("[1/1page]"), 1, 1)])).toBe(
      "activity_pager_unreadable",
    );
    // The container claimed more pages than a page without a pager can have.
    expect(monthCoverageCode([captured(page(""), 1, 2)])).toBe("activity_pager_unreadable");
  });

  test("pages missing are unwalked", () => {
    expect(monthCoverageCode([captured(listPage(16, 1, 2, 10), 1, 2)])).toBe(
      "activity_pages_unwalked",
    );
    expect(monthCoverageCode([])).toBe("activity_pages_unwalked");
  });

  test("a total that differs between pages is unreadable", () => {
    expect(
      monthCoverageCode([
        captured(listPage(16, 1, 2, 10), 1, 2),
        captured(listPage(17, 2, 2, 7), 2, 2),
      ]),
    ).toBe("activity_pager_unreadable");
  });

  test("blocks that do not add up to the total are a mismatch", () => {
    expect(
      monthCoverageCode([
        captured(listPage(16, 1, 2, 10), 1, 2),
        captured(listPage(16, 2, 2, 5), 2, 2),
      ]),
    ).toBe("activity_total_mismatch");
    expect(
      monthCoverageCode([
        captured(listPage(16, 1, 2, 10), 1, 2),
        captured(listPage(16, 2, 2, 6).replace("</form>", '<table class="tableStyle4"></table></form>'), 2, 2),
      ]),
    ).toBe("activity_total_mismatch");
  });

  test("a page that states another index or page count than its walk position is unreadable", () => {
    // Page 1 twice (Next did not advance).
    expect(
      monthCoverageCode([
        captured(listPage(16, 1, 2, 10), 1, 2),
        captured(listPage(16, 1, 2, 10), 2, 2),
      ]),
    ).toBe("activity_pager_unreadable");
    // Out of order.
    expect(
      monthCoverageCode([
        captured(listPage(16, 2, 2, 6), 2, 2),
        captured(listPage(16, 1, 2, 10), 1, 2),
      ]),
    ).toBe("activity_pager_unreadable");
    // The container's page count disagrees with the page's.
    expect(monthCoverageCode([captured(listPage(7, 1, 1, 7), 1, 2)])).toBe(
      "activity_pager_unreadable",
    );
    expect(
      monthCoverageCode([captured(listPage(16, 1, 2, 10), 1, 2), captured(listPage(16, 2, 3, 6), 2, 2)]),
    ).toBe("activity_pager_unreadable");
    // Conflicting pagers on one page.
    expect(
      monthCoverageCode([captured(page(`${pager(16, 1, 2)}${pager(16, 2, 2)}`), 1, 2)]),
    ).toBe("activity_pager_unreadable");
    expect(monthCoverageCode([captured(page("Found 0 Result [0/0page]"), 1, 1)])).toBe(
      "activity_pager_unreadable",
    );
  });
});
