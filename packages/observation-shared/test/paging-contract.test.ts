// The one paging contract (ADR 0128): which `next` and `paging` values are
// legal, how they agree, what the builders produce and what the refusal
// family answers. Synthetic tokens only.
import { describe, expect, test } from "bun:test";
import {
  continueCall,
  contextExpired,
  continuationOf,
  cursorMismatch,
  invalidCursor,
  pagedFields,
  pagedFieldsAbsentOrValid,
  PAGING_REFUSAL_STATUS,
  resultLimitExceeded,
  validContinuation,
  validPagedFields,
  validPaging,
  validPagingRefusalBody,
} from "../src/paging-contract.ts";

describe("next", () => {
  test("names one to three continuation arguments and nothing else", () => {
    expect(validContinuation({ arguments: { cursor: "c_12" } })).toBe(true);
    expect(validContinuation({ arguments: { offset: 50 } })).toBe(true);
    expect(validContinuation({ arguments: { offset: 500, latestOffset: 0 } })).toBe(true);
    // A filter, a page size or an empty patch is never a continuation.
    expect(validContinuation({ arguments: { source: "s" } })).toBe(false);
    expect(validContinuation({ arguments: { cursor: "c_1", limit: 10 } })).toBe(false);
    expect(validContinuation({ arguments: {} })).toBe(false);
    // Only `arguments`.
    expect(validContinuation({ arguments: { offset: 1 }, tool: "x" })).toBe(false);
    expect(validContinuation({ offset: 1 })).toBe(false);
  });

  test("a value is a position or a bounded token without control characters", () => {
    expect(validContinuation({ arguments: { offset: -1 } })).toBe(false);
    expect(validContinuation({ arguments: { offset: 1.5 } })).toBe(false);
    expect(validContinuation({ arguments: { cursor: "" } })).toBe(false);
    expect(validContinuation({ arguments: { cursor: "a\nb" } })).toBe(false);
    expect(validContinuation({ arguments: { cursor: "a".repeat(2048) } })).toBe(true);
    expect(validContinuation({ arguments: { cursor: "a".repeat(2049) } })).toBe(false);
  });

  test("a cursor is always a token and an offset always a position", () => {
    expect(validContinuation({ arguments: { cursor: 50 } })).toBe(false);
    expect(validContinuation({ arguments: { offset: "50" } })).toBe(false);
    expect(validContinuation({ arguments: { latestOffset: "0" } })).toBe(false);
  });
});

describe("paging", () => {
  test("hasMore exactly when something stopped the page early", () => {
    expect(validPaging({ limit: 50, returned: 7, hasMore: false, stoppedBy: null })).toBe(true);
    expect(validPaging({ limit: 50, returned: 50, hasMore: true, stoppedBy: "limit" })).toBe(true);
    expect(validPaging({ limit: 25, returned: 9, hasMore: true, stoppedBy: "bytes" })).toBe(true);
    expect(validPaging({ limit: 50, returned: 50, hasMore: true, stoppedBy: "budget" })).toBe(true);
    expect(validPaging({ limit: null, returned: 3, hasMore: true, stoppedBy: "bytes" })).toBe(true);
    expect(validPaging({ limit: 50, returned: 50, hasMore: true, stoppedBy: null })).toBe(false);
    expect(validPaging({ limit: 50, returned: 5, hasMore: false, stoppedBy: "limit" })).toBe(false);
  });

  test("a page holds at most its limit, and a page the limit stopped is full", () => {
    expect(validPaging({ limit: 10, returned: 11, hasMore: false, stoppedBy: null })).toBe(false);
    expect(validPaging({ limit: 10, returned: 9, hasMore: true, stoppedBy: "limit" })).toBe(false);
    expect(validPaging({ limit: 0, returned: 0, hasMore: false, stoppedBy: null })).toBe(false);
    expect(validPaging({ limit: 10, returned: 0, hasMore: false, stoppedBy: null })).toBe(true);
  });

  test("exact keys only", () => {
    expect(validPaging({ limit: 10, returned: 1, hasMore: false, stoppedBy: null, total: 1 })).toBe(
      false,
    );
    expect(validPaging({ limit: 10, returned: 1, hasMore: false })).toBe(false);
  });
});

describe("next and paging together", () => {
  const more = { limit: 50, returned: 50, hasMore: true, stoppedBy: "limit" } as const;
  test("a continuation exactly when items follow and the grant may read them", () => {
    expect(validPagedFields({ next: { arguments: { offset: 50 } }, paging: more })).toBe(true);
    expect(validPagedFields({ next: null, paging: more })).toBe(false);
    expect(
      validPagedFields({
        next: null,
        paging: { ...more, stoppedBy: "budget" },
      }),
    ).toBe(true);
    expect(
      validPagedFields({
        next: { arguments: { offset: 50 } },
        paging: { ...more, stoppedBy: "budget" },
      }),
    ).toBe(false);
    expect(
      validPagedFields({
        next: { arguments: { offset: 50 } },
        paging: { limit: 50, returned: 3, hasMore: false, stoppedBy: null },
      }),
    ).toBe(false);
    expect(validPagedFields({ paging: more })).toBe(false);
  });

  test("absent fields pass the deprecation-release check; present ones are judged", () => {
    expect(pagedFieldsAbsentOrValid({ items: [] })).toBe(true);
    expect(pagedFieldsAbsentOrValid({ next: null })).toBe(false);
    expect(
      pagedFieldsAbsentOrValid({
        next: null,
        paging: { limit: 5, returned: 0, hasMore: false, stoppedBy: null },
      }),
    ).toBe(true);
  });
});

