import { describe, expect, test } from "bun:test";
import {
  AGENT_CAPABILITIES,
  grantAllows,
  grantAllowsRow,
  grantedSources,
  grantFor,
  parseGrants,
  perimeterRefFor,
  validGrant,
} from "../src/grants.ts";
import { capabilitiesFor } from "../src/capabilities.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../poc/observation-pipeline/shared/api-schema.ts";
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
      "evidence.read",
      "interpretation.propose",
    ]);
    for (const capability of [
      "interpretation.accept",
      "calculation.run",
      "collection.request",
      "report.export",
      "policy.admin",
      "retention.admin",
      "external-money-action",
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
    expect(report.proposalMethods).toEqual([]);
    // Nothing in the report names a source the principal cannot see.
    expect(JSON.stringify(report)).not.toContain("fixture-b");
  });
});
