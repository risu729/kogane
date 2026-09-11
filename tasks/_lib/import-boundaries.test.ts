// The CI half of the import rules in docs/package-layout.md (design review
// D07, unified plan U04; acceptance tests G4-07 and G4-08). It runs in the
// repository-wide `ci:root` task, because it belongs to no single workspace.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  BOUNDARY_RULES,
  assetViolations,
  boundaryViolations,
  boundaryViolationsIn,
  resolveAssetDirectory,
  resolveSpecifier,
} from "./import-boundaries.ts";
import { REPO_ROOT, trackedFiles } from "./repo-root.ts";
import { parseJsonc } from "../../scripts/jsonc.ts";

const SOURCES = trackedFiles("*.ts", "*.tsx").filter((path) => !path.includes("/node_modules/"));

describe("import boundaries", () => {
  test("no deployed or shared module imports a PoC, an experiment or the client", () => {
    const violations = boundaryViolationsIn(REPO_ROOT, SOURCES).filter(
      (violation) => violation.rule === "deployed-code-imports-experiment",
    );
    expect(violations).toEqual([]);
  });

  test("the web client reads the HTTP contract, not SQL, a PoC or an experiment", () => {
    const violations = boundaryViolationsIn(REPO_ROOT, SOURCES).filter(
      (violation) => violation.rule === "ui-imports-database",
    );
    expect(violations).toEqual([]);
  });

  test("only apps/web/test may reach a service internal", () => {
    const violations = boundaryViolationsIn(REPO_ROOT, SOURCES).filter(
      (violation) => violation.rule === "ui-imports-service-internals",
    );
    expect(violations).toEqual([]);
    // The exception is a single named file, not a hole: if a second test wants
    // a Worker internal, that is a design decision, not a formality.
    const exempt = SOURCES.filter(
      (path) =>
        path.startsWith("apps/web/test/") &&
        boundaryViolations(path, readFileSync(`${REPO_ROOT}/${path}`, "utf8")).length === 0 &&
        /from "\.\.\/\.\.\/\.\.\/services\//u.test(readFileSync(`${REPO_ROOT}/${path}`, "utf8")),
    );
    expect(exempt).toEqual(["apps/web/test/evidence-preview.browser.test.ts"]);
  });

  test("the guard sees a real crossing and lets the allowed direction through", () => {
    // Positive: the import a service used to have before the parsers moved.
    const forbidden =
      'import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry.ts";';
    expect(boundaryViolations("services/processor/src/worker.ts", forbidden)).toEqual([
      {
        path: "services/processor/src/worker.ts",
        specifier: "../../../poc/observation-pipeline/src/parsers/registry.ts",
        rule: "deployed-code-imports-experiment",
      },
    ]);
    // Same for the experiment and the client the same move created.
    for (const specifier of [
      "../../../experiments/observation-pipeline-local/src/store.ts",
      "../../../apps/web/src/api.ts",
    ])
      expect(
        boundaryViolations(
          "services/processor/src/worker.ts",
          `import { x } from "${specifier}";`,
        ).map((violation) => violation.rule),
      ).toEqual(["deployed-code-imports-experiment"]);
    // Negative: the import it has now.
    const allowed = 'import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";';
    expect(boundaryViolations("services/processor/src/worker.ts", allowed)).toEqual([]);
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
    expect(boundaryViolations("services/processor/src/publication-gate.ts", allowed)).toEqual([]);
  });

  test("a promoted collector is in scope: the import it had in poc/ is now a crossing", () => {
    // U04 moved the collectors to services/collector-* and their diagnostics
    // helper to packages/; the relative import they used to share would now
    // point back into poc/, and the first rule has to see it.
    const path = "services/collector-vpass/src/worker.ts";
    const before =
      'import { createDiagnostics } from "../../../poc/collector-diagnostics/src/index";';
    expect(boundaryViolations(path, before).map((violation) => violation.rule)).toEqual([
      "deployed-code-imports-experiment",
    ]);
    const after =
      'import { createDiagnostics } from "../../../packages/collector-diagnostics/src/index";';
    expect(boundaryViolations(path, after)).toEqual([]);
    expect(
      SOURCES.filter((source) => source.startsWith("services/collector-")).length,
    ).toBeGreaterThan(0);
  });

  test("the UI rules catch a query builder, a storage adapter and an experiment", () => {
    for (const [specifier, rule] of [
      ["../../../packages/read-model/src/concepts.ts", "ui-imports-database"],
      ["../../../packages/storage-d1/src/core.ts", "ui-imports-database"],
      ["../../../experiments/observation-pipeline-local/src/store.ts", "ui-imports-database"],
      ["../../../services/app/src/http.ts", "ui-imports-service-internals"],
    ] as const)
      expect(
        boundaryViolations("apps/web/src/api.ts", `import { x } from "${specifier}";`).map(
          (violation) => violation.rule,
        ),
        specifier,
      ).toEqual([rule]);
    const allowed =
      'import type { ApiMetadata } from "../../../packages/observation-shared/src/api-contract.ts";';
    expect(boundaryViolations("apps/web/src/api.ts", allowed)).toEqual([]);
    // The named exception applies to the service rule only.
    const internal = 'import { secureResponse } from "../../../services/a/src/http.ts";';
    expect(boundaryViolations("apps/web/test/x.test.ts", internal)).toEqual([]);
    const storage = 'import { q } from "../../../packages/storage-d1/src/core.ts";';
    expect(boundaryViolations("apps/web/test/x.test.ts", storage).map((v) => v.rule)).toEqual([
      "ui-imports-database",
    ]);
  });

  test("dynamic imports and export-from cross the boundary just as static imports do", () => {
    const path = "packages/read-model/src/reader.ts";
    for (const text of [
      'export * from "../../../experiments/observation-pipeline-local/src/store.ts";',
      'const m = await import("../../../experiments/observation-pipeline-local/src/store.ts");',
    ])
      expect(boundaryViolations(path, text).map((violation) => violation.rule)).toEqual([
        "deployed-code-imports-experiment",
      ]);
  });

  test("data paths and package specifiers are not dependencies", () => {
    // A fixture the moved parser tests still read, and a npm package: neither
    // is an import of experiment code, and neither may fail the guard.
    const path = "packages/parsers/src/parsers/moneyforward-parser.ts";
    expect(
      boundaryViolations(
        path,
        'import { parse } from "parse5";\nconst url = new URL("../../../../tests/fixtures/observation-pipeline/x.json", import.meta.url);',
      ),
    ).toEqual([]);
    // Tests are outside the scope of the first rule on purpose: the importer's
    // audit tests compare against the PoC collectors that produced the bytes.
    expect(
      boundaryViolations(
        "services/collector-r2-importer/test/worker.test.ts",
        'import { x } from "../../../poc/mobile-suica-worker/src/storage.ts";',
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
      "deployed-code-imports-experiment",
      "package-imports-service",
      "ui-imports-database",
      "ui-imports-service-internals",
    ]);
    // The scopes must actually match files, or the guard would pass vacuously.
    for (const rule of BOUNDARY_RULES)
      expect(
        SOURCES.some((path) => rule.scope.test(path)),
        rule.name,
      ).toBe(true);
  });
});

