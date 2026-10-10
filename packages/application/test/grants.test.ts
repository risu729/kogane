import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../../../scripts/jsonc.ts";
import {
  AGENT_CAPABILITIES,
  grantAllows,
  grantAllowsRow,
  grantAllowsScheduleSource,
  grantedSources,
  grantFor,
  parseGrants,
  perimeterRefFor,
  validGrant,
  type Grant,
} from "../src/grants.ts";
import { capabilitiesFor } from "../src/capabilities.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { grant } from "./fixture.ts";

describe("grants are deny-by-default", () => {
  test("an absent, empty or unparsable table grants nothing", () => {
    for (const configured of [undefined, null, "", "   ", "not json", "[]", '"text"', "123"])
      expect(parseGrants(configured).size).toBe(0);
  });

  test("one invalid entry rejects the whole table rather than half-applying it", () => {
    const valid = {
      scopes: { sources: ["fixture-a"], accounts: "*" },
      capabilities: ["summary.read"],
      budget: { maxRows: 10, maxProposalTargets: 2, maxExplainDepth: 2 },
    };
    expect(parseGrants(JSON.stringify({ good: valid })).size).toBe(1);
    expect(
      parseGrants(
        JSON.stringify({ good: valid, bad: { ...valid, capabilities: ["ledger.write"] } }),
      ).size,
    ).toBe(0);
  });

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
      // Maintenance windows are read only: a revision is delegated in
      // MCP_DELEGATIONS (ADR 0063), never granted here, and there is no job
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

  test("an entry body never names its own principal: a principal or any unknown key rejects the table", () => {
    const valid: Omit<Grant, "principal"> = {
      scopes: { sources: ["fixture-a"], accounts: "*" },
      capabilities: ["summary.read"],
      budget: { maxRows: 10, maxProposalTargets: 2, maxExplainDepth: 2 },
    };
    // The synthetic shape docs/agent-api.md documents still parses, under its key.
    const table = parseGrants(JSON.stringify({ "reporting-agent": valid }));
    expect(table.size).toBe(1);
    expect(grantFor(table, "reporting-agent")).toEqual({ principal: "reporting-agent", ...valid });
    // A body naming a different principal used to override the key it is
    // stored under; the whole table is now refused instead.
    for (const body of [
      { ...valid, principal: "fixture-operator" },
      { ...valid, principal: "reporting-agent" },
      { principal: "fixture-operator", ...valid },
      { ...valid, note: "an unknown key" },
    ]) {
      const refused = parseGrants(JSON.stringify({ "reporting-agent": body, other: valid }));
      expect(refused.size).toBe(0);
      expect(grantFor(refused, "reporting-agent")).toBeNull();
      expect(grantFor(refused, "fixture-operator")).toBeNull();
    }
    // A missing key is refused as before.
    const { budget: _budget, ...withoutBudget } = valid;
    expect(parseGrants(JSON.stringify({ "reporting-agent": withoutBudget })).size).toBe(0);
  });

  test("an authenticated principal with no entry has no grant", () => {
    const table = parseGrants(
      JSON.stringify({
        known: {
          scopes: { sources: "*", accounts: "*" },
          capabilities: ["summary.read"],
          budget: { maxRows: 10, maxProposalTargets: 1, maxExplainDepth: 1 },
        },
      }),
    );
    expect(grantFor(table, "known")?.principal).toBe("known");
    expect(grantFor(table, "stranger")).toBeNull();
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

  test("a table naming the maintenance write is refused whole, so no agent grant can write", () => {
    const entry = (capabilities: string[]) => ({
      scopes: { sources: [], accounts: [], scheduleSources: ["fixture-a"] },
      capabilities,
      budget: { maxRows: 1, maxProposalTargets: 1, maxExplainDepth: 1 },
    });
    expect(parseGrants(JSON.stringify({ reader: entry(["schedules.read"]) })).size).toBe(1);
    expect(
      parseGrants(
        JSON.stringify({
          reader: entry(["schedules.read"]),
          "mcp-client:writer": entry(["schedules.read", "schedules.maintenance.update"]),
        }),
      ).size,
    ).toBe(0);
  });

  test("the report states the schedule scope and no write beyond proposals", () => {
    const report = capabilitiesFor(maintenance, CENTRAL_STORE_CAPABILITIES, 65_536);
    expect(report.intents).toEqual([]);
    expect(report.scopes.scheduleSources).toEqual(["fixture-a"]);
    expect(report.writes).toEqual({ proposals: false, adoption: false, externalActions: false });
  });
});

describe("the committed agent-API grant table under this vocabulary (#640)", () => {
  /** Every capability a grant may name that writes anything but an inert proposal: none. */
  const writes = (table: Map<string, Grant>) =>
    [...table.values()].flatMap((entry) =>
      entry.capabilities.filter(
        (capability) => capability !== "interpretation.propose" && !capability.endsWith(".read"),
      ),
    );
  const assertParsedWhole = (configured: string) => {
    const entries = Object.keys(JSON.parse(configured) as Record<string, unknown>).length;
    const table = parseGrants(configured);
    // Refusing an entry refuses the whole table, so a vocabulary change that
    // removed a capability the shipped table names would empty it: it must not.
    expect(entries).toBeGreaterThan(0);
    expect(table.size).toBe(entries);
    expect(writes(table)).toEqual([]);
    for (const entry of table.values()) {
      expect(grantAllows(entry, "schedules.maintenance.update" as never)).toBe(false);
      expect(capabilitiesFor(entry, CENTRAL_STORE_CAPABILITIES, 65_536).writes).toEqual({
        proposals: grantAllows(entry, "interpretation.propose"),
        adoption: false,
        externalActions: false,
      });
    }
  };

  test("a synthetic copy of the shipped entry's shape parses and grants no schedule write", () => {
    assertParsedWhole(
      JSON.stringify({
        "mcp-client:owner-subject-synthetic": {
          scopes: { sources: "*", accounts: "*" },
          capabilities: ["summary.read", "records.read"],
          budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
        },
      }),
    );
  });

  test("the committed App configuration's table parses whole and grants no schedule write", () => {
    // Read at run time from the committed files; nothing of it is copied here.
    const wrangler = parseJsonc(
      readFileSync(new URL("../../../services/app/wrangler.jsonc", import.meta.url), "utf8"),
      "services/app/wrangler.jsonc",
    ) as { vars: Record<string, string> };
    const configured = wrangler.vars["AGENT_API_GRANTS"]!;
    const cloudflare = readFileSync(
      new URL("../../../services/app/cloudflare.config.ts", import.meta.url),
      "utf8",
    );
    const native = /AGENT_API_GRANTS:\s*bindings\.text\(\s*'([^']*)'/u.exec(cloudflare)?.[1];
    // The two committed configurations ship the same table.
    expect(native === configured).toBe(true);
    if (configured.trim() === "") return;
    assertParsedWhole(configured);
    // The vocabulary itself can name no schedule write.
    expect(AGENT_CAPABILITIES.filter((capability) => capability.startsWith("schedules."))).toEqual([
      "schedules.read",
    ]);
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
