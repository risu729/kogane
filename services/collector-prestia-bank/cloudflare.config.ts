import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { parseJsonc } from "../../scripts/jsonc.ts";
import { bindings, defineConfig } from "cf/config";

const legacyConfig = parseJsonc(
  readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
  "wrangler.jsonc",
) as { vars: { RELEASE_SHA: string; PRESTIA_BANK_USER_AGENT: string } };

export default defineConfig({
  accountId: "59ea63cc00914b30ca410b062ae2bb7f",
  worker: {
    name: "kogane-prestia-bank-collector",
    compatibilityDate: "2026-09-07",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/schedule-entrypoint.ts",
    workersDev: true,
    previewUrls: false,
    observability: { enabled: true },
    env: {
      RELEASE_SHA: bindings.text(legacyConfig.vars.RELEASE_SHA),
      COLLECTOR_SCHEMA_VERSION: bindings.text("prestia-bank-collector-v1"),
      PRESTIA_BANK_USER_AGENT: bindings.text(legacyConfig.vars.PRESTIA_BANK_USER_AGENT),
      PRESTIA_BANK_USER_ID: bindings.secret(),
      PRESTIA_BANK_PASSWORD: bindings.secret(),
      DATA: bindings.r2({ name: "kogane-raw-evidence" }),
      SCHEDULE_DB: bindings.d1({
        name: "kogane-raw-evidence",
        id: "b335a887-250d-45c9-bd72-af83f35fdc60",
      }),
    },
  },
});