describe("G4-08 build-closure boundaries", () => {
  /** Every `assets.directory` a tracked Wrangler configuration declares. */
  // The same four workspaces the resource ledger walks: a Worker config that
  // appears under apps/ or experiments/ is checked from the day it exists.
  const assets = trackedFiles(
    "apps/*/wrangler*.jsonc",
    "experiments/*/wrangler*.jsonc",
    "poc/*/wrangler*.jsonc",
    "services/*/wrangler*.jsonc",
  ).map((path) => {
    const config = parseJsonc(readFileSync(`${REPO_ROOT}/${path}`, "utf8"), path) as {
      assets?: { directory?: string };
    };
    return { path, directory: config.assets?.directory };
  });

  test("no deployed Worker serves bytes built inside a PoC or an experiment", () => {
    expect(assets.some((entry) => entry.directory !== undefined)).toBe(true);
    expect(assetViolations(assets)).toEqual([]);
  });

  test("the asset guard resolves the directory and sees the crossing it exists for", () => {
    expect(
      resolveAssetDirectory("services/app/wrangler.jsonc", "../../apps/web/dist-production"),
    ).toBe("apps/web/dist-production");
    expect(
      assetViolations([
        {
          path: "services/app/wrangler.jsonc",
          directory: "../../poc/observation-pipeline/web/dist",
        },
      ]),
    ).toEqual([
      {
        config: "services/app/wrangler.jsonc",
        directory: "poc/observation-pipeline/web/dist",
      },
    ]);
    expect(
      assetViolations([{ path: "services/app/wrangler.jsonc", directory: "../../apps/web/dist" }]),
    ).toEqual([]);
  });
});
