// Publication gate guard (docs/publication-gate.md). Since migration 0026
// "current" is membership in published_parse_runs. A reader that tests
// `superseded_by_parse_run_id IS NULL` instead would show unadopted results
// (future candidates) the moment they exist, so no production code may state
// that predicate except the places that must compare against it: the read
// model's legacy comparison concept, the writers that maintain the pointer,
// and the PoC store writer. The `IS NOT NULL` form only marks replaced
// history and is not a publication decision. Tests and the frozen legacy
// adapter are out of scope.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./ci-package.ts";

const ALLOWED = new Set([
  // The legacy rule, exported only for the consistency comparison.
  "packages/read-model/src/concepts.ts",
  // The supersession batch the writer still maintains during compatibility.
  "services/observation-pipeline/src/worker.ts",
  // The projection writer, consistency check and bounded repair.
  "services/observation-pipeline/src/publication-gate.ts",
  // The local PoC writer and its one-time backfill.
  "poc/observation-pipeline/src/store.ts",
]);
const PREDICATE = /superseded_by_parse_run_id\s+IS\s+NULL/iu;
const EVERY_PREDICATE = new RegExp(PREDICATE.source, "giu");

function trackedSources(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.ts", "*.tsx"], {
    cwd: REPO_ROOT,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((path) => !/(^|\/)test\/|\.test\.tsx?$|(^|\/)node_modules\//u.test(path))
    .sort();
}

describe("publication gate predicate guard", () => {
  test("no production read composes the supersession predicate outside the allowed writers", () => {
    const offenders: string[] = [];
    for (const path of trackedSources()) {
      const text = readFileSync(join(REPO_ROOT, path), "utf8");
      const hits = text.match(EVERY_PREDICATE);
      if (!hits) continue;
      if (!ALLOWED.has(path)) offenders.push(`${path} (${hits.length})`);
    }
    expect(offenders).toEqual([]);
  });

  test("the allowed writers still carry the predicate they are exempted for", () => {
    for (const path of ALLOWED)
      expect(readFileSync(join(REPO_ROOT, path), "utf8"), path).toMatch(PREDICATE);
  });

  test("the read model's current concept is the projection and the legacy rule is named as such", () => {
    const concepts = readFileSync(join(REPO_ROOT, "packages/read-model/src/concepts.ts"), "utf8");
    expect(concepts).toMatch(/export const publishedParses = \{[\s\S]*?published_parse_runs/u);
    expect(concepts).toMatch(
      /export const legacyPublishedParses = \{[\s\S]*?superseded_by_parse_run_id IS NULL/u,
    );
    const snapshot = readFileSync(
      join(REPO_ROOT, "poc/observation-pipeline/src/snapshot-query.ts"),
      "utf8",
    );
    expect(snapshot).toContain("publishedParseRuns");
  });
});
