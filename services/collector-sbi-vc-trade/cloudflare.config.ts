import { bindings, defineConfig } from "cf/config";

// Code-only deployment reuses the provisioned legacy Durable Object namespace.
// Lifecycle migrations stay in wrangler.jsonc and are not applied by this config.
export default defineConfig({
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-sbi-vc-session-poc",
    compatibilityDate: "2026-08-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/schedule-entrypoint.ts",
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
    },
    env: {
      SESSION_SEED: bindings.secret(),
      SESSION_ENCRYPTION_KEY: bindings.secret(),
      ADMIN_TOKEN: bindings.secret(),
      PASSKEY_CREDENTIAL: bindings.secret(),

      COLLECTOR_SCHEMA_VERSION: bindings.text("sbi-vc-trade-worker-poc-v1"),
      DATA: bindings.r2({ name: "kogane-raw-evidence" }),
      SCHEDULE_DB: bindings.d1({
        name: "kogane-raw-evidence",
        id: "b335a887-250d-45c9-bd72-af83f35fdc60",
      }),
      SESSION_STATE: bindings.durableObject({
        worker: "kogane-sbi-vc-session-poc",
        exportName: "SbiVcSessionState",
      }),
    },
  },
});
