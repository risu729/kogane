import { describe, expect, test } from "bun:test";
import {
  DELEGATION_CAPABILITIES,
  MCP_AUTHORITY,
  WHOLE_STORE_CAPABILITIES,
} from "../src/delegation/contract.ts";
import { resolveDelegation } from "../src/delegation/resolve.ts";
import {
  delegationCapabilities,
  delegationExecutionReadiness,
} from "../src/delegation/readiness.ts";
import type { Grant } from "../src/grants.ts";

const OWNER = "owner-synthetic";
const PRINCIPAL = `mcp-client:${OWNER}`;
const NOW = "2026-10-09T00:00:00.000Z";
function grant(scopes: Partial<Grant["scopes"]> = {}, principal = PRINCIPAL): Grant {
  return {
    principal,
    scopes: { sources: "*", accounts: "*", scheduleSources: "*", ...scopes },
    capabilities: ["summary.read"],
    budget: { maxRows: 10, maxProposalTargets: 1, maxExplainDepth: 1 },
  };
}
const resolve = (change: Partial<Parameters<typeof resolveDelegation>[0]> = {}) =>
  resolveDelegation({
    grants: { OPERATOR_SUBJECTS: JSON.stringify([OWNER]), AGENT_GRANTS: "" },
    readGrant: grant(),
    caller: { kind: "mcp-client", principal: PRINCIPAL },
    now: NOW,
    ...change,
  });

describe("ADR 0084: the MCP principal of the UI operator, derived, never declared", () => {
  test("the operator's MCP principal holds every operation capability within its read grant", async () => {
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
  });
  test("a browser caller, even naming an MCP principal, never yields one", async () => {
    for (const principal of [OWNER, PRINCIPAL])
      expect(await resolve({ caller: { kind: "browser", principal } })).toEqual({
        ok: false,
        code: "delegation_not_mcp_client",
      });
    expect(await resolve({ caller: { kind: "mcp-client", principal: OWNER } })).toEqual({
      ok: false,
      code: "delegation_not_mcp_client",
    });
  });
  test("only a subject the UI grades as the operator; agents and strangers get nothing", async () => {
    for (const principal of [
      "mcp-client:other-synthetic",
      "mcp-client:",
      `mcp-client:${PRINCIPAL}`,
      "mcp-client: bad",
      `mcp-client:${"a".repeat(129)}`,
    ])
      expect(
        await resolve({
          caller: { kind: "mcp-client", principal },
          readGrant: grant({}, principal),
        }),
      ).toEqual({ ok: false, code: "delegation_not_configured" });
    expect(
      await resolve({ grants: { OPERATOR_SUBJECTS: "", AGENT_GRANTS: JSON.stringify([OWNER]) } }),
    ).toEqual({ ok: false, code: "delegation_not_configured" });
    expect(await resolve({ grants: { OPERATOR_SUBJECTS: "[]" } })).toEqual({
      ok: false,
      code: "delegation_not_configured",
    });
  });
  test("unreadable or overlapping operator lists are a misconfiguration, as in the UI", async () => {
    for (const grants of [
      { OPERATOR_SUBJECTS: "{" },
      { OPERATOR_SUBJECTS: JSON.stringify([OWNER]), AGENT_GRANTS: "[1]" },
      { OPERATOR_SUBJECTS: JSON.stringify([OWNER]), AGENT_GRANTS: JSON.stringify([OWNER]) },
    ])
      expect(await resolve({ grants })).toEqual({ ok: false, code: "delegation_misconfigured" });
    expect(await resolve({ now: "not a time" })).toEqual({
      ok: false,
      code: "delegation_misconfigured",
    });
  });
  test("without its own read grant the principal has no operation authority", async () => {
    expect(await resolve({ readGrant: null })).toEqual({
      ok: false,
      code: "delegation_not_configured",
    });
    expect(await resolve({ readGrant: grant({}, "mcp-client:other-synthetic") })).toEqual({
      ok: false,
      code: "delegation_not_configured",
    });
  });
  test("the scope is the read grant's; a missing schedule axis is none", async () => {
    const { scheduleSources: _, ...scopes } = grant({ sources: ["fixture-source"] }).scopes;
    const narrow = await resolve({ readGrant: { ...grant(), scopes } });
    expect(narrow.ok).toBe(true);
    if (!narrow.ok) return;
    expect(narrow.principal.scopes).toEqual({
      sources: ["fixture-source"],
      accounts: "*",
      scheduleSources: [],
    });
  });
  test("command and projection capabilities need whole source and account reads", async () => {
    for (const scopes of [{ sources: ["fixture-source"] }, { accounts: ["fixture-account"] }]) {
      const resolution = await resolve({ readGrant: grant(scopes) });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) continue;
      expect(resolution.principal.capabilities).toEqual(
        DELEGATION_CAPABILITIES.filter((c) => !WHOLE_STORE_CAPABILITIES.includes(c)),
      );
      for (const capability of WHOLE_STORE_CAPABILITIES)
        expect(delegationExecutionReadiness(resolution, capability, [capability]).reason).toBe(
          "delegation_capability_denied",
        );
    }
  });
  test("the reference has no clock, and changes with the authority it names", async () => {
    const ref = async (change: Partial<Parameters<typeof resolveDelegation>[0]> = {}) => {
      const resolution = await resolve(change);
      if (!resolution.ok) throw new Error(resolution.code);
      return resolution.principal.delegationRef;
    };
    const base = await ref();
    expect(await ref({ now: "2026-12-31T23:59:59.999Z" })).toBe(base);
    expect(await ref({ readGrant: grant({ scheduleSources: ["fixture-source"] }) })).not.toBe(base);
    expect(await ref({ readGrant: grant({ sources: ["fixture-source"] }) })).not.toBe(base);
  });
  test("removing the operator or the grant revokes on the next resolution", async () => {
    expect((await resolve()).ok).toBe(true);
    expect((await resolve({ grants: { OPERATOR_SUBJECTS: "" } })).ok).toBe(false);
    expect((await resolve({ readGrant: null })).ok).toBe(false);
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
      await resolve({ readGrant: grant({ sources: ["fixture-source"] }) }),
      await resolve({ grants: { OPERATOR_SUBJECTS: "{" } }),
      await resolve({ caller: { kind: "mcp-client", principal: "other-synthetic" } }),
    ]) {
      const text = JSON.stringify(delegationCapabilities(resolution));
      for (const forbidden of [OWNER, "fixture-source", "notAfter", "writesPerDay", "dlg_"])
        expect(text).not.toContain(forbidden);
    }
  });
});
