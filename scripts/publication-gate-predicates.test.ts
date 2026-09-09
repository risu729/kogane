// Publication gate guard (docs/publication-gate.md). Since migration 0026
// "current" is membership in published_parse_runs. A reader that tests
// `superseded_by_parse_run_id IS NULL` instead would show unadopted results
// (future candidates) the moment they exist, and a reader that tests
// `status = 'ok'` would show them too: success and adoption are two facts.
//
// The guard is an allow-list of individual occurrences, not of whole files.
// Exempting a file lets a new query inside it inherit the exemption silently,
// which is how the replay-plan estimate and the `/status` freshness signal
// kept reading `parse_runs.status='ok'` after the gate landed. So:
//
//   * every permitted `superseded_by_parse_run_id IS NULL` must sit on a line
//     that carries the comment marker `gate:writer` (a writer that maintains
//     the supersession pointer) or `gate:comparison` (the legacy rule, named
//     as such for the consistency check), or on the line directly below such
//     a marker. `//`, `--` (inside SQL) and JSDoc `*` all count as comments;
//   * every file that may state the predicate, or read `status = 'ok'`,
//     carries an exact expected count here. Adding an occurrence fails until
//     the number is changed deliberately, in review;
//   * migrations may state the predicate only up to 0026, the migration that
//     introduced the projection and backfilled it from that rule.
//
// The `IS NOT NULL` form only marks replaced history and is not a publication
// decision. Tests and the frozen legacy adapter are out of scope.
//
// This file runs in the standalone offline CI step
// (`bun run scripts/ci-package.ts --standalone`, `mise run ci:standalone`),
// which is where scripts/ci-packages.ts lists it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { REPO_ROOT } from "./ci-package.ts";

/** Occurrences allowed per file, each of which must also carry a marker. */
const PREDICATE_ALLOW_LIST: Record<string, number> = {
  // The legacy rule, exported only for the consistency comparison.
  "packages/read-model/src/concepts.ts": 1,
  // The projection writer's two statements and the module note. Since
  // migration 0028 the repair selection reads publication_gate_gaps, which
  // already excludes candidate results, so it states the rule no more.
  "services/observation-pipeline/src/publication-gate.ts": 3,
  // The supersession batch the writer still maintains during compatibility.
  "services/observation-pipeline/src/worker.ts": 3,
  // The candidate writer: a candidate is recorded only if the same batch left
  // its run ok and unsuperseded. A writer decision, never a read.
  "services/observation-pipeline/src/release-adoption.ts": 1,
  // The local PoC writer, its one-time backfill and the backfill's note.
  "poc/observation-pipeline/src/store.ts": 4,
};

/**
 * `status = 'ok'` is the execution-attempt fact ("the parser finished"), not
 * the publication fact ("normal reads use this run"). Only writers, the
 * identity interpretation path (which reads historical runs on purpose) and
 * the concept that names the fact may state it; every reader-facing signal
 * joins `published_parse_runs` instead.
 */
const OK_STATUS_ALLOW_LIST: Record<string, number> = {
  // successfulParses (the named execution fact) and the legacy rule.
  "packages/read-model/src/concepts.ts": 2,
  // Writer: publish batch, the duplicate-attempt skip, the job close, and the
  // comment that explains when contract v2 rows become visible.
  "services/observation-pipeline/src/worker.ts": 7,
  // Writer: the two projection statements and the module note.
  "services/observation-pipeline/src/publication-gate.ts": 4,
  // Candidate writer: the run is marked ok, the candidate row is recorded only
  // for an ok unsuperseded run, and the job is closed only for an ok run.
  // Everything the comparison calls "published" comes from the projection.
  "services/observation-pipeline/src/release-adoption.ts": 3,
  // Identity writer: interprets every successful run, published or not.
  "services/observation-pipeline/src/identity-store.ts": 5,
  // Identity audit: coverage over interpreted runs, not over what readers see.
  "services/observation-pipeline/src/identity-audit.ts": 2,
  // Operator diagnostics over parse attempts per artifact; no reader path.
  "services/observation-pipeline/scripts/diagnose.ts": 1,
  // Decorates published and superseded runs; adoption comes from the LEFT JOIN
  // on the projection, not from this status test (which only drops pending runs).
  "packages/read-model/src/organization.ts": 1,
  // The local PoC writer and its backfill.
  "poc/observation-pipeline/src/store.ts": 5,
};

