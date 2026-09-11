// Generator for the dependency resolution ledger
// (`infra/dependency-resolution.md`), unified plan U01/U03 / chapter 07 §5.
//
// The repository is one Bun workspace with a single root `bun.lock` and an
// isolated linker (U03), so a workspace's resolution is the closure the root
// lockfile gives it, not a lockfile of its own. The text lockfile scopes a
// conflicting pin under the requesting package (`"<parent>/<name>"`), which is
// how two TypeScript and five Wrangler versions coexist; resolving a name
// therefore means walking those prefixes before falling back to the bare
// entry.
//
// It is a snapshot, not a guard: it is regenerated on demand, not asserted in
// CI, because the lockfile changes for legitimate reasons. The migration note
// it carries is the record chapter 07 §5 asks for — what the merge onto one
// lockfile did to resolved versions.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_MARKDOWN_PATH = "infra/dependency-resolution.md";
const WORKSPACES = ["packages", "poc", "services"] as const;

/**
 * The one-off record chapter 07 §5 asks for: what merging 28 per-package
 * lockfiles into one workspace lockfile did to resolved versions. It is static
 * because it describes a migration, not the current tree; the generated tables
 * below it are the current tree.
 */
const MIGRATION_NOTE = `## Post-workspace resolution (U03)

Before: 28 independent \`bun.lock\` files, one per package, each resolved on its
own day. After: one root \`bun.lock\` for a Bun workspace of 29 members, with
\`bunfig.toml\` setting \`linker = "isolated"\`.

**No direct dependency pin changed, and no workspace lost a version it pinned.**
Bun records a conflicting exact pin per workspace (\`@kogane/evidence-browser/typescript\`
→ 7.0.2 while the bare \`typescript\` is 5.9.3; five different Wrangler versions
coexist the same way), and the isolated linker materialises each workspace's own
\`node_modules\` from those entries. The one exception is a caret range, noted
below.

Every other difference is a **transitive** package whose parent declared a
range: the per-package lockfiles had each pinned a different point in that range
because they were generated on different days; a single lockfile resolves the
range once and shares the result. 155 (workspace, package) pairs differ, over 38
package names:

| package                                      | before (across the old lockfiles) | after                                                             | workspaces affected |
| -------------------------------------------- | --------------------------------- | ----------------------------------------------------------------- | ------------------- |
| \`@cloudflare/workers-types\`                  | 5.20260825.1                      | 5.20260911.1                                                      | 1                   |
| \`@jridgewell/sourcemap-codec\`                | 1.5.5                             | 1.6.0                                                             | 6                   |
| \`@oxc-project/types\`                         | 0.147.0, 0.148.0                  | 0.149.0                                                           | 4                   |
| \`@rolldown/binding-*\` (15 platform packages) | 1.2.6, 1.2.7                      | 1.2.8                                                             | 4                   |
| \`@types/node\`                                | 24.3.0, 26.3.0, 26.4.0, 26.4.1, 26.5.0 | unchanged where pinned; 26.4.1 where only \`bun-types@*\` asked     | 24                  |
| \`bare-events\`                                | 2.9.1                             | 2.9.2                                                             | 1                   |
| \`bare-path\`                                  | 3.1.1                             | 3.1.2                                                             | 4                   |
| \`bare-stream\`                                | 2.13.3                            | 2.13.4                                                            | 1                   |
| \`bare-url\`                                   | 2.5.2                             | 2.5.4                                                             | 4                   |
| \`entities\`                                   | 8.0.0                             | 8.1.0                                                             | 4                   |
| \`ip-address\`                                 | 10.5.0                            | 10.7.0                                                            | 2                   |
| \`nanoid\`                                     | 3.3.18                            | 3.3.19                                                            | 4                   |
| \`obug\`                                       | 2.1.4                             | 2.2.1                                                             | 3                   |
| \`postcss\`                                    | 8.5.26                            | 8.5.28                                                            | 3                   |
| \`rolldown\`                                   | 1.2.6, 1.2.7                      | 1.2.8                                                             | 4                   |
| \`socks\`                                      | 2.8.9                             | 2.8.10                                                            | 4                   |
| \`streamx\`                                    | 2.28.0                            | 2.28.1                                                            | 1                   |
| \`tar-stream\`                                 | 3.2.0                             | 3.2.1                                                             | 1                   |
| \`tinyexec\`                                   | 1.3.0                             | 1.3.1                                                             | 2                   |
| \`tldts\`, \`tldts-core\`                        | 7.4.11                            | 7.4.12                                                            | 1                   |
| \`undici-types\`                               | 7.10.0, 8.9.0                     | follows the \`@types/node\` each workspace resolves (7.10.0, 8.3.0) | 15                  |
| \`use-sync-external-store\`                    | 1.6.0                             | 1.7.0                                                             | 1                   |
| \`ws\`                                         | 8.21.0                            | 8.21.0 and 8.21.3 side by side                                    | 3                   |

Notes on the rows that are not purely mechanical:

- **\`@cloudflare/workers-types\` in \`poc/vpass-json\`** is the only _direct_
  dependency whose resolution moved: it is declared as \`^5.20260825.1\`, the one
  caret range in the repository, and re-resolving it picked 5.20260911.1. Every
  other direct dependency in every workspace is an exact pin and is unchanged.
- **\`@types/node\`** is pinned exactly by 13 workspaces and those pins survive.
  Where it arrived only through \`@types/bun\` → \`bun-types\` (which asks for
  \`*\`), the shared lockfile resolves that \`*\` once, to 26.4.1, instead of to
  whatever was current on the day each package lockfile was written. A
  workspace that pins 24.3.0 keeps 24.3.0 in its own \`node_modules\` and sees
  26.4.1 only nested under \`bun-types\`.
- **\`iconv-lite\`, \`parse5\`, \`entities\` in \`poc/vpoint-worker\`**: the old
  lockfile had duplicated copies under \`whatwg-encoding\`, \`encoding-sniffer\`
  and \`htmlparser2\`; the shared graph deduplicates them onto the versions those
  parents already accept. The package's own pin (\`iconv-lite\` 0.7.0) is
  unchanged.
- **Platform packages** (\`@rolldown/binding-*\`, \`@esbuild/*\`,
  \`@cloudflare/workerd-*\`, \`@typescript/typescript-*\`) appear in the lockfile
  for every platform but only one is installed per host.

### Root-level tooling

The root manifest declares \`typescript\` 5.9.3, \`vitest\` 4.1.11 and \`wrangler\`
4.128.0 so that \`node_modules/.bin\` exists at the repository root: the shared
\`risu729/wrangler-deploy-action\` resolves Wrangler by walking up from its
working directory, and \`mise.toml\` puts that directory on \`PATH\`. Tasks still
call \`./node_modules/.bin/<binary>\` from their own workspace, so a workspace
that pins a different version keeps using it. Adding these three did not change
any workspace's resolution (verified by re-running the comparison above).

### How the comparison was made

For every workspace, the transitive closure reachable from its declared
dependencies was computed from the old per-package \`bun.lock\` and from the new
root \`bun.lock\`, using the text lockfile's scoping rules (\`<parent>/<name>\`
entries override the bare \`<name>\` entry), and the two closures were compared
package by package.

### What was deliberately not done

Conflicting pins were **kept**, not reconciled: \`typescript\` 5.9.3 and 7.0.2,
\`wrangler\` 4.125.0/4.126.0/4.127.0/4.127.1/4.128.0, \`@cloudflare/vitest-plugin\`
1.1.2 and 1.1.3, \`@cloudflare/puppeteer\` 1.1.0 and 1.4.0, \`playwright\` 1.62.0
and 1.62.1, \`iconv-lite\` 0.7.0 and 0.7.3, \`@types/node\` 24.3.0/26.3.0/26.4.0.
Hoisting shared tooling to the root and aligning these versions are separate
changes with their own test runs.`;

