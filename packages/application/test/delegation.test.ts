import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/src/context.ts";
import {
  DELEGATION_CAPABILITIES,
  DELEGATION_LIMITS,
  DELEGATION_ROLE_CAPABILITIES,
  effectiveDelegationCapabilities,
  type DelegationEntry,
  type DelegationReadGrant,
} from "../src/delegation/contract.ts";
import { parseDelegations } from "../src/delegation/parse.ts";
import { resolveDelegation } from "../src/delegation/resolve.ts";
import {
  delegationCapabilities,
  delegationExecutionReadiness,
} from "../src/delegation/readiness.ts";

const OWNER = "owner-synthetic";
const PRINCIPAL = `mcp-client:${OWNER}`;
const NOW = "2026-10-09T00:00:00Z";
function entry(change: Partial<DelegationEntry> = {}): DelegationEntry {
  return {
    delegatedBy: OWNER,
    role: "maintainer",
    scopes: { sources: ["fixture-source"], accounts: "*", scheduleSources: ["fixture-source"] },
    issuedAt: NOW,
    notAfter: "2026-11-08T00:00:00Z",
    budget: { writesPerDay: 30 },
    ...change,
  };
}
function readGrants(
  scope: DelegationReadGrant["scopes"] = {
    sources: "*",
    accounts: "*",
    scheduleSources: "*",
  },
) {
  return new Map([[PRINCIPAL, { principal: PRINCIPAL, scopes: scope }]]);
}
const configured = (value: unknown = entry(), principal = PRINCIPAL) =>
  JSON.stringify({ [principal]: value });
const parse = (value: unknown) =>
  parseDelegations(configured(value), JSON.stringify([OWNER]), readGrants());
const resolve = (change: Partial<Parameters<typeof resolveDelegation>[0]> = {}) =>
  resolveDelegation({
    configured: configured(),
    operatorSubjects: JSON.stringify([OWNER]),
    readGrants: readGrants(),
    caller: { kind: "mcp-client", principal: PRINCIPAL },
    now: NOW,
    ...change,
  });

