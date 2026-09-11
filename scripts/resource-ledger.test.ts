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
import { basename, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseJsonc, stripJsonc } from "./jsonc.ts";
import {
  DISPOSITIONS,
  LEDGER_JSON_PATH,
  LEDGER_MARKDOWN_PATH,
  LIVE_INVENTORY,
  REPO_ROOT,
  SCANNED_WORKSPACES,
  buildResourceLedger,
  renderResourceMarkdown,
  resourceIdentityLines,
} from "./resource-ledger.ts";

const ledger = buildResourceLedger(REPO_ROOT);

/**
 * Every runtime identity the twelve deployed PoC collectors declared before
 * U04 promoted their directories, as `resourceIdentityLines` renders them:
 * read from the ledger of `origin/main` at `d096178`, the commit this work
 * item branched from, and never regenerated.
 *
 * A `git mv` may not touch any of it. A line carries no directory, only the
 * Worker name, the config's file name and what Cloudflare addresses, so a
 * promotion that is genuinely a move leaves the lines byte-identical. The
 * trailing `sha256` is the digest of the Wrangler config file, which closes
 * what the name-only `vars` and `secrets` fields leave open.
 */
const COLLECTOR_IDENTITIES_BEFORE_THE_PROMOTIONS = [
  "kogane-globalpass-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=17 18 * * * d1=- r2=SNAPSHOTS>kogane-globalpass-collector-poc kv=- queue-producers=- queue-consumers=- do=COLLECTOR_CONTAINER>GlobalPassCollectorContainer do-migrations=v1[sqlite:GlobalPassCollectorContainer] do-exports=- containers=GlobalPassCollectorContainer:./Dockerfile:basic:2 browser=BROWSER vpc=MESH>tunnel:6b0ccf30-68b2-494e-baa8-f4f9f3e46b33,CF_EGRESS>network:cf1:network services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION,RELAY_PUBLIC_URL secrets=- sha256=9fdc9afbf599a5ee2985f59da30cbbce17ef360ca4951c03b8c65587d7ff5886",
  "kogane-mobile-suica-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=10 21 * * * d1=- r2=SNAPSHOTS>kogane-mobile-suica-collector-poc kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=BROWSER vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION secrets=ADMIN_TRIGGER_TOKEN,JRE_ID_CREDENTIAL_JSON sha256=3b1d3e2a52ad9c6216f67db0c49422e6a8d1588410306d7204dca6a508330e74",
  "kogane-moneyforward-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=15 21 * * * d1=- r2=SNAPSHOTS>kogane-moneyforward-collector-poc kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION secrets=- sha256=ad007eb7c3ef7581d66e3b16d5bb6d07e29b47dacfc181185ef1b4855d071c53",
  "kogane-myjcb-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-myjcb-collector-poc kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=BROWSER vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION secrets=- sha256=1f0480817f8af50ca4dce3b1ea719f4006d478272394d6f380ebb12f93ecfa5a",
  "kogane-sbi-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-sbi-collector-poc kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION secrets=- sha256=58eedda45be2be8cc95e9110469a51a7e631bd572e29be3069517521c23ece10",
  "kogane-sbi-shinsei-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-sbi-shinsei-collector-poc kv=- queue-producers=- queue-consumers=- do=COLLECTOR_CONTAINER>SbiShinseiCollectorContainer do-migrations=v1[sqlite:SbiShinseiCollectorContainer] do-exports=- containers=SbiShinseiCollectorContainer:./Dockerfile:basic:2 browser=- vpc=MESH>tunnel:6b0ccf30-68b2-494e-baa8-f4f9f3e46b33 services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION,RELAY_PUBLIC_URL secrets=- sha256=e18e123aa61d961ad2bf082f8a9538948f82fe17082ef27a00bf1edead4b959c",
  "kogane-sbi-vc-session-poc config=wrangler.jsonc live=true role=deployed email=false crons=*/15 * * * *,5 21 * * * d1=- r2=SNAPSHOTS>kogane-sbi-vc-trade-poc kv=- queue-producers=- queue-consumers=- do=SESSION_STATE>SbiVcSessionState do-migrations=v1[sqlite:SbiVcSessionState] do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION secrets=- sha256=c1c85fb18c6c6f36f81dd2b907e5d9c6e22d2c6ecf74acd1e87623a435cd55b8",
  "kogane-smbc-direct-backfill-poc config=wrangler.jsonc live=true role=deployed email=false crons=- d1=- r2=SNAPSHOTS>kogane-smbc-direct-backfill-poc kv=- queue-producers=- queue-consumers=- do=BACKFILL_SESSION>SmbcBackfillSession do-migrations=v1[sqlite:SmbcBackfillSession] do-exports=- containers=- browser=- vpc=TAMIA>tunnel:6b0ccf30-68b2-494e-baa8-f4f9f3e46b33 services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION,DEFAULT_BACKFILL_FROM,SMBC_DIRECT_BASE_URL,SMBC_DIRECT_LOGIN_BASE_URL secrets=- sha256=8f1d284ca0bfa705b30fb10272c73d0ddf09c1a497375e2456c898539072d31f",
  "kogane-sony-bank-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-sony-bank-collector-poc kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION secrets=- sha256=57d87ffdb7a47fc81fd197da11d319dd74c26708d4ed5d89378c6bc65ad11976",
  "kogane-vpass-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-vpass-collector-poc kv=- queue-producers=RAW_EVIDENCE_QUEUE>kogane-vpass-raw-evidence-import queue-consumers=kogane-vpass-raw-evidence-import[dlq:kogane-vpass-raw-evidence-import-dlq,batch:1,retries:10,concurrency:-] do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=- secrets=- sha256=2a1963ae7ef7085b6b964b82315359d5dc92c1eff84345e359b32a822c58c859",
  "kogane-vpoint-collector-poc config=wrangler.jsonc live=true role=deployed email=true crons=15 21 * * * d1=- r2=SNAPSHOTS>kogane-vpoint-collector-poc,VPOINT_PAY_SNAPSHOTS>kogane-vpoint-pay-collector-poc kv=- queue-producers=- queue-consumers=- do=VPOINT_SESSION>VPointSession do-migrations=- do-exports=VPointSession:sqlite containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTOR_SCHEMA_VERSION,VPOINT_PAY_EMAIL_RECIPIENT secrets=ADMIN_TRIGGER_TOKEN,VPOINT_EMAIL_FORWARD_TO,VPOINT_EMAIL_RECIPIENT,VPOINT_MEMBER_NUMBER sha256=781902f46780e89d7125cedf6588e24c6945c90f23fdd45da4845dd423cdfa49",
  "kogane-vpoint-pay-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=- d1=- r2=SNAPSHOTS>kogane-vpoint-pay-collector-poc kv=- queue-producers=- queue-consumers=- do=VPOINT_PAY_STATE>VPointPayCredentialState do-migrations=- do-exports=VPointPayCredentialState:sqlite containers=- browser=- vpc=- services=- assets=- vars=COLLECTOR_SCHEMA_VERSION secrets=ADMIN_TRIGGER_TOKEN,VPOINT_PAY_DEVICE_UUID,VPOINT_PAY_REFRESH_TOKEN sha256=4af3e7bb4f2f9edf70f979edbd0557aab81fca5c41beac511be81ce946e09f76",
];

