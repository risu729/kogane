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
  resourceIdentityLines,
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
        // The READ database of U11: created empty on 2026-09-11; its
        // migrations are applied through the processor's read-migrations
        // configuration only.
        databaseName: "kogane-read",
        databaseId: "320ebe31-a031-48a1-985f-0e6fabbd517a",
        live: true,
        bindings: [
          "kogane-evidence-browser",
          "kogane-observation-pipeline",
          "kogane-read-migrations",
        ],
      },
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

/**
 * The identity lines of every Wrangler config that moved when
 * `services/evidence-browser` became `services/app` and
 * `services/observation-pipeline` became `services/processor`, captured from
 * the configs' bytes **before** the move.
 *
 * Six of the seven digests are the bytes as they stood on the old path: the
 * move was a rename and nothing inside the configs had to change, because both
 * directories stayed two levels below the repository root and every relative
 * path in them (`../../apps/web/dist`, `../../apps/web/dist-production`,
 * `../../packages/storage-d1/migrations/core`,
 * `../../packages/storage-d1/migrations/read`) still resolves.
 *
 * The exception is `kogane-read-migrations`, whose digest is
 * e5c9c269… rather than the pre-move 2146336c…: its header comment quotes the
 * `wrangler d1 migrations apply --config <path>` command that runs it, and that
 * path is the file's own. Nothing it declares changed — same binding, same
 * database id, same `migrations_dir` — which is exactly what the rest of the
 * line asserts.
 *
 * Three lines were refreshed when U16 landed on main while this move was in
 * review: `kogane-evidence-browser`, `kogane-evidence-browser-test` and
 * `kogane-observation-pipeline` gain `REWARD_READ_PROJECTION_ENABLED` (and the
 * test config `REWARDS_V2_ENABLED`) in `vars=`, with the digest that follows
 * from it. Only those two fields moved on each line — the Worker names, D1 and
 * R2 bindings, the queue consumer, the cron and the asset directories are the
 * pre-move values still, which is what this list exists to prove about the
 * rename. A var added by another change is not a rename changing an identity.
 */
