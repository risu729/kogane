// The converted reads' wire checks (ADR 0128): during the release that keeps
// the deprecated fields, an answer without `next` and `paging` still
// validates, one with them validates only when they say what the old fields
// say. Empty synthetic pages: the agreement rules do not depend on rows.
import { describe, expect, test } from "bun:test";
import { validApiResponse } from "../src/api-validation.ts";
import { validAuditPage } from "../src/audit-contract.ts";
import { validNextPage } from "../src/card-settlement-contract.ts";
import { validEvidenceResponse } from "../src/evidence-validation.ts";
import { validIdentityResponse } from "../src/identity-contract.ts";
import { pagedFields } from "../src/paging-contract.ts";

const end = pagedFields({ limit: 50, returned: 0, next: null });

describe("an answer without next and paging, then with agreeing and disagreeing ones", () => {
  test("identity pages agree on the offset", () => {
    const old = { rows: [], coverage: { limit: 100, truncated: false, nextOffset: null } };
    const path = "/api/identity/accounts";
    expect(validIdentityResponse(path, old)).toBe(true);
    expect(
      validIdentityResponse(path, {
        ...old,
        ...pagedFields({ limit: 100, returned: 0, next: null }),
      }),
    ).toBe(true);
    // An offset the deprecated coverage does not name.
    expect(
      validIdentityResponse(path, {
        ...old,
        next: { arguments: { offset: 100 } },
        paging: { limit: 100, returned: 0, hasMore: true, stoppedBy: "bytes" },
      }),
    ).toBe(false);
  });

  test("the report list agrees on its offset-as-text cursor", () => {
    const old = { apiVersion: 2, items: [], nextCursor: null };
    expect(validApiResponse("/api/v2/reports", old)).toBe(true);
    expect(validApiResponse("/api/v2/reports", { ...old, ...end })).toBe(true);
    expect(
      validApiResponse("/api/v2/reports", {
        ...old,
        nextCursor: "50",
        ...end,
      }),
    ).toBe(false);
  });

  test("an evidence list agrees on its id cursor", () => {
    const old = {
      apiVersion: "evidence-v1",
      sourceId: "sony-bank",
      coverage: "sealed-only",
      items: [],
      nextCursor: null,
    };
    const path = "/api/evidence/v1/sources/sony-bank/runs";
    expect(validEvidenceResponse(path, old)).toBe(true);
    expect(validEvidenceResponse(path, { ...old, ...end })).toBe(true);
    expect(
      validEvidenceResponse(path, {
        ...old,
        ...pagedFields({ limit: 25, returned: 0, next: null }),
      }),
    ).toBe(false);
  });

  test("a card settlement page agrees on nextOffset and nextPage, budget included", () => {
    const none = { nextOffset: null, nextPage: "none" };
    expect(validNextPage(none, 50)).toBe(true);
    expect(validNextPage({ ...none, ...end }, 50)).toBe(true);
    const offered = { nextOffset: 50, nextPage: "offered" };
    expect(
      validNextPage(
        { ...offered, ...pagedFields({ limit: 50, returned: 50, next: { offset: 50 } }) },
        50,
      ),
    ).toBe(true);
    expect(validNextPage({ ...offered, ...end }, 50)).toBe(false);
    const withheld = { nextOffset: null, nextPage: "budget_exceeded" };
    expect(
      validNextPage(
        { ...withheld, ...pagedFields({ limit: 50, returned: 50, next: null, withheld: true }) },
        50,
      ),
    ).toBe(true);
    // A withheld page is never the end of the list.
    expect(validNextPage({ ...withheld, ...end }, 50)).toBe(false);
  });

  test("an audit page agrees on its cursor", () => {
    const old = { schemaVersion: "kogane-audit-page-v1", records: [], cursor: null };
    expect(validAuditPage(old)).toBe(true);
    expect(validAuditPage({ ...old, ...end })).toBe(true);
    expect(
      validAuditPage({
        ...old,
        next: { arguments: { cursor: "abc" } },
        paging: { limit: 50, returned: 0, hasMore: true, stoppedBy: "bytes" },
      }),
    ).toBe(false);
  });
});
