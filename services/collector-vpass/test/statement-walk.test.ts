// The statement walk and the month check against the field types the live site
// sends. Synthetic fixtures only: every value is invented and no provider is
// contacted. What was observed live (2026-09-27, field names and types only):
// a finalized month answers with `WebMeisaiCommonDisplayServiceBean` and
// `WebMeisaiTopDisplayServiceBean`, whose `webMeisaiTopK3Vo` carries `allCnt`
// as a JSON string beside `rowCnt`, `limitCnt`, `dispCnt`, `pageNo`,
// `lastPage`, `nextPageRow`, `prevPageRow` and `payTotal`; a customized month
// answers with `CustomizedMeisaiAnsDisplayServiceBean`, whose `total` is a
// JSON number beside `responseCnt`, `pageSize` and `pageFlg`. The types of the
// other fields were not reported, so the fixtures below vary them.
import { describe, expect, test } from "bun:test";
import { providerCount } from "../src/provider-count";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { persistCardRun, type VpassCardRun } from "../src/shared-collection";
import { collectMonth, type MemberPost } from "../src/statement-walk";

const TOP = "/memapi/jaxrs/web_meisai/web_meisai_top/v1";
const ANSWER = "/memapi/jaxrs/meisai/meisai_ans/v1";

function envelope(content: Record<string, unknown>) {
  const json = { header: { resultCode: 0 }, body: { content } };
  return { rawText: JSON.stringify(json), json };
}

const rows = (count: number) =>
  Array.from({ length: count }, () => ({ data: ["SYNTHETIC"], rowType: "4K" }));

/** A finalized page in the observed shape; only `allCnt`'s type is known. */
function finalizedPage(
  rowCount: number,
  k3: { allCnt: unknown; nextPageRow?: unknown; [field: string]: unknown },
) {
  return envelope({
    WebMeisaiCommonDisplayServiceBean: { comSeikyuYMList: [] },
    WebMeisaiTopDisplayServiceBean: {
      meisaiList: rows(rowCount),
      webMeisaiTopK3Vo: {
        rowCnt: String(rowCount),
        limitCnt: "2",
        dispCnt: String(rowCount),
        pageNo: "1",
        lastPage: "2",
        prevPageRow: "",
        payTotal: "0",
        ...k3,
      },
    },
  });
}

/** A customized page in the observed shape: `total` is a number. */
function customizedPage(rowCount: number, total: unknown) {
  return envelope({
    CustomizedMeisaiAnsDisplayServiceBean: {
      meisaiList: rows(rowCount),
      total,
      responseCnt: String(rowCount),
      pageSize: 2,
      pageFlg: "3",
    },
  });
}

/** A provider that answers requests in order and records what was asked. */
function scripted(answers: ReturnType<typeof envelope>[]) {
  const requests: [string, Record<string, unknown>][] = [];
  const post: MemberPost = async (path, content) => {
    requests.push([path, content]);
    const answer = answers[requests.length - 1];
    if (!answer) throw new Error("the walk asked for a page past the script");
    return answer;
  };
  return { post, requests };
}

/** The card's coverage code for one walked month, as the persist diagnostic logs it. */
async function monthCoverage(capture: VpassCardRun["months"][string]) {
  const outcome = await persistCardRun(new FakeR2Bucket(), {
    sessionRunId: "2026-09-11T21-00-00-000Z",
    cardLabel: "card-001",
    startedAt: "2026-09-11T21:00:00.000Z",
    completedAt: "2026-09-11T21:04:00.000Z",
    cardListRawJson: envelope({ DropdownListInitDisplayServiceBean: { multiCardInfoList: [] } })
      .rawText,
    selectCardRawJson: envelope({ MultiCardUpdateBean: {} }).rawText,
    webMeisaiTopRawJson: envelope({ WebMeisaiTopDisplayServiceBean: {} }).rawText,
    months: { "202609": capture },
  });
  expect(outcome.result.outcome).toBe("persisted");
  return outcome.coverage;
}

describe("a provider count is read exactly, as a number or a digit string", () => {
  test("numbers and digit strings are the same value", () => {
    for (const [value, expected] of [
      [0, 0],
      [3, 3],
      ["0", 0],
      ["3", 3],
      ["003", 3],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect([value, providerCount(value)]).toEqual([value, expected]);
    }
  });

  test("anything else is no count, never a zero", () => {
    for (const value of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "-1",
      "+1",
      " 1",
      "1 ",
      "1,000",
      "1.0",
      "1e3",
      "0x10",
      "３",
      "",
      "9007199254740992",
      "12345678901234567",
      null,
      undefined,
      true,
      [],
      {},
    ]) {
      expect([value, providerCount(value)]).toEqual([value, null]);
    }
  });
});

