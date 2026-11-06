// The `GET /api/v2/delegations` contract: exact keys, closed codes, and a
// state that agrees with the window it names. Synthetic values only.
import { describe, expect, test } from "bun:test";
import { validApiResponse } from "../src/api-validation.ts";
import {
  DELEGATION_STATUS_PATH,
  validDelegationStatus,
  type DelegationStatus,
  type DelegationStatusEntry,
} from "../src/delegation-status-contract.ts";

const row = (change: Partial<DelegationStatusEntry> = {}): DelegationStatusEntry => ({
  principal: "mcp-client:owner-synthetic",
  delegatedBy: "owner-synthetic",
  role: "maintainer",
  capabilities: ["schedules.maintenance.update", "operations.read"],
  scopes: { sources: ["synthetic-source"], accounts: "*", scheduleSources: [] },
  issuedAt: "2026-10-01T00:00:00Z",
  notAfter: "2026-11-01T00:00:00Z",
  writesPerDay: 30,
  state: "in_force",
  delegationRef: `dlg_${"a".repeat(64)}`,
  ...change,
});
const view = (
  delegations: DelegationStatusEntry[] = [row()],
  change: Partial<DelegationStatus> = {},
): DelegationStatus => ({
  schemaVersion: "kogane-delegation-status-v1",
  evaluatedAt: "2026-10-09T00:00:00.000Z",
  configuration: delegations.length > 0 ? "valid" : "none",
  delegations,
  ...change,
});

describe("delegation status contract", () => {
  test("accepts the three configurations the server answers", () => {
    expect(validApiResponse(DELEGATION_STATUS_PATH, view())).toBe(true);
    expect(validApiResponse(DELEGATION_STATUS_PATH, view([]))).toBe(true);
    expect(
      validApiResponse(DELEGATION_STATUS_PATH, view([], { configuration: "misconfigured" })),
    ).toBe(true);
    expect(
      validDelegationStatus(
        view([
          row({ state: "expired", notAfter: "2026-10-09T00:00:00.000Z" }),
          row({
            principal: "mcp-client:second-synthetic",
            delegatedBy: "second-synthetic",
            issuedAt: "2026-10-09T00:00:00.001Z",
            state: "not_yet_valid",
          }),
        ]),
      ),
    ).toBe(true);
  });

  test("refuses any key it does not name, at every level", () => {
    expect(validDelegationStatus({ ...view(), raw: "{}" })).toBe(false);
    expect(validDelegationStatus(view([{ ...row(), token: "x" } as DelegationStatusEntry]))).toBe(
      false,
    );
    expect(
      validDelegationStatus(
        view([row({ scopes: { ...row().scopes, extra: [] } as DelegationStatusEntry["scopes"] })]),
      ),
    ).toBe(false);
    const { delegationRef: _ref, ...missing } = row();
    expect(validDelegationStatus(view([missing as DelegationStatusEntry]))).toBe(false);
  });

  test("refuses codes, roles and capabilities outside the vocabulary", () => {
    for (const change of [
      { state: "active" },
      { role: "admin" },
      { capabilities: ["grants.update"] },
      { capabilities: [] },
      // Not in vocabulary order, or repeated.
      { capabilities: ["operations.read", "schedules.maintenance.update"] },
      { capabilities: ["operations.read", "operations.read"] },
      { delegationRef: "dlg_short" },
      { writesPerDay: 0 },
      { writesPerDay: 201 },
      { issuedAt: "2026-10-01" },
    ] as Partial<DelegationStatusEntry>[])
      expect(validDelegationStatus(view([row(change)]))).toBe(false);
    expect(validDelegationStatus(view([], { configuration: "broken" as "none" }))).toBe(false);
    expect(
      validDelegationStatus(view([], { schemaVersion: "v2" as "kogane-delegation-status-v1" })),
    ).toBe(false);
  });

  test("the principal is the delegator's own MCP identity", () => {
    for (const change of [
      { principal: "mcp-client:someone-else" },
      { principal: "owner-synthetic" },
      {
        principal: "mcp-client:mcp-client:owner-synthetic",
        delegatedBy: "mcp-client:owner-synthetic",
      },
    ])
      expect(validDelegationStatus(view([row(change)]))).toBe(false);
  });

  test("the configuration agrees with the entries, and entries are ordered once", () => {
    expect(validDelegationStatus(view([], { configuration: "valid" }))).toBe(false);
    expect(validDelegationStatus(view([row()], { configuration: "none" }))).toBe(false);
    expect(validDelegationStatus(view([row()], { configuration: "misconfigured" }))).toBe(false);
    expect(validDelegationStatus(view([row(), row()]))).toBe(false);
    const second = row({ principal: "mcp-client:a-synthetic", delegatedBy: "a-synthetic" });
    expect(validDelegationStatus(view([row(), second]))).toBe(false);
    expect(validDelegationStatus(view([second, row()]))).toBe(true);
  });

  test("the state is the window read at `evaluatedAt`", () => {
    for (const change of [
      { state: "expired" },
      { state: "not_yet_valid" },
      { notAfter: "2026-10-09T00:00:00.000Z" },
      { issuedAt: "2026-10-09T00:00:00.001Z" },
      // An empty or inverted window.
      { issuedAt: "2026-11-01T00:00:00Z" },
    ] as Partial<DelegationStatusEntry>[])
      expect(validDelegationStatus(view([row(change)]))).toBe(false);
  });
});
