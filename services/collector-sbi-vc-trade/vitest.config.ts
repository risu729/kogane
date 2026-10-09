import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The Worker does not read a collection-target var. Shared DATA is the
        // only persist path, including this runtime suite.
        bindings: {
          // Apply the actual operational schema used by all provider leases.
          SCHEDULE_TEST_MIGRATIONS: (
            await readD1Migrations(
              path.join(import.meta.dirname, "../../packages/storage-d1/migrations/core"),
            )
          ).filter((migration) => migration.name === "0065_alarm_schedules.sql"),
        },
        serviceBindings: {
          RAW_EVIDENCE_IMPORTER: () =>
            Response.json({ error: "not_used_in_runtime_tests" }, { status: 503 }),
        },
      },
    })),
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
