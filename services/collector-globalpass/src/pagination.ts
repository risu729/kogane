// What a GLOBAL PASS Account Activities page says about its own pages.
//
// Observed live on 2026-09-27 (structure only, no values): a month with more
// than ten statements shows `Found N Result [p/Ppage] Back Next` and at most
// ten statement blocks per page; Back and Next are POST links; there are no
// page-number links and no page-size setting. The container selects a month
// and keeps `page.content()` once, so it stores page 1 of such a month and
// never follows Next (`container/server.mjs`, `collectBrowser`).
//
// This module only reads the counts the page states, from its visible text,
// so the Worker can refuse to call a month captured when the page itself says
// more pages exist. It never returns provider text. A page that states no
// pager yields nulls: that is "no pager seen", not a proof of a whole month,
// because the pager's markup has not been reviewed in a stored capture.

export interface ActivityPageState {
  /** `N` of `Found N Result`, or null when the page states none. */
  readonly statedTotal: number | null;
  /** `p` of `[p/Ppage]`, or null when the page shows no pager. */
  readonly pageIndex: number | null;
  /** `P` of `[p/Ppage]`, or null when the page shows no pager. */
  readonly pageCount: number | null;
  /** The page states two different totals or two different pagers. */
  readonly conflicting: boolean;
}

export type ActivityPaginationCode = "activity_pages_unwalked" | "activity_pager_unreadable";

const STATED_TOTAL = /\bFound\s+(\d{1,5})\s+Results?\b/giu;
const PAGER = /\[\s*(\d{1,4})\s*\/\s*(\d{1,4})\s*pages?\s*\]/giu;

export function activityPageState(html: string): ActivityPageState {
  const text = visibleText(html);
  const totals = new Set([...text.matchAll(STATED_TOTAL)].map((match) => Number(match[1])));
  const pagers = [...text.matchAll(PAGER)].map((match) => [Number(match[1]), Number(match[2])]);
  const distinctPagers = new Set(pagers.map(([index, count]) => `${index}/${count}`));
  const [total] = totals;
  const pager = distinctPagers.size === 1 ? pagers[0] : undefined;
  return {
    statedTotal: totals.size === 1 && total !== undefined ? total : null,
    pageIndex: pager?.[0] ?? null,
    pageCount: pager?.[1] ?? null,
    conflicting: totals.size > 1 || distinctPagers.size > 1,
  };
}

/**
 * Why the stored page is not the whole month, or `undefined` when the page
 * states no further page. The collector walks no page, so any pager that
 * names more than one page (or a page other than the first) means rows the
 * run did not capture.
 */
export function uncapturedPagesCode(state: ActivityPageState): ActivityPaginationCode | undefined {
  if (state.conflicting) return "activity_pager_unreadable";
  if (state.pageCount === null || state.pageIndex === null) return undefined;
  if (state.pageCount < 1 || state.pageIndex < 1 || state.pageIndex > state.pageCount) {
    return "activity_pager_unreadable";
  }
  return state.pageCount > 1 ? "activity_pages_unwalked" : undefined;
}

/** The page's visible text: tags, scripts, styles and comments removed. */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/giu, " ")
    .replace(/\s+/gu, " ");
}
