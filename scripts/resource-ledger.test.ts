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
 *
 * U09 is the one work item that edits a line here, and only in the commit that
 * edits that collector's config: switching a source to the shared DATA bucket
 * adds the `COLLECTION_TARGET` var and the `DATA` binding, which moves `vars`,
 * `r2` and the config digest. Everything Cloudflare addresses on its own — the
 * Worker name, the crons, the Email route, the Durable Object classes and
 * tags, the per-source buckets — still may not move, and a diff that changes
 * any of those is the failure this list exists to catch.
 */
const COLLECTOR_IDENTITIES_BEFORE_THE_PROMOTIONS = [
  "kogane-globalpass-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=17 18 * * * d1=- r2=SNAPSHOTS>kogane-globalpass-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=COLLECTOR_CONTAINER>GlobalPassCollectorContainer do-migrations=v1[sqlite:GlobalPassCollectorContainer] do-exports=- containers=GlobalPassCollectorContainer:./Dockerfile:basic:2 browser=BROWSER vpc=MESH>tunnel:6b0ccf30-68b2-494e-baa8-f4f9f3e46b33,CF_EGRESS>network:cf1:network services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION,RELAY_PUBLIC_URL secrets=- sha256=52d5bb91db10607c56666454e0a314a5f5691ae8de70865b63b018fc3338913f",
  "kogane-mobile-suica-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=10 21 * * * d1=- r2=SNAPSHOTS>kogane-mobile-suica-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=BROWSER vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION secrets=ADMIN_TRIGGER_TOKEN,JRE_ID_CREDENTIAL_JSON sha256=023583bf0368d2e2b9f1288b4ed8da34145828ed6add9d698619c77c3ecbfe0c",
  "kogane-moneyforward-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=15 21 * * * d1=- r2=SNAPSHOTS>kogane-moneyforward-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION secrets=- sha256=429d195b1d9b46150b84a4b5374d5fb2b1eeb7dc0cd6d992874b2c7a07851b98",
  "kogane-myjcb-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-myjcb-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=BROWSER vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION secrets=- sha256=db0981e3f7f6214619be3a1918c298d87079f7643dd0406d1d461f1ea1b86538",
  "kogane-sbi-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-sbi-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION secrets=- sha256=d08d4503fecbeec9db5813c6fc046a375083cf7b28bc5f67a26119d0ba11be12",
  "kogane-sbi-shinsei-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-sbi-shinsei-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=COLLECTOR_CONTAINER>SbiShinseiCollectorContainer do-migrations=v1[sqlite:SbiShinseiCollectorContainer] do-exports=- containers=SbiShinseiCollectorContainer:./Dockerfile:basic:2 browser=- vpc=MESH>tunnel:6b0ccf30-68b2-494e-baa8-f4f9f3e46b33 services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION,RELAY_PUBLIC_URL secrets=- sha256=d65a105282762bbd451ba2d15f22dfa252a82ab0c1a1c5f27ce08404f73d31d9",
  "kogane-sbi-vc-session-poc config=wrangler.jsonc live=true role=deployed email=false crons=*/15 * * * *,5 21 * * * d1=- r2=SNAPSHOTS>kogane-sbi-vc-trade-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=SESSION_STATE>SbiVcSessionState do-migrations=v1[sqlite:SbiVcSessionState] do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION secrets=- sha256=baa0192b85b651861ae781c8ef595f961ba417bc2ee67d2d07cbcd2c4c95ecaf",
  "kogane-smbc-direct-backfill-poc config=wrangler.jsonc live=true role=deployed email=false crons=- d1=- r2=SNAPSHOTS>kogane-smbc-direct-backfill-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=BACKFILL_SESSION>SmbcBackfillSession do-migrations=v1[sqlite:SmbcBackfillSession] do-exports=- containers=- browser=- vpc=TAMIA>tunnel:6b0ccf30-68b2-494e-baa8-f4f9f3e46b33 services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION,DEFAULT_BACKFILL_FROM,SMBC_DIRECT_BASE_URL,SMBC_DIRECT_LOGIN_BASE_URL secrets=- sha256=ea13596b57d97e1bddabbd88f9ae90c6d4b07ef87754ceac1adfe67cf0173379",
  "kogane-sony-bank-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-sony-bank-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION secrets=- sha256=7d0b583daf9a29e8148e9bacb8b32674c1f81c2bedf5bb1914ec45c7a83ccb3b",
  "kogane-vpass-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=0 21 * * * d1=- r2=SNAPSHOTS>kogane-vpass-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=RAW_EVIDENCE_QUEUE>kogane-vpass-raw-evidence-import queue-consumers=kogane-vpass-raw-evidence-import[dlq:kogane-vpass-raw-evidence-import-dlq,batch:1,retries:10,concurrency:-] do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET secrets=- sha256=a421c91728468b813788f7d09d27eef57209cc2a24616368abe5514967aa91d7",
  "kogane-vpoint-collector-poc config=wrangler.jsonc live=true role=deployed email=true crons=15 21 * * * d1=- r2=SNAPSHOTS>kogane-vpoint-collector-poc,VPOINT_PAY_SNAPSHOTS>kogane-vpoint-pay-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=VPOINT_SESSION>VPointSession do-migrations=- do-exports=VPointSession:sqlite containers=- browser=- vpc=- services=RAW_EVIDENCE_IMPORTER>kogane-collector-r2-importer assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION,VPOINT_PAY_EMAIL_RECIPIENT secrets=ADMIN_TRIGGER_TOKEN,VPOINT_EMAIL_FORWARD_TO,VPOINT_EMAIL_RECIPIENT,VPOINT_MEMBER_NUMBER sha256=11e545004cff76729e781ae5de55d04e90db0a59a5e6ec645d6072011f4a6dc1",
  "kogane-vpoint-pay-collector-poc config=wrangler.jsonc live=true role=deployed email=false crons=- d1=- r2=SNAPSHOTS>kogane-vpoint-pay-collector-poc,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=VPOINT_PAY_STATE>VPointPayCredentialState do-migrations=- do-exports=VPointPayCredentialState:sqlite containers=- browser=- vpc=- services=- assets=- vars=COLLECTION_TARGET,COLLECTOR_SCHEMA_VERSION secrets=ADMIN_TRIGGER_TOKEN,VPOINT_PAY_DEVICE_UUID,VPOINT_PAY_REFRESH_TOKEN sha256=6483411d1557fe8ad7f5f8e00fb2edaafae9f904fffbf082c4114017a60d4dea",
];