describe("the finalized walk stops on its stated total when `allCnt` is a string", () => {
  for (const cursorType of ["string", "number"] as const) {
    const cursor = (value: number) => (cursorType === "string" ? String(value) : value);

    test(`two pages, \`nextPageRow\` as a ${cursorType}: no request past the last page, month complete`, async () => {
      const { post, requests } = scripted([
        finalizedPage(2, { allCnt: "3", nextPageRow: cursor(3) }),
        finalizedPage(1, { allCnt: "3", nextPageRow: cursor(5), pageNo: "2" }),
      ]);
      const capture = await collectMonth(post, "202609");
      expect(requests).toEqual([
        [TOP, { p01: "202609", p03: "1" }],
        [TOP, { p01: "202609", p03: "3" }],
      ]);
      expect(capture.transactionCount).toBe(3);
      expect(capture.pages.map((page) => [page.kind, page.index])).toEqual([
        ["top", 0],
        ["top", 1],
      ]);
      expect(await monthCoverage(capture)).toBe("complete");
    });
  }

  test("one page holding the whole month: one request, month complete", async () => {
    const { post, requests } = scripted([finalizedPage(2, { allCnt: "2", nextPageRow: "3" })]);
    const capture = await collectMonth(post, "202609");
    expect(requests).toHaveLength(1);
    expect(await monthCoverage(capture)).toBe("complete");
  });

  test("an empty month states zero: one request, month complete", async () => {
    const { post, requests } = scripted([finalizedPage(0, { allCnt: "0", nextPageRow: "1" })]);
    const capture = await collectMonth(post, "202609");
    expect(requests).toHaveLength(1);
    expect(await monthCoverage(capture)).toBe("complete");
  });

  test("a page that stops short of the stated total is a mismatch, not complete", async () => {
    // The provider says the month has 4 rows, but after the first page the
    // next one comes back empty: the walk ends there and the check refuses it.
    const { post } = scripted([
      finalizedPage(2, { allCnt: "4", nextPageRow: "3" }),
      finalizedPage(0, { allCnt: "4", nextPageRow: "5" }),
    ]);
    const capture = await collectMonth(post, "202609");
    expect(capture.transactionCount).toBe(2);
    expect(await monthCoverage(capture)).toBe("stated_total_mismatch");
  });

  test("without a readable `allCnt` the walk ends on the first empty page and the month is unverified", async () => {
    const { post, requests } = scripted([
      finalizedPage(2, { allCnt: "2件", nextPageRow: "3" }),
      finalizedPage(0, { allCnt: "2件", nextPageRow: "5" }),
    ]);
    const capture = await collectMonth(post, "202609");
    expect(requests).toHaveLength(2);
    expect(await monthCoverage(capture)).toBe("stated_total_unverified");
  });
  test("a negative or over-long stated count no longer stops the walk: it is no count", async () => {
    // Before `providerCount`, the walk read any integer number and any digit
    // string of any length, so a negative `allCnt` stopped it after one page.
    // Now such a value is no count: the walk runs to its first empty page and
    // the month check reports the month unverified.
    for (const allCnt of [-1, "00000000000000000002"]) {
      const { post, requests } = scripted([
        finalizedPage(2, { allCnt, nextPageRow: "3" }),
        finalizedPage(0, { allCnt, nextPageRow: "5" }),
      ]);
      const capture = await collectMonth(post, "202609");
      expect([allCnt, requests.length]).toEqual([allCnt, 2]);
      expect(await monthCoverage(capture)).toBe("stated_total_unverified");
    }
  });
});

describe("the customized walk stops on its stated numeric `total`", () => {
  test("an empty top page, then answer pages up to the total: no request past it", async () => {
    const { post, requests } = scripted([
      customizedPage(0, 3),
      customizedPage(2, 3),
      customizedPage(1, 3),
    ]);
    const capture = await collectMonth(post, "202609");
    expect(requests).toEqual([
      [TOP, { p01: "202609", p03: "1" }],
      [ANSWER, { seikyuYM: "202609", start: "0", end: "1" }],
      [ANSWER, { seikyuYM: "202609", start: "2", end: "3" }],
    ]);
    expect(capture.pages.map((page) => [page.kind, page.index])).toEqual([
      ["top", 0],
      ["answer", 1],
      ["answer", 2],
    ]);
    expect(await monthCoverage(capture)).toBe("complete");
  });

  test("an answer page that comes back empty before the total is a mismatch", async () => {
    const { post } = scripted([customizedPage(0, 3), customizedPage(2, 3), customizedPage(0, 3)]);
    const capture = await collectMonth(post, "202609");
    expect(capture.transactionCount).toBe(2);
    expect(await monthCoverage(capture)).toBe("stated_total_mismatch");
  });
});

