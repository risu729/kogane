import { bindings, defineConfig, defineContainer, exports } from "cf/config";

const collectorContainer = defineContainer({
  name: "kogane-sbi-shinsei-collector-poc-sbishinseicollectorcontainer",
  image: { dockerfile: "./Dockerfile", buildContext: "." },
  maxInstances: 2,
  instanceType: "basic",
  schedulingPolicy: "default",
  constraints: { regions: ["APAC"] },
});

export default defineConfig({
  containers: [collectorContainer],
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-sbi-shinsei-collector-poc",
    compatibilityDate: "2026-08-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/schedule-entrypoint.ts",
    workersDev: true,
    previewUrls: false,
    placement: {
      region: "aws:ap-northeast-1",
    },
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        invocationLogs: true,
        headSamplingRate: 1,
      },
    },
    env: {
      COLLECTOR_SCHEMA_VERSION: bindings.text("sbi-shinsei-worker-poc-v1"),
      RELAY_PUBLIC_URL: bindings.text(
        "wss://kogane-sbi-shinsei-collector-poc.takuanimal.workers.dev/tcp",
      ),
      SCHEDULE_DB: bindings.d1({
        name: "kogane-raw-evidence",
        id: "b335a887-250d-45c9-bd72-af83f35fdc60",
      }),
      DATA: bindings.r2({
        name: "kogane-raw-evidence",
      }),
      MESH: bindings.vpcNetwork({
        tunnelId: "6b0ccf30-68b2-494e-baa8-f4f9f3e46b33",
        dev: {
          remote: true,
        },
      }),
      COLLECTOR_CONTAINER: bindings.durableObject({
        worker: "kogane-sbi-shinsei-collector-poc",
        exportName: "SbiShinseiCollectorContainer",
      }),
    },

    exports: {
      SbiShinseiCollectorContainer: exports.durableObject({
        storage: "sqlite",
        container: collectorContainer,
      }),
    },
  },
});
