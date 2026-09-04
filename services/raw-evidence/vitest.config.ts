import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          d1Databases: ["DB"],
          r2Buckets: ["EVIDENCE"],
          bindings: {
            INGEST_CLIENT_KEYS: JSON.stringify({ test: "test-secret-at-least-twenty-chars" }),
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // The D1 concurrency cases intentionally serialize multiple Worker calls.
    // Five seconds is too tight on shared CI runners and under parallel test load.
    testTimeout: 20_000,
  },
});
