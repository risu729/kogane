// Import boundaries between the deployed code, the shared packages, the web
// client and the experiments (design review D07, unified plan U04, chapter 07
// §3, docs/package-layout.md).
//
// Rules, all about the direction of a dependency rather than about the name of
// a directory:
//
//   * nothing under `services/*/src` or `packages/*/src` may import a module
//     inside `poc/`, `experiments/` or `apps/`. An experiment is where code is
//     free to change; a deployed Worker that imports one cannot be reasoned
//     about separately from it. `apps/` is on the list for the same reason in
//     the other direction: the client is a consumer of the contracts, never a
//     source of them.
//   * nothing under `apps/web` may import a service's `src`, the SQL of
//     `packages/read-model`, `packages/storage-d1`, a PoC or an experiment.
//     The UI reads the HTTP contract; giving it a query builder would put a
//     second, unreviewed reader in front of the same database.
//     `apps/web/test` is the single, named exception to the *service* half:
//     one Playwright test boots `services/evidence-browser`'s own response
//     helper in-process to prove the client still renders under the production
//     CSP. Vite never sees `test/`, so that edge is not in the shipped bundle
//     — and `assetBoundaryViolations` below checks what actually is.
//
// Only import specifiers are inspected. A fixture path (`new URL("../fixtures/…")`)
// is data, not a dependency, so it is deliberately out of scope.
//
// Specifiers are not the whole build closure, which is why two more guards sit
// next to this one: `assetBoundaryViolations` reads what a Worker configuration
// serves, and `depcruise.ts` walks the resolved module graph (G4-07, G4-08).
import { readFileSync } from "node:fs";

/** A rule: files matching `scope` may not import anything matching `forbidden`. */
export interface BoundaryRule {
  name: string;
  scope: RegExp;
  /** Paths inside `scope` the rule deliberately does not apply to. */
  except?: RegExp;
  forbidden: RegExp;
  reason: string;
}

export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    name: "deployed-code-imports-experiment",
    scope: /^(?:services|packages)\/[^/]+\/src\//u,
    forbidden: /(?:^|\/)(?:poc|experiments|apps)\//u,
    reason:
      "deployed and shared code must not import a PoC, an experiment or the client; promote the module to packages/",
  },
  {
    // U05 moved the CORE SQL and the registration use cases out of the three
    // services into packages/. A package that imported a service back would
    // undo that in one line and reintroduce the cycle the extraction removed:
    // the services depend on the packages, never the other way round. The
    // services keep re-export shims at the old module paths, which is the
    // allowed direction.
    name: "package-imports-service",
    scope: /^packages\/[^/]+\/src\//u,
    forbidden: /(?:^|\/)services\/[^/]+\/(?:src|test|scripts)(?:\/|$)/u,
    reason: "shared packages are imported by the services, never the reverse",
  },
  {
    name: "ui-imports-database",
    scope: /^apps\/web\//u,
    forbidden:
      /(?:^|\/)(?:packages\/read-model\/src|packages\/storage-d1|poc|experiments)(?:\/|$)/u,
    reason:
      "the UI reads the HTTP contract, never the read model's SQL, a storage adapter, a PoC or an experiment",
  },
  {
    name: "ui-imports-service-internals",
    scope: /^apps\/web\//u,
    except: /^apps\/web\/test\//u,
    forbidden: /(?:^|\/)services\/[^/]+\/src(?:\/|$)/u,
    reason:
      "the shipped client reads the HTTP contract, never a service internal; only apps/web/test may boot one, and Vite never sees test/",
  },
];

/** Import, export-from and dynamic-import specifiers, quoted either way. */
const SPECIFIER =
  /(?:from|import)\s*\(?\s*(?<quote>["'])(?<spec>[^"']+)\k<quote>|require\(\s*(?<rquote>["'])(?<rspec>[^"']+)\k<rquote>\s*\)/gu;

/** The repository-relative path a relative specifier names, without extension
 * resolution: only its directory shape decides which side of a boundary it is
 * on. A bare specifier (a npm package) resolves to nothing here. */
export function resolveSpecifier(path: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const parts = path.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export interface BoundaryViolation {
  path: string;
  specifier: string;
  rule: string;
}

/** Every boundary a single file's imports cross, as `path`, specifier and rule. */
export function boundaryViolations(path: string, text: string): BoundaryViolation[] {
  const rules = BOUNDARY_RULES.filter(
    (rule) => rule.scope.test(path) && !(rule.except?.test(path) ?? false),
  );
  if (rules.length === 0) return [];
  const violations: BoundaryViolation[] = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match.groups?.["spec"] ?? match.groups?.["rspec"];
    if (specifier === undefined) continue;
    const resolved = resolveSpecifier(path, specifier);
    if (resolved === undefined) continue;
    for (const rule of rules)
      if (rule.forbidden.test(resolved)) violations.push({ path, specifier, rule: rule.name });
  }
  return violations;
}

/** The same check over files on disk, given repository-relative paths. */
export function boundaryViolationsIn(root: string, paths: readonly string[]): BoundaryViolation[] {
  return paths.flatMap((path) => boundaryViolations(path, readFileSync(`${root}/${path}`, "utf8")));
}

/**
 * Directories a deployed Worker must not serve. A Wrangler `assets.directory`
 * is a build-closure dependency that no import guard can see: a production
 * Worker that serves bytes built inside `poc/` or `experiments/` depends on an
 * experiment just as hard as one that imports it (acceptance test G4-08).
 * A build directory under `apps/` is the supported shape: that is what the
 * client workspace is for.
 */
const FORBIDDEN_ASSET_ROOT = /^(?:poc|experiments)\//u;

export interface AssetViolation {
  config: string;
  directory: string;
}

/** The repository-relative directory a Wrangler `assets.directory` names. */
export function resolveAssetDirectory(configPath: string, directory: string): string {
  const parts = configPath.split("/").slice(0, -1);
  for (const segment of directory.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** Worker configurations whose served assets are built inside an experiment. */
export function assetViolations(
  configs: readonly { path: string; directory: string | undefined }[],
): AssetViolation[] {
  return configs
    .filter(
      (config) =>
        config.directory !== undefined &&
        FORBIDDEN_ASSET_ROOT.test(resolveAssetDirectory(config.path, config.directory)),
    )
    .map((config) => ({
      config: config.path,
      directory: resolveAssetDirectory(config.path, config.directory as string),
    }));
}
