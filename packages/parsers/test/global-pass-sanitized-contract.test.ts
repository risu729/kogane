// The contract between what the collector stores and what the activity parser
// reads: the collector's synthetic Account Activities page, carrying the
// activity parser's synthetic statement and the pager in its observed markup,
// goes through `sanitizeGlobalPassActivityHtml` and then through
// `global-pass-activity` with the metadata of a successful run, as a stored
// shared-run page does. Synthetic data only.
//
// It lives here, not in services/collector-globalpass/test, because that
// workspace's TypeScript does not type-check this package's parser modules;
// a test may import a service's modules (docs/package-layout.md).
//
// The sanitizer rewrites only the dynamic `nablarch_hidden` values, `#…`
// hrefs and `onclick`/`onchange` handlers; it leaves the doctype, the month
// `select` and its `option` `value`/`selected` attributes, the pager text and
// every `table`/`th`/`td`, which is all the parser reads. These tests pin that.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { sanitizeGlobalPassActivityHtml } from "../../../services/collector-globalpass/src/sanitize.ts";
import { fixture } from "../../../services/collector-globalpass/test/activity-fixture.ts";
import { globalPassActivity } from "../src/parsers/global-pass-activity-parser.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

/** The activity parser's synthetic statement page (one record, month 2099-02). */
const STATEMENT = readFileSync(join(FIXTURES_ROOT, "global-pass", "activity-2099-02.html"), "utf8");
const SELECT = STATEMENT.match(/<select\b[\s\S]*?<\/select>/u)![0].replace(
  "<select ",
  '<select onchange="sel_submit(this)" ',
);
const TABLES = STATEMENT.slice(
  STATEMENT.indexOf("<table"),
  STATEMENT.lastIndexOf("</table>") + "</table>".length,
);

/** The pager as surveyed on 2026-10-04 (docs/sources/prestia.md), with placeholder counts. */
function pager(index: number, count: number, language: "en" | "ja" = "en"): string {
  const label =
    language === "en"
      ? { found: "Found 1 Result", page: `[${index}/${count}page]`, back: "Back", next: "Next" }
      : { found: "検索結果 1件", page: `[${index}/${count}ページ]`, back: "前へ", next: "次へ" };
  const link = (kind: "prev" | "next", text: string, enabled: boolean) =>
    enabled
      ? `<a class="nablarch_${kind}Submit" name="${kind}Submit" href="/p/statementInquiry/RW1313010201" onclick="return window.nablarch_submit(event, this);" tabindex="0">${text}</a>`
      : text;
  return (
    '<div class="nablarch_paging">' +
    `<div class="resultCountHeader">${label.found}</div>` +
    `<div class="nablarch_currentPageNumber">${label.page}</div>` +
    `<div class="nablarch_prevSubmit">${link("prev", label.back, index > 1)}</div>` +
    `<div class="nablarch_nextSubmit">${link("next", label.next, index < count)}</div>` +
    "</div>"
  );
}

/**
 * The collector's page of variant A or B in English (as nightly runs receive
 * it), with the month select of the statement and `list` inside the last form,
 * where the survey found the pagers and statement blocks.
 */
function collectorPage(variant: "a" | "b", list: string): string {
  const shell = fixture(variant)
    .replace("<head>", "<head><title>Account Activities</title>")
    .replace("<h1>ご利用明細</h1>", "<h1></h1><h3>2099/02</h3>")
    .replace('<select onchange="sel_submit(this)"></select>', SELECT);
  const last = shell.lastIndexOf("<form></form>");
  if (last < 0 || !shell.includes(SELECT)) throw new Error("fixture shape changed");
  return `${shell.slice(0, last)}<form>${list}</form>${shell.slice(last + "<form></form>".length)}`;
}

function meta(artifactKey = "activity-2099-02.html"): ArtifactMeta {
  return {
    id: 1,
    sourceId: "global-pass",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "globalpass-activity",
    artifactKey,
    url: null,
    mime: "text/html",
    fetchedAt: "2099-03-01T00:00:00Z",
    sha256: "0".repeat(64),
  };
}
const parse = (html: string, artifactKey?: string) =>
  globalPassActivity.parse(new TextEncoder().encode(html), meta(artifactKey));

describe("sanitized collector page → global-pass-activity@1.1.0", () => {
  for (const variant of ["a", "b"] as const) {
    test(`variant ${variant}: a one-page month reads as the statement alone`, () => {
      const raw = collectorPage(variant, pager(1, 1) + TABLES + pager(1, 1));
      const stored = sanitizeGlobalPassActivityHtml(raw);
      expect(stored).not.toBe(raw);
      // What the parser reads is left byte for byte.
      expect(stored).toContain(TABLES);
      expect(stored).toContain('<option value="20990299" selected>2099-02</option>');
      expect(stored).toContain('<div class="nablarch_currentPageNumber">[1/1page]</div>');
      expect(stored.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(parse(stored)).toEqual(parse(STATEMENT));
      expect(parse(stored).observations).toHaveLength(1);
    });
  }

  test("a walked page 2 reads under its page-qualified key", () => {
    const stored = sanitizeGlobalPassActivityHtml(
      collectorPage("a", pager(2, 2) + TABLES + pager(2, 2)),
    );
    const [observation] = parse(stored, "activity-2099-02-p2.html").observations;
    expect(observation).toMatchObject({
      rawLocator: "html:activity-page=2;activity-record=1",
    });
    // The same page under the page-1 key is refused: the pager names page 2.
    expect(() => parse(stored)).toThrow("global-pass pager and artifact key name different pages");
  });

  test("the pager in Japanese reads the same", () => {
    const stored = sanitizeGlobalPassActivityHtml(
      collectorPage("b", pager(1, 1, "ja") + TABLES + pager(1, 1, "ja")),
    );
    expect(parse(stored)).toEqual(parse(STATEMENT));
  });

  test("limit: a month the collector calls empty (no Found line, no pager, no table) is refused", () => {
    // The collector proves a month whole when its page shows no Found line, no
    // pager and no statement block (ADR 0026, amendment of 2026-10-04). The
    // parser refuses a page without its activity table: zero-table pages stay
    // unsupported until the provider's explicit empty state is established
    // (docs/observations.md, "Remaining GlobalPass shape investigation").
    const stored = sanitizeGlobalPassActivityHtml(collectorPage("a", ""));
    expect(() => parse(stored)).toThrow("global-pass activity table cardinality drift");
  });
});
