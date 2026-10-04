import { bindings, defineConfig } from "cf/config";

// Code-only deployment reuses the provisioned legacy Durable Object namespace.
// Lifecycle migrations stay in wrangler.jsonc and are not applied by this config.
export default defineConfig({
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-smbc-direct-backfill-poc",
    compatibilityDate: "2026-08-31",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker.ts",
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
    },
    env: {
      SMBC_CREDENTIAL_JSON: bindings.secret(),
      SESSION_ENCRYPTION_KEY: bindings.secret(),
      ADMIN_TRIGGER_TOKEN: bindings.secret(),

      COLLECTOR_SCHEMA_VERSION: bindings.text("smbc-direct-backfill-worker-poc-v2"),
      SMBC_DIRECT_BASE_URL: bindings.text("https://direct3.smbc.co.jp"),
      SMBC_DIRECT_LOGIN_BASE_URL: bindings.text("https://direct.smbc.co.jp"),
      DEFAULT_BACKFILL_FROM: bindings.text("2019-01-01"),
      DATA: bindings.r2({ name: "kogane-raw-evidence" }),
      TAMIA: bindings.vpcNetwork({
        tunnelId: "6b0ccf30-68b2-494e-baa8-f4f9f3e46b33",
        dev: { remote: true },
      }),
      BACKFILL_SESSION: bindings.durableObject({
        worker: "kogane-smbc-direct-backfill-poc",
        exportName: "SmbcBackfillSession",
      }),
    },
  },
});