/** Migrations that may state the legacy rule: those up to the gate itself. */
const LAST_LEGACY_MIGRATION = 26;

const PREDICATE = /superseded_by_parse_run_id\s+IS\s+NULL/giu;
const OK_STATUS = /status\s*=\s*'ok'/gu;
/** A deliberate annotation in a TypeScript, SQL or JSDoc comment. */
const MARKER = /(?:\/\/|--|\*)[^\n]*\bgate:(?:writer|comparison)\b/u;

function tracked(...patterns: string[]): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", ...patterns], { cwd: REPO_ROOT });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\0").filter(Boolean).sort();
}

function productionSources(): string[] {
  return tracked("*.ts", "*.tsx").filter(
    (path) => !/(^|\/)test\/|\.test\.tsx?$|(^|\/)node_modules\//u.test(path),
  );
}

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function count(text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
}

/** Occurrences of `pattern` that are neither on a marked line nor directly
 * below one, reported as `path:line`. */
function unmarked(path: string, text: string, pattern: RegExp): string[] {
  const lines = text.split("\n");
  const single = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  return lines.flatMap((line, index) =>
    single.test(line) && !MARKER.test(line) && !MARKER.test(lines[index - 1] ?? "")
      ? [`${path}:${index + 1}`]
      : [],
  );
}

describe("publication gate predicate guard", () => {
  test("no production source states the supersession predicate outside the marked writers", () => {
    const offenders: string[] = [];
    for (const path of productionSources()) {
      const hits = count(read(path), PREDICATE);
      if (hits === 0) continue;
      if (!Object.hasOwn(PREDICATE_ALLOW_LIST, path)) offenders.push(`${path} (${hits})`);
    }
    expect(offenders).toEqual([]);
  });

  test("each allowed file states the predicate exactly as often as reviewed, on marked lines", () => {
    const counts: Record<string, number> = {};
    const missingMarker: string[] = [];
    for (const path of Object.keys(PREDICATE_ALLOW_LIST)) {
      const text = read(path);
      counts[path] = count(text, PREDICATE);
      missingMarker.push(...unmarked(path, text, PREDICATE));
    }
    expect(counts).toEqual(PREDICATE_ALLOW_LIST);
    expect(missingMarker).toEqual([]);
  });

  test("no production source reads the success status outside the reviewed writers", () => {
    const counts: Record<string, number> = {};
    for (const path of productionSources()) {
      const hits = count(read(path), OK_STATUS);
      if (hits > 0) counts[path] = hits;
    }
    expect(counts).toEqual(OK_STATUS_ALLOW_LIST);
  });

  test("a migration after the gate may not embed the legacy rule", () => {
    const migrations = tracked("services/raw-evidence/migrations/*.sql");
    expect(migrations.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    const legacy: string[] = [];
    for (const path of migrations) {
      if (count(read(path), PREDICATE) === 0) continue;
      const number = Number.parseInt(basename(path).slice(0, 4), 10);
      legacy.push(basename(path));
      if (!Number.isInteger(number) || number > LAST_LEGACY_MIGRATION) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    // The projection and the view that compares it with the legacy rule.
    expect(legacy).toContain("0026_publication_gate.sql");
  });

  test("the read model's current concept is the projection and the legacy rule is named as such", () => {
    const concepts = read("packages/read-model/src/concepts.ts");
    expect(concepts).toMatch(/export const publishedParses = \{[\s\S]*?published_parse_runs/u);
    expect(concepts).toMatch(
      /export const legacyPublishedParses = \{[\s\S]*?superseded_by_parse_run_id IS NULL/u,
    );
    // Promoted out of the PoC by design review D07; the SQL is unchanged.
    expect(read("packages/parsers/src/snapshot-query.ts")).toContain("publishedParseRuns");
  });

  test("the operator signals of the pipeline Worker read the projection", () => {
    const worker = read("services/observation-pipeline/src/worker.ts");
    // Replay planning: "already parsed" is "already published".
    expect(worker).toContain(
      "EXISTS(SELECT 1 FROM published_parse_runs pub WHERE pub.fetch_artifact_id=a.id",
    );
    // /status freshness: the newest adopted parse, not the newest success.
    expect(worker).toContain("(SELECT max(parsed_at) FROM published_observation_parses)");
  });
});
