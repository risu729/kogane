import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "../../packages/storage-d1/migrations/core"),
          ),
          // The workers pool does not inherit the host process environment, so
          // the opt-in load harness reads its shape from this binding
          // (test/load.test.ts, scripts/load-fixture.ts).
          KOGANE_LOAD_CONFIG: JSON.stringify(
            Object.fromEntries(
              Object.entries(process.env).filter(([name]) => name.startsWith("KOGANE_LOAD")),
            ),
          ),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"], testTimeout: 30_000 },
});
