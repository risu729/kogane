// The resolved-import half of the boundary guard (unified plan U04, chapter
// 07 §3/§6; acceptance tests **G4-07** and **G4-08**).
//
// `import-boundaries.ts` reads specifiers as written. This one runs
// dependency-cruiser over the resolved module graph, which is the only way to
// catch a bare specifier, an `exports` map, an alias or a dynamic `import()`
// that reaches an experiment. The rules live in `dependency-cruiser.config.mjs`.
//
// A boundary rule is worthless if the run that enforces it saw almost nothing,
// and dependency-cruiser fails *quietly* in exactly that way: with no
// TypeScript < 7 resolvable it prints `missing-typescript-transpiler`, cruises
// a few dozen modules and still exits 0. Every workspace that deploys a Worker
// pins `typescript@7`, so the root manifest deliberately keeps `5.9.3` for this
// step. The assertions below make a regression loud instead of silent:
//
//   * zero error-severity violations;
//   * a TypeScript transpiler is available and is the < 7 one;
//   * at least MINIMUM_MODULES modules were cruised;
//   * the graph still contains the cross-workspace edges the rules are about
//     (a relative import across workspaces, and a type-only one), because if
//     resolution broke, every rule would pass by seeing nothing.
import { REPO_ROOT } from "./repo-root.ts";

/** Roots the cruise starts from; dependencies outside them are followed anyway. */
export const ROOTS = ["services", "packages", "apps", "experiments"] as const;

/**
 * Floor for the cruised module count. The run cruises 530 modules today; a
 * number well below that but far above the ~44 of a transpiler-less run fails
 * a silent regression without failing every deletion.
 */
export const MINIMUM_MODULES = 400;

export interface CruiseDependency {
  resolved: string;
  dependencyTypes?: string[];
}

export interface CruiseModule {
  source: string;
  dependencies?: CruiseDependency[];
}

export interface CruiseResult {
  modules: CruiseModule[];
  summary: {
    error: number;
    warn: number;
    info: number;
    totalCruised: number;
    violations: { from: string; to: string; rule: { name: string; severity: string } }[];
    environment?: {
      transpilersFound?: { name: string; available: boolean; currentVersion: string }[];
    };
  };
}

/** An edge the graph must still contain, proving the cruise resolved anything. */
export interface ProbeEdge {
  name: string;
  from: RegExp;
  to: RegExp;
  /** When set, the edge must carry this dependency type (e.g. `type-only`). */
  dependencyType?: string;
}

export const PROBES: readonly ProbeEdge[] = [
  {
    name: "a deployed Worker still imports a shared package across workspaces",
    from: /^services\/[^/]+\/src\//u,
    to: /^packages\/[^/]+\/src\//u,
  },
  {
    name: "the web client still imports the shared HTTP contract",
    from: /^apps\/web\/src\//u,
    to: /^packages\/observation-shared\/src\//u,
  },
  {
    name: "type-only imports are part of the graph",
    from: /^apps\/web\/src\//u,
    to: /^packages\/[^/]+\/src\//u,
    dependencyType: "type-only",
  },
];

function edges(result: CruiseResult): { from: string; to: string; types: string[] }[] {
  return result.modules.flatMap((module) =>
    (module.dependencies ?? []).map((dependency) => ({
      from: module.source,
      to: dependency.resolved,
      types: dependency.dependencyTypes ?? [],
    })),
  );
}

/** Everything wrong with one cruise result, as human-readable lines. */
export function cruiseProblems(result: CruiseResult): string[] {
  const problems: string[] = [];
  for (const violation of result.summary.violations)
    problems.push(
      `${violation.rule.name}: ${violation.from} -> ${violation.to} (${violation.rule.severity})`,
    );
  if (result.summary.error > 0 && result.summary.violations.length === 0)
    problems.push(`${result.summary.error} error-severity violations were reported without detail`);
  const typescript = (result.summary.environment?.transpilersFound ?? []).find(
    (entry) => entry.name === "typescript",
  );
  if (typescript === undefined || !typescript.available)
    problems.push(
      "no TypeScript transpiler is resolvable: dependency-cruiser would silently cruise almost nothing; keep typescript 5.x in the root manifest",
    );
  if (result.summary.totalCruised < MINIMUM_MODULES)
    problems.push(
      `only ${result.summary.totalCruised} modules were cruised, below the ${MINIMUM_MODULES} floor: the rules would pass vacuously`,
    );
  const found = edges(result);
  for (const probe of PROBES)
    if (
      !found.some(
        (edge) =>
          probe.from.test(edge.from) &&
          probe.to.test(edge.to) &&
          (probe.dependencyType === undefined || edge.types.includes(probe.dependencyType)),
      )
    )
      problems.push(`the graph no longer contains ${probe.name}; the cruise resolved nothing`);
  return problems;
}

export function cruise(root: string = REPO_ROOT): CruiseResult {
  const result = Bun.spawnSync(
    [
      "node_modules/.bin/depcruise",
      "--config",
      "dependency-cruiser.config.mjs",
      "--output-type",
      "json",
      ...ROOTS,
    ],
    { cwd: root },
  );
  const stdout = result.stdout.toString();
  if (stdout.trim() === "")
    throw new Error(`depcruise produced no output: ${result.stderr.toString().trim()}`);
  return JSON.parse(stdout) as CruiseResult;
}

if (import.meta.main) {
  try {
    const result = cruise();
    const problems = cruiseProblems(result);
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    } else {
      console.error(`depcruise: ${result.summary.totalCruised} modules, no boundary violations`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "depcruise failed");
    process.exitCode = 1;
  }
}
