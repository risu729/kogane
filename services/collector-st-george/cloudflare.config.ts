import { bindings, defineConfig, defineContainer, exports } from "cf/config";

const collectorContainer = defineContainer({
  name: "kogane-st-george-collector-stgeorgecollectorcontainer",
  image: { dockerfile: "./Dockerfile", buildContext: "." },
  maxInstances: 1,
  instanceType: "basic",
  schedulingPolicy: "default",
  constraints: { regions: ["APAC"] },
});

export default defineConfig({
  containers: [collectorContainer],
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-st-george-collector",
    compatibilityDate: "2026-09-07",
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
      COLLECTOR_SCHEMA_VERSION: bindings.text("st-george-browser-v1"),
      EGRESS_MODE: bindings.text("tamia"),
      RELAY_PUBLIC_URL: bindings.text(
        "wss://kogane-st-george-collector.takuanimal.workers.dev/tcp",
      ),
      SCHEDULE_DB: bindings.d1({
        name: "kogane-raw-evidence",
        id: "b335a887-250d-45c9-bd72-af83f35fdc60",
      }),
      DATA: bindings.r2({
        name: "kogane-raw-evidence",
      }),
      TAMIA: bindings.vpcNetwork({
        tunnelId: "6b0ccf30-68b2-494e-baa8-f4f9f3e46b33",
        dev: {
          remote: true,
        },
      }),
      COLLECTOR_CONTAINER: bindings.durableObject({
        worker: "kogane-st-george-collector",
        exportName: "StGeorgeCollectorContainer",
      }),
      SESSION_STATE: bindings.durableObject({
        worker: "kogane-st-george-collector",
        exportName: "StGeorgeCollectionState",
      }),
    },

    exports: {
      StGeorgeCollectorContainer: exports.durableObject({
        storage: "sqlite",
        container: collectorContainer,
      }),
      StGeorgeCollectionState: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
