import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-vpoint-pay-collector-poc",
    compatibilityDate: "2026-08-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker.ts",
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
      COLLECTOR_SCHEMA_VERSION: bindings.text("vpoint-pay-worker-poc-v1"),
      VPOINT_PAY_REFRESH_TOKEN: bindings.secret(),
      VPOINT_PAY_DEVICE_UUID: bindings.secret(),
      ADMIN_TRIGGER_TOKEN: bindings.secret(),
      DATA: bindings.r2({
        name: "kogane-raw-evidence",
      }),
      VPOINT_PAY_STATE: bindings.durableObject({
        worker: "kogane-vpoint-pay-collector-poc",
        exportName: "VPointPayCredentialState",
      }),
    },
    exports: {
      VPointPayCredentialState: exports.durableObject({
        storage: "sqlite",
      }),
    },
  },
});