describe("builders", () => {
  test("pagedFields says the end, a continuation and a withheld page", () => {
    expect(pagedFields({ limit: 50, returned: 3, next: null })).toEqual({
      next: null,
      paging: { limit: 50, returned: 3, hasMore: false, stoppedBy: null },
    });
    expect(pagedFields({ limit: 50, returned: 50, next: { offset: 100 } })).toEqual({
      next: { arguments: { offset: 100 } },
      paging: { limit: 50, returned: 50, hasMore: true, stoppedBy: "limit" },
    });
    expect(
      pagedFields({ limit: 25, returned: 12, next: { cursor: "k" }, stoppedBy: "bytes" }),
    ).toEqual({
      next: { arguments: { cursor: "k" } },
      paging: { limit: 25, returned: 12, hasMore: true, stoppedBy: "bytes" },
    });
    expect(pagedFields({ limit: 50, returned: 50, next: null, withheld: true })).toEqual({
      next: null,
      paging: { limit: 50, returned: 50, hasMore: true, stoppedBy: "budget" },
    });
  });

  test("pagedFields refuses a value the contract would refuse", () => {
    expect(() =>
      pagedFields({ limit: 50, returned: 50, next: { offset: 1 }, withheld: true }),
    ).toThrow();
    expect(() => pagedFields({ limit: 50, returned: 51, next: null })).toThrow();
    expect(() => pagedFields({ limit: 50, returned: 49, next: { offset: 49 } })).toThrow();
  });

  test("a client continues by merging next.arguments into its last call", () => {
    const last = { collection: "accounts", source: "s", offset: 0 };
    const next = pagedFields({ limit: 2, returned: 2, next: { offset: 2 } }).next!;
    expect(continueCall(last, next)).toEqual({ collection: "accounts", source: "s", offset: 2 });
    expect(continuationOf({ next }, "offset")).toBe(2);
    expect(continuationOf({ next }, "cursor")).toBe(null);
    expect(continuationOf({ next: null }, "offset")).toBe(null);
  });
});

describe("refusals", () => {
  test("each code has its one status", () => {
    expect(PAGING_REFUSAL_STATUS).toEqual({
      invalid_cursor: 400,
      cursor_mismatch: 400,
      context_expired: 410,
      result_limit_exceeded: 413,
    });
    expect(invalidCursor()).toEqual({ status: 400, error: "invalid_cursor" });
    expect(contextExpired()).toEqual({ status: 410, error: "context_expired" });
    expect(cursorMismatch(["filters"])).toEqual({
      status: 400,
      error: "cursor_mismatch",
      mustMatch: ["filters"],
    });
    expect(resultLimitExceeded()).toEqual({ status: 413, error: "result_limit_exceeded" });
    expect(resultLimitExceeded({ detail: "full" })).toEqual({
      status: 413,
      error: "result_limit_exceeded",
      retryWith: { arguments: { detail: "full" } },
    });
  });

  test("hints name arguments only", () => {
    expect(() => cursorMismatch([])).toThrow();
    expect(() => cursorMismatch(["a value with spaces"])).toThrow();
    expect(() => resultLimitExceeded({})).toThrow();
  });

  test("a refusal body carries only its own code's hint", () => {
    expect(validPagingRefusalBody({ error: "invalid_cursor" })).toBe(true);
    expect(
      validPagingRefusalBody({ error: "invalid_cursor", requestId: "r", refs: ["cursor"] }),
    ).toBe(true);
    expect(validPagingRefusalBody({ error: "cursor_mismatch", mustMatch: ["source"] })).toBe(true);
    expect(validPagingRefusalBody({ error: "cursor_mismatch" })).toBe(false);
    expect(validPagingRefusalBody({ error: "invalid_cursor", mustMatch: ["source"] })).toBe(false);
    expect(
      validPagingRefusalBody({
        error: "result_limit_exceeded",
        retryWith: { arguments: { detail: "full" } },
      }),
    ).toBe(true);
    expect(
      validPagingRefusalBody({ error: "result_limit_exceeded", retryWith: { detail: "full" } }),
    ).toBe(false);
    expect(validPagingRefusalBody({ error: "stale_context" })).toBe(false);
    expect(validPagingRefusalBody({ error: "invalid_cursor", message: "x" })).toBe(false);
  });
});
