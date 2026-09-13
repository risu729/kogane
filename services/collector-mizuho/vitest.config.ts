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
          ADMIN_TRIGGER_TOKEN: "local-test-only",
          COLLECTOR_SCHEMA_VERSION: "mizuho-collector-v1",
        },
      },
    }),
  ],
  test: { include: ["worker-test/**/*.test.ts"] },
});
