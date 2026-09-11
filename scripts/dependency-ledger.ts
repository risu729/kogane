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
// lockfile did to resolved versions. That note, and any other static block this
// generator renders verbatim, lives in `dependency-ledger-notes.ts`: a large
// literal in the middle of a generator merges cleanly into two declarations of
// the same name, and U15 moved it out so that a second copy collides instead
// (`dependency-ledger.test.ts`).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATION_NOTE } from "./dependency-ledger-notes.ts";
import { parseJsonc } from "./jsonc.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_MARKDOWN_PATH = "infra/dependency-resolution.md";
// `apps` and `experiments` joined the root manifest's globs in U04.
const WORKSPACES = ["apps", "experiments", "packages", "services"] as const;

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
    // A top-level directory disappears once its last member has moved (07 §1
    // empties `poc/`), and `experiments/` only appears when the first one lands.
    if (!existsSync(base)) continue;
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
