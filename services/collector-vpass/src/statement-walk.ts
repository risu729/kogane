// One statement month's page walk, as the Worker runs it (moved out of
// `./worker` unchanged so it can be driven by a synthetic provider in tests).
//
// A month answers in one of two shapes, and the walk ends as follows:
//
// - Finalized (`WebMeisaiTopDisplayServiceBean`, paged by `p03`): after a page
//   whose `webMeisaiTopK3Vo.allCnt` is less than its `nextPageRow` (both read
//   by `providerCount`, so a digit string and a number are the same value),
//   or on an empty page after the first. The next page is requested with the
//   page's `nextPageRow` as the cursor; a missing or repeated cursor fails the
//   card.
// - Customized (`CustomizedMeisaiAnsDisplayServiceBean`, paged through
//   `meisai_ans` by row offset and `pageSize`): once the rows reach the
//   stated `total` and `pageFlg` is `1` or `3`, or on an empty answer page.
//
// The live site also sends `pageNo`, `lastPage`, `rowCnt`, `limitCnt`,
// `dispCnt` and `prevPageRow` (finalized) and `responseCnt` (customized). Only
// their presence has been observed, not what their values mean, so the walk
// does not read them (ADR 0004). Whether a month is whole is decided after the
// walk, from the stored pages, by `monthCheck` in `./shared-collection`.
import { providerCount } from "./provider-count";
import type { VpassMonthCapture } from "./shared-collection";

const MEISAI_TOP_PATH = "/memapi/jaxrs/web_meisai/web_meisai_top/v1";
const MEISAI_ANSWER_PATH = "/memapi/jaxrs/meisai/meisai_ans/v1";
const MAX_PAGES_PER_MONTH = 100;

type JsonObject = Record<string, unknown>;

/** The Worker's authenticated member-API POST, reduced to what the walk needs. */
export type MemberPost = (
  path: string,
  content: JsonObject,
) => Promise<{ readonly rawText: string; readonly json: JsonObject }>;

type PageCapture = VpassMonthCapture["pages"][number];

const integer = providerCount;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: unknown, ...path: string[]): JsonObject | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return isObject(current) ? current : null;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

export async function collectMonth(post: MemberPost, month: string): Promise<VpassMonthCapture> {
  // The Android app always supplies p03=1 for the first finalized-statement
  // page. Omitting p03 returns only the display/header bean with zero rows.
  let current = await post(MEISAI_TOP_PATH, { p01: month, p03: "1" });
  const content = objectAt(current.json, "body", "content");
  if (!content) throw new Error(`${month} response has no content`);
  if (objectAt(content, "WebMeisaiTopDisplayServiceBean")) {
    let transactions = 0;
    const seen = new Set<string>();
    const pages: PageCapture[] = [];
    for (let page = 0; page < MAX_PAGES_PER_MONTH; page += 1) {
      pages.push({ kind: "top", index: page, rawJson: current.rawText });
      const bean = objectAt(current.json, "body", "content", "WebMeisaiTopDisplayServiceBean");
      const rowCount = arrayAt(bean, "meisaiList").length;
      transactions += rowCount;
      const detail = objectAt(bean, "webMeisaiTopK3Vo");
      const allCount = integer(detail?.["allCnt"]);
      const nextPageRow = integer(detail?.["nextPageRow"]);
      if (
        (allCount !== null && nextPageRow !== null && allCount < nextPageRow) ||
        (rowCount === 0 && page > 0)
      ) {
        return { pages, transactionCount: transactions };
      }
      const candidate = detail?.["nextPageRow"];
      const cursor =
        typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
      if (!cursor || seen.has(cursor)) throw new Error(`${month} returned an invalid page cursor`);
      seen.add(cursor);
      current = await post(MEISAI_TOP_PATH, { p01: month, p03: cursor });
    }
    throw new Error(`${month} exceeded ${MAX_PAGES_PER_MONTH} pages`);
  }
  const customized = objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean");
  if (!customized) throw new Error(`${month} returned an unknown statement shape`);
  let transactions = arrayAt(customized, "meisaiList").length;
  const pages: PageCapture[] = [{ kind: "top", index: 0, rawJson: current.rawText }];
  let total = integer(customized["total"]) ?? transactions;
  const pageSize = Math.max(1, integer(customized["pageSize"]) ?? 100);
  let page = 1;
  // Current/unsettled statements are fetched by a different app method. A
  // top response may merely signal that route with an empty customized bean,
  // so always make the first meisai_ans request when no rows were returned.
  let shouldFetch = transactions === 0 || transactions < total;
  while (shouldFetch && page < MAX_PAGES_PER_MONTH) {
    current = await post(MEISAI_ANSWER_PATH, {
      seikyuYM: month,
      start: String(transactions),
      end: String(transactions + pageSize - 1),
    });
    const responseBean = objectAt(
      current.json,
      "body",
      "content",
      "CustomizedMeisaiAnsDisplayServiceBean",
    );
    const rows = arrayAt(responseBean, "meisaiList");
    pages.push({ kind: "answer", index: page, rawJson: current.rawText });
    if (rows.length === 0) break;
    transactions += rows.length;
    total = integer(responseBean?.["total"]) ?? total;
    const pageFlag = responseBean?.["pageFlg"];
    shouldFetch = transactions < total || (pageFlag !== "1" && pageFlag !== "3");
    page += 1;
  }
  if (shouldFetch && page >= MAX_PAGES_PER_MONTH) {
    throw new Error(`${month} exceeded ${MAX_PAGES_PER_MONTH} pages`);
  }
  return { pages, transactionCount: transactions };
}
