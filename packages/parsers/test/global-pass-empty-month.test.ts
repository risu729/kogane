// The observed empty month (ADR 0026's empty-month amendment of 2026-10-04): on a month
// with no statement the provider's Account Activities page shows its month
// select and no Found line, no pager and no table. `global-pass-activity`
// 1.2.0 reads that page as zero observations; every other page without a
// table stays refused with the messages 1.1.0 gives. The page here is
// synthetic: the shared anonymous fixture with its tables removed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { globalPassActivity } from "../src/parsers/global-pass-activity-parser.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const fixture = readFileSync(join(FIXTURES_ROOT, "global-pass", "activity-2099-02.html"), "utf8");
const meta = (overrides: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
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
});

/** The fixture with every table removed: the observed empty-month shape. */
function emptyMonthHtml(): string {
  const first = fixture.indexOf("<table");
  const end = fixture.lastIndexOf("</table>") + "</table>".length;
  if (first < 0 || end < first) throw new Error("fixture table boundary missing");
  const html = fixture.slice(0, first) + fixture.slice(end);
  if (/<table\b/iu.test(html)) throw new Error("empty-month page still has a table");
  return html;
}
const encode = (html: string): Uint8Array => new TextEncoder().encode(html);
/** The empty-month page with `markup` inserted after its heading. */
const withMarkup = (markup: string): Uint8Array =>
  encode(emptyMonthHtml().replace("<h1>ご利用明細</h1>", `<h1>ご利用明細</h1>${markup}`));
const parse = (bytes: Uint8Array, overrides: Partial<ArtifactMeta> = {}) =>
  globalPassActivity.parse(bytes, meta(overrides));

describe("global-pass-activity 1.2.0: the observed empty month", () => {
  test("is the release that reads the empty month", () => {
    expect(globalPassActivity.version).toBe("1.2.0");
  });

  test("reads page 1 with a month select and no table, pager or Found line as zero observations", () => {
    const result = parse(encode(emptyMonthHtml()));
    // A complete reading of nothing: no row, no amount, no warning (the same
    // result 1.1.0 already gives a month table with no row).
    expect(result).toEqual({ observations: [], warnings: [] });
    expect(parse(encode(emptyMonthHtml()))).toEqual(result);
    // Text inside a script or a comment is not on the page.
    expect(
      parse(
        withMarkup(
          "<script>var label = 'Found 1 Result [1/1page]';</script><!-- 検索結果 1件 [1/1ページ] -->",
        ),
      ),
    ).toEqual(result);
  });

  test("a page without a table that shows any part of the pager stays refused", () => {
    for (const markup of [
      // The observed one-page month's pager with its table missing.
      '<div class="nablarch_paging"><div class="resultCountHeader">Found 3 Result</div>' +
        '<div class="nablarch_currentPageNumber">[1/1page]</div>' +
        '<div class="nablarch_prevSubmit">Back</div><div class="nablarch_nextSubmit">Next</div></div>',
      '<div class="nablarch_paging"><div class="resultCountHeader">検索結果 3件</div>' +
        '<div class="nablarch_currentPageNumber">[1/1ページ]</div>' +
        '<div class="nablarch_prevSubmit">前へ</div><div class="nablarch_nextSubmit">次へ</div></div>',
      // A Found line alone, in either language, with or without its class.
      '<div class="resultCountHeader">Found 0 Result</div>',
      "<p>Found 2 Results</p>",
      "<p>検索結果 0件</p>",
      // A pager alone, an empty pager container, a pager link.
      '<div class="nablarch_currentPageNumber">[1/1page]</div>',
      "<p>[1/1ページ]</p>",
      '<div class="nablarch_paging"></div>',
      '<a class="nablarch_nextSubmit" href="#">Next</a>',
      // A pager class on any other tag, even empty.
      '<span class="resultCountHeader"></span>',
      '<p class="x nablarch_prevSubmit"></p>',
    ]) {
      expect(() => parse(withMarkup(markup))).toThrow(/table cardinality drift/u);
    }
    // An unreadable pager keeps its own message.
    expect(() => parse(withMarkup('<div class="nablarch_currentPageNumber">1/1</div>'))).toThrow(
      /pager is unreadable/u,
    );
    // Any table, even one the parser does not model.
    expect(() => parse(withMarkup("<table><tr><td>x</td></tr></table>"))).toThrow(
      /table cardinality drift/u,
    );
  });

  test("only page 1 of the key's month, with one selected month, can be empty", () => {
    expect(() =>
      parse(encode(emptyMonthHtml()), { artifactKey: "activity-2099-02-p2.html" }),
    ).toThrow(/later page has no pager/u);
    expect(() =>
      parse(withMarkup('<div class="nablarch_currentPageNumber">[2/2page]</div>'), {
        artifactKey: "activity-2099-02-p2.html",
      }),
    ).toThrow(/table cardinality drift/u);
    expect(() => parse(encode(emptyMonthHtml()), { artifactKey: "activity-2099-01.html" })).toThrow(
      /artifact key and selected month/u,
    );
    expect(() => parse(encode(emptyMonthHtml().replace("selected>2099-02", ">2099-02")))).toThrow(
      /one selected/u,
    );
    expect(() => parse(encode(emptyMonthHtml().replace(/<select[\s\S]*?<\/select>/u, "")))).toThrow(
      /month selector cardinality drift/u,
    );
    expect(() => parse(encode(emptyMonthHtml().replace(/^<!doctype html>/iu, "")))).toThrow(
      /doctype drift/u,
    );
    expect(() => parse(encode(emptyMonthHtml()), { runStatus: "partial" })).toThrow(
      /successful failure-free/u,
    );
  });
});
