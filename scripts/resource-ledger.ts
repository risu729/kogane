// Generator for the runtime resource ledger (`infra/resources.json`,
// `infra/resources.md`), unified plan U01 / chapter 07 §1, §6.
//
// Every runtime resource this repository can deploy is declared in a
// `wrangler*.jsonc` under `apps/`, `experiments/`, `poc/` or `services/`. The
// first two workspaces hold no Worker today; they are walked so that a
// directory promoted out of `poc/` (U04 moved the PoC client and its local
// store) still carries its disposition instead of dropping out of the ledger.
//
// The remaining directory moves of 07 §1 must not change a single one of those
// identities: Worker `name`, Durable Object class name and migration tag, R2
// bucket, Queue, cron, D1 id.
// The ledger is the machine-readable record of what those identities are today
// and `scripts/resource-ledger.test.ts` fails when a config and the ledger
// disagree, so a rename cannot slip through as "just a directory move"
// (acceptance tests G0-06, G0-07, G0-12).
//
// The live column comes from a read of the Cloudflare account on 2026-09-11;
// it is recorded here as data, not fetched, so the check stays offline.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Cloudflare account that every deployed resource below belongs to. */
export const ACCOUNT_ID = "59ea63cc00914b30ca410b062ae2bb7f";

/**
 * Live Cloudflare inventory, read 2026-09-11 from account `risu`.
 *
 * Queues, Durable Object namespaces, Email routes and cron triggers are not
 * listable through the API this was read with, so they are derived from the
 * configs instead and marked `unverified-live` in the ledger.
 */
/**
 * Queues a config declares that do not exist in the account yet. They are
 * created by the first deploy that carries the config, and the feature behind
 * them stays flagged off until they do — so the ledger says "to be created by
 * the first deploy" rather than letting a reader assume the resource is live.
 *
 * A name leaves this list when the queue exists; nothing else about the
 * ledger changes, because a queue's identity never does (G0-06).
 */
export const QUEUES_TO_CREATE: Readonly<Record<string, string>> = {
  // U08: R2 event notifications for `runs/*/terminal.json` on the shared DATA
  // bucket reach the Processor through it. See docs/processor.md.
  "kogane-collection-terminals": "to be created by the first deploy (U08)",
  "kogane-collection-terminals-dlq": "to be created by the first deploy (U08)",
};

export const LIVE_INVENTORY = {
  readAt: "2026-09-11",
  accountId: ACCOUNT_ID,
  /** Worker scripts that exist in the account. */
  workers: [
    "kogane-collector-r2-importer",
    "kogane-demo",
    "kogane-evidence-browser",
    "kogane-globalpass-collector-poc",
    "kogane-globalpass-container-probe-20260827",
    "kogane-ingest",
    "kogane-mobile-suica-collector-poc",
    "kogane-moneyforward-collector-poc",
    "kogane-myjcb-collector-poc",
    "kogane-observation-pipeline",
    "kogane-sbi-collector-poc",
    "kogane-sbi-shinsei-collector-poc",
    "kogane-sbi-vc-session-poc",
    "kogane-smbc-direct-backfill-poc",
    "kogane-sony-bank-collector-poc",
    "kogane-vpass-collector-poc",
    "kogane-vpoint-collector-poc",
    "kogane-vpoint-pay-collector-poc",
  ],
  /** R2 buckets that exist in the account (kogane ones only). */
  buckets: [
    "kogane-globalpass-collector-poc",
    "kogane-mobile-suica-collector-poc",
    "kogane-moneyforward-collector-poc",
    "kogane-myjcb-collector-poc",
    "kogane-raw-evidence",
    "kogane-sbi-collector-poc",
    "kogane-sbi-shinsei-collector-poc",
    "kogane-sbi-vc-trade-poc",
    "kogane-smbc-direct-backfill-poc",
    "kogane-sony-bank-collector-poc",
    "kogane-vpass-collector-poc",
    "kogane-vpoint-collector-poc",
    "kogane-vpoint-pay-collector-poc",
  ],
  /** D1 databases that exist in the account. */
  d1Databases: [
    { name: "kogane-raw-evidence", id: "b335a887-250d-45c9-bd72-af83f35fdc60" },
    // The READ database of U11: created empty on 2026-09-11, region APAC; its
    // migrations are applied by the deploy step, never by hand.
    { name: "kogane-read", id: "320ebe31-a031-48a1-985f-0e6fabbd517a" },
  ],
  /** KV namespaces: none exist. */
  kvNamespaces: [] as string[],
  /**
   * Live Workers with no config in this repository. Nothing here can redeploy
   * them, so deleting one is not reversible by any release of this repository.
   * Disposition (U15): delete manually after the owner confirms — see
   * `docs/legacy-retirement.md` §7 and `infra/protection.md` §1.
   */
  workersWithoutConfig: ["kogane-globalpass-container-probe-20260827"],
} as const;

export interface Disposition {
  /** `poc/…` rows come from the plan's inventories/poc_disposition.csv. */
  source: string;
  proposedAction: string;
  proposedTarget: string;
  requiredVerification: string;
  executionStatus: string;
  /** What the plan recorded before the live account was read. */
  planLiveResourceStatus: string;
}