/**
 * Worker name and Wrangler config file name of every config in the repository
 * before U04, from the same ledger. A directory move may not add, drop or
 * rename a deployable target. Unlike the lines above, this survives the other
 * promotions of chapter 07 §1, which do edit configs: the App's asset
 * directory follows the UI to `apps/web`. `kogane-read-migrations` is listed
 * because U11 added it on main while this move was in review; it is a config
 * this item neither moves nor touches.
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
  "kogane-read-migrations wrangler.read-migrations.jsonc",
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
 *
 * Three lines were refreshed again when the command grant lists became
 * explicit allow-lists: `kogane-evidence-browser`,
 * `kogane-evidence-browser-test` and `kogane-demo` declare the new
 * `OPERATOR_SUBJECTS` var (the demo also declares `AGENT_GRANTS`, to state
 * that it grants nobody), with the digests that follow from it. Only `vars=`
 * and `sha256=` moved on each line, for the same reason as above: the Worker
 * names, the D1 and R2 bindings, the service binding and the asset directories
 * are the pre-move values still.
 *
 * Three lines were refreshed once more for the release postcheck (U14,
 * plan 11 §6): `kogane-evidence-browser` and `kogane-evidence-browser-test`
 * gain `HEALTH_PROBE_TOKENS` and `RELEASE_SHA`, and
 * `kogane-observation-pipeline` gains `RELEASE_SHA`, in `vars=` with the
 * digests that follow. Again only `vars=` and `sha256=` moved: the App's
 * `PIPELINE` service binding is the one it already had — the health route
 * reuses it rather than adding a second binding to the same Worker — and no
 * Worker name, database id, bucket, queue, Durable Object class or cron
 * changed.
 */
