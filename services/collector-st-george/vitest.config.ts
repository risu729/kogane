import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        compatibilityDate: "2026-09-07",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["DATA"],
        d1Databases: ["TEST_DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "../../packages/storage-d1/migrations/core"),
          ),
          TEST_BOOTSTRAP: readFileSync(
            path.join(import.meta.dirname, "../../infra/bootstrap/ingest-clients.sql"),
            "utf8",
          ),
        },
      },
    })),
  ],
  test: { include: ["worker-test/**/*.test.ts"], testTimeout: 30_000 },
});
