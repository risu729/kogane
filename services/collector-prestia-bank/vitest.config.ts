import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-07",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["DATA"],
        bindings: {
          RELEASE_SHA: "0000000000000000000000000000000000000000",
          ADMIN_TRIGGER_TOKEN: "local-test-only",
          PRESTIA_BANK_USER_ID: "syntheticuser12",
          PRESTIA_BANK_PASSWORD: "syntheticpassword",
          PRESTIA_BANK_USER_AGENT: "Synthetic WebView",
          COLLECTOR_SCHEMA_VERSION: "prestia-bank-collector-v1",
        },
      },
    }),
  ],
  test: { include: ["worker-test/**/*.test.ts"] },
});