export interface PackageRecord {
  directory: string;
  name: string;
  lockfile: "bun.lock" | "package-lock.json" | "none";
  /** Declared ranges, by dependency name. */
  declared: Record<string, { range: string; kind: "dependencies" | "devDependencies" }>;
  /** Resolved versions from this package's own bun.lock, by dependency name. */
  resolved: Record<string, string>;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Resolved versions from a Bun text lockfile.
 *
 * `bun.lock` is JSONC whose `packages` map holds `"name": ["name@version", …]`
 * entries; nested keys (`"a/b"`) are a dependency of a dependency resolved to
 * its own copy, and the identifier before the last `@` is the package name.
 */
export function resolvedVersions(lockText: string, label: string): Record<string, string> {
  const packages = object(object(parseJsonc(lockText, label))["packages"]);
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(packages)) {
    const identifier = Array.isArray(value) ? value[0] : undefined;
    if (typeof identifier !== "string") continue;
    const at = identifier.lastIndexOf("@");
    if (at <= 0) continue;
    const name = identifier.slice(0, at);
    const version = identifier.slice(at + 1);
    // A nested key resolves the same name to a private copy; record the
    // top-level resolution, which is what a consumer actually imports.
    if (key === name || resolved[name] === undefined) resolved[name] = version;
  }
  return resolved;
}