/**
 * Worker name and Wrangler config file name of every config in the repository
 * before U04, from the same ledger. A directory move may not add, drop or
 * rename a deployable target. Unlike the lines above, this survives the other
 * promotions of chapter 07 §1, which do edit configs: the App's asset
 * directory follows the UI to `apps/web`.
 */
const WORKER_CONFIGS_BEFORE_THE_PROMOTIONS = [
  "kogane-collector-r2-importer wrangler.jsonc",
  "kogane-demo wrangler.demo.jsonc",
  "kogane-evidence-browser wrangler.jsonc",
  "kogane-evidence-browser-test wrangler.test.jsonc",
  "kogane-global-pass-layer-b-audit-local wrangler.audit-global-pass-layer-b.jsonc",
  "kogane-globalpass-collector-poc wrangler.jsonc",
  "kogane-ingest wrangler.jsonc",
  "kogane-mobile-suica-collector-poc wrangler.jsonc",
  "kogane-moneyforward-collector-poc wrangler.jsonc",
  "kogane-moneyforward-layer-b-audit-local wrangler.audit-moneyforward-layer-b.jsonc",
  "kogane-moneyforward-r2-contract-audit-local wrangler.audit-moneyforward.jsonc",
  "kogane-myjcb-collector-poc wrangler.jsonc",
  "kogane-myjcb-r2-layer-b-audit-local wrangler.audit-myjcb.jsonc",
  "kogane-observation-ops-local wrangler.ops.jsonc",
  "kogane-observation-pipeline wrangler.jsonc",
  "kogane-observation-read-diagnostic wrangler.diagnostic.jsonc",
  "kogane-sbi-collector-poc wrangler.jsonc",
  "kogane-sbi-shinsei-collector-poc wrangler.jsonc",
  "kogane-sbi-shinsei-r2-layer-b-audit-local wrangler.audit-sbi-shinsei.jsonc",
  "kogane-sbi-vc-r2-layer-b-audit-local wrangler.audit-sbi-vc.jsonc",
  "kogane-sbi-vc-session-poc wrangler.jsonc",
  "kogane-smbc-direct-backfill-poc wrangler.jsonc",
  "kogane-smbc-direct-r2-contract-audit-local wrangler.audit-smbc-direct.jsonc",
  "kogane-smbc-direct-r2-layer-b-audit-local wrangler.audit-smbc-direct-layer-b.jsonc",
  "kogane-sony-bank-collector-poc wrangler.jsonc",
  "kogane-sony-bank-r2-layer-b-audit-local wrangler.audit-sony-layer-b.jsonc",
  "kogane-tamia-tcp-bridge-20260825 wrangler.bootstrap.jsonc",
  "kogane-tamia-tcp-bridge-20260825 wrangler.jsonc",
  "kogane-vpass-browser-run-20260825 wrangler.bootstrap.jsonc",
  "kogane-vpass-browser-run-20260825 wrangler.jsonc",
  "kogane-vpass-collector-poc wrangler.jsonc",
  "kogane-vpass-identity-backfill-local wrangler.identity-backfill.jsonc",
  "kogane-vpass-r2-layer-b-audit-local wrangler.audit-vpass-layer-b.jsonc",
  "kogane-vpass-runtime-probe-20260825 wrangler.jsonc",
  "kogane-vpoint-collector-poc wrangler.jsonc",
  "kogane-vpoint-pay-collector-poc wrangler.jsonc",
  "kogane-vpoint-pay-email-r2-contract-audit-local wrangler.audit-v-point-pay-email.jsonc",
  "kogane-vpoint-pay-r2-layer-b-audit-local wrangler.audit-v-point-pay-layer-b.jsonc",
  "kogane-vpoint-r2-contract-audit-local wrangler.audit-v-point.jsonc",
];

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
        ...SCANNED_WORKSPACES.map((workspace) => `${workspace}/**/wrangler*`),
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

  test("every scanned directory carries a plan disposition", () => {
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

/**
 * Where chapter 07 §1 puts each promoted collector. The Worker name on the left
 * is the identity Cloudflare knows; the directory on the right is the only
 * thing U04 changed about it.
 */
const PROMOTED_COLLECTOR_DIRECTORIES: readonly (readonly [string, string])[] = [
  ["kogane-globalpass-collector-poc", "services/collector-globalpass"],
  ["kogane-mobile-suica-collector-poc", "services/collector-mobile-suica"],
  ["kogane-moneyforward-collector-poc", "services/collector-moneyforward"],
  ["kogane-myjcb-collector-poc", "services/collector-myjcb"],
  ["kogane-sbi-collector-poc", "services/collector-sbi-securities"],
  ["kogane-sbi-shinsei-collector-poc", "services/collector-sbi-shinsei"],
  ["kogane-sbi-vc-session-poc", "services/collector-sbi-vc-trade"],
  ["kogane-smbc-direct-backfill-poc", "services/collector-smbc-direct"],
  ["kogane-sony-bank-collector-poc", "services/collector-sony-bank"],
  ["kogane-vpass-collector-poc", "services/collector-vpass"],
  ["kogane-vpoint-collector-poc", "services/collector-vpoint"],
  ["kogane-vpoint-pay-collector-poc", "services/collector-vpoint-pay"],
];

describe("G0-06/G0-07/G5-15 a moved directory keeps its resource identities", () => {
  // The promotions of chapter 07 §1 are `git mv` plus repointing, and 11 §4
  // names the failure mode they must not have: a directory move that renames
  // infrastructure. `resourceIdentityLines` drops exactly what a move changes
  // and keeps everything Cloudflare addresses, so the pre-move lines have to
  // survive the move unchanged.
  const identities = resourceIdentityLines(ledger);

  test("the promoted collectors declare the identities they declared in poc/", () => {
    const promoted = new Set(
      COLLECTOR_IDENTITIES_BEFORE_THE_PROMOTIONS.map((line) => line.split(" ")[0] as string),
    );
    expect(identities.filter((line) => promoted.has(line.split(" ")[0] as string))).toEqual(
      COLLECTOR_IDENTITIES_BEFORE_THE_PROMOTIONS,
    );
  });

  test("each promoted collector is deployable from the directory the plan named", () => {
    // G0-12 read forwards: the collectors are still in the repository, still
    // have a config, and are where 07 §1 says they belong.
    const byWorker = new Map(
      ledger.directories.flatMap((entry) =>
        entry.workers.map((worker) => [worker.name, entry.directory] as const),
      ),
    );
    for (const [worker, directory] of PROMOTED_COLLECTOR_DIRECTORIES)
      expect([worker, byWorker.get(worker)]).toEqual([worker, directory]);
  });

  test("no Worker config is added, dropped or renamed by a directory move", () => {
    expect(
      ledger.directories
        .flatMap((entry) =>
          entry.workers.map((worker) => `${worker.name} ${basename(worker.config)}`),
        )
        .sort(),
    ).toEqual(WORKER_CONFIGS_BEFORE_THE_PROMOTIONS);
  });
});