describe("S3 declaration core is fail closed, not execution authority", () => {
  test("absent, empty and explicit empty tables are inert", async () => {
    for (const configured of [undefined, "", "   ", "{}"])
      expect(await resolve({ configured })).toEqual({
        ok: false,
        code: "delegation_not_configured",
      });
    expect(parseDelegations("", "bad operators", new Map())).toEqual({
      ok: true,
      entries: new Map(),
    });
  });
  test("unreadable input is different from an absent declaration", async () => {
    for (const configured of [null, "{", "[]", '"text"', "123"])
      expect(await resolve({ configured })).toEqual({
        ok: false,
        code: "delegation_misconfigured",
      });
  });
  test("only the owner's exact attenuated map key may be delegated", () => {
    for (const principal of [
      OWNER,
      "mcp-client:other-synthetic",
      "mcp-client:mcp-client:owner-synthetic",
    ])
      expect(
        parseDelegations(configured(entry(), principal), JSON.stringify([OWNER]), readGrants()).ok,
      ).toBe(false);
    for (const value of [
      entry({ delegatedBy: "other-synthetic" }),
      entry({ delegatedBy: PRINCIPAL }),
      entry({ delegatedBy: " bad" }),
    ])
      expect(parse(value).ok).toBe(false);
    expect(parseDelegations(configured(), "[]", readGrants()).ok).toBe(false);
    expect(parseDelegations(configured(), "{", readGrants()).ok).toBe(false);
    expect(parseDelegations(configured(), JSON.stringify([OWNER]), new Map()).ok).toBe(false);
  });
  test("browser caller, even claiming an MCP name, never sees table state", async () => {
    for (const principal of [OWNER, PRINCIPAL])
      expect(await resolve({ configured: "{", caller: { kind: "browser", principal } })).toEqual({
        ok: false,
        code: "delegation_not_mcp_client",
      });
    expect(await resolve({ caller: { kind: "mcp-client", principal: OWNER } })).toEqual({
      ok: false,
      code: "delegation_not_configured",
    });
    expect(
      await resolve({ caller: { kind: "mcp-client", principal: "mcp-client:other-synthetic" } }),
    ).toEqual({
      ok: false,
      code: "delegation_not_configured",
    });
  });
  test("body authority and unknown keys reject every entry", () => {
    const valid = entry();
    for (const value of [
      { ...valid, principal: PRINCIPAL },
      { ...valid, extra: "never" },
      { ...valid, budget: { writesPerDay: 30, extra: true } },
      { ...valid, scopes: { ...valid.scopes, extra: true } },
    ])
      expect(parse(value).ok).toBe(false);
    for (const key of ["delegatedBy", "role", "scopes", "issuedAt", "notAfter", "budget"]) {
      const value: Record<string, unknown> = { ...valid };
      delete value[key];
      expect(parse(value).ok).toBe(false);
    }
    expect(
      parseDelegations(
        JSON.stringify({ [PRINCIPAL]: valid, invalid: {} }),
        JSON.stringify([OWNER]),
        readGrants(),
      ),
    ).toEqual({
      ok: false,
      code: "delegation_misconfigured",
    });
  });
  test("closed roles and additions; neither acceptance nor R3/R4 is an API grant", () => {
    for (const role of ["owner", "admin", "agent", "unknown"])
      expect(parse({ ...entry(), role }).ok).toBe(false);
    for (const capability of [
      "interpretation.accept",
      "schedules.lease.release",
      "policy.admin",
      "Access.update",
      "economic-event.resolve-identity",
      "external-money-action",
    ])
      expect(parse({ ...entry(), capabilities: [capability] }).ok).toBe(false);
    for (const capabilities of [null, "operations.read", ["operations.read", "operations.read"]])
      expect(parse({ ...entry(), capabilities }).ok).toBe(false);
    for (const role of ["maintainer", "reviewer", "operator-delegate"] as const) {
      const value = entry({ role, scopes: { sources: "*", accounts: "*", scheduleSources: "*" } });
      expect(parse(value).ok).toBe(true);
      expect(effectiveDelegationCapabilities(value)).toEqual(DELEGATION_ROLE_CAPABILITIES[role]);
    }
    const value = entry({ capabilities: ["operations.collection.request", "operations.read"] });
    expect(effectiveDelegationCapabilities(value)).toEqual(
      DELEGATION_CAPABILITIES.filter(
        (capability) =>
          DELEGATION_ROLE_CAPABILITIES.maintainer.includes(capability) ||
          capability === "operations.collection.request",
      ),
    );
  });
  test("every scope axis is a subset; missing schedule scope grants none", () => {
    for (const axis of ["sources", "accounts", "scheduleSources"] as const) {
      for (const scope of ["*", ["denied-synthetic"]] as const) {
        const value = entry({
          scopes: { sources: [], accounts: [], scheduleSources: [], [axis]: scope },
        });
        expect(
          parseDelegations(
            configured(value),
            JSON.stringify([OWNER]),
            readGrants({
              sources: ["fixture-source"],
              accounts: ["fixture-account"],
              scheduleSources: ["fixture-source"],
            }),
          ).ok,
        ).toBe(false);
      }
      for (const scope of [
        ["duplicate", "duplicate"],
        [""],
        ["x".repeat(257)],
        Array.from({ length: 65 }, (_, i) => `scope-${i}`),
        null,
      ])
        expect(parse({ ...entry(), scopes: { ...entry().scopes, [axis]: scope } }).ok).toBe(false);
    }
    const grants = readGrants({ sources: "*", accounts: "*" });
    expect(parseDelegations(configured(), JSON.stringify([OWNER]), grants).ok).toBe(false);
    expect(
      parseDelegations(
        configured(entry({ scopes: { ...entry().scopes, scheduleSources: [] } })),
        JSON.stringify([OWNER]),
        grants,
      ).ok,
    ).toBe(true);
    const mismatched = new Map([
      [PRINCIPAL, { principal: "other", scopes: { sources: "*", accounts: "*" } as const }],
    ]);
    expect(parseDelegations(configured(), JSON.stringify([OWNER]), mismatched).ok).toBe(false);
  });
  test("command and projection capabilities require whole source and account axes", () => {
    for (const capability of DELEGATION_CAPABILITIES.filter(
      (value) => value.startsWith("commands.") || value === "operations.projection.request",
    )) {
      for (const scopes of [
        entry().scopes,
        { ...entry().scopes, sources: "*" as const, accounts: ["fixture-account"] },
      ])
        expect(parse(entry({ capabilities: [capability], scopes })).ok).toBe(false);
      expect(
        parse(
          entry({
            capabilities: [capability],
            scopes: { sources: "*", accounts: "*", scheduleSources: [] },
          }),
        ).ok,
      ).toBe(true);
    }
  });
  test("lifetimes and integer write budgets are bounded", () => {
    for (const writesPerDay of [0, 201, -1, 1.5, Infinity])
      expect(parse(entry({ budget: { writesPerDay } })).ok).toBe(false);
    for (const writesPerDay of [1, 200])
      expect(parse(entry({ budget: { writesPerDay } })).ok).toBe(true);
    for (const notAfter of [
      NOW,
      "2026-10-08T00:00:00Z",
      "2027-01-08T00:00:00Z",
      "2026-11-31T00:00:00Z",
      "not-time",
    ])
      expect(parse(entry({ notAfter })).ok).toBe(false);
    expect(
      parse(
        entry({ notAfter: new Date(Date.parse(NOW) + DELEGATION_LIMITS.lifetimeMs).toISOString() }),
      ).ok,
    ).toBe(true);
    expect(
      parse(
        entry({
          notAfter: new Date(Date.parse(NOW) + DELEGATION_LIMITS.lifetimeMs + 1).toISOString(),
        }),
      ).ok,
    ).toBe(false);
    expect(parse(entry({ issuedAt: "2026-10-09" })).ok).toBe(false);
  });
  test("nanosecond and offset bounds are exact, not rounded by Date.parse", async () => {
    const narrow = entry({
      issuedAt: "2026-10-09T00:00:00.000000001Z",
      notAfter: "2026-10-09T00:00:00.000000003Z",
    });
    expect(parse(narrow).ok).toBe(true);
    expect(await resolve({ configured: configured(narrow), now: NOW })).toEqual({
      ok: false,
      code: "delegation_not_yet_valid",
    });
    expect(
      (
        await resolve({
          configured: configured(narrow),
          now: "2026-10-09T09:00:00.000000001+09:00",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await resolve({ configured: configured(narrow), now: "2026-10-09T00:00:00.000000002Z" })).ok,
    ).toBe(true);
    expect(
      await resolve({ configured: configured(narrow), now: "2026-10-09T00:00:00.000000003Z" }),
    ).toEqual({ ok: false, code: "delegation_expired" });
    expect(parse(entry({ notAfter: "2027-01-07T00:00:00Z" })).ok).toBe(true);
    expect(parse(entry({ notAfter: "2027-01-07T00:00:00.000000001Z" })).ok).toBe(false);
  });

  test("time window is half open; invalid clock never activates", async () => {
    expect((await resolve()).ok).toBe(true);
    expect(await resolve({ now: "2026-10-08T23:59:59.999Z" })).toEqual({
      ok: false,
      code: "delegation_not_yet_valid",
    });
    expect(await resolve({ now: entry().notAfter })).toEqual({
      ok: false,
      code: "delegation_expired",
    });
    expect(await resolve({ now: "not-time" })).toEqual({
      ok: false,
      code: "delegation_misconfigured",
    });
  });
  test("at most eight entries; never partially accepts a ninth", () => {
    const owners = Array.from({ length: 9 }, (_, index) => `synthetic-${index}`);
    const values = owners.map(
      (owner) => [`mcp-client:${owner}`, entry({ delegatedBy: owner })] as const,
    );
    const grants = new Map(
      owners.map((owner) => [
        `mcp-client:${owner}`,
        {
          principal: `mcp-client:${owner}`,
          scopes: { sources: "*", accounts: "*", scheduleSources: "*" } as const,
        },
      ]),
    );
    expect(
      parseDelegations(
        JSON.stringify(Object.fromEntries(values.slice(0, 8))),
        JSON.stringify(owners),
        grants,
      ).ok,
    ).toBe(true);
    expect(
      parseDelegations(JSON.stringify(Object.fromEntries(values)), JSON.stringify(owners), grants)
        .ok,
    ).toBe(false);
  });
  test("canonical reference names exact declaration and changes on every declared field", async () => {
    const value = entry();
    const resolution = await resolve();
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("fixture invalid");
    expect(resolution.principal).toMatchObject({
      id: PRINCIPAL,
      delegator: OWNER,
      kind: "delegated",
      delegationRef: `dlg_${await canonicalDigest(value)}`,
    });
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(await resolve({ configured: configured(reordered) })).toEqual(resolution);
    for (const changed of [
      entry({
        role: "operator-delegate",
        scopes: { sources: "*", accounts: "*", scheduleSources: [] },
      }),
      entry({ capabilities: [] }),
      entry({ budget: { writesPerDay: 31 } }),
      entry({ notAfter: "2026-11-07T00:00:00Z" }),
      entry({ issuedAt: "2026-10-08T00:00:00Z" }),
      entry({ scopes: { ...value.scopes, scheduleSources: [] } }),
    ]) {
      const next = await resolve({ configured: configured(changed) });
      expect(next.ok).toBe(true);
      if (next.ok)
        expect(next.principal.delegationRef).not.toBe(resolution.principal.delegationRef);
    }
  });
  test("revocation is re-evaluated on the next resolution", async () => {
    expect((await resolve()).ok).toBe(true);
    expect((await resolve({ configured: "" })).ok).toBe(false);
    expect((await resolve({ operatorSubjects: "[]" })).ok).toBe(false);
    expect((await resolve({ readGrants: new Map() })).ok).toBe(false);
    expect(
      (
        await resolve({
          readGrants: readGrants({ sources: [], accounts: "*", scheduleSources: [] }),
        })
      ).ok,
    ).toBe(false);
    expect((await resolve({ now: entry().notAfter })).ok).toBe(false);
  });
  test("configured does not mean executable; closed dependency reasons differ", async () => {
    const resolution = await resolve();
    for (const capability of DELEGATION_CAPABILITIES)
      expect(delegationExecutionReadiness(resolution, capability).available).toBe(false);
    expect(delegationExecutionReadiness(resolution, "operations.import.request")).toEqual({
      available: false,
      reason: "delegation_execution_unavailable",
      blockedBy: ["delegation_audit_unavailable", "delegation_operation_path_unavailable"],
    });
    expect(delegationExecutionReadiness(resolution, "schedules.survey.decide").blockedBy).toContain(
      "delegation_confirmation_unavailable",
    );
    expect(
      delegationExecutionReadiness(resolution, "schedules.maintenance.update").blockedBy,
    ).toContain("delegation_processor_unavailable");
    expect(delegationExecutionReadiness(resolution, "commands.plan").reason).toBe(
      "delegation_capability_denied",
    );
    expect(delegationExecutionReadiness(resolution, "Access.update").reason).toBe(
      "unsupported_semantics",
    );
    expect(
      delegationExecutionReadiness({ ok: false, code: "delegation_expired" }, "operations.read")
        .reason,
    ).toBe("delegation_expired");
  });
  test("public report never returns identities, scope, expiry, budget or reference", async () => {
    for (const resolution of [
      await resolve(),
      await resolve({ configured: "{" }),
      await resolve({ caller: { kind: "mcp-client", principal: "other-synthetic" } }),
    ]) {
      const report = delegationCapabilities(resolution);
      const text = JSON.stringify(report);
      for (const forbidden of [
        OWNER,
        "fixture-source",
        "fixture-account",
        "delegationRef",
        "delegatedBy",
        "notAfter",
        "issuedAt",
        "writesPerDay",
        "dlg_",
      ])
        expect(text).not.toContain(forbidden);
      expect(report.available).toBe(false);
      if (!resolution.ok) expect(report.capabilities).toEqual([]);
    }
  });
});
