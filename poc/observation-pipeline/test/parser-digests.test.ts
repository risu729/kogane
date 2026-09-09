// Parser build identity (design review D03, A04). `parser.version` is a
// human-readable change note; `code_digest` is what actually identifies the
// transformation. These tests are the CI half of the rule migration 0028
// enforces in the schema: the same parser name and version may never carry
// two different code digests.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PARSERS, PARSER_CODE_DIGESTS, PARSER_DIGESTS } from "../src/parsers/registry.ts";
import {
  computeParserDigests,
  digestViolations,
  renderDigests,
  type ParserRelease,
} from "../scripts/parser-digests.ts";

const computed = await computeParserDigests(PARSERS);

describe("parser code digests", () => {
  test("the checked-in digests describe the sources on disk", () => {
    // Changing a parser file, or a shared helper it imports, without running
    // `bun run scripts/parser-digests.ts` fails here.
    expect(computed.releases).toEqual(PARSER_DIGESTS.releases);
    expect(computed.sourceDigests).toEqual(PARSER_DIGESTS.sourceDigests);
  });

  test("every deployed parser has exactly one recorded release at its version", () => {
    expect(Object.keys(PARSER_DIGESTS.releases).sort()).toEqual(
      [...PARSERS].map((parser) => parser.name).sort(),
    );
    for (const parser of PARSERS)
      expect(PARSER_DIGESTS.releases[parser.name]?.version, parser.name).toBe(parser.version);
    expect(new Set(PARSERS.map((parser) => parser.name)).size).toBe(PARSERS.length);
  });

  test("a digest covers the parser's own module and the local modules it imports", () => {
    for (const [name, release] of Object.entries(PARSER_DIGESTS.releases)) {
      expect(release.sources.length, name).toBeGreaterThan(0);
      expect([...release.sources].sort(), name).toEqual(release.sources);
      for (const source of release.sources)
        expect(PARSER_DIGESTS.sourceDigests[source], `${name}: ${source}`).toMatch(/^[0-9a-f]{64}$/);
      expect(PARSER_CODE_DIGESTS[name]).toBe(release.codeDigest);
    }
    // Shared transforms are inside the digest range, unrelated code is not:
    // a change to util.ts must invalidate the parsers that use it, a change
    // to the web UI must not.
    const sony = PARSER_DIGESTS.releases["sony-bank-gross-balance"]!;
    expect(sony.sources).toContain("poc/observation-pipeline/src/parsers/util.ts");
    expect(sony.sources).toContain("poc/observation-pipeline/src/types.ts");
    expect(sony.sources.some((path) => path.startsWith("poc/observation-pipeline/web/"))).toBe(
      false,
    );
  });

  test("the same name and version with a different code digest is rejected", () => {
    const [name] = Object.keys(PARSER_DIGESTS.releases);
    const recorded = PARSER_DIGESTS.releases[name!]!;
    const changed: Record<string, ParserRelease> = {
      ...PARSER_DIGESTS.releases,
      [name!]: { ...recorded, codeDigest: `${"0".repeat(63)}1` },
    };
    expect(digestViolations(PARSER_DIGESTS.releases, changed)).toEqual([
      { parser: name!, code: "code_digest_changed_without_version" },
    ]);
    // A version change alongside the digest change is a new release, which is
    // reported as a change but is not the forbidden case.
    const bumped: Record<string, ParserRelease> = {
      ...PARSER_DIGESTS.releases,
      [name!]: { ...recorded, version: "99.0.0", codeDigest: `${"0".repeat(63)}1` },
    };
    expect(digestViolations(PARSER_DIGESTS.releases, bumped)).toEqual([
      { parser: name!, code: "version_changed" },
    ]);
    expect(digestViolations(PARSER_DIGESTS.releases, PARSER_DIGESTS.releases)).toEqual([]);
  });

  test("the generated file is exactly what the generator would write", () => {
    expect(readFileSync(new URL("../src/parsers/digests.ts", import.meta.url), "utf8")).toBe(
      renderDigests(computed),
    );
  });
});
