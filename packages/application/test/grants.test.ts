import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENT_CAPABILITIES,
  grantAllows,
  grantAllowsRow,
  grantAllowsScheduleSource,
  grantedSources,
  fullGrant,
  GRANT_LIMITS,
  perimeterRefFor,
  validGrant,
  type Grant,
} from "../src/grants.ts";
import { capabilitiesFor } from "../src/capabilities.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { grant } from "./fixture.ts";

describe("the whole-store grant every proved caller gets (ADR 0084)", () => {
  test("it reads and proposes over every source, account and schedule, at the published bounds", () => {
    const full = fullGrant("mcp-client:owner-subject-synthetic");
    expect(validGrant(full)).toBe(true);
    expect(full).toEqual({
      principal: "mcp-client:owner-subject-synthetic",
      scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
      capabilities: AGENT_CAPABILITIES,
      budget: {
        maxRows: GRANT_LIMITS.maxRows,
        maxProposalTargets: GRANT_LIMITS.maxProposalTargets,
        maxExplainDepth: GRANT_LIMITS.maxExplainDepth,
      },
    });
    expect(grantAllowsRow(full, "fixture-a", "account-a")).toBe(true);
    expect(grantAllowsScheduleSource(full, "fixture-a")).toBe(true);
    expect(grantedSources(full)).toBeNull();
  });

  test("it never names a write beyond an inert proposal: operations are not read grants", () => {
    const report = capabilitiesFor(fullGrant("anyone"), CENTRAL_STORE_CAPABILITIES, 65_536);
    expect(report.writes).toEqual({ proposals: true, adoption: false, externalActions: false });
    expect(grantAllows(fullGrant("anyone"), "schedules.maintenance.update" as never)).toBe(false);
  });

  test("no committed configuration declares a grant table any more", () => {
    for (const file of [
      "../../../services/app/wrangler.jsonc",
      "../../../services/app/cloudflare.config.ts",
    ])
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toContain(
        "AGENT_API_GRANTS",
      );
  });
});

describe("the grant vocabulary", () => {
  test("no configuration can name a capability outside the minimal set", () => {
    expect([...AGENT_CAPABILITIES]).toEqual([
      "summary.read",
      "records.read",
      "audit.read",
      "evidence.read",
      "interpretation.propose",
      "schedules.read",
    ]);
    for (const capability of [
      "interpretation.accept",
      "calculation.run",
      "collection.request",
      "report.export",
      "policy.admin",
      "retention.admin",
      "external-money-action",
      // Maintenance windows are read only: a revision is an operation of the
      // operator's MCP principal (ADR 0084), never granted here, and there is no job
      // edit, toggle, lease release or run.
      "schedules.maintenance.update",
      "schedules.update",
      "schedules.enable",
      "schedules.lease.release",
      "schedules.collection.run",
      "schedules.*",
    ])
      expect(validGrant({ ...grant(), capabilities: [capability] })).toBe(false);
  });

  test("budgets outside the published bounds are refused", () => {
    expect(
      validGrant({ ...grant(), budget: { maxRows: 0, maxProposalTargets: 1, maxExplainDepth: 1 } }),
    ).toBe(false);
    expect(
      validGrant({
        ...grant(),
        budget: { maxRows: 100_000, maxProposalTargets: 1, maxExplainDepth: 1 },
      }),
    ).toBe(false);
  });
});

describe("scope arithmetic", () => {
  test("a listed scope admits only its own values", () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: ["account-a"] } });
    expect(grantAllowsRow(narrow, "fixture-a", "account-a")).toBe(true);
    expect(grantAllowsRow(narrow, "fixture-a", "account-b")).toBe(false);
    expect(grantAllowsRow(narrow, "fixture-b", "account-a")).toBe(false);
    expect(grantedSources(narrow)).toEqual(["fixture-a"]);
    expect(grantedSources(grant())).toBeNull();
  });

  test("the perimeter of a narrower grant differs, so its contexts differ", () => {
    expect(perimeterRefFor(grant())).not.toBe(
      perimeterRefFor(grant({ scopes: { sources: ["fixture-a"], accounts: "*" } })),
    );
  });
});

