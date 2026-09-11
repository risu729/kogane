// The synthetic fixtures kept their exact bytes when they left the PoC
// (unified plan U04, chapter 07 §3, acceptance test **G0-04**).
//
// `tests/fixtures/MANIFEST.sha256` was generated from
// `git show d096178:poc/observation-pipeline/fixtures/<path>` — the bytes as
// they were before the move — and rewritten to the new path only. This suite
// hashes what is on disk now and compares, so a formatter, an editor's newline
// handling or a well-meant "fix" to a fixture fails here instead of silently
// changing what every parser test asserts.
//
// It also pins the formatter exclusions: the manifest is only a guarantee if
// the tools that rewrite files are told to leave these ones alone, and the new
// location has to keep matching the same `**/fixtures/**` glob the old one did.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, trackedFiles } from "../tasks/_lib/repo-root.ts";

const MANIFEST = "tests/fixtures/MANIFEST.sha256";
const FIXTURES = "tests/fixtures/observation-pipeline";

/** `<sha256>  <repository-relative path>` per line, as `sha256sum` writes it. */
function readManifest(): { path: string; sha256: string }[] {
  return readFileSync(join(REPO_ROOT, MANIFEST), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const match = /^(?<sha256>[0-9a-f]{64}) {2}(?<path>\S.*)$/u.exec(line);
      if (match?.groups === undefined) throw new Error(`${MANIFEST}: malformed line: ${line}`);
      return { path: match.groups["path"] as string, sha256: match.groups["sha256"] as string };
    });
}

const entries = readManifest();
const tracked = trackedFiles(FIXTURES);

describe("G0-04 moved fixtures keep their bytes", () => {
  test("the manifest lists exactly the fixtures git tracks", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.path).sort()).toEqual(tracked);
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
    for (const entry of entries) expect(entry.path.startsWith(`${FIXTURES}/`)).toBe(true);
  });

  test("every fixture still hashes to the value recorded before the move", () => {
    const actual = entries.map((entry) => ({
      path: entry.path,
      sha256: createHash("sha256").update(readFileSync(join(REPO_ROOT, entry.path))).digest("hex"),
    }));
    expect(actual).toEqual(entries);
  });

  test("the guard notices a changed byte", () => {
    // The check above is only worth running if it can fail: hashing a fixture
    // with one byte appended must not produce the recorded digest.
    const first = entries[0];
    if (first === undefined) throw new Error("no fixtures");
    const bytes = readFileSync(join(REPO_ROOT, first.path));
    const changed = createHash("sha256")
      .update(Buffer.concat([bytes, Buffer.from("\n")]))
      .digest("hex");
    expect(changed).not.toBe(first.sha256);
  });

  test("every formatter and linter still excludes the fixtures", () => {
    // `**/fixtures/**` matched `poc/observation-pipeline/fixtures/**` and
    // matches `tests/fixtures/**`; these four configs are the only things in
    // the repository allowed to rewrite a tracked file.
    for (const config of ["hk.pkl", ".oxfmtrc.json", ".oxlintrc.json", ".typos.toml"])
      expect(readFileSync(join(REPO_ROOT, config), "utf8"), config).toContain("**/fixtures/**");
    expect(FIXTURES.split("/").includes("fixtures")).toBe(true);
  });
});