/** Resolved versions from an npm lockfile (v3): `packages["node_modules/x"].version`. */
export function npmResolvedVersions(lockText: string, label: string): Record<string, string> {
  const packages = object(object(parseJsonc(lockText, label))["packages"]);
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(packages)) {
    const marker = key.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const name = key.slice(marker + "node_modules/".length);
    const version = object(value)["version"];
    if (typeof version === "string" && resolved[name] === undefined) resolved[name] = version;
  }
  return resolved;
}

/**
 * The closure one workspace resolves from the root text lockfile.
 *
 * `packages` keys are either a bare package name or `"<parent>/<name>"`, where
 * the parent chain is the requesting package's own name. Resolution walks that
 * chain outwards, so a workspace that pins a different version of a shared
 * dependency reads its own entry rather than the shared one.
 */
export function workspaceResolvedVersions(
  lockText: string,
  workspaceDirectory: string,
  label: string,
): Record<string, string> {
  const lock = object(parseJsonc(lockText, label));
  const packages = object(lock["packages"]);
  const manifest = object(object(lock["workspaces"])[workspaceDirectory]);
  const rootKey = typeof manifest["name"] === "string" ? manifest["name"] : workspaceDirectory;
  const entry = (key: string): unknown[] | undefined => {
    const value = packages[key];
    return Array.isArray(value) ? value : undefined;
  };
  const resolveKey = (parent: string, name: string): string | undefined => {
    let prefix = parent;
    while (prefix.length > 0) {
      if (entry(`${prefix}/${name}`) !== undefined) return `${prefix}/${name}`;
      const cut = prefix.lastIndexOf("/");
      if (cut < 0) break;
      prefix = prefix.slice(0, cut);
    }
    return entry(name) === undefined ? undefined : name;
  };
  const bareName = (key: string): string => {
    const parts = key.split("/");
    return parts.at(-2)?.startsWith("@") === true
      ? `${parts.at(-2)}/${parts.at(-1)}`
      : (parts.at(-1) ?? key);
  };
  const resolved: Record<string, string> = {};
  const seen = new Set<string>();
  const queue: [string, string][] = [];
  // The workspace's own node_modules holds its direct dependencies; a nested
  // copy of the same name belongs to whoever asked for it. Record the direct
  // resolutions first and let the traversal fill in only the rest.
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const name of Object.keys(object(manifest[kind]))) {
      const key = resolveKey(rootKey, name);
      const identifier = key === undefined ? undefined : entry(key)?.[0];
      if (typeof identifier === "string")
        resolved[name] = identifier.slice(identifier.lastIndexOf("@") + 1);
      queue.push([rootKey, name]);
    }
  }
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    const key = resolveKey(next[0], next[1]);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    const record = entry(key);
    const identifier = record?.[0];
    if (typeof identifier !== "string") continue;
    const at = identifier.lastIndexOf("@");
    const name = bareName(key);
    if (resolved[name] === undefined) resolved[name] = identifier.slice(at + 1);
    const meta = object(record?.[2]);
    const optionalPeers = new Set(
      Array.isArray(meta["optionalPeers"]) ? (meta["optionalPeers"] as string[]) : [],
    );
    for (const field of ["dependencies", "optionalDependencies"] as const)
      for (const child of Object.keys(object(meta[field]))) queue.push([key, child]);
    for (const child of Object.keys(object(meta["peerDependencies"])))
      if (!optionalPeers.has(child)) queue.push([key, child]);
  }
  return resolved;
}

