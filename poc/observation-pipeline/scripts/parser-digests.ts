// Parser code digests: the build identity of every deployed transformation.
//
// Design review D03 asks that a parser be identified by more than its display
// `version`: the same version with different code is a different
// transformation, and the deployment that would introduce one must be
// refused. `parser.version` stays the human-readable change note; the digest
// below is what `parser_releases.code_digest` records and what migration 0028
// pins per (name, version).
//
// Scope of the digest, deliberately narrower than the repository commit: a
// parser's own module and the local modules it transitively imports (shared
// helpers such as src/parsers/util.ts, the parser types, the domain coverage
// contract). A CSS change in web/ must not force every artifact to be
// re-parsed; a change to util.ts must.
//
// Regenerate after a deliberate parser change, from poc/observation-pipeline:
//   bun run scripts/parser-digests.ts
// The generator refuses to record a changed digest for an unchanged
// `version`, and test/parser-digests.test.ts fails when the checked-in file
// no longer matches the sources.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { canonicalJson, sha256Hex } from "../../../packages/domain/src/context.ts";
import type { Parser } from "../src/types.ts";

/** Repository root, from poc/observation-pipeline/scripts/. */
export const REPO_ROOT = new URL("../../../", import.meta.url);
const PARSERS_DIR = new URL("poc/observation-pipeline/src/parsers/", REPO_ROOT);

export interface ParserRelease {
  version: string;
  codeDigest: string;
  /** Repository-relative source files the digest covers, sorted. */
  sources: string[];
}
export interface ParserDigests {
  /** Repository-relative path -> SHA-256 of the file's bytes. */
  sourceDigests: Record<string, string>;
  releases: Record<string, ParserRelease>;
}

const RELATIVE_IMPORT = /(?:^|[\s;])(?:import|export)\b[^;]*?from\s*"(\.[^"]*)"/gu;

function repoRelative(url: URL): string {
  return url.href.slice(REPO_ROOT.href.length);
}

/** Local modules `file` imports, transitively, inside this repository. */
function moduleClosure(entry: URL, seen = new Set<string>()): Set<string> {
  const path = repoRelative(entry);
  if (seen.has(path) || !existsSync(entry)) return seen;
  seen.add(path);
  const text = readFileSync(entry, "utf8");
  for (const match of text.matchAll(RELATIVE_IMPORT)) {
    const target = new URL(match[1]!, entry);
    if (target.href.startsWith(REPO_ROOT.href)) moduleClosure(target, seen);
  }
  return seen;
}

function isParser(value: unknown): value is Parser {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Parser).name === "string" &&
    typeof (value as Parser).version === "string" &&
    typeof (value as Parser).accepts === "function" &&
    typeof (value as Parser).parse === "function"
  );
}

/**
 * Parser name -> the module that defines it, read from the registry's own
 * import list. Import order is irrelevant: a module exporting several parsers
 * gives each of them the same source closure, which is correct, because a
 * change anywhere in that module can change any of them.
 */
export async function parserModules(): Promise<Map<string, URL>> {
  const registry = new URL("registry.ts", PARSERS_DIR);
  const modules = new Map<string, URL>();
  for (const match of readFileSync(registry, "utf8").matchAll(RELATIVE_IMPORT)) {
    const target = new URL(match[1]!, registry);
    if (!existsSync(target)) continue;
    const exports: Record<string, unknown> = await import(target.href);
    for (const value of Object.values(exports))
      if (isParser(value) && !modules.has(value.name)) modules.set(value.name, target);
  }
  return modules;
}

/** Recompute every digest from the working tree. */
export async function computeParserDigests(parsers: readonly Parser[]): Promise<ParserDigests> {
  const modules = await parserModules();
  const sourceDigests: Record<string, string> = {};
  const releases: Record<string, ParserRelease> = {};
  for (const parser of [...parsers].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const entry = modules.get(parser.name);
    if (!entry) throw new Error(`parser module not found for ${parser.name}`);
    const sources = [...moduleClosure(entry)].sort();
    for (const source of sources)
      sourceDigests[source] ??= await sha256Hex(readFileSync(new URL(source, REPO_ROOT), "utf8"));
    releases[parser.name] = {
      version: parser.version,
      codeDigest: await sha256Hex(
        canonicalJson({
          files: sources.map((path) => ({ path, sha256: sourceDigests[path]! })),
          scheme: "parser-code-digest-v1",
        }),
      ),
      sources,
    };
  }
  return { sourceDigests: Object.fromEntries(Object.entries(sourceDigests).sort()), releases };
}

export interface DigestViolation {
  parser: string;
  code: "code_digest_changed_without_version" | "version_changed" | "missing" | "unexpected";
}

/**
 * The rule the review states as the short-term compatibility measure: the
 * same `name/version` may never carry a different code digest. Comparing the
 * checked-in record with the freshly computed one is the only place that can
 * see a same-version code change, so both the generator and CI use it.
 */
export function digestViolations(
  recorded: Record<string, ParserRelease>,
  computed: Record<string, ParserRelease>,
): DigestViolation[] {
  const violations: DigestViolation[] = [];
  for (const [parser, next] of Object.entries(computed)) {
    const previous = recorded[parser];
    if (!previous) {
      violations.push({ parser, code: "missing" });
      continue;
    }
    if (previous.version === next.version && previous.codeDigest !== next.codeDigest)
      violations.push({ parser, code: "code_digest_changed_without_version" });
    else if (previous.version !== next.version) violations.push({ parser, code: "version_changed" });
  }
  for (const parser of Object.keys(recorded))
    if (!(parser in computed)) violations.push({ parser, code: "unexpected" });
  return violations;
}

export function renderDigests(digests: ParserDigests): string {
  return `// Generated by scripts/parser-digests.ts. Do not edit by hand.
//
// \`codeDigest\` is the build identity of a parser: SHA-256 over the canonical
// list of its own module and every local module it transitively imports, with
// each file's own SHA-256. Migration 0028 refuses to register the same
// parser name and version with a different digest, and
// test/parser-digests.test.ts fails when this file no longer matches the
// sources it describes.
import type { ParserDigests } from "../../scripts/parser-digests.ts";

export const PARSER_DIGESTS: ParserDigests = ${JSON.stringify(digests, null, 2)};

/** Parser name -> build digest, the value \`parser_releases.code_digest\` stores. */
export const PARSER_CODE_DIGESTS: Record<string, string> = Object.fromEntries(
  Object.entries(PARSER_DIGESTS.releases).map(([name, release]) => [name, release.codeDigest]),
);
`;
}

if (import.meta.main) {
  const { PARSERS } = await import("../src/parsers/registry.ts");
  const target = new URL("poc/observation-pipeline/src/parsers/digests.ts", REPO_ROOT);
  const computed = await computeParserDigests(PARSERS);
  if (existsSync(target)) {
    const { PARSER_DIGESTS } = await import(target.href);
    const violations = digestViolations(PARSER_DIGESTS.releases, computed.releases).filter(
      (violation) => violation.code === "code_digest_changed_without_version",
    );
    if (violations.length) {
      console.error(
        `Refusing to record a changed code digest for an unchanged parser version: ${violations
          .map((violation) => violation.parser)
          .join(", ")}. Bump the parser version first.`,
      );
      process.exitCode = 1;
    }
  }
  if (process.exitCode !== 1) {
    writeFileSync(target, renderDigests(computed));
    console.log(`wrote ${Object.keys(computed.releases).length} parser digests`);
  }
}
