import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-myjcb-collector-poc",
    compatibilityDate: "2026-08-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/schedule-entrypoint.ts",
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        invocationLogs: true,
        headSamplingRate: 1,
      },
    },
    env: {
      COLLECTOR_SCHEMA_VERSION: bindings.text("myjcb-worker-poc-v1"),
      SCHEDULE_DB: bindings.d1({
        name: "kogane-raw-evidence",
        id: "b335a887-250d-45c9-bd72-af83f35fdc60",
      }),
      DATA: bindings.r2({
        name: "kogane-raw-evidence",
      }),
      BROWSER: bindings.browser({}),
    },
  },
});