export function readPackages(root: string): PackageRecord[] {
  const records: PackageRecord[] = [];
  const candidates: string[] = [];
  for (const workspace of WORKSPACES) {
    const base = join(root, workspace);
    for (const entry of readdirSync(base).sort()) {
      if (!statSync(join(base, entry)).isDirectory()) continue;
      // `container/` holds the npm-managed image build of a collector; it is a
      // second manifest in the same directory and U03 does not absorb it.
      candidates.push(`${workspace}/${entry}`, `${workspace}/${entry}/container`);
    }
  }
  for (const relativeDirectory of candidates) {
    const directory = join(root, relativeDirectory);
    let manifestText: string;
    try {
      manifestText = readFileSync(join(directory, "package.json"), "utf8");
    } catch {
      continue;
    }
    const manifest = object(JSON.parse(manifestText));
    const declared: PackageRecord["declared"] = {};
    for (const kind of ["dependencies", "devDependencies"] as const)
      for (const [name, range] of Object.entries(object(manifest[kind])))
        if (typeof range === "string") declared[name] = { range, kind };
    let resolved: Record<string, string> = {};
    let lockfile: PackageRecord["lockfile"] = "none";
    try {
      // One root lockfile for the whole workspace since U03; a directory that
      // still carries its own (the npm-managed container images) is read below.
      resolved = workspaceResolvedVersions(
        readFileSync(join(root, "bun.lock"), "utf8"),
        relativeDirectory,
        "bun.lock",
      );
      if (Object.keys(resolved).length === 0 && Object.keys(declared).length > 0)
        throw new Error("not a workspace member");
      lockfile = "bun.lock";
    } catch {
      try {
        resolved = npmResolvedVersions(
          readFileSync(join(directory, "package-lock.json"), "utf8"),
          `${relativeDirectory}/package-lock.json`,
        );
        lockfile = "package-lock.json";
      } catch {
        lockfile = "none";
      }
    }
    records.push({
      directory: relativeDirectory,
      name: typeof manifest["name"] === "string" ? (manifest["name"] as string) : "(unnamed)",
      lockfile,
      declared,
      resolved,
    });
  }
  return records;
}

function cell(value: string | undefined): string {
  return value === undefined || value === "" ? "—" : value.replaceAll("|", "\\|");
}

