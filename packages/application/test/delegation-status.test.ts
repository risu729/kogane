// The operator's view of the delegation table (ADR 0063, amendment of
// 2026-11-06). Synthetic identities and configuration only.
import { describe, expect, test } from "bun:test";
import {
  DELEGATION_CAPABILITIES,
  DELEGATION_ROLES,
  type DelegationEntry,
} from "../src/delegation/contract.ts";
import { resolveDelegation } from "../src/delegation/resolve.ts";
import { delegationStatus } from "../src/delegation/status.ts";
import {
  DELEGATION_STATUS_CAPABILITIES,
  DELEGATION_STATUS_ROLES,
  validDelegationStatus,
} from "../../observation-shared/src/delegation-status-contract.ts";

const OWNER = "owner-status-synthetic";
const SECOND = "second-status-synthetic";
const NOW = "2026-10-09T00:00:00.000Z";
const entry = (delegatedBy = OWNER, change: Partial<DelegationEntry> = {}): DelegationEntry => ({
  delegatedBy,
  role: "reviewer",
  scopes: { sources: "*", accounts: "*", scheduleSources: [] },
  issuedAt: "2026-10-01T00:00:00Z",
  notAfter: "2026-11-01T00:00:00Z",
  budget: { writesPerDay: 10 },
  ...change,
});
const grants = new Map(
  [OWNER, SECOND].map((subject) => [
    `mcp-client:${subject}`,
    {
      principal: `mcp-client:${subject}`,
      scopes: { sources: "*" as const, accounts: "*" as const, scheduleSources: "*" as const },
    },
  ]),
);
const status = (configured: unknown, now = NOW) =>
  delegationStatus({
    configured: typeof configured === "string" ? configured : JSON.stringify(configured),
    operatorSubjects: JSON.stringify([OWNER, SECOND]),
    readGrants: grants,
    now,
  });

