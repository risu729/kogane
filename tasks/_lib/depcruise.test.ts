// The assertions that keep `mise run root:depcruise` from passing vacuously
// (unified plan U04; acceptance test G4-07). The cruise itself runs in its own
// task because it takes seconds; what is unit-tested here is the part that
// decides whether a cruise result means anything at all.
import { describe, expect, test } from "bun:test";
import { MINIMUM_MODULES, PROBES, cruiseProblems, type CruiseResult } from "./depcruise.ts";

/** A result shaped like a healthy cruise, with every probe edge present. */
function healthy(overrides: Partial<CruiseResult["summary"]> = {}): CruiseResult {
  return {
    modules: [
      {
        source: "services/processor/src/worker.ts",
        dependencies: [
          { resolved: "packages/parsers/src/parsers/registry.ts", dependencyTypes: ["local"] },
        ],
      },
      {
        source: "apps/web/src/api.ts",
        dependencies: [
          {
            resolved: "packages/observation-shared/src/api-contract.ts",
            dependencyTypes: ["local", "type-only", "import"],
          },
        ],
      },
    ],
    summary: {
      error: 0,
      warn: 0,
      info: 0,
      totalCruised: MINIMUM_MODULES + 1,
      violations: [],
      environment: {
        transpilersFound: [
          { name: "typescript", available: true, currentVersion: "typescript@5.9.3" },
        ],
      },
      ...overrides,
    },
  };
}

describe("G4-07 resolved-import guard", () => {
  test("a healthy cruise has nothing to report", () => {
    expect(cruiseProblems(healthy())).toEqual([]);
  });

  test("a violation is reported with its rule and both ends", () => {
    const problems = cruiseProblems(
      healthy({
        error: 1,
        violations: [
          {
            from: "services/app/src/worker.ts",
            to: "experiments/observation-pipeline-local/src/store.ts",
            rule: { name: "no-product-to-experiment", severity: "error" },
          },
        ],
      }),
    );
    expect(problems).toEqual([
      "no-product-to-experiment: services/app/src/worker.ts -> experiments/observation-pipeline-local/src/store.ts (error)",
    ]);
  });

  test("a cruise that saw almost nothing fails instead of passing", () => {
    // dependency-cruiser 18 exits 0 with ~44 modules when no TypeScript < 7 is
    // resolvable. That is the silent failure this floor exists to catch.
    expect(cruiseProblems(healthy({ totalCruised: 44 }))).toEqual([
      `only 44 modules were cruised, below the ${MINIMUM_MODULES} floor: the rules would pass vacuously`,
    ]);
  });

  test("a missing TypeScript transpiler fails", () => {
    const problems = cruiseProblems(
      healthy({
        environment: {
          transpilersFound: [
            { name: "typescript", available: false, currentVersion: "-" },
            { name: "javascript", available: true, currentVersion: "acorn@8.18.0" },
          ],
        },
      }),
    );
    expect(problems).toEqual([
      "no TypeScript transpiler is resolvable: dependency-cruiser would silently cruise almost nothing; keep typescript 5.x in the root manifest",
    ]);
  });

  test("each probe edge is required, including the type-only one", () => {
    const withoutTypeOnly = healthy();
    const client = withoutTypeOnly.modules[1];
    if (client?.dependencies?.[0] === undefined) throw new Error("fixture");
    client.dependencies[0].dependencyTypes = ["local", "import"];
    expect(cruiseProblems(withoutTypeOnly)).toEqual([
      `the graph no longer contains ${PROBES[2]?.name}; the cruise resolved nothing`,
    ]);
    expect(cruiseProblems({ modules: [], summary: healthy().summary }).length).toBe(PROBES.length);
  });

  test("an error count without detail is still a failure", () => {
    expect(cruiseProblems(healthy({ error: 3 }))).toEqual([
      "3 error-severity violations were reported without detail",
    ]);
  });
});