/**
 * Directory dispositions.
 *
 * `poc/*` rows are transcribed from
 * `inventories/poc_disposition.csv` of the unified plan; `services/*` rows come
 * from chapter 07 §1 together with the resolved layout decisions D1 and D2
 * (raw-evidence stays deployed as the legacy ingest adapter until U15; the
 * importer is absorbed by the Processor in U08 and its Worker keeps running
 * until U15).
 *
 * A directory that has been promoted keeps its row under the new key with
 * `executionStatus: "EXECUTED_U04"`: the plan's proposal and what was actually
 * done stay next to each other, and the key follows the directory because the
 * ledger reads `services/` and `poc/` from disk. A directory promoted out of
 * both — `poc/collector-diagnostics` and `poc/sbi-vc-trade-client`, which went
 * to `packages/` — leaves the map, because nothing under `packages/` declares a
 * runtime resource.
 */
export const DISPOSITIONS: Readonly<Record<string, Disposition>> = {
  "apps/web": {
    source: "poc_disposition.csv row poc/observation-pipeline + decision D1",
    proposedAction: "promoted-from-poc",
    proposedTarget: "apps/web (the React client and its frontend tests)",
    requiredVerification:
      "U04 executed the move; the three bundles are byte-identical and the client imports no service internal",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "experiments/cloudflare-browser-run": {
    source: "poc_disposition.csv (was poc/cloudflare-browser-run)",
    proposedAction: "isolate-or-promote",
    proposedTarget:
      "experiments/cloudflare-browser-run (isolated; promote only on a real consumer)",
    requiredVerification:
      "classified as isolate: no services/, packages/, wrangler config, task or asset outside the directory references it",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "experiments/cloudflare-runtime-probe": {
    source: "poc_disposition.csv (was poc/cloudflare-runtime-probe)",
    proposedAction: "isolate",
    proposedTarget: "experiments/cloudflare-runtime-probe",
    requiredVerification: "purpose and stop condition recorded in EXPERIMENT.md",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "experiments/observation-pipeline-local": {
    source: "poc_disposition.csv row poc/observation-pipeline + decision D1",
    proposedAction: "isolated-as-experiment",
    proposedTarget: "experiments/observation-pipeline-local (EXPERIMENT.md: risu729, 2026-12-31)",
    requiredVerification:
      "U04 executed the move; retire once the App API covers replay and status (docs/research/observation-pipeline-poc.md)",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "experiments/tamia-tcp-bridge": {
    source: "poc_disposition.csv (was poc/tamia-tcp-bridge)",
    proposedAction: "promote-service-if-used",
    proposedTarget:
      "experiments/tamia-tcp-bridge (not used by any collector; promote to services/tamia-tcp-bridge only when one routes through it)",
    requiredVerification:
      "checked: GLOBAL PASS binds the tamia Tunnel directly by tunnel_id and relays through its own /tcp, no config, binding, var, secret or task names kogane-tamia-tcp-bridge-20260825, and that Worker is not in the account inventory",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/app": {
    source: "plan 07 §1 + decision D1",
    proposedAction: "rename-directory",
    proposedTarget: "services/app",
    // Executed: the directory moved from `services/evidence-browser`. All three
    // configs are byte-identical to what they were under the old directory, so
    // the frozen identity lines in `scripts/resource-ledger.test.ts` still match
    // (G0-06, G5-15). The Worker names did not move with the directory.
    requiredVerification: "git mv only; Worker names kogane-evidence-browser and kogane-demo stay",
    executionStatus: "EXECUTED_RENAME",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-globalpass": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-globalpass",
    requiredVerification: "keep Container, relay, browser diagnostics and resource identity",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-mobile-suica": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-mobile-suica",
    requiredVerification: "contract tests, live/secret/resource mapping confirmed",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-moneyforward": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-moneyforward",
    requiredVerification: "collector/importer/CORE mapping and resource identity kept",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-myjcb": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-myjcb",
    requiredVerification: "keep the Browser Run login and fetch boundary",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-r2-importer": {
    source: "plan 07 §1 + decision D2",
    proposedAction: "absorb-into-processor",
    proposedTarget: "services/processor (queue consumer and adapters, U08)",
    requiredVerification:
      "the Worker keeps running until U15; old protocol still readable; no double cron",
    executionStatus: "PLANNED_NOT_EXECUTED",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-sbi-securities": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-sbi-securities",
    requiredVerification: "contract tests and resource identity; secret material is not moved",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-sbi-shinsei": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-sbi-shinsei",
    requiredVerification: "keep the container/relay/credential operation contract",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-sbi-vc-trade": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-sbi-vc-trade",
    requiredVerification: "keep the client dependency and the resource identity",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-smbc-direct": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-smbc-direct",
    requiredVerification:
      "keep the human-required boundary; never turn it into unattended re-authentication",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-sony-bank": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-sony-bank",
    requiredVerification: "keep the sanitize/HTML/CSV contract and the resource identity",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-vpass": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-vpass",
    requiredVerification: "keep the Worker name and the R2/cron/auth contract",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-vpoint": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-vpoint",
    requiredVerification: "keep the Email route and the DO class/tag/storage",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/collector-vpoint-pay": {
    source: "poc_disposition.csv",
    proposedAction: "promote-service",
    proposedTarget: "services/collector-vpoint-pay",
    requiredVerification: "confirm the Email/collection entry point and the resource identity",
    executionStatus: "EXECUTED_U04",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/processor": {
    source: "plan 07 §1 + decision D1",
    proposedAction: "rename-directory",
    proposedTarget: "services/processor",
    // Executed: the directory moved from `services/observation-pipeline`. The
    // deployed config is byte-identical, cron, queue consumer and D1 ids
    // included; only the comment in `wrangler.read-migrations.jsonc` that
    // quotes its own path changed (G0-06, G0-07, G5-15).
    requiredVerification: "git mv only; Worker name kogane-observation-pipeline and cron stay",
    executionStatus: "EXECUTED_RENAME",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
  "services/raw-evidence": {
    source: "plan 07 §1 + decision D2/D3",
    proposedAction: "keep-as-legacy-adapter",
    proposedTarget: "packages/storage-d1 + packages/application (U05); migrations move in U05",
    requiredVerification:
      "kogane-ingest stays deployed until U15; migration filenames and bytes unchanged",
    executionStatus: "PLANNED_NOT_EXECUTED",
    planLiveResourceStatus: "NOT_VERIFIED",
  },
};

export interface CompletedDisposition {
  /** Directory the plan named, as it was before the move. */
  source: string;
  proposedAction: string;
  /** Where the content is now: a directory, a document, or both. */
  result: string;
  /** Commit that last carried the code, so `git show <commit>:<source>` works. */
  lastCommit: string;
  /** What the live-resource check found before the row was executed. */
  liveResourceCheck: string;
}

/**
 * Plan rows whose directory has left `DISPOSITIONS` entirely.
 *
 * `DISPOSITIONS` is asserted to describe exactly the directories that exist
 * under the scanned workspaces, so a row has to leave it the moment its
 * directory is retired or promoted into `packages/`. Each entry here records
 * the live-resource check that allowed the row to be executed, because no
 * directory may be retired for the sole reason that nothing imports it
 * (acceptance test G0-12).
 */
export const COMPLETED_DISPOSITIONS: readonly CompletedDisposition[] = [
  {
    source: "poc/camoufox-container-probe",
    proposedAction: "retire-candidate",
    result: "docs/research/camoufox.md (code removed)",
    lastCommit: "5fb143e0f77a492ae9cfdbe0266fe77774b8bd30",
    liveResourceCheck:
      "no wrangler config, no Worker, no bucket, no cron, no container application; local image deleted 2026-08-26",
  },
  {
    source: "poc/collector-diagnostics",
    proposedAction: "promote-shared",
    result:
      "packages/collector-diagnostics (7 collector Workers; exports createDiagnostics, safeErrorDetails)",
    lastCommit: "5fb143e0f77a492ae9cfdbe0266fe77774b8bd30",
    liveResourceCheck:
      "no wrangler config of its own; it is a library every collector Worker on the account links into its bundle, so it is promoted rather than retired",
  },
  {
    source: "poc/kameleo-container-probe",
    proposedAction: "retire-candidate",
    result: "docs/research/kameleo.md (code removed)",
    lastCommit: "5fb143e0f77a492ae9cfdbe0266fe77774b8bd30",
    liveResourceCheck:
      "no wrangler config, no Worker, no bucket, no cron; local container, volume and image deleted 2026-08-26",
  },
  {
    source: "poc/oci-browser-probe",
    proposedAction: "isolate-or-retire",
    result:
      "docs/research/oci-browser.md (code removed; conclusions in docs/authenticated-collectors.md)",
    lastCommit: "5fb143e0f77a492ae9cfdbe0266fe77774b8bd30",
    liveResourceCheck:
      "retire branch: no wrangler config, no Worker and no OCI relay — the only collector relay is the pre-existing tamia Tunnel (GLOBAL PASS, exit JP/KIX ASN 18144); the probe's own install on host bots was purged and verified on 2026-08-26",
  },
  {
    source: "poc/sbi-securities",
    proposedAction: "classify-before-delete",
    result:
      "docs/research/sbi-securities.md (code removed; no operational CLI added to the collector)",
    lastCommit: "5fb143e0f77a492ae9cfdbe0266fe77774b8bd30",
    liveResourceCheck:
      "no wrangler config, Worker, bucket or cron; a local overlay on an external checkout, superseded by services/collector-sbi-securities (kogane-sbi-collector-poc), which reimplements the same read-only paths without mnie",
  },
  {
    source: "poc/sbi-vc-trade-client",
    proposedAction: "promote-shared-if-used",
    result: "packages/sbi-vc-trade-client",
    lastCommit: "5fb143e0f77a492ae9cfdbe0266fe77774b8bd30",
    liveResourceCheck:
      "no wrangler config of its own; services/collector-sbi-vc-trade links it into the bundle of kogane-sbi-vc-session-poc, so it is promoted rather than retired",
  },
];

/** Config keys that carry no runtime resource identity. */
const COSMETIC_KEYS = new Set([
  "$schema",
  "account_id",
  "compatibility_date",
  "compatibility_flags",
  "limits",
  "main",
  "name",
  "observability",
  "placement",
  "preview_urls",
  "upload_source_maps",
  "workers_dev",
]);

/** Config keys this generator extracts into a dedicated ledger field. */
const EXTRACTED_KEYS = new Set([
  "assets",
  "browser",
  "containers",
  "d1_databases",
  "durable_objects",
  "exports",
  "kv_namespaces",
  "migrations",
  "queues",
  "r2_buckets",
  "secrets",
  "services",
  "triggers",
  "vars",
  "vpc_networks",
]);

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function array(value: unknown): Json[] {
  return Array.isArray(value) ? value.map((entry) => object(entry)) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function names(value: unknown): string[] {
  return Object.keys(object(value)).sort();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

export interface WorkerResources {
  config: string;
  name: string;
  main?: string;
  /** How the config is used: deployed, local audit, test-only, binding-only. */
  role: "deployed" | "local-audit" | "test-only" | "binding-only" | "not-deployed";
  liveWorker: boolean;
  crons: string[];
  emailHandler: boolean;
  d1: {
    binding: string;
    databaseName: string;
    databaseId: string;
    migrationsDir?: string;
    live: boolean;
  }[];
  r2: { binding: string; bucket: string; live: boolean }[];
  kv: { binding: string; id?: string }[];
  queueProducers: { binding: string; queue: string }[];
  queueConsumers: {
    queue: string;
    deadLetterQueue?: string;
    maxBatchSize?: number;
    maxRetries?: number;
    maxConcurrency?: number;
  }[];
  durableObjects: { name: string; className: string; scriptName?: string }[];
  durableObjectExports: { className: string; storage?: string }[];
  durableObjectMigrations: { tag: string; newSqliteClasses: string[]; newClasses: string[] }[];
  containers: { className: string; image?: string; instanceType?: string; maxInstances?: number }[];
  browserBinding?: string;
  vpcNetworks: { binding: string; tunnelId?: string; networkId?: string }[];
  serviceBindings: { binding: string; service: string }[];
  assets?: { directory: string; binding?: string };
  varNames: string[];
  requiredSecretNames: string[];
  /** Resource-bearing keys this generator does not extract yet; must stay empty. */
  unextractedKeys: string[];
}

function workerRole(
  name: string,
  main: string | undefined,
  live: boolean,
): WorkerResources["role"] {
  if (live) return "deployed";
  if (main === undefined) return "binding-only";
  if (name.endsWith("-test")) return "test-only";
  if (name.endsWith("-local")) return "local-audit";
  return "not-deployed";
}

function readWorker(root: string, configPath: string): WorkerResources {
  const absolute = join(root, configPath);
  const config = object(parseJsonc(readFileSync(absolute, "utf8"), configPath));
  const name = text(config["name"]) ?? "";
  if (name === "") throw new Error(`Wrangler config without a name: ${configPath}`);
  const main = text(config["main"]);
  const live = (LIVE_INVENTORY.workers as readonly string[]).includes(name);
  const liveBuckets = LIVE_INVENTORY.buckets as readonly string[];
  const liveD1 = LIVE_INVENTORY.d1Databases.map((entry) => entry.id);
  const mainPath = main === undefined ? undefined : join(dirname(absolute), main);
  const emailHandler =
    mainPath !== undefined &&
    existsSync(mainPath) &&
    /\basync email\s*\(/u.test(readFileSync(mainPath, "utf8"));
  const queues = object(config["queues"]);
  return {
    config: configPath,
    name,
    ...(main === undefined ? {} : { main }),
    role: workerRole(name, main, live),
    liveWorker: live,
    crons: strings(object(config["triggers"])["crons"]),
    emailHandler,
    d1: array(config["d1_databases"]).map((entry) => {
      const migrationsDir = text(entry["migrations_dir"]);
      const databaseId = text(entry["database_id"]) ?? "";
      return {
        binding: text(entry["binding"]) ?? "",
        databaseName: text(entry["database_name"]) ?? "",
        databaseId,
        ...(migrationsDir === undefined ? {} : { migrationsDir }),
        live: liveD1.includes(databaseId),
      };
    }),
    r2: array(config["r2_buckets"]).map((entry) => {
      const bucket = text(entry["bucket_name"]) ?? "";
      return {
        binding: text(entry["binding"]) ?? "",
        bucket,
        live: liveBuckets.includes(bucket),
      };
    }),
    kv: array(config["kv_namespaces"]).map((entry) => {
      const id = text(entry["id"]);
      return { binding: text(entry["binding"]) ?? "", ...(id === undefined ? {} : { id }) };
    }),
    queueProducers: array(queues["producers"]).map((entry) => ({
      binding: text(entry["binding"]) ?? "",
      queue: text(entry["queue"]) ?? "",
    })),
    queueConsumers: array(queues["consumers"]).map((entry) => {
      const deadLetterQueue = text(entry["dead_letter_queue"]);
      const numeric = (key: string): number | undefined =>
        typeof entry[key] === "number" ? (entry[key] as number) : undefined;
      const maxBatchSize = numeric("max_batch_size");
      const maxRetries = numeric("max_retries");
      const maxConcurrency = numeric("max_concurrency");
      return {
        queue: text(entry["queue"]) ?? "",
        ...(deadLetterQueue === undefined ? {} : { deadLetterQueue }),
        ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
        ...(maxRetries === undefined ? {} : { maxRetries }),
        ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      };
    }),
    durableObjects: array(object(config["durable_objects"])["bindings"]).map((entry) => {
      const scriptName = text(entry["script_name"]);
      return {
        name: text(entry["name"]) ?? "",
        className: text(entry["class_name"]) ?? "",
        ...(scriptName === undefined ? {} : { scriptName }),
      };
    }),
    durableObjectExports: Object.entries(object(config["exports"]))
      .filter(([, value]) => text(object(value)["type"]) === "durable-object")
      .map(([className, value]) => {
        const storage = text(object(value)["storage"]);
        return { className, ...(storage === undefined ? {} : { storage }) };
      })
      .sort((a, b) => a.className.localeCompare(b.className)),
    durableObjectMigrations: array(config["migrations"]).map((entry) => ({
      tag: text(entry["tag"]) ?? "",
      newSqliteClasses: strings(entry["new_sqlite_classes"]),
      newClasses: strings(entry["new_classes"]),
    })),
    containers: array(config["containers"]).map((entry) => {
      const image = text(entry["image"]);
      const instanceType = text(entry["instance_type"]);
      const maxInstances =
        typeof entry["max_instances"] === "number" ? (entry["max_instances"] as number) : undefined;
      return {
        className: text(entry["class_name"]) ?? "",
        ...(image === undefined ? {} : { image }),
        ...(instanceType === undefined ? {} : { instanceType }),
        ...(maxInstances === undefined ? {} : { maxInstances }),
      };
    }),
    ...(text(object(config["browser"])["binding"]) === undefined
      ? {}
      : { browserBinding: text(object(config["browser"])["binding"]) as string }),
    vpcNetworks: array(config["vpc_networks"]).map((entry) => {
      const tunnelId = text(entry["tunnel_id"]);
      const networkId = text(entry["network_id"]);
      return {
        binding: text(entry["binding"]) ?? "",
        ...(tunnelId === undefined ? {} : { tunnelId }),
        ...(networkId === undefined ? {} : { networkId }),
      };
    }),
    serviceBindings: array(config["services"]).map((entry) => ({
      binding: text(entry["binding"]) ?? "",
      service: text(entry["service"]) ?? "",
    })),
    ...(text(object(config["assets"])["directory"]) === undefined
      ? {}
      : {
          assets: {
            directory: text(object(config["assets"])["directory"]) as string,
            ...(text(object(config["assets"])["binding"]) === undefined
              ? {}
              : { binding: text(object(config["assets"])["binding"]) as string }),
          },
        }),
    varNames: names(config["vars"]),
    requiredSecretNames: strings(object(config["secrets"])["required"]).toSorted((a, b) =>
      a.localeCompare(b),
    ),
    unextractedKeys: Object.keys(config)
      .filter((key) => !COSMETIC_KEYS.has(key) && !EXTRACTED_KEYS.has(key))
      .sort(),
  };
}

/** Workspaces the ledger walks. `apps` and `experiments` joined it in U04. */
export const WORKSPACES = ["apps", "experiments", "services"] as const;

export type Workspace = (typeof WORKSPACES)[number];

export interface DirectoryEntry {
  directory: string;
  workspace: Workspace;
  disposition: (Disposition & { liveResourceStatus: string }) | null;
  workers: WorkerResources[];
}

export interface ResourceLedger {
  generatedBy: string;
  plan: string;
  liveInventory: typeof LIVE_INVENTORY;
  completedDispositions: readonly CompletedDisposition[];
  directories: DirectoryEntry[];
  summary: {
    configCount: number;
    deployedWorkerCount: number;
    crons: { worker: string; cron: string; live: boolean }[];
    queues: {
      queue: string;
      producers: string[];
      consumers: string[];
      deadLetterQueues: string[];
      /** Empty when the queue exists; otherwise why it does not yet. */
      toCreate: string;
    }[];
    durableObjectClasses: { worker: string; className: string; tag: string; storage: string }[];
    r2Buckets: { bucket: string; live: boolean; readers: string[] }[];
    d1Databases: { databaseName: string; databaseId: string; live: boolean; bindings: string[] }[];
    emailWorkers: string[];
    liveWorkersWithoutConfig: string[];
    liveBucketsWithoutConfig: string[];
  };
}

function directoriesOf(root: string, workspace: Workspace): string[] {
  const base = join(root, workspace);
  return readdirSync(base)
    .filter((entry) => statSync(join(base, entry)).isDirectory())
    .map((entry) => `${workspace}/${entry}`)
    .sort();
}

function configsOf(root: string, directory: string): string[] {
  const base = join(root, directory);
  const found = readdirSync(base).filter((entry) =>
    /^wrangler.*\.(?:jsonc|json|toml)$/u.test(entry),
  );
  for (const entry of found) {
    if (entry.endsWith(".toml"))
      throw new Error(
        `${directory}/${entry}: the resource ledger reads JSONC wrangler configs only; add a TOML reader before committing one`,
      );
  }
  return found.map((entry) => `${directory}/${entry}`).sort();
}

function liveResourceStatus(workers: WorkerResources[]): string {
  const live = workers.filter((worker) => worker.liveWorker).map((worker) => worker.name);
  const buckets = [
    ...new Set(
      workers.flatMap((worker) =>
        worker.r2.filter((entry) => entry.live).map((entry) => entry.bucket),
      ),
    ),
  ].sort();
  if (live.length === 0 && buckets.length === 0) return "NO_LIVE_RESOURCE";
  const parts: string[] = [];
  if (live.length > 0) parts.push(`workers=${live.sort().join(",")}`);
  if (buckets.length > 0) parts.push(`buckets=${buckets.join(",")}`);
  return `LIVE(${parts.join("; ")})`;
}

export function buildResourceLedger(root: string): ResourceLedger {
  const directories: DirectoryEntry[] = [];
  for (const workspace of WORKSPACES) {
    for (const directory of directoriesOf(root, workspace)) {
      const workers = configsOf(root, directory).map((config) => readWorker(root, config));
      const disposition = DISPOSITIONS[directory];
      directories.push({
        directory,
        workspace,
        disposition:
          disposition === undefined
            ? null
            : { ...disposition, liveResourceStatus: liveResourceStatus(workers) },
        workers,
      });
    }
  }
  const workers = directories.flatMap((entry) => entry.workers);
  const queueNames = [
    ...new Set(
      workers.flatMap((worker) => [
        ...worker.queueProducers.map((entry) => entry.queue),
        ...worker.queueConsumers.map((entry) => entry.queue),
      ]),
    ),
  ].sort();
  const bucketNames = [
    ...new Set(workers.flatMap((worker) => worker.r2.map((entry) => entry.bucket))),
  ].sort();
  const d1Ids = [
    ...new Set(workers.flatMap((worker) => worker.d1.map((entry) => entry.databaseId))),
  ].sort();
  return {
    generatedBy: "scripts/resource-ledger.ts",
    plan: "unified plan U01; chapters 07 §1 and §6; acceptance tests G0-06, G0-07, G0-12",
    liveInventory: LIVE_INVENTORY,
    completedDispositions: COMPLETED_DISPOSITIONS,
    directories,
    summary: {
      configCount: workers.length,
      deployedWorkerCount: new Set(workers.filter((w) => w.liveWorker).map((w) => w.name)).size,
      crons: workers
        .flatMap((worker) =>
          worker.crons.map((cron) => ({ worker: worker.name, cron, live: worker.liveWorker })),
        )
        .sort((a, b) => a.worker.localeCompare(b.worker) || a.cron.localeCompare(b.cron)),
      queues: queueNames.map((queue) => ({
        queue,
        producers: workers
          .filter((worker) => worker.queueProducers.some((entry) => entry.queue === queue))
          .map((worker) => worker.name)
          .sort(),
        consumers: workers
          .filter((worker) => worker.queueConsumers.some((entry) => entry.queue === queue))
          .map((worker) => worker.name)
          .sort(),
        deadLetterQueues: [
          ...new Set(
            workers.flatMap((worker) =>
              worker.queueConsumers
                .filter((entry) => entry.queue === queue && entry.deadLetterQueue !== undefined)
                .map((entry) => entry.deadLetterQueue as string),
            ),
          ),
        ].sort(),
        toCreate: QUEUES_TO_CREATE[queue] ?? "",
      })),
      durableObjectClasses: workers
        .flatMap((worker) =>
          worker.durableObjects.map((binding) => ({
            worker: worker.name,
            className: binding.className,
            tag:
              worker.durableObjectMigrations.find((migration) =>
                [...migration.newSqliteClasses, ...migration.newClasses].includes(
                  binding.className,
                ),
              )?.tag ?? "(declared via exports)",
            storage:
              worker.durableObjectExports.find((entry) => entry.className === binding.className)
                ?.storage ??
              (worker.durableObjectMigrations.some((migration) =>
                migration.newSqliteClasses.includes(binding.className),
              )
                ? "sqlite"
                : "unknown"),
          })),
        )
        .sort((a, b) => a.worker.localeCompare(b.worker) || a.className.localeCompare(b.className)),
      r2Buckets: bucketNames.map((bucket) => ({
        bucket,
        live: (LIVE_INVENTORY.buckets as readonly string[]).includes(bucket),
        readers: workers
          .filter((worker) => worker.r2.some((entry) => entry.bucket === bucket))
          .map((worker) => worker.name)
          .sort(),
      })),
      d1Databases: d1Ids.map((databaseId) => {
        const entries = workers.flatMap((worker) =>
          worker.d1.filter((entry) => entry.databaseId === databaseId),
        );
        return {
          databaseName: entries[0]?.databaseName ?? "",
          databaseId,
          live: LIVE_INVENTORY.d1Databases.some((entry) => entry.id === databaseId),
          bindings: workers
            .filter((worker) => worker.d1.some((entry) => entry.databaseId === databaseId))
            .map((worker) => worker.name)
            .sort(),
        };
      }),
      emailWorkers: workers
        .filter((worker) => worker.emailHandler)
        .map((worker) => worker.name)
        .sort(),
      liveWorkersWithoutConfig: (LIVE_INVENTORY.workers as readonly string[])
        .filter((name) => !workers.some((worker) => worker.name === name))
        .toSorted((a, b) => a.localeCompare(b)),
      liveBucketsWithoutConfig: (LIVE_INVENTORY.buckets as readonly string[])
        .filter((bucket) => !bucketNames.includes(bucket))
        .toSorted((a, b) => a.localeCompare(b)),
    },
  };
}

function cell(value: string | undefined): string {
  return value === undefined || value === "" ? "—" : value.replaceAll("|", "\\|");
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.join("<br>");
}

export function renderResourceMarkdown(ledger: ResourceLedger): string {
  const lines: string[] = [];
  lines.push("# Runtime resource ledger");
  lines.push("");
  lines.push(
    "Generated from the `wrangler*.jsonc` files under `apps/`, `experiments/`, `poc/` and `services/` by",
    "`scripts/resource-ledger.ts`. Do not edit by hand: `scripts/resource-ledger.test.ts`",
    "regenerates it and fails when this file and the configs disagree.",
  );
  lines.push("");
  lines.push(
    `Live column: Cloudflare account \`${ledger.liveInventory.accountId}\`, read ${ledger.liveInventory.readAt}.`,
    "Queues, Durable Object namespaces, cron triggers and Email routes are not listable through that",
    "API, so they are derived from the configs and are **unverified against the live account**.",
  );
  lines.push("");
  lines.push(
    "Unified plan U01. The directory moves of chapter 07 §1 must not change any identity in this",
    "file: Worker `name`, Durable Object class name and migration tag, R2 bucket name, Queue name,",
    "cron expression, Email route or D1 id (acceptance tests G0-06, G0-07, G0-12).",
  );
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Wrangler configs: ${ledger.summary.configCount}`);
  lines.push(`- Distinct Workers that exist in the account: ${ledger.summary.deployedWorkerCount}`);
  lines.push(
    `- Live Workers with no config in this repository: ${list(ledger.summary.liveWorkersWithoutConfig)}`,
  );
  lines.push(
    `- Live R2 buckets no config references: ${list(ledger.summary.liveBucketsWithoutConfig)}`,
  );
  lines.push(
    `- Workers with an \`email()\` handler (Email routes are configured outside this repository): ${list(ledger.summary.emailWorkers)}`,
  );
  lines.push("");

  lines.push("## D1 databases");
  lines.push("");
  lines.push("| database | id | live | bound by |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of ledger.summary.d1Databases)
    lines.push(
      `| ${cell(entry.databaseName)} | \`${entry.databaseId}\` | ${entry.live ? "yes" : "no"} | ${list(entry.bindings)} |`,
    );
  lines.push("");

  lines.push("## R2 buckets");
  lines.push("");
  lines.push("| bucket | live | bound by |");
  lines.push("| --- | --- | --- |");
  for (const entry of ledger.summary.r2Buckets)
    lines.push(`| ${cell(entry.bucket)} | ${entry.live ? "yes" : "no"} | ${list(entry.readers)} |`);
  lines.push("");

  lines.push("## Queues");
  lines.push("");
  lines.push("| queue | producers | consumers | dead letter | exists |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const entry of ledger.summary.queues)
    lines.push(
      `| ${cell(entry.queue)} | ${list(entry.producers)} | ${list(entry.consumers)} | ${list(entry.deadLetterQueues)} | ${
        entry.toCreate === "" ? "declared (unverified)" : cell(entry.toCreate)
      } |`,
    );
  lines.push("");

  lines.push("## Durable Object classes and migration tags");
  lines.push("");
  lines.push("| worker | class | migration tag | storage |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of ledger.summary.durableObjectClasses)
    lines.push(
      `| ${cell(entry.worker)} | ${cell(entry.className)} | ${cell(entry.tag)} | ${cell(entry.storage)} |`,
    );
  lines.push("");

  lines.push("## Cron triggers");
  lines.push("");
  lines.push("| worker | cron (UTC) | deployed |");
  lines.push("| --- | --- | --- |");
  for (const entry of ledger.summary.crons)
    lines.push(`| ${cell(entry.worker)} | \`${entry.cron}\` | ${entry.live ? "yes" : "no"} |`);
  lines.push("");

  lines.push("## Executed plan rows that left the table");
  lines.push("");
  lines.push(
    "Directories the plan's dispositions retired, or promoted into `packages/`, where no runtime",
    "resource is declared. They are listed here because they are no longer in the table below; the",
    "commit column is what `git show` needs to read removed code back (acceptance test G0-12: none",
    "of these was retired merely because nothing imported it). A directory promoted *within* the",
    "scanned workspaces keeps its row below with `EXECUTED_U04`.",
  );
  lines.push("");
  lines.push("| was | action | result | last commit | live-resource check |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const entry of ledger.completedDispositions)
    lines.push(
      `| \`${entry.source}\` | \`${entry.proposedAction}\` | ${cell(entry.result)} | \`${entry.lastCommit.slice(0, 12)}\` | ${cell(entry.liveResourceCheck)} |`,
    );
  lines.push("");

  lines.push("## Directories");
  lines.push("");
  for (const directory of ledger.directories) {
    lines.push(`### \`${directory.directory}\``);
    lines.push("");
    if (directory.disposition === null) lines.push("Disposition: not listed in the plan.");
    else {
      lines.push(
        `- Disposition (${directory.disposition.source}): \`${directory.disposition.proposedAction}\` → ${directory.disposition.proposedTarget}`,
      );
      lines.push(`- Required verification: ${directory.disposition.requiredVerification}`);
      lines.push(
        `- Execution status: ${directory.disposition.executionStatus} (plan recorded \`${directory.disposition.planLiveResourceStatus}\`)`,
      );
      lines.push(`- Live resources: ${directory.disposition.liveResourceStatus}`);
    }
    lines.push("");
    if (directory.workers.length === 0) {
      lines.push("No wrangler config.");
      lines.push("");
      continue;
    }
    for (const worker of directory.workers) {
      lines.push(`#### \`${worker.name}\` — \`${worker.config}\``);
      lines.push("");
      lines.push(
        `- Role: ${worker.role}; exists in the account: ${worker.liveWorker ? "yes" : "no"}`,
      );
      lines.push(
        `- Entry point: ${cell(worker.main)}${worker.emailHandler ? "; has an `email()` handler" : ""}`,
      );
      lines.push(
        `- D1: ${list(worker.d1.map((entry) => `${entry.binding} → ${entry.databaseName} \`${entry.databaseId}\`${entry.migrationsDir === undefined ? "" : ` (migrations_dir \`${entry.migrationsDir}\`)`}${entry.live ? "" : " (not live)"}`))}`,
      );
      lines.push(
        `- R2: ${list(worker.r2.map((entry) => `${entry.binding} → ${entry.bucket}${entry.live ? "" : " (not live)"}`))}`,
      );
      lines.push(`- KV: ${list(worker.kv.map((entry) => `${entry.binding} → ${cell(entry.id)}`))}`);
      lines.push(
        `- Queues: ${list([
          ...worker.queueProducers.map((entry) => `produce ${entry.binding} → ${entry.queue}`),
          ...worker.queueConsumers.map(
            (entry) =>
              `consume ${entry.queue}${entry.deadLetterQueue === undefined ? "" : ` (dlq ${entry.deadLetterQueue})`}`,
          ),
        ])}`,
      );
      lines.push(
        `- Durable Objects: ${list(worker.durableObjects.map((entry) => `${entry.name} → ${entry.className}`))}`,
      );
      lines.push(
        `- DO migration tags: ${list(worker.durableObjectMigrations.map((entry) => `${entry.tag}: ${[...entry.newSqliteClasses, ...entry.newClasses].join(", ")}`))}`,
      );
      lines.push(
        `- Containers: ${list(worker.containers.map((entry) => `${entry.className} (${cell(entry.image)}, ${cell(entry.instanceType)}, max ${entry.maxInstances ?? "?"})`))}`,
      );
      lines.push(`- Browser binding: ${cell(worker.browserBinding)}`);
      lines.push(
        `- VPC networks: ${list(worker.vpcNetworks.map((entry) => `${entry.binding} → ${cell(entry.tunnelId ?? entry.networkId)}`))}`,
      );
      lines.push(
        `- Service bindings: ${list(worker.serviceBindings.map((entry) => `${entry.binding} → ${entry.service}`))}`,
      );
      lines.push(`- Crons: ${list(worker.crons.map((cron) => `\`${cron}\``))}`);
      lines.push(
        `- Assets: ${worker.assets === undefined ? "—" : `\`${worker.assets.directory}\` → ${cell(worker.assets.binding)}`}`,
      );
      lines.push(`- Vars (names only): ${list(worker.varNames)}`);
      lines.push(`- Required secrets (names only): ${list(worker.requiredSecretNames)}`);
      if (worker.unextractedKeys.length > 0)
        lines.push(`- **Unextracted config keys**: ${list(worker.unextractedKeys)}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * One canonical line per Wrangler config naming every runtime identity it
 * declares, plus the SHA-256 of the config file's bytes.
 *
 * A directory move changes the ledger's `directory` and `config` keys by
 * design, so the ledger itself cannot answer "did this move rename a
 * resource?". These lines deliberately drop the directory and keep only what
 * Cloudflare addresses — Worker name, cron, Queue, R2 bucket, D1 id, Durable
 * Object class and migration tag, container class, browser/VPC/service
 * bindings, var and secret *names* — so the set of lines is invariant under a
 * directory rename. The digest closes the gap the name-only fields leave
 * (`vars` values, DO migration ordering, anything a future key adds): a move
 * that edits a config at all shows up here.
 *
 * `scripts/resource-ledger.test.ts` compares them two ways: the promoted
 * collectors against the frozen set captured before the U04 promotions, and
 * the configs that moved in the services rename against the bytes they had
 * before that move (acceptance G0-06, G0-07, G5-15).
 */
export function resourceIdentityLines(ledger: ResourceLedger, root = REPO_ROOT): string[] {
  const list = (entries: readonly string[]): string =>
    entries.length === 0 ? "-" : entries.join(",");
  return ledger.directories
    .flatMap((entry) => entry.workers)
    .map((worker) => {
      const digest = createHash("sha256")
        .update(readFileSync(join(root, worker.config)))
        .digest("hex");
      const migrations = worker.durableObjectMigrations.map(
        (migration) =>
          `${migration.tag}[${list([
            ...migration.newSqliteClasses.map((className) => `sqlite:${className}`),
            ...migration.newClasses.map((className) => `classic:${className}`),
          ])}]`,
      );
      return [
        worker.name,
        `config=${basename(worker.config)}`,
        `live=${String(worker.liveWorker)}`,
        `role=${worker.role}`,
        `email=${String(worker.emailHandler)}`,
        `crons=${list(worker.crons)}`,
        `d1=${list(
          worker.d1.map(
            (item) =>
              `${item.binding}>${item.databaseName}#${item.databaseId}${
                item.migrationsDir === undefined ? "" : `@${item.migrationsDir}`
              }`,
          ),
        )}`,
        `r2=${list(worker.r2.map((item) => `${item.binding}>${item.bucket}`))}`,
        `kv=${list(worker.kv.map((item) => `${item.binding}#${item.id ?? "-"}`))}`,
        `queue-producers=${list(
          worker.queueProducers.map((item) => `${item.binding}>${item.queue}`),
        )}`,
        `queue-consumers=${list(
          worker.queueConsumers.map(
            (item) =>
              `${item.queue}[dlq:${item.deadLetterQueue ?? "-"},batch:${item.maxBatchSize ?? "-"},retries:${item.maxRetries ?? "-"},concurrency:${item.maxConcurrency ?? "-"}]`,
          ),
        )}`,
        `do=${list(
          worker.durableObjects.map(
            (item) =>
              `${item.name}>${item.className}${item.scriptName === undefined ? "" : `@${item.scriptName}`}`,
          ),
        )}`,
        `do-migrations=${list(migrations)}`,
        `do-exports=${list(
          worker.durableObjectExports.map((item) => `${item.className}:${item.storage ?? "-"}`),
        )}`,
        `containers=${list(
          worker.containers.map(
            (item) =>
              `${item.className}:${item.image ?? "-"}:${item.instanceType ?? "-"}:${item.maxInstances ?? "-"}`,
          ),
        )}`,
        `browser=${worker.browserBinding ?? "-"}`,
        `vpc=${list(
          worker.vpcNetworks.map(
            (item) =>
              `${item.binding}>${item.tunnelId === undefined ? `network:${item.networkId ?? "-"}` : `tunnel:${item.tunnelId}`}`,
          ),
        )}`,
        `services=${list(worker.serviceBindings.map((item) => `${item.binding}>${item.service}`))}`,
        `assets=${worker.assets === undefined ? "-" : `${worker.assets.directory}>${worker.assets.binding ?? "-"}`}`,
        `vars=${list(worker.varNames)}`,
        `secrets=${list(worker.requiredSecretNames)}`,
        `sha256=${digest}`,
      ].join(" ");
    })
    .sort();
}

export const LEDGER_JSON_PATH = "infra/resources.json";
export const LEDGER_MARKDOWN_PATH = "infra/resources.md";

export async function main(root = REPO_ROOT): Promise<void> {
  const ledger = buildResourceLedger(root);
  await Bun.write(join(root, LEDGER_JSON_PATH), `${JSON.stringify(ledger, null, 2)}\n`);
  await Bun.write(join(root, LEDGER_MARKDOWN_PATH), renderResourceMarkdown(ledger));
  console.log(
    `wrote ${LEDGER_JSON_PATH} and ${LEDGER_MARKDOWN_PATH} (${ledger.summary.configCount} configs)`,
  );
}

if (import.meta.main) await main();