describe("maintenance-settings grants (ADR 0046, as amended by ADR 0063)", () => {
  const maintenance = grant({
    scopes: { sources: [], accounts: [], scheduleSources: ["fixture-a"] },
    capabilities: ["schedules.read"],
  });

  test("the schedule scope is separate, optional and bounded like any scope", () => {
    expect(validGrant(maintenance)).toBe(true);
    expect(validGrant(grant())).toBe(true);
    expect(
      validGrant(grant({ scopes: { sources: "*", accounts: "*", scheduleSources: "*" } })),
    ).toBe(true);
    for (const scheduleSources of ["fixture-a", [1], ["dup", "dup"], Array(65).fill("x")])
      expect(
        validGrant({ ...grant(), scopes: { sources: "*", accounts: "*", scheduleSources } }),
      ).toBe(false);
    expect(
      validGrant({ ...grant(), scopes: { sources: "*", accounts: "*", schedules: ["x"] } }),
    ).toBe(false);
  });

  test("an absent schedule scope reaches no source, and financial scope never stands in", () => {
    expect(grantAllowsScheduleSource(maintenance, "fixture-a")).toBe(true);
    expect(grantAllowsScheduleSource(maintenance, "fixture-b")).toBe(false);
    const financial = grant({ scopes: { sources: "*", accounts: "*" } });
    expect(grantAllowsScheduleSource(financial, "fixture-a")).toBe(false);
  });

  test("no financial capability implies the schedule read, or the reverse", () => {
    expect(grantAllows(grant(), "schedules.read")).toBe(false);
    for (const capability of ["summary.read", "records.read", "evidence.read"] as const)
      expect(grantAllows(maintenance, capability)).toBe(false);
  });

  test("a grant naming the maintenance write is not valid, so no read grant can write", () => {
    expect(validGrant(maintenance)).toBe(true);
    expect(
      validGrant({
        ...maintenance,
        capabilities: ["schedules.read", "schedules.maintenance.update"],
      }),
    ).toBe(false);
  });

  test("the report states the schedule scope and no write beyond proposals", () => {
    const report = capabilitiesFor(maintenance, CENTRAL_STORE_CAPABILITIES, 65_536);
    expect(report.intents).toEqual([]);
    expect(report.scopes.scheduleSources).toEqual(["fixture-a"]);
    expect(report.writes).toEqual({ proposals: false, adoption: false, externalActions: false });
  });
});

describe("capability report", () => {
  test("records.read alone does not carry evidence.read", () => {
    const records = grant({ capabilities: ["summary.read", "records.read"] });
    expect(grantAllows(records, "records.read")).toBe(true);
    expect(grantAllows(records, "evidence.read")).toBe(false);
    expect(grantAllows(records, "interpretation.propose")).toBe(false);
  });

  test("the report describes only the principal's own grant and never adoption", () => {
    const narrow = grant({
      capabilities: ["summary.read"],
      scopes: { sources: ["fixture-a"], accounts: "*" },
    });
    const report = capabilitiesFor(narrow, CENTRAL_STORE_CAPABILITIES, 65_536);
    expect(report.intents.map((entry) => entry.intent)).toEqual(["holdings", "coverage"]);
    expect(report.scopes.sources).toEqual(["fixture-a"]);
    expect(report.writes).toEqual({ proposals: false, adoption: false, externalActions: false });
    expect(report.scopes.scheduleSources).toEqual([]);
    expect(report.proposalMethods).toEqual([]);
    // Nothing in the report names a source the principal cannot see.
    expect(JSON.stringify(report)).not.toContain("fixture-b");
  });
});
