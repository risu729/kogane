// The wire checks of ADR 0128 slices S6 and S7: the two candidate reviews and
// the agent query answer. Until S9 an answer without `next` and `paging`
// still validates; one with them validates only when they say what the
// deprecated fields say. A candidate page's `nextOffset` alone cannot tell
// the last page from one the grant's `maxRows` withholds, so the check reads
// `total` too: items past this page with no `nextOffset` are withheld
// (`stoppedBy: "budget"`). Empty synthetic pages: the agreement rules do not
// depend on the items.
import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_CANDIDATE_STATUSES,
  ACCOUNT_CONNECTION_STATES,
} from "../../domain/src/account-candidates.ts";
import { ACCOUNT_CANDIDATES_PATH } from "../src/account-candidates-contract.ts";
import { validApiResponse } from "../src/api-validation.ts";
import { INSTRUMENT_CANDIDATES_PATH } from "../src/instrument-candidates-contract.ts";
import { pagedFields } from "../src/paging-contract.ts";

const zeros = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, 0]));

function accountPage(input: { offset: number; total: number; nextOffset: number | null }) {
  return {
    schemaVersion: "kogane-account-candidates-v1",
    query: { view: "open", offset: input.offset, sourceAccountId: null },
    manifest: { policy: "account-candidates-v1" },
    summary: {
      connections: zeros(ACCOUNT_CONNECTION_STATES),
      candidates: zeros(ACCOUNT_CANDIDATE_STATUSES),
      held: 0,
      unreviewedAggregatorAccounts: 0,
      sameAccountRecorded: 0,
      sameAccountProposed: 0,
    },
    decisions: "change-lifecycle",
    total: input.total,
    items: [],
    nextOffset: input.nextOffset,
    sourceAccounts: [],
  };
}

function instrumentPage(input: { offset: number; total: number; nextOffset: number | null }) {
  return {
    schemaVersion: "kogane-instrument-candidates-v1",
    query: { view: "open", offset: input.offset, identifierId: null },
    manifest: { policy: "instrument-candidates-v1" },
    summary: zeros([
      "identifiers",
      "unresolved",
      "proposed",
      "adopted",
      "rejected",
      "separated",
      "hints",
      "held",
    ]),
    decisions: "change-lifecycle",
    total: input.total,
    items: [],
    nextOffset: input.nextOffset,
    identifiers: [],
  };
}

describe("the candidate reviews agree with nextOffset and total (S6)", () => {
  for (const [path, page] of [
    [ACCOUNT_CANDIDATES_PATH, accountPage],
    [INSTRUMENT_CANDIDATES_PATH, instrumentPage],
  ] as const)
    test(path, () => {
      const empty = page({ offset: 0, total: 0, nextOffset: null });
      expect(validApiResponse(path, empty)).toBe(true);
      const end = pagedFields({ limit: 50, returned: 0, next: null });
      expect(validApiResponse(path, { ...empty, ...end })).toBe(true);
      // Only one of the two fields is not an answer of the contract.
      expect(validApiResponse(path, { ...empty, paging: end.paging })).toBe(false);
      // A continuation the deprecated nextOffset does not name.
      const continuing = {
        next: { arguments: { offset: 50 } },
        paging: { limit: 50, returned: 0, hasMore: true, stoppedBy: "bytes" },
      };
      expect(validApiResponse(path, { ...empty, ...continuing })).toBe(false);
      // A page size other than the review's 50.
      expect(
        validApiResponse(path, {
          ...empty,
          ...pagedFields({ limit: 100, returned: 0, next: null }),
        }),
      ).toBe(false);

      // Items after this page, but no nextOffset: the grant withholds them.
      const withheld = page({ offset: 0, total: 120, nextOffset: null });
      expect(validApiResponse(path, withheld)).toBe(true);
      expect(
        validApiResponse(path, {
          ...withheld,
          ...pagedFields({ limit: 50, returned: 0, next: null, withheld: true }),
        }),
      ).toBe(true);
      // Saying it is the last page is refused, as is offering the page.
      expect(validApiResponse(path, { ...withheld, ...end })).toBe(false);
      expect(validApiResponse(path, { ...withheld, ...continuing })).toBe(false);

      // An offset past the list is the end, never a withheld page.
      const past = page({ offset: 200, total: 120, nextOffset: null });
      expect(validApiResponse(path, { ...past, ...end })).toBe(true);
      expect(
        validApiResponse(path, {
          ...past,
          ...pagedFields({ limit: 50, returned: 0, next: null, withheld: true }),
        }),
      ).toBe(false);
    });
});

function queryAnswer(intent: string, nextCursor: string | null, data: Record<string, unknown>) {
  const dimension = { state: "not-applicable", reasonCodes: [], evidenceRefs: [] };
  return {
    schemaVersion: "kogane-query-response-v1",
    contextId: "ctx_synthetic",
    resultRef: "result:synthetic",
    unresolvedInputs: [],
    result: {
      schemaVersion: "financial-result-v1",
      contextId: "ctx_synthetic",
      resolvedQuery: {
        schemaVersion: "query-spec-v1",
        intent,
        perimeterRef: "perimeter:synthetic",
        effectiveTime: { kind: "unknown", reasonCode: "synthetic" },
        basisRefs: {},
        filters: {},
        limit: 2,
      },
      completeness: "partial",
      data,
      coverage: { scopeRef: "scope", coveredRef: "covered", gaps: [], truncated: false },
      quality: {
        identity: dimension,
        freshness: dimension,
        numeric: dimension,
        reconciliation: dimension,
        valuation: dimension,
      },
      nextCursor,
      explanationRefs: [],
      warnings: [],
    },
  };
}

describe("the agent query answer agrees with result.nextCursor (S7)", () => {
  const path = "/api/v2/query";
  const rows = { intent: "activity", rows: [{}, {}] };

  test("a row page carries the same cursor, the resolved limit and its rows", () => {
    const page = queryAnswer("activity", "c0ffee", rows);
    expect(validApiResponse(path, page)).toBe(true);
    const fields = pagedFields({ limit: 2, returned: 2, next: { cursor: "c0ffee" } });
    expect(validApiResponse(path, { ...page, ...fields })).toBe(true);
    // Another cursor, another limit, a count other than the rows, a withheld page.
    for (const wrong of [
      pagedFields({ limit: 2, returned: 2, next: { cursor: "other" } }),
      pagedFields({ limit: 3, returned: 2, next: { cursor: "c0ffee" }, stoppedBy: "bytes" }),
      pagedFields({ limit: 2, returned: 1, next: { cursor: "c0ffee" }, stoppedBy: "bytes" }),
      pagedFields({ limit: 2, returned: 2, next: null, withheld: true }),
      pagedFields({ limit: 2, returned: 2, next: { offset: 2 } }),
    ])
      expect(validApiResponse(path, { ...page, ...wrong })).toBe(false);
    const last = queryAnswer("reported-state", null, { intent: "reported-state", rows: [{}] });
    expect(
      validApiResponse(path, {
        ...last,
        ...pagedFields({ limit: 2, returned: 1, next: null }),
      }),
    ).toBe(true);
  });

  test("an intent that answers whole carries neither field", () => {
    const coverage = queryAnswer("coverage", null, { intent: "coverage", scopes: [] });
    expect(validApiResponse(path, coverage)).toBe(true);
    expect(
      validApiResponse(path, {
        ...coverage,
        ...pagedFields({ limit: 2, returned: 0, next: null }),
      }),
    ).toBe(false);
  });
});