describe("the finalized walk refuses a missing, empty, or repeated cursor", () => {
  test("a missing or empty `nextPageRow` fails the month before another page is requested", async () => {
    // `allCnt` is a readable count and the page has rows, so the stated-total
    // and empty-page stops do not fire. The cursor check is what refuses it.
    const cases = [
      ["absent", finalizedPage(2, { allCnt: "4" })],
      ["empty", finalizedPage(2, { allCnt: "4", nextPageRow: "" })],
      ["not a string or number", finalizedPage(2, { allCnt: "4", nextPageRow: null })],
    ] as const;
    for (const [label, page] of cases) {
      const { post, requests } = scripted([page]);
      await expect(collectMonth(post, "202609")).rejects.toThrow(
        "202609 returned an invalid page cursor",
      );
      expect([label, requests]).toEqual([label, [[TOP, { p01: "202609", p03: "1" }]]]);
    }
  });

  test("a `nextPageRow` that repeats an earlier cursor fails the month before another page is requested", async () => {
    // "3" then "5" are new cursors. The third page repeats the first cursor,
    // as a string or as the same number. A further page is scripted so a walk
    // that continued would have to ask for it.
    for (const repeated of ["3", 3] as const) {
      const { post, requests } = scripted([
        finalizedPage(1, { allCnt: "9", nextPageRow: "3" }),
        finalizedPage(1, { allCnt: "9", nextPageRow: "5", pageNo: "2" }),
        finalizedPage(1, { allCnt: "9", nextPageRow: repeated, pageNo: "3" }),
        finalizedPage(1, { allCnt: "9", nextPageRow: "7", pageNo: "4" }),
      ]);
      await expect(collectMonth(post, "202609")).rejects.toThrow(
        "202609 returned an invalid page cursor",
      );
      expect([repeated, requests]).toEqual([
        repeated,
        [
          [TOP, { p01: "202609", p03: "1" }],
          [TOP, { p01: "202609", p03: "3" }],
          [TOP, { p01: "202609", p03: "5" }],
        ],
      ]);
    }
  });
});

/** Finalized pages whose cursors are new and whose stated total does not end the month. */
function openFinalizedPages(count: number) {
  return Array.from({ length: count }, (_, index) =>
    finalizedPage(1, { allCnt: "100000", nextPageRow: String(index + 2) }),
  );
}

function topRequests(count: number) {
  return Array.from({ length: count }, (_, index) => [
    TOP,
    { p01: "202609", p03: String(index + 1) },
  ]);
}

/**
 * A customized top page with no rows, then one-row answer pages. The top page's
 * `pageSize` is 2, so each answer is requested across two row slots while the
 * captured count advances by the single row that page returns.
 */
function openCustomizedPages(answerPages: number, total: number) {
  return [
    customizedPage(0, total),
    ...Array.from({ length: answerPages }, () => customizedPage(1, total)),
  ];
}

function answerRequests(answerCount: number) {
  return [
    [TOP, { p01: "202609", p03: "1" }],
    ...Array.from({ length: answerCount }, (_, index) => [
      ANSWER,
      { seikyuYM: "202609", start: String(index), end: String(index + 1) },
    ]),
  ];
}

describe("the page walk stops at 100 pages", () => {
  test("a finalized month that is still open after 100 pages fails and does not request the next scripted page", async () => {
    // The first page is fetched before the loop. Each of the 100 iterations
    // then fetches the following page before the bound is checked, so the
    // failure is thrown after 101 calls. The 102nd scripted page stays unused.
    // `allCnt` stays above every cursor, and the cursors do not repeat.
    const { post, requests } = scripted(openFinalizedPages(102));
    await expect(collectMonth(post, "202609")).rejects.toThrow("202609 exceeded 100 pages");
    expect(requests).toEqual(topRequests(101));
  });

  test("a finalized month that ends on the 100th page makes no further request", async () => {
    const { post, requests } = scripted([
      ...openFinalizedPages(99),
      finalizedPage(1, { allCnt: "100", nextPageRow: "101" }),
      finalizedPage(1, { allCnt: "100", nextPageRow: "200" }),
    ]);
    const capture = await collectMonth(post, "202609");
    expect(capture.transactionCount).toBe(100);
    expect(capture.pages.map((page) => [page.kind, page.index])).toEqual(
      Array.from({ length: 100 }, (_, index) => ["top", index]),
    );
    expect(requests).toEqual(topRequests(100));
  });

  test("a customized month that is still short of its total after the bound fails and does not request the next scripted page", async () => {
    // One top page and 99 answer pages are the calls made while `page < 100`.
    // The stated total is still above those rows. A 100th answer page is
    // scripted and must stay unrequested.
    const { post, requests } = scripted(openCustomizedPages(100, 10_000));
    await expect(collectMonth(post, "202609")).rejects.toThrow("202609 exceeded 100 pages");
    expect(requests).toEqual(answerRequests(99));
  });

  test("a customized month that reaches its total on the last accepted answer page makes no further request", async () => {
    const { post, requests } = scripted(openCustomizedPages(100, 99));
    const capture = await collectMonth(post, "202609");
    expect(capture.transactionCount).toBe(99);
    expect(capture.pages.map((page) => [page.kind, page.index])).toEqual([
      ["top", 0],
      ...Array.from({ length: 99 }, (_, index) => ["answer", index + 1]),
    ]);
    expect(requests).toEqual(answerRequests(99));
  });
});
