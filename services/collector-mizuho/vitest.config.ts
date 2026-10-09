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
          MIZUHO_CUSTOMER_NUMBER: "0000000000",
          MIZUHO_LOGIN_PASSWORD: "syntheticpassword",
          COLLECTOR_SCHEMA_VERSION: "mizuho-collector-v1",
        },
      },
    }),
  ],
  test: {
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.{ts,tsx,js,mjs}"],
      exclude: ["src/**/*.d.ts"],
      reportsDirectory: "coverage/workerd",
      reporter: ["text", "lcov", "json-summary", "json"],
      reportOnFailure: true,
    },
    include: ["worker-test/**/*.test.ts"],
  },
});
