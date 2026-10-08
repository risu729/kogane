import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { parseJsonc } from "../../scripts/jsonc.ts";
import { bindings, defineConfig, triggers } from "cf/config";

const legacyConfig = parseJsonc(
  readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
  "wrangler.jsonc",
) as { vars: { RELEASE_SHA: string } };

// Code-only deployment reuses the provisioned legacy Durable Object namespace.
// Lifecycle migrations stay in wrangler.jsonc and are not applied by this config.
export default defineConfig({
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-observation-pipeline",
    compatibilityDate: "2026-09-07",
    compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"],
    entrypoint: "src/schedule-entrypoint.ts",
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, headSamplingRate: 1 },
    limits: { cpuMs: 300000 },
    env: {
      SCHEDULES_ENABLED: bindings.text("true"),
      RECONCILIATION_ENABLED: bindings.text("true"),
      PURCHASE_RECOGNITION_ENABLED: bindings.text("true"),
      REWARD_CLAIMS_ENABLED: bindings.text("true"),
      REWARD_READ_PROJECTION_ENABLED: bindings.text("true"),
      REPORTS_ENABLED: bindings.text("true"),
      BALANCE_PROJECTION_ENABLED: bindings.text("1"),
      RELEASE_CANDIDATES_ENABLED: bindings.text("true"),
      SHARED_R2_INGEST_ENABLED: bindings.text("true"),
      OPS_DISPATCH_ENABLED: bindings.text("true"),
      OPS_COLLECTOR_DISPATCH_CONNECTIONS: bindings.text(""),
      COLLECTION_DATA_BUCKET: bindings.text("kogane-raw-evidence"),
      COLLECTION_ACCOUNT_ID: bindings.text("59ea63cc00914b30ca410b062ae2bb7f"),
      COLLECTION_INGEST_CLIENT: bindings.text("processor-shared-r2"),
      RELEASE_SHA: bindings.text(legacyConfig.vars.RELEASE_SHA),
      EVIDENCE: bindings.r2({ name: "kogane-raw-evidence" }),
      DATA: bindings.r2({ name: "kogane-raw-evidence" }),
      DB: bindings.d1({ name: "kogane-raw-evidence", id: "b335a887-250d-45c9-bd72-af83f35fdc60" }),
      READ: bindings.d1({ name: "kogane-read", id: "320ebe31-a031-48a1-985f-0e6fabbd517a" }),
      SCHEDULE_GLOBALPASS: bindings.worker({
        worker: "kogane-globalpass-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_VPASS: bindings.worker({
        worker: "kogane-vpass-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_MYJCB: bindings.worker({
        worker: "kogane-myjcb-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_SBI_SECURITIES: bindings.worker({
        worker: "kogane-sbi-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_SBI_SHINSEI: bindings.worker({
        worker: "kogane-sbi-shinsei-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_SONY_BANK: bindings.worker({
        worker: "kogane-sony-bank-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_SBI_VC_TRADE: bindings.worker({
        worker: "kogane-sbi-vc-session-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_MOBILE_SUICA: bindings.worker({
        worker: "kogane-mobile-suica-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_MONEYFORWARD: bindings.worker({
        worker: "kogane-moneyforward-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_VPOINT: bindings.worker({
        worker: "kogane-vpoint-collector-poc",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_MIZUHO: bindings.worker({
        worker: "kogane-mizuho-collector",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_ST_GEORGE: bindings.worker({
        worker: "kogane-st-george-collector",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_PRESTIA_BANK: bindings.worker({
        worker: "kogane-prestia-bank-collector",
        exportName: "ScheduledCollection",
      }),
      SCHEDULE_ALARMS: bindings.durableObject({
        worker: "kogane-observation-pipeline",
        exportName: "ScheduleAlarm",
      }),
    },
    triggers: [
      triggers.queue({
        name: "kogane-collection-terminals",
        maxBatchSize: 10,
        maxBatchTimeout: 5,
        maxRetries: 5,
        retryDelay: 30,
        deadLetterQueue: "kogane-collection-terminals-dlq",
        maxConcurrency: 2,
      }),
    ],
  },
});
