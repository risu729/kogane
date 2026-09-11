// The CI half of the import rules in docs/package-layout.md (design review
// D07). It runs in the standalone offline step, where scripts/ci-packages.ts
// lists it, because it belongs to no single package.
import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "./ci-package.ts";
import {
  BOUNDARY_RULES,
  boundaryViolations,
  boundaryViolationsIn,
  resolveSpecifier,
} from "./import-boundaries.ts";

function tracked(...patterns: string[]): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", ...patterns], { cwd: REPO_ROOT });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\0").filter(Boolean).sort();
}

const SOURCES = tracked("*.ts", "*.tsx").filter((path) => !path.includes("/node_modules/"));

describe("import boundaries", () => {
  test("no deployed or shared module imports the PoC", () => {
    const violations = boundaryViolationsIn(REPO_ROOT, SOURCES).filter(
      (violation) => violation.rule === "deployed-code-imports-poc",
    );
    expect(violations).toEqual([]);
  });

  test("the PoC web UI reads the HTTP contract, not a service internal or read-model SQL", () => {
    const violations = boundaryViolationsIn(REPO_ROOT, SOURCES).filter(
      (violation) => violation.rule === "ui-imports-database",
    );
    expect(violations).toEqual([]);
  });

  test("no shared package imports a service back (U05)", () => {
    const violations = boundaryViolationsIn(REPO_ROOT, SOURCES).filter(
      (violation) => violation.rule === "package-imports-service",
    );
    expect(violations).toEqual([]);
  });

  test("the extraction direction is one-way: package to service is a crossing", () => {
    const forbidden = 'import { loadRun } from "../../../services/raw-evidence/src/http.ts";';
    expect(
      boundaryViolations("packages/storage-d1/src/core/fetch-runs.ts", forbidden).map(
        (violation) => violation.rule,
      ),
    ).toEqual(["package-imports-service"]);
    // The other direction — a service importing the shared package — is what
    // U05 produced and must stay allowed.
    const allowed =
      'import { publishBatch } from "../../../packages/storage-d1/src/atomic/publication.ts";';
    expect(
      boundaryViolations("services/observation-pipeline/src/publication-gate.ts", allowed),
    ).toEqual([]);
  });

  test("the guard sees a real crossing and lets the allowed direction through", () => {
    // Positive: the import a service used to have before the parsers moved.
    const forbidden =
      'import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry.ts";';
    expect(boundaryViolations("services/observation-pipeline/src/worker.ts", forbidden)).toEqual([
      {
        path: "services/observation-pipeline/src/worker.ts",
        specifier: "../../../poc/observation-pipeline/src/parsers/registry.ts",
        rule: "deployed-code-imports-poc",
      },
    ]);
    // Negative: the import it has now.
    const allowed = 'import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";';
    expect(boundaryViolations("services/observation-pipeline/src/worker.ts", allowed)).toEqual([]);
  });

  test("the UI rule catches a query builder and allows the shared contract", () => {
    const forbidden =
      'import { snapshotCtes } from "../../../../packages/read-model/src/concepts.ts";';
    expect(
      boundaryViolations("poc/observation-pipeline/web/src/api.ts", forbidden).map(
        (violation) => violation.rule,
      ),
    ).toEqual(["ui-imports-database"]);
    const allowed =
      'import type { ApiMetadata } from "../../../../packages/observation-shared/src/api-contract.ts";';
    expect(boundaryViolations("poc/observation-pipeline/web/src/api.ts", allowed)).toEqual([]);
  });

  test("dynamic imports and export-from cross the boundary just as static imports do", () => {
    const path = "packages/read-model/src/reader.ts";
    for (const text of [
      'export * from "../../../poc/observation-pipeline/src/types.ts";',
      'const m = await import("../../../poc/observation-pipeline/src/types.ts");',
    ])
      expect(boundaryViolations(path, text).map((violation) => violation.rule)).toEqual([
        "deployed-code-imports-poc",
      ]);
  });

  test("data paths and package specifiers are not dependencies", () => {
    // A fixture the moved parser tests still read, and a npm package: neither
    // is an import of PoC code, and neither may fail the guard.
    const path = "packages/parsers/src/parsers/moneyforward-parser.ts";
    expect(
      boundaryViolations(
        path,
        'import { parse } from "parse5";\nconst url = new URL("../../../../poc/observation-pipeline/fixtures/x.json", import.meta.url);',
      ),
    ).toEqual([]);
    // Tests are outside the scope of the first rule on purpose: the synthetic
    // collector fixtures and the PoC collectors they compare against stayed.
    expect(
      boundaryViolations(
        "packages/parsers/test/parsers.test.ts",
        'import { x } from "../../../poc/observation-pipeline/src/store.ts";',
      ),
    ).toEqual([]);
  });

  test("specifier resolution normalizes the relative path it is given", () => {
    expect(resolveSpecifier("services/a/src/worker.ts", "../../../poc/x/y.ts")).toBe("poc/x/y.ts");
    expect(resolveSpecifier("services/a/src/worker.ts", "./local.ts")).toBe(
      "services/a/src/local.ts",
    );
    expect(resolveSpecifier("services/a/src/worker.ts", "parse5")).toBeUndefined();
  });

  test("every rule is exercised by the repository-wide checks above", () => {
    expect(BOUNDARY_RULES.map((rule) => rule.name).sort()).toEqual([
      "deployed-code-imports-poc",
      "package-imports-service",
      "ui-imports-database",
    ]);
    // The scopes must actually match files, or the guard would pass vacuously.
    for (const rule of BOUNDARY_RULES)
      expect(
        SOURCES.some((path) => rule.scope.test(path)),
        rule.name,
      ).toBe(true);
  });
});
