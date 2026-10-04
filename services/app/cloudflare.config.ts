import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { parseJsonc } from "../../scripts/jsonc.ts";
import { bindings, defineConfig } from "cf/config";

const legacyConfig = parseJsonc(
  readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
  "wrangler.jsonc",
) as { vars: { RELEASE_SHA: string } };

export default defineConfig({
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-evidence-browser",
    compatibilityDate: "2026-09-05",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker.ts",
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: {
        enabled: true,
        invocationLogs: false,
        headSamplingRate: 1,
      },
    },
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: true,
    },
    env: {
      SCHEDULES_ENABLED: bindings.text("true"),
      DEPLOYMENT_SCHEDULE_TOKENS: bindings.text('["32f6a8d0612c6a657eb74dc066cefbcf.access"]'),
      BALANCE_PROJECTION_ENABLED: bindings.text("1"),
      REWARDS_V2_ENABLED: bindings.text("true"),
      EVIDENCE_SOURCE_ID: bindings.text("sony-bank"),
      EVENTS_V2_ENABLED: bindings.text("true"),
      ACCESS_ISSUER: bindings.text("https://risu729.cloudflareaccess.com"),
      ACCESS_AUDIENCE: bindings.text(
        "20cc9cb6173e2755bc3ffd5f43a9adf45b0c2ad8451a1b2d330cc2b75f0d85c8",
      ),
      COMMANDS_ENABLED: bindings.text("true"),
      OPERATOR_SUBJECTS: bindings.text('["2c440753-9011-502c-a22d-bb013593c11a"]'),
      AGENT_GRANTS: bindings.text(""),
      AGENT_API_GRANTS: bindings.text(""),
      OPS_API_ENABLED: bindings.text("true"),
      SESSION_REFRESH_POLICY: bindings.text(""),
      RELEASE_SHA: bindings.text(legacyConfig.vars.RELEASE_SHA),
      HEALTH_PROBE_TOKENS: bindings.text('["32f6a8d0612c6a657eb74dc066cefbcf.access"]'),
      DB: bindings.d1({
        name: "kogane-raw-evidence",
        id: "b335a887-250d-45c9-bd72-af83f35fdc60",
      }),
      READ: bindings.d1({
        name: "kogane-read",
        id: "320ebe31-a031-48a1-985f-0e6fabbd517a",
      }),
      EVIDENCE: bindings.r2({
        name: "kogane-raw-evidence",
      }),
      PIPELINE: bindings.worker({
        worker: "kogane-observation-pipeline",
      }),
      ASSETS: bindings.assets(),
    },
  },
});