const FROZEN_MOVED_IDENTITIES = [
  "kogane-demo config=wrangler.demo.jsonc live=true role=deployed email=false crons=- d1=- r2=- kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=- assets=../../apps/web/dist>ASSETS vars=ACCESS_AUDIENCE,ACCESS_ISSUER,AGENT_GRANTS,BALANCE_PROJECTION_ENABLED,OPERATOR_SUBJECTS,OPS_API_ENABLED,READ_PROJECTION_ENABLED secrets=- sha256=02b83910203f98bb4dcd063c1fab2aa608f99df527033ad0de8899fbfcc8617f",
  "kogane-evidence-browser config=wrangler.jsonc live=true role=deployed email=false crons=- d1=DB>kogane-raw-evidence#b335a887-250d-45c9-bd72-af83f35fdc60,READ>kogane-read#320ebe31-a031-48a1-985f-0e6fabbd517a r2=EVIDENCE>kogane-raw-evidence kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=PIPELINE>kogane-observation-pipeline assets=../../apps/web/dist-production>ASSETS vars=ACCESS_AUDIENCE,ACCESS_ISSUER,AGENT_API_GRANTS,AGENT_GRANTS,BALANCE_PROJECTION_ENABLED,COMMANDS_ENABLED,EVENTS_V2_ENABLED,EVIDENCE_SOURCE_ID,HEALTH_PROBE_TOKENS,OPERATOR_SUBJECTS,OPS_API_ENABLED,READ_PROJECTION_ENABLED,RELEASE_SHA,REWARDS_V2_ENABLED,REWARD_READ_PROJECTION_ENABLED,SESSION_REFRESH_POLICY secrets=- sha256=4519751a972749a7368e340f9dea2822025dc8735fd6ae4d7ae5bf0e5cc966f4",
  "kogane-evidence-browser-test config=wrangler.test.jsonc live=false role=test-only email=false crons=- d1=DB>test#00000000-0000-0000-0000-000000000001,READ>test-read#00000000-0000-0000-0000-000000000002 r2=EVIDENCE>test kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=- assets=test/assets>ASSETS vars=ACCESS_AUDIENCE,ACCESS_ISSUER,AGENT_API_GRANTS,AGENT_GRANTS,BALANCE_PROJECTION_ENABLED,COMMANDS_ENABLED,EVENTS_V2_ENABLED,EVIDENCE_SOURCE_ID,HEALTH_PROBE_TOKENS,OPERATOR_SUBJECTS,OPS_API_ENABLED,READ_PROJECTION_ENABLED,RELEASE_SHA,REWARDS_V2_ENABLED,REWARD_READ_PROJECTION_ENABLED,SESSION_REFRESH_POLICY secrets=- sha256=0ed2d9ce98cdb92776b4c7c2b9363ec5358dfae36931c9ecf66125c23fb3b0f6",
  "kogane-observation-ops-local config=wrangler.ops.jsonc live=false role=binding-only email=false crons=- d1=- r2=- kv=- queue-producers=- queue-consumers=- do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=OBSERVATIONS>kogane-observation-pipeline assets=- vars=- secrets=- sha256=902d4629a87b356b9fbecc55e816a13de9f008add7b5d911b61c0908cbb8cfbf",
  "kogane-observation-pipeline config=wrangler.jsonc live=true role=deployed email=false crons=*/5 * * * * d1=DB>kogane-raw-evidence#b335a887-250d-45c9-bd72-af83f35fdc60@../../packages/storage-d1/migrations/core,READ>kogane-read#320ebe31-a031-48a1-985f-0e6fabbd517a r2=EVIDENCE>kogane-raw-evidence,DATA>kogane-raw-evidence kv=- queue-producers=- queue-consumers=kogane-collection-terminals[dlq:kogane-collection-terminals-dlq,batch:10,retries:5,concurrency:2] do=- do-migrations=- do-exports=- containers=- browser=- vpc=- services=- assets=- vars=BALANCE_PROJECTION_ENABLED,COLLECTION_ACCOUNT_ID,COLLECTION_DATA_BUCKET,COLLECTION_INGEST_CLIENT,OPS_DISPATCH_ENABLED,READ_PROJECTION_ENABLED,RECONCILIATION_ENABLED,RELEASE_CANDIDATES_ENABLED,RELEASE_SHA,REPORTS_ENABLED,REWARD_CLAIMS_ENABLED,REWARD_READ_PROJECTION_ENABLED,SHARED_R2_INGEST_ENABLED secrets=- sha256=07446c6444f1ba5673e999d9ac55cf540df6761b9f2c7b2bd1e6daa3cf428fbc",
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
