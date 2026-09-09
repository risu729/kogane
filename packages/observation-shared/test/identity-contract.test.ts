import { expect, test } from "bun:test";
import { validIdentityResponse, nextIdentityOffset } from "../src/identity-contract.ts";
test("identity transport rejects invalid counts, origins, statuses, and unbounded pages", () => {
  const row = {
    referenceId: "ref",
    targetId: "target",
    label: "Synthetic",
    role: "cash",
    status: "provider-local",
    source: "synthetic",
    reference: '["synthetic"]',
    reason: "rule",
    revision: 1,
    observedCount: 1,
    origin: { kind: "balance", id: 1 },
  };
  const value = { rows: [row], coverage: { limit: 100, truncated: false, nextOffset: null } };
  expect(validIdentityResponse("/api/identity/accounts", value)).toBe(true);
  for (const patch of [
    { observedCount: -1 },
    { revision: 0 },
    { status: "confirmed" },
    { origin: { kind: "balance", id: 0 } },
  ])
    expect(
      validIdentityResponse("/api/identity/accounts", { ...value, rows: [{ ...row, ...patch }] }),
    ).toBe(false);
  expect(
    validIdentityResponse("/api/identity/accounts", { ...value, rows: Array(101).fill(row) }),
  ).toBe(false);
  expect(validIdentityResponse("/api/identity/missing", { ...value, rows: [] })).toBe(false);
});
test("identity pagination crosses the former cap but never rounds an unsafe next offset", () => {
  expect(nextIdentityOffset(1_000_000, true)).toBe(1_000_100);
  expect(nextIdentityOffset(Number.MAX_SAFE_INTEGER - 100, true)).toBe(Number.MAX_SAFE_INTEGER);
  expect(nextIdentityOffset(Number.MAX_SAFE_INTEGER, false)).toBe(null);
  expect(() => nextIdentityOffset(Number.MAX_SAFE_INTEGER - 99, true)).toThrow(
    "pagination_offset_overflow",
  );
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => nextIdentityOffset(value, false)).toThrow("invalid_offset");
});
test("coverage status counts partition organized observations without negative remaining work", () => {
  const row = {
    source: "synthetic",
    eligible: 5,
    organized: 4,
    identified: 1,
    providerLocal: 1,
    aggregate: 1,
    unresolved: 1,
  };
  const valid = (patch: Record<string, number>) =>
    validIdentityResponse("/api/identity/coverage", {
      rows: [{ ...row, ...patch }],
      coverage: { limit: 100, truncated: false, nextOffset: null },
    });
  expect(valid({})).toBe(true);
  expect(valid({ eligible: 3 })).toBe(false);
  expect(valid({ organized: 3 })).toBe(false);
  expect(valid({ organized: 5 })).toBe(false);
  expect(
    valid({
      eligible: Number.MAX_SAFE_INTEGER,
      organized: Number.MAX_SAFE_INTEGER,
      identified: Number.MAX_SAFE_INTEGER,
    }),
  ).toBe(false);
  expect(
    valid({
      eligible: 0,
      organized: 0,
      identified: 0,
      providerLocal: 0,
      aggregate: 0,
      unresolved: 0,
    }),
  ).toBe(true);
});
