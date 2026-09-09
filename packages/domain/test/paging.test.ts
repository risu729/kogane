// The snapshot page envelope and its cursor contract (review 06, D10).
import { describe, expect, test } from "bun:test";
import {
  checkKeysetCursor,
  decodeKeysetCursor,
  encodeKeysetCursor,
  KEYSET_PAGINATION_VERSION,
  SNAPSHOT_PAGE_SCHEMA_VERSION,
  validObservedQuantity,
  validPageDataCoverage,
  validPageInfo,
  validSnapshotPage,
} from "../src/paging.ts";

const isNumber = (value: unknown): value is number => typeof value === "number";
const cursor = { s: "a".repeat(64), f: "b".repeat(64), k: "2026-09-08", t: 41 };

describe("snapshot page envelope", () => {
  test("a page separates its own end from the completeness of the data behind it", () => {
    const page = {
      schemaVersion: SNAPSHOT_PAGE_SCHEMA_VERSION,
      items: [1, 2],
      page: {
        limit: 100,
        hasMore: true,
        nextCursor: encodeKeysetCursor(cursor),
        snapshotId: cursor.s,
        paginationVersion: KEYSET_PAGINATION_VERSION,
      },
      dataCoverage: {
        completeness: "partial",
        stale: true,
        reasons: ["unresolved:overlap_unknown"],
      },
    };
    expect(validSnapshotPage(page, isNumber)).toBe(true);
    // A complete page of incomplete data and an incomplete page of complete
    // data are both expressible, which is the point of the split.
    expect(validPageInfo({ ...page.page, hasMore: false, nextCursor: null })).toBe(true);
    expect(validPageDataCoverage({ completeness: "complete", stale: false, reasons: [] })).toBe(
      true,
    );
    expect(validPageDataCoverage({ completeness: "mostly", stale: false, reasons: [] })).toBe(
      false,
    );
    // An unknown extra field is a contract change, not a free extension.
    expect(validSnapshotPage({ ...page, netWorth: "1" }, isNumber)).toBe(false);
  });

  test("a cursor round-trips and carries no account, metric or amount", () => {
    const text = encodeKeysetCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeKeysetCursor(text)).toEqual({ v: "keyset-cursor-v1", ...cursor });
    const decoded = atob(text.replace(/-/gu, "+").replace(/_/gu, "/"));
    for (const forbidden of ["source_account", "amount", "JPY", "account_balance"])
      expect(decoded).not.toContain(forbidden);
  });

  test("a malformed, oversized or foreign cursor is rejected, never reinterpreted", () => {
    for (const text of ["", "not-a-cursor", "***", btoa("{}"), "a".repeat(4096)])
      expect(decodeKeysetCursor(text)).toBeNull();
    // A well-formed base64url payload with the wrong shape is still refused.
    const wrongShape = btoa(JSON.stringify({ v: "keyset-cursor-v1", s: "x" }))
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
    expect(decodeKeysetCursor(wrongShape)).toBeNull();
  });

  test("a changed filter is a mismatch and a deleted snapshot is an expired context", () => {
    const decoded = decodeKeysetCursor(encodeKeysetCursor(cursor))!;
    expect(
      checkKeysetCursor(decoded, { filterDigest: cursor.f, snapshotReadable: true }),
    ).toBeNull();
    expect(
      checkKeysetCursor(decoded, { filterDigest: "c".repeat(64), snapshotReadable: true }),
    ).toBe("cursor_mismatch");
    expect(
      checkKeysetCursor(decoded, {
        filterDigest: cursor.f,
        requestedSnapshotId: "d".repeat(64),
        snapshotReadable: true,
      }),
    ).toBe("cursor_mismatch");
    // The snapshot is gone: reading starts again from a new context rather
    // than silently continuing in a different list.
    expect(checkKeysetCursor(decoded, { filterDigest: cursor.f, snapshotReadable: false })).toBe(
      "context_expired",
    );
  });

  test("an observed quantity keeps the legacy columns as evidence and never guesses an exponent", () => {
    const quantity = {
      normalized: {
        policyVersion: "decimal-v1",
        status: "exact",
        coefficient: "60000",
        scale: 0,
        basis: "minor_units",
      },
      unitReference: "JPY",
      sourceRepresentation: {
        amountText: "60,000",
        legacyMinorUnits: "60000",
        legacyMinorUnitExponent: 0,
      },
    };
    expect(validObservedQuantity(quantity)).toBe(true);
    expect(
      validObservedQuantity({
        ...quantity,
        sourceRepresentation: { ...quantity.sourceRepresentation, legacyMinorUnitExponent: null },
      }),
    ).toBe(true);
    // A missing value stays missing; it is never carried as an exact zero.
    expect(
      validObservedQuantity({
        ...quantity,
        normalized: {
          policyVersion: "decimal-v1",
          status: "missing",
          coefficient: null,
          scale: null,
          basis: "none",
        },
      }),
    ).toBe(true);
    expect(
      validObservedQuantity({
        ...quantity,
        sourceRepresentation: { ...quantity.sourceRepresentation, legacyMinorUnits: "60,000" },
      }),
    ).toBe(false);
  });
});
