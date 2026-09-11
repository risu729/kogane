// The runtime resource ledger must describe the configs that are on disk.
//
// Unified plan U01, acceptance tests G0-06 (renaming a Worker directory must
// not change the physical Worker/DO/R2/Queue identity), G0-07 (DO migration tag
// and class keep addressing the same state) and G0-12 (a PoC with a live cron
// is not deleted just because nothing imports it). The ledger is only worth
// anything if it cannot silently fall behind, so this suite regenerates it and
// compares, which makes "changed a wrangler config without updating the ledger"
// a CI failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseJsonc, stripJsonc } from "./jsonc.ts";
import {
  DISPOSITIONS,
  LEDGER_JSON_PATH,
  LEDGER_MARKDOWN_PATH,
  LIVE_INVENTORY,
  REPO_ROOT,
  buildResourceLedger,
  renderResourceMarkdown,
} from "./resource-ledger.ts";

const ledger = buildResourceLedger(REPO_ROOT);

describe("JSONC reader", () => {
  test("removes comments and trailing commas without touching string contents", () => {
    expect(parseJsonc('{"a": 1, /* c */ "b": ["x", "y",], // tail\n}', "unit")).toEqual({
      a: 1,
      b: ["x", "y"],
    });
    expect(parseJsonc('{"url": "https://example.test/a//b", "q": "a,}"}', "unit")).toEqual({
      url: "https://example.test/a//b",
      q: "a,}",
    });
    expect(stripJsonc('"\\" // not a comment"')).toBe('"\\" // not a comment"');
  });
});

describe("G0-06/G0-07/G0-12 resource ledger", () => {
  test("infra/resources.json is the current generator output", () => {
    expect(readFileSync(join(REPO_ROOT, LEDGER_JSON_PATH), "utf8")).toBe(
      `${JSON.stringify(ledger, null, 2)}\n`,
    );
  });

  test("infra/resources.md is the current generator output", () => {
    expect(readFileSync(join(REPO_ROOT, LEDGER_MARKDOWN_PATH), "utf8")).toBe(
      renderResourceMarkdown(ledger),
    );
  });

  test("every wrangler config tracked by git is in the ledger", () => {
    const result = Bun.spawnSync(
      [
        "git",
        "ls-files",
        "-z",
        "--",
        "apps/*/wrangler*",
        "experiments/*/wrangler*",
        "poc/*/wrangler*",
        "services/*/wrangler*",
      ],
      { cwd: REPO_ROOT },
    );
    expect(result.exitCode).toBe(0);
    const tracked = result.stdout.toString().split("\0").filter(Boolean).sort();
    expect(tracked.length).toBeGreaterThan(0);
    expect(
      ledger.directories.flatMap((entry) => entry.workers.map((w) => w.config)).sort(),
    ).toEqual(tracked);
  });

  test("every walked workspace directory carries a plan disposition", () => {
    expect(
      ledger.directories.filter((entry) => entry.disposition === null).map((e) => e.directory),
    ).toEqual([]);
    // A stale disposition key would silently document a directory that no
    // longer exists; the moves of 07 §1 must update this map.
    expect(Object.keys(DISPOSITIONS).sort()).toEqual(
      ledger.directories.map((entry) => entry.directory).sort(),
    );
  });

  test("no wrangler config declares a resource the ledger does not extract", () => {
    expect(
      ledger.directories
        .flatMap((entry) => entry.workers)
        .filter((worker) => worker.unextractedKeys.length > 0)
        .map((worker) => `${worker.config}: ${worker.unextractedKeys.join(",")}`),
    ).toEqual([]);
  });

  test("the deployed identities of the live account are all accounted for", () => {
    // Anything live without a config here cannot be redeployed from this
    // repository; U15 has to decide about it explicitly rather than by silence.
    expect(ledger.summary.liveWorkersWithoutConfig).toEqual([
      ...LIVE_INVENTORY.workersWithoutConfig,
    ]);
    expect(ledger.summary.liveBucketsWithoutConfig).toEqual([]);
    expect(ledger.summary.d1Databases.filter((entry) => entry.live)).toEqual([
      {
        databaseName: "kogane-raw-evidence",
        databaseId: "b335a887-250d-45c9-bd72-af83f35fdc60",
        live: true,
        bindings: [
          "kogane-evidence-browser",
          "kogane-ingest",
          "kogane-observation-pipeline",
          "kogane-observation-read-diagnostic",
        ],
      },
    ]);
  });

  test("PoC directories with a live cron or a live Worker are marked live", () => {
    // G0-12: "nothing imports it" is not a reason to delete a collector.
    const cronWorkers = new Set(ledger.summary.crons.filter((e) => e.live).map((e) => e.worker));
    expect(cronWorkers.size).toBeGreaterThan(10);
    for (const directory of ledger.directories) {
      const hasLive = directory.workers.some(
        (worker) => worker.liveWorker || worker.r2.some((entry) => entry.live),
      );
      expect(directory.disposition?.liveResourceStatus.startsWith("LIVE(") ?? false).toBe(hasLive);
    }
  });

  test("Durable Object classes keep a tag or an explicit sqlite export", () => {
    for (const entry of ledger.summary.durableObjectClasses) {
      expect(entry.className).not.toBe("");
      expect(entry.storage).toBe("sqlite");
    }
  });
});
