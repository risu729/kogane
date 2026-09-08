import { expect, test } from "bun:test";
import { validIdentityResponse } from "../shared/identity-contract.ts";
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
