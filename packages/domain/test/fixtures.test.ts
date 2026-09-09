// Every fixture is synthetic, validates against the domain contracts, and is
// listed in the fixtures README so later PRs can find and reuse it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { coverageClaimViolations, validCoverageClaim } from "../src/coverage.ts";
import { validAllocation, validDecisionRevision, validTypedRelation } from "../src/decisions.ts";
import { validMetricDefinition } from "../src/metrics.ts";
import { validMeasureCandidate, validScopeRelationClaim } from "../src/scope.ts";
import { validTemporalValue } from "../src/time.ts";
import { validExactRatio, validQuantity } from "../src/values.ts";
import { loadFixture } from "./helpers.ts";

const root = new URL("../fixtures/", import.meta.url);
const files = ["v1", "v2", "v3"]
  .flatMap((slice) => readdirSync(new URL(slice, root)).map((name) => `${slice}/${name}`))
  .sort();

describe("fixture inventory", () => {
  test("the three slices contain exactly the reviewed scenarios and the README lists each file", () => {
    expect(files).toEqual([
      "v1/sc01-linked-deposit.json",
      "v1/sc06-connection-only.json",
      "v1/sc15-empty-snapshots.json",
      "v2/sc02-charge-purchase-settle.json",
      "v2/sc03-pending-posted-refund.json",
      "v2/sc04-installments.json",
      "v3/sc11-wallet-points.json",
      "v3/sc12-expiry-activities.json",
      "v3/sc13-redemption-request.json",
      "v3/sc14-conversion-offer.json",
    ]);
    const readme = readFileSync(new URL("README.md", root), "utf8");
    for (const file of files) expect(readme).toContain(file);
  });

  test("every fixture is marked synthetic and carries no URLs, e-mail addresses or long digit runs", () => {
    for (const file of files) {
      const text = readFileSync(new URL(file, root), "utf8");
      const fixture = JSON.parse(text) as { synthetic?: boolean; scenario?: string };
      expect(fixture.synthetic).toBe(true);
      expect(fixture.scenario).toMatch(/^SC\d{2}$/u);
      expect(text).not.toMatch(/https?:\/\//u);
      expect(text).not.toMatch(/@/u);
      expect(text).not.toMatch(/\d{9,}/u);
    }
  });
});

describe("fixture contents validate against the contracts", () => {
  const walk = (
    value: unknown,
    visit: (node: Record<string, unknown>, path: string) => void,
    path = "$",
  ) => {
    if (Array.isArray(value))
      value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
    else if (value !== null && typeof value === "object") {
      visit(value as Record<string, unknown>, path);
      for (const [key, item] of Object.entries(value)) walk(item, visit, `${path}.${key}`);
    }
  };

  test("quantities, ratios and temporal values", () => {
    let quantities = 0;
    let temporal = 0;
    for (const file of files)
      walk(loadFixture(file), (node, path) => {
        if ("unitRef" in node && "value" in node) {
          expect(validQuantity(node), `${file} ${path}`).toBe(true);
          quantities += 1;
        }
        if ("numerator" in node) expect(validExactRatio(node), `${file} ${path}`).toBe(true);
        if (
          typeof node.kind === "string" &&
          ["instant", "local-date", "period", "unknown"].includes(node.kind) &&
          ("basis" in node || "granularity" in node || "reasonCode" in node)
        ) {
          expect(validTemporalValue(node), `${file} ${path}`).toBe(true);
          temporal += 1;
        }
      });
    expect(quantities).toBeGreaterThanOrEqual(20);
    expect(temporal).toBeGreaterThan(2);
  });

  test("candidates, relations, decisions, allocations, coverage claims and metric definitions", () => {
    const counts = {
      candidates: 0,
      scopeRelations: 0,
      typedRelations: 0,
      decisions: 0,
      allocations: 0,
      claims: 0,
      definitions: 0,
    };
    for (const file of files)
      walk(loadFixture(file), (node, path) => {
        const label = `${file} ${path}`;
        if ("scopeRef" in node && "authorityRank" in node) {
          expect(validMeasureCandidate(node), label).toBe(true);
          counts.candidates += 1;
        }
        if ("relation" in node && "left" in node) {
          expect(validScopeRelationClaim(node), label).toBe(true);
          counts.scopeRelations += 1;
        }
        if ("relationId" in node) {
          expect(validTypedRelation(node), label).toBe(true);
          counts.typedRelations += 1;
        }
        if ("revisionId" in node) {
          expect(validDecisionRevision(node), label).toBe(true);
          counts.decisions += 1;
        }
        if ("allocationId" in node) {
          expect(validAllocation(node), label).toBe(true);
          counts.allocations += 1;
        }
        if ("claimId" in node) {
          expect(validCoverageClaim(node), label).toBe(true);
          expect(coverageClaimViolations(node as never), label).toEqual([]);
          counts.claims += 1;
        }
        if ("metricId" in node && "aggregationRule" in node) {
          expect(validMetricDefinition(node), label).toBe(true);
          counts.definitions += 1;
        }
      });
    expect(counts).toEqual({
      candidates: 8,
      scopeRelations: 5,
      typedRelations: 5,
      decisions: 2,
      allocations: 3,
      claims: 5,
      definitions: 4,
    });
  });
});
