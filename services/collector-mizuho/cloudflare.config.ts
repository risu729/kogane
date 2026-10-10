import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-mizuho-collector",
    compatibilityDate: "2026-09-07",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/schedule-entrypoint.ts",
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
    },
    env: {
      COLLECTOR_SCHEMA_VERSION: bindings.text("mizuho-collector-v1"),
      MIZUHO_CUSTOMER_NUMBER: bindings.secret(),
      MIZUHO_LOGIN_PASSWORD: bindings.secret(),
      SCHEDULE_DB: bindings.d1({
        name: "kogane-raw-evidence",
        id: "b335a887-250d-45c9-bd72-af83f35fdc60",
      }),
      DATA: bindings.r2({
        name: "kogane-raw-evidence",
      }),
    },
  },
});
