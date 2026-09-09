// Import boundaries between the deployed code, the shared packages and the
// PoC (design review D07, docs/package-layout.md).
//
// Two rules, both about the direction of a dependency rather than about the
// name of a directory:
//
//   * nothing under `services/*/src` or `packages/*/src` may import a module
//     inside `poc/`. The PoC is where experiments are free to change; a
//     deployed Worker that imports one cannot be reasoned about separately
//     from it. Parsers, identity resolution and the shared contracts were
//     promoted into `packages/` precisely so that this rule can hold.
//   * nothing under `poc/observation-pipeline/web` may import a service's
//     `src` or the SQL of `packages/read-model`. The UI reads the HTTP
//     contract; giving it a query builder would put a second, unreviewed
//     reader in front of the same database.
//
// Only import specifiers are inspected. A fixture path (`new URL("../fixtures/…")`)
// is data, not a dependency, so it is deliberately out of scope: the synthetic
// parser fixtures stayed with the PoC when the parsers moved.
import { readFileSync } from "node:fs";

/** A rule: files matching `scope` may not import anything matching `forbidden`. */
export interface BoundaryRule {
  name: string;
  scope: RegExp;
  forbidden: RegExp;
  reason: string;
}

export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    name: "deployed-code-imports-poc",
    scope: /^(?:services|packages)\/[^/]+\/src\//u,
    forbidden: /(?:^|\/)poc\//u,
    reason: "deployed and shared code must not import the PoC; promote the module to packages/",
  },
  {
    name: "ui-imports-database",
    scope: /^poc\/observation-pipeline\/web\//u,
    forbidden: /(?:^|\/)(?:packages\/read-model\/src|services\/[^/]+\/src)(?:\/|$)/u,
    reason: "the UI reads the HTTP contract, never a service internal or the read model's SQL",
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
  const rules = BOUNDARY_RULES.filter((rule) => rule.scope.test(path));
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
