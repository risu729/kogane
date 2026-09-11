// Generator for the pre-workspace dependency baseline
// (`infra/dependency-resolution.md`), unified plan U01 → U03 / chapter 07 §5.
//
// Today every `services/*`, `packages/*` and `poc/*` directory is its own Bun
// package with its own `bun.lock`, so the same dependency can resolve to a
// different version in each of them. U03 merges them into one root workspace
// with a single lockfile, and 07 §5 requires the diff of *resolved* versions
// before and after that merge: a workspace migration must not quietly upgrade
// anything. This file is that "before".
//
// It is a snapshot, not a guard: it is regenerated on demand, not asserted in
// CI, because the lockfiles change for legitimate reasons and U03 replaces the
// layout it describes.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_MARKDOWN_PATH = "infra/dependency-resolution.md";
const WORKSPACES = ["packages", "poc", "services"] as const;

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
      resolved = resolvedVersions(
        readFileSync(join(directory, "bun.lock"), "utf8"),
        `${relativeDirectory}/bun.lock`,
      );
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
  lines.push("# Dependency resolution baseline (pre-workspace)");
  lines.push("");
  lines.push(
    "Generated by `bun run scripts/dependency-ledger.ts`. Unified plan U01, input to U03.",
    "",
    "Every `services/*`, `packages/*` and `poc/*` directory is its own Bun package with its own",
    "`bun.lock` today. Chapter 07 §5 requires that moving to one root workspace and one lockfile",
    'does not change what anything resolves to: this file is the "before" half of that diff, so U03',
    "can show the delta instead of asserting there was none. Version bumps are separate pull",
    "requests (decision D4).",
    "",
    "This is a snapshot, not a CI guard. Regenerate it when a manifest or a lockfile changes.",
  );
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
