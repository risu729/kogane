import { describe, expect, test } from "bun:test";
import { activityPageState, uncapturedPagesCode } from "../src/pagination";

// Synthetic pages in the observed pager shape (`Found N Result [p/Ppage] Back
// Next`). The counts are placeholders, not production values.
const page = (body: string) =>
  `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;

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

  test("a pager repeated above and below the list is one pager", () => {
    const state = activityPageState(
      page("Found 20 Result [2/2page] ... Found 20 Result [2/2page]"),
    );
    expect(state).toEqual({ statedTotal: 20, pageIndex: 2, pageCount: 2, conflicting: false });
    expect(uncapturedPagesCode(state)).toBe("activity_pages_unwalked");
  });

  test("ignores script, style and comments", () => {
    expect(
      activityPageState(
        page(
          "<script>var s='Found 99 Result [1/9page]';</script><style>/* [1/9page] */</style><!-- Found 99 Result -->",
        ),
      ),
    ).toEqual({ statedTotal: null, pageIndex: null, pageCount: null, conflicting: false });
  });

  test("decides which pages the stored one leaves out", () => {
    const code = (body: string) => uncapturedPagesCode(activityPageState(page(body)));
    expect(code("no pager")).toBeUndefined();
    expect(code("Found 7 Result")).toBeUndefined();
    expect(code("Found 7 Result [1/1page]")).toBeUndefined();
    expect(code("Found 16 Result [1/2page]")).toBe("activity_pages_unwalked");
    expect(code("[1/2page] [1/3page]")).toBe("activity_pager_unreadable");
    expect(code("Found 16 Result Found 17 Result")).toBe("activity_pager_unreadable");
    expect(code("[3/2page]")).toBe("activity_pager_unreadable");
    expect(code("[0/0page]")).toBe("activity_pager_unreadable");
  });
});
