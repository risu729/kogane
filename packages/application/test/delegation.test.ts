import { describe, expect, test } from "bun:test";
import { DELEGATION_CAPABILITIES, MCP_AUTHORITY } from "../src/delegation/contract.ts";
import { resolveDelegation } from "../src/delegation/resolve.ts";
import {
  delegationCapabilities,
  delegationExecutionReadiness,
} from "../src/delegation/readiness.ts";

const OWNER = "owner-synthetic";
const PRINCIPAL = `mcp-client:${OWNER}`;
const NOW = "2026-10-09T00:00:00.000Z";
const resolve = (change: Partial<Parameters<typeof resolveDelegation>[0]> = {}) =>
  resolveDelegation({ caller: { kind: "mcp-client", principal: PRINCIPAL }, now: NOW, ...change });

describe("ADR 0084: any MCP client Access verified acts with the UI's authority, nothing configured", () => {
  test("a verified MCP client holds every operation capability over the whole store", async () => {
    const resolution = await resolve();
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.principal).toMatchObject({
      kind: "delegated",
      id: PRINCIPAL,
      delegator: OWNER,
      capabilities: [...DELEGATION_CAPABILITIES],
      scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
      budget: { writesPerDay: MCP_AUTHORITY.writesPerDay },
      notAfter: new Date(Date.parse(NOW) + MCP_AUTHORITY.envelopeMs).toISOString(),
    });
    expect(resolution.principal.delegationRef).toMatch(/^dlg_[0-9a-f]{64}$/u);
    // Another verified subject is just as able, as itself.
    const other = await resolve({ caller: { kind: "mcp-client", principal: "mcp-client:other" } });
    expect(other.ok && other.principal.delegator).toBe("other");
  });
  test("a browser caller, even naming an MCP principal, never yields one", async () => {
    for (const principal of [OWNER, PRINCIPAL])
      expect(await resolve({ caller: { kind: "browser", principal } })).toEqual({
        ok: false,
        code: "delegation_not_mcp_client",
      });
  });
  test("a principal outside the actor shape is refused, whatever its kind claims", async () => {
    for (const principal of [
      OWNER,
      "mcp-client:",
      `mcp-client:${PRINCIPAL}`,
      "mcp-client: bad",
      `mcp-client:${"a".repeat(129)}`,
    ])
      expect(await resolve({ caller: { kind: "mcp-client", principal } })).toEqual({
        ok: false,
        code: "delegation_not_mcp_client",
      });
  });
  test("an unreadable clock is a misconfiguration", async () => {
    expect(await resolve({ now: "not a time" })).toEqual({
      ok: false,
      code: "delegation_misconfigured",
    });
  });
  test("the reference has no clock, and names its principal", async () => {
    const ref = async (change: Partial<Parameters<typeof resolveDelegation>[0]> = {}) => {
      const resolution = await resolve(change);
      if (!resolution.ok) throw new Error(resolution.code);
      return resolution.principal.delegationRef;
    };
    const base = await ref();
    expect(await ref({ now: "2026-12-31T23:59:59.999Z" })).toBe(base);
    expect(await ref({ caller: { kind: "mcp-client", principal: "mcp-client:other" } })).not.toBe(
      base,
    );
  });
});

describe("readiness is not authority", () => {
  test("held does not mean executable; closed dependency reasons differ", async () => {
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
    expect(delegationExecutionReadiness(resolution, "Access.update").reason).toBe(
      "unsupported_semantics",
    );
    expect(
      delegationExecutionReadiness(
        { ok: false, code: "delegation_not_configured" },
        "operations.read",
      ).reason,
    ).toBe("delegation_not_configured");
  });
  test("an installed adapter makes exactly its own capability ready, and grants nothing", async () => {
    const resolution = await resolve();
    const installed = ["operations.read"] as const;
    expect(delegationExecutionReadiness(resolution, "operations.read", installed)).toEqual({
      available: true,
      reason: "ready",
      blockedBy: [],
    });
    for (const capability of [
      "operations.import.request",
      "schedules.survey.decide",
      "commands.decide.relation",
      "operations.collection.request",
    ])
      expect(delegationExecutionReadiness(resolution, capability, installed)).toEqual({
        available: false,
        reason: "delegation_execution_unavailable",
        blockedBy: ["delegation_adapter_unavailable"],
      });
    const report = delegationCapabilities(resolution, installed);
    expect(report).toMatchObject({ available: true, reason: "ready", configuration: "valid" });
    expect(
      report.capabilities.filter((entry) => entry.available).map((entry) => entry.capability),
    ).toEqual(["operations.read"]);
    expect(
      delegationCapabilities({ ok: false, code: "delegation_misconfigured" }, installed),
    ).toEqual(
      expect.objectContaining({
        available: false,
        reason: "delegation_misconfigured",
        capabilities: [],
      }),
    );
  });
  test("the public report never returns identities, scope, expiry, budget or reference", async () => {
    for (const resolution of [
      await resolve(),
      await resolve({ now: "not a time" }),
      await resolve({ caller: { kind: "mcp-client", principal: "other-synthetic" } }),
    ]) {
      const text = JSON.stringify(delegationCapabilities(resolution));
      for (const forbidden of [OWNER, "notAfter", "writesPerDay", "dlg_"])
        expect(text).not.toContain(forbidden);
    }
  });
});
