// What GLOBAL PASS Account Activities pages say about their own month, and
// whether the pages a run captured are the whole month.
//
// Observed live on 2026-10-04 by the owner (round 8 and its addendum,
// structure and counts only, in English and in Japanese): every month that has statements shows two
// identical pagers, above and below the list, each a `div.nablarch_paging`
// with `Found N Result`, `[p/Ppage]`, Back and Next (in Japanese `検索結果
// N件`, `[p/Pページ]`, 前へ and 次へ; markup and behaviour identical). A month of ten or fewer
// statements shows `[1/1page]` with both links disabled; a month with no
// statement shows no Found line, no pager and no table. Each statement block
// is two `table.tableStyle4`; a two-page month showed ten blocks on page 1 and
// the rest on page 2, and both pages stated the same N, equal to the sum.
// The container walks Next (`container/server.mjs`, `walkActivityPages`) and
// sends every page; this module reads the counts each page states and decides
// whether the month is proven whole. It never returns provider text.

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

/** A page's stated counts plus the statement blocks it shows. */
export interface ActivityPageRead extends ActivityPageState {
  /**
   * Statement blocks on the page: `table.tableStyle4` elements divided by
   * two (two per block, observed 2026-10-04), or null when their number is
   * odd and so names no whole number of blocks.
   */
  readonly statementBlocks: number | null;
}

/** One page as the container sent it: its position in the walk and the page. */
export interface CapturedActivityPage {
  /** The walk's page number, 1 for the page the month selection renders. */
  readonly page: number;
  /** The page count the container read from the pager (1 without a pager). */
  readonly pageCount: number;
  readonly read: ActivityPageRead;
}

export type ActivityPaginationCode =
  /** The pager states more pages than the run captured. */
  | "activity_pages_unwalked"
  /** The pages' totals, pagers or walk positions disagree, or a pager is missing. */
  | "activity_pager_unreadable"
  /** The statement blocks across the pages do not add up to the stated total. */
  | "activity_total_mismatch";

/**
 * The most pages the container walks in one month. The largest month
 * observed stated 20 results, two pages of ten (2026-09-27); five pages is
 * fifty statements. A month stating more is sent as its first five pages and
 * is `activity_pages_unwalked`. `container/server.mjs` holds the same number.
 */
export const ACTIVITY_PAGE_CAP = 5;

/** `Found N Result` (English) or `検索結果 N件` (Japanese). */
const STATED_TOTAL = /\bFound\s+(\d{1,5})\s+Results?\b|検索結果\s*(\d{1,5})\s*件/giu;
/** `[p/Ppage]` (English) or `[p/Pページ]` (Japanese). */
const PAGER = /\[\s*(\d{1,4})\s*\/\s*(\d{1,4})\s*(?:pages?|ページ)\s*\]/giu;
const TABLE = /<table\b[^>]*>/giu;
const CLASS_ATTRIBUTE = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;

export function activityPageState(html: string): ActivityPageState {
  const text = visibleText(html);
  const totals = new Set(
    [...text.matchAll(STATED_TOTAL)].map((match) => Number(match[1] ?? match[2])),
  );
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

/** The statement blocks a page shows, from its `table.tableStyle4` elements. */
export function statementBlockCount(html: string): number | null {
  const markup = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ");
  let tables = 0;
  for (const tag of markup.match(TABLE) ?? []) {
    const match = CLASS_ATTRIBUTE.exec(tag);
    const classes = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").split(/\s+/u);
    if (classes.includes("tableStyle4")) tables += 1;
  }
  return tables % 2 === 0 ? tables / 2 : null;
}

export function readActivityPage(html: string): ActivityPageRead {
  return { ...activityPageState(html), statementBlocks: statementBlockCount(html) };
}

/**
 * Why the captured pages are not the whole month, or `undefined` when they
 * are proven whole. Whole means one of the two observed shapes:
 *
 * - an empty month: one page with no Found line, no pager and no statement
 *   block;
 * - a paged month: every page states the same `N` and the same `P`, the walk
 *   captured pages 1..P in order and each states its own index, and the
 *   statement blocks across the pages add up to `N`.
 *
 * Anything else is not proven. A page that shows statements without a pager,
 * or a Found line without a pager, is a shape nobody observed.
 */
export function monthCoverageCode(
  pages: readonly CapturedActivityPage[],
): ActivityPaginationCode | undefined {
  const first = pages[0];
  if (first === undefined) return "activity_pages_unwalked";
  if (pages.some(({ read }) => read.conflicting)) return "activity_pager_unreadable";
  if (first.read.pageCount === null && first.read.statedTotal === null) {
    const empty =
      pages.length === 1 &&
      first.page === 1 &&
      first.pageCount === 1 &&
      first.read.statementBlocks === 0;
    return empty ? undefined : "activity_pager_unreadable";
  }
  const total = first.read.statedTotal;
  const count = first.read.pageCount;
  if (total === null || count === null || count < 1) return "activity_pager_unreadable";
  for (const [position, captured] of pages.entries()) {
    const { read } = captured;
    if (
      read.statedTotal !== total ||
      read.pageCount !== count ||
      captured.pageCount !== count ||
      captured.page !== position + 1 ||
      read.pageIndex !== captured.page ||
      captured.page > count
    ) {
      return "activity_pager_unreadable";
    }
  }
  if (pages.length < count) return "activity_pages_unwalked";
  let blocks = 0;
  for (const { read } of pages) {
    if (read.statementBlocks === null) return "activity_total_mismatch";
    blocks += read.statementBlocks;
  }
  return blocks === total ? undefined : "activity_total_mismatch";
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