export function renderDependencyMarkdown(records: PackageRecord[]): string {
  const directDependencies = [
    ...new Set(records.flatMap((record) => Object.keys(record.declared))),
  ].sort();
  const conflicts = directDependencies
    .map((dependency) => {
      const rows = records
        .filter((record) => record.declared[dependency] !== undefined)
        .map((record) => ({
          directory: record.directory,
          range: record.declared[dependency]?.range ?? "",
          version: record.resolved[dependency] ?? "(unresolved)",
        }));
      return { dependency, rows, versions: [...new Set(rows.map((row) => row.version))].sort() };
    })
    .filter((entry) => entry.versions.length > 1);

  const lines: string[] = [];
  lines.push("# Dependency resolution ledger");
  lines.push("");
  lines.push(
    "Generated by `mise run ledger:deps`. Unified plan U01/U03, chapter 07 §5.",
    "",
    'The repository is one Bun workspace: a single root `bun.lock` and `linker = "isolated"`, so',
    "each workspace below gets its own `node_modules` holding exactly the versions it pins. The",
    "tables are the closure the root lockfile gives each workspace. Version bumps are separate pull",
    "requests (decision D4).",
    "",
    "This is a snapshot, not a CI guard. Regenerate it when a manifest or the lockfile changes.",
  );
  lines.push("");
  lines.push(MIGRATION_NOTE.trimEnd());
  lines.push("");

  lines.push("## Dependencies that resolve to more than one version");
  lines.push("");
  if (conflicts.length === 0) lines.push("None.");
  else {
    lines.push(
      "These are what a single hoisted lockfile has to reconcile. Keeping the resolved version of",
      "each consumer is the requirement; where that is impossible the change must be called out.",
      "",
    );
    lines.push("| dependency | resolved versions | by package (declared range → resolved) |");
    lines.push("| --- | --- | --- |");
    for (const entry of conflicts)
      lines.push(
        `| \`${entry.dependency}\` | ${entry.versions.join(", ")} | ${entry.rows
          .map((row) => `${row.directory}: \`${row.range}\` → ${row.version}`)
          .join("<br>")} |`,
      );
  }
  lines.push("");

  lines.push("## Declared dependencies and resolved versions");
  lines.push("");
  for (const record of records) {
    lines.push(`### \`${record.directory}\` — \`${record.name}\``);
    lines.push("");
    lines.push(
      record.lockfile === "none"
        ? "No lockfile; resolved versions unknown."
        : `Lockfile: \`${record.lockfile}\`.`,
      "",
    );
    const declared = Object.keys(record.declared).sort();
    if (declared.length === 0) {
      lines.push("No declared dependencies.", "");
      continue;
    }
    lines.push("| dependency | kind | declared | resolved |");
    lines.push("| --- | --- | --- | --- |");
    for (const dependency of declared) {
      const entry = record.declared[dependency];
      lines.push(
        `| \`${dependency}\` | ${cell(entry?.kind)} | \`${entry?.range ?? ""}\` | ${cell(record.resolved[dependency])} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Transitive packages that resolve to more than one version");
  lines.push("");
  lines.push(
    "Nothing declares these directly; they differ because each package resolved its own lockfile.",
    "A single hoisted lockfile picks one version per name, so every row here is a resolution U03",
    "has to decide and record rather than absorb silently.",
  );
  lines.push("");
  lines.push("| package | versions | resolved by |");
  lines.push("| --- | --- | --- |");
  const transitive = [...new Set(records.flatMap((record) => Object.keys(record.resolved)))]
    .filter((name) => !directDependencies.includes(name))
    .sort();
  for (const name of transitive) {
    const rows = records
      .filter((record) => record.resolved[name] !== undefined)
      .map((record) => `${record.directory}: ${record.resolved[name] ?? ""}`);
    const versions = [
      ...new Set(
        records.flatMap((record) =>
          record.resolved[name] === undefined ? [] : [record.resolved[name] as string],
        ),
      ),
    ].sort();
    if (versions.length > 1)
      lines.push(`| \`${name}\` | ${versions.join(", ")} | ${rows.join("<br>")} |`);
  }
  lines.push("");

  lines.push("## Closure digest per package");
  lines.push("");
  lines.push(
    "SHA-256 over the package's sorted `name@version` closure. U03 regenerates this file after the",
    "workspace merge; a package whose digest is unchanged resolved to exactly the same closure, and",
    "a changed digest has to be explained dependency by dependency.",
  );
  lines.push("");
  lines.push("| package | lockfile | packages | closure sha256 |");
  lines.push("| --- | --- | --- | --- |");
  for (const record of records) {
    const all = Object.entries(record.resolved)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, version]) => `${name}@${version}`);
    lines.push(
      `| \`${record.directory}\` | ${record.lockfile} | ${all.length} | \`${createHash("sha256").update(all.join("\n")).digest("hex")}\` |`,
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function main(root = REPO_ROOT): Promise<void> {
  const records = readPackages(root);
  await Bun.write(join(root, LEDGER_MARKDOWN_PATH), renderDependencyMarkdown(records));
  console.log(`wrote ${LEDGER_MARKDOWN_PATH} (${records.length} packages)`);
}

if (import.meta.main) await main();