describe("delegation status reads the resolver's table, never more", () => {
  test("the wire vocabulary is the delegation vocabulary", () => {
    expect([...DELEGATION_STATUS_CAPABILITIES]).toEqual([...DELEGATION_CAPABILITIES]);
    expect([...DELEGATION_STATUS_ROLES]).toEqual([...DELEGATION_ROLES]);
  });

  test("absent and empty tables are `none`; an unreadable one is `misconfigured`", async () => {
    for (const configured of ["", "   ", "{}"]) {
      const view = await status(configured);
      expect(view).toMatchObject({ configuration: "none", delegations: [] });
      expect(validDelegationStatus(view)).toBe(true);
    }
    for (const configured of ["{", "[]", "1", { [`mcp-client:${OWNER}`]: { role: "reviewer" } }]) {
      const view = await status(configured);
      expect(view).toEqual({
        schemaVersion: "kogane-delegation-status-v1",
        evaluatedAt: NOW,
        configuration: "misconfigured",
        delegations: [],
      });
      expect(validDelegationStatus(view)).toBe(true);
    }
  });

  test("entries are ordered by principal and carry the resolver's reference and capabilities", async () => {
    const table = {
      [`mcp-client:${SECOND}`]: entry(SECOND, {
        role: "maintainer",
        scopes: { sources: ["s"], accounts: "*", scheduleSources: ["s"] },
      }),
      [`mcp-client:${OWNER}`]: entry(OWNER, { capabilities: ["schedules.job.update"] }),
    };
    const view = await status(table);
    expect(validDelegationStatus(view)).toBe(true);
    expect(view.delegations.map((row) => row.principal)).toEqual([
      `mcp-client:${OWNER}`,
      `mcp-client:${SECOND}`,
    ]);
    for (const row of view.delegations) {
      const resolved = await resolveDelegation({
        configured: JSON.stringify(table),
        operatorSubjects: JSON.stringify([OWNER, SECOND]),
        readGrants: grants,
        caller: { kind: "mcp-client", principal: row.principal },
        now: NOW,
      });
      if (!resolved.ok) throw new Error("synthetic entry must resolve");
      expect(row.delegationRef).toBe(resolved.principal.delegationRef);
      expect(row.capabilities).toEqual([...resolved.principal.capabilities]);
      expect(row.state).toBe("in_force");
    }
    expect(view.delegations[0]!.capabilities).toEqual([
      "commands.plan",
      "commands.decide.card-settlement",
      "commands.decide.relation",
      "schedules.job.update",
    ]);
  });

  test("the window is `[issuedAt, notAfter)` at nanosecond precision, as the resolver reads it", async () => {
    for (const [now, state, code] of [
      ["2026-09-30T23:59:59.999999999Z", "not_yet_valid", "delegation_not_yet_valid"],
      ["2026-10-01T00:00:00Z", "in_force", null],
      ["2026-10-31T23:59:59.999999999Z", "in_force", null],
      ["2026-11-01T00:00:00Z", "expired", "delegation_expired"],
    ] as const) {
      const view = await status({ [`mcp-client:${OWNER}`]: entry() }, now);
      expect(view.delegations[0]!.state).toBe(state);
      expect(validDelegationStatus(view)).toBe(true);
      const resolved = await resolveDelegation({
        configured: JSON.stringify({ [`mcp-client:${OWNER}`]: entry() }),
        operatorSubjects: JSON.stringify([OWNER, SECOND]),
        readGrants: grants,
        caller: { kind: "mcp-client", principal: `mcp-client:${OWNER}` },
        now,
      });
      expect(resolved.ok ? null : resolved.code).toBe(code);
    }
  });

  test("`misconfigured` exactly when the resolver refuses the table, for every caller", async () => {
    const tables: unknown[] = [
      "",
      "{}",
      "{",
      "null",
      "[]",
      { [`mcp-client:${OWNER}`]: entry() },
      { [`mcp-client:${OWNER}`]: entry(), [`mcp-client:${SECOND}`]: entry(SECOND) },
      // Key and delegator disagree; delegator is not an operator.
      { [`mcp-client:${SECOND}`]: entry(OWNER) },
      { "mcp-client:not-an-operator": entry("not-an-operator") },
      // An unknown key, a capability outside the vocabulary, a repeated one.
      { [`mcp-client:${OWNER}`]: { ...entry(), note: "x" } },
      { [`mcp-client:${OWNER}`]: entry(OWNER, { capabilities: ["grants.update" as never] }) },
      {
        [`mcp-client:${OWNER}`]: entry(OWNER, {
          capabilities: ["operations.read", "operations.read"],
        }),
      },
      // Command capabilities need whole-store scope.
      {
        [`mcp-client:${OWNER}`]: entry(OWNER, {
          scopes: { sources: ["s"], accounts: "*", scheduleSources: [] },
        }),
      },
      // Empty or inverted window, a lifetime over 90 days, a budget out of range.
      { [`mcp-client:${OWNER}`]: entry(OWNER, { notAfter: "2026-10-01T00:00:00Z" }) },
      { [`mcp-client:${OWNER}`]: entry(OWNER, { notAfter: "2027-01-01T00:00:00Z" }) },
      { [`mcp-client:${OWNER}`]: entry(OWNER, { budget: { writesPerDay: 201 } }) },
      // A valid entry beside an invalid one.
      { [`mcp-client:${OWNER}`]: entry(), [`mcp-client:${SECOND}`]: entry(OWNER) },
    ];
    for (const table of tables) {
      const configured = typeof table === "string" ? table : JSON.stringify(table);
      const view = await status(configured);
      expect(validDelegationStatus(view)).toBe(true);
      for (const principal of [`mcp-client:${OWNER}`, `mcp-client:${SECOND}`]) {
        const resolved = await resolveDelegation({
          configured,
          operatorSubjects: JSON.stringify([OWNER, SECOND]),
          readGrants: grants,
          caller: { kind: "mcp-client", principal },
          now: NOW,
        });
        const refused = !resolved.ok && resolved.code === "delegation_misconfigured";
        expect(view.configuration === "misconfigured").toBe(refused);
        // A listed entry is exactly one the resolver honours in its window.
        const listed = view.delegations.find((row) => row.principal === principal);
        expect(listed !== undefined).toBe(resolved.ok);
      }
    }
  });

  test("a scope list is a copy, never the parsed configuration object", async () => {
    const view = await status({
      [`mcp-client:${OWNER}`]: entry(OWNER, {
        role: "maintainer",
        scopes: { sources: ["a"], accounts: "*", scheduleSources: ["a", "b"] },
      }),
    });
    expect(view.delegations[0]!.scopes).toEqual({
      sources: ["a"],
      accounts: "*",
      scheduleSources: ["a", "b"],
    });
  });

  test("a clock that is not a canonical instant is a programming error", async () => {
    await expect(status({}, "yesterday")).rejects.toThrow(TypeError);
  });
});