const FROZEN_MOVED_IDENTITIES = [
  "kogane-demo config=wrangler.demo.jsonc live=true role=deployed email=false crons=- d1=- r2=- kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=- assets=../../apps/web/dist>ASSETS vars=ACCESS_AUDIENCE,ACCESS_ISSUER,BALANCE_PROJECTION_ENABLED,OPS_API_ENABLED,READ_PROJECTION_ENABLED secrets=- sha256=6185fc69201cbece8b600c389794fa1b573e8b8ae3680196733f0150140a431a",
  "kogane-evidence-browser config=wrangler.jsonc live=true role=deployed email=false crons=- d1=DB>kogane-raw-evidence#b335a887-250d-45c9-bd72-af83f35fdc60,READ>kogane-read#320ebe31-a031-48a1-985f-0e6fabbd517a r2=EVIDENCE>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=PIPELINE>kogane-observation-pipeline assets=../../apps/web/dist-production>ASSETS vars=ACCESS_AUDIENCE,ACCESS_ISSUER,AGENT_API_GRANTS,AGENT_GRANTS,BALANCE_PROJECTION_ENABLED,COMMANDS_ENABLED,EVENTS_V2_ENABLED,EVIDENCE_SOURCE_ID,OPS_API_ENABLED,READ_PROJECTION_ENABLED,REWARDS_V2_ENABLED,REWARD_READ_PROJECTION_ENABLED,SESSION_REFRESH_POLICY secrets=- sha256=b620e5f8a95c2034d9daeab72af626b8e8d5d5a6c8625973d0b6dd27e7aca24b",
  "kogane-evidence-browser-test config=wrangler.test.jsonc live=false role=test-only email=false crons=- d1=DB>test#00000000-0000-0000-0000-000000000001,READ>test-read#00000000-0000-0000-0000-000000000002 r2=EVIDENCE>test kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=- assets=test/assets>ASSETS vars=ACCESS_AUDIENCE,ACCESS_ISSUER,AGENT_API_GRANTS,AGENT_GRANTS,BALANCE_PROJECTION_ENABLED,COMMANDS_ENABLED,EVENTS_V2_ENABLED,EVIDENCE_SOURCE_ID,OPS_API_ENABLED,READ_PROJECTION_ENABLED,REWARDS_V2_ENABLED,REWARD_READ_PROJECTION_ENABLED,SESSION_REFRESH_POLICY secrets=- sha256=05e2bac7e49d655ed2a46905a9266e119a21f5a833f846b0ebc8c732ebb141b2",
  "kogane-observation-ops-local config=wrangler.ops.jsonc live=false role=binding-only email=false crons=- d1=- r2=- kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=OBSERVATIONS>kogane-observation-pipeline assets=- vars=- secrets=- sha256=902d4629a87b356b9fbecc55e816a13de9f008add7b5d911b61c0908cbb8cfbf",
  "kogane-observation-pipeline config=wrangler.jsonc live=true role=deployed email=false crons=*/5 * * * * d1=DB>kogane-raw-evidence#b335a887-250d-45c9-bd72-af83f35fdc60@../../packages/storage-d1/migrations/core,READ>kogane-read#320ebe31-a031-48a1-985f-0e6fabbd517a r2=EVIDENCE>kogane-raw-evidence,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=kogane-collection-terminals[dlq:kogane-collection-terminals-dlq,batch:10,retries:5,concurrency:2] do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=- assets=- vars=BALANCE_PROJECTION_ENABLED,COLLECTION_ACCOUNT_ID,COLLECTION_DATA_BUCKET,COLLECTION_INGEST_CLIENT,OPS_DISPATCH_ENABLED,READ_PROJECTION_ENABLED,RECONCILIATION_ENABLED,RELEASE_CANDIDATES_ENABLED,REPORTS_ENABLED,REWARD_CLAIMS_ENABLED,REWARD_READ_PROJECTION_ENABLED,SHARED_R2_INGEST_ENABLED secrets=- sha256=7905d5bdf083756d0ba94f1b7e2794aef0dfa0c148d05f7da3b239e7006fdede",
  "kogane-observation-read-diagnostic config=wrangler.diagnostic.jsonc live=false role=binding-only email=false crons=- d1=DB>kogane-raw-evidence#b335a887-250d-45c9-bd72-af83f35fdc60 r2=EVIDENCE>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=- assets=- vars=- secrets=- sha256=7256ac0f0d3807296d2c7c532ced593a2495ecc3e7dc8086a4f396b055f621ba",
  "kogane-read-migrations config=wrangler.read-migrations.jsonc live=false role=binding-only email=false crons=- d1=READ>kogane-read#320ebe31-a031-48a1-985f-0e6fabbd517a@../../packages/storage-d1/migrations/read r2=- kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=- assets=- vars=- secrets=- sha256=e5c9c2695790db0a397980644d222574a8006302aec28aee7a379ca5330ede89",
];

describe("G0-06/G0-07/G5-15 the directory rename changed no runtime identity", () => {
  test("the moved configs declare what they declared before the move", () => {
    const moved = new Set(
      ledger.directories
        .filter(
          (entry) => entry.directory === "services/app" || entry.directory === "services/processor",
        )
        .flatMap((entry) => entry.workers.map((worker) => worker.name)),
    );
    // Seven configs moved; a missing one would make the assertion below pass by
    // comparing nothing.
    expect(moved.size).toBe(7);
    expect(
      resourceIdentityLines(ledger).filter((line) => moved.has(line.split(" ")[0] as string)),
    ).toEqual(FROZEN_MOVED_IDENTITIES);
  });

  test("no Worker name, bucket, queue or database id mentions the new directory names", () => {
    // A directory rename that leaked into a resource name is the failure G0-06
    // and G5-15 are about: `wrangler deploy` would create a second Worker and
    // leave the live one running.
    for (const line of FROZEN_MOVED_IDENTITIES) {
      const [name = "", ...rest] = line.split(" ");
      expect(name.startsWith("kogane-")).toBe(true);
      expect(rest.join(" ")).not.toContain("services/app");
      expect(rest.join(" ")).not.toContain("services/processor");
    }
  });
});
