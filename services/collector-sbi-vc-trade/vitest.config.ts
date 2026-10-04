import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // U09: the runtime suite exercises the shared path, so the var the
        // deployed config ships as "legacy" is overridden here. The legacy
        // path is covered by the `test/` suite and by the unchanged code.
        bindings: {
          COLLECTION_TARGET: "shared",
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
    include: ["worker-test/**/*.test.ts"],
  },
});
