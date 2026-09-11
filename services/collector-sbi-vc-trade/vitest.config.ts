import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        serviceBindings: {
          RAW_EVIDENCE_IMPORTER: () =>
            Response.json({ error: "not_used_in_runtime_tests" }, { status: 503 }),
        },
      },
    }),
  ],
  test: {
    include: ["worker-test/**/*.test.ts"],
  },
});
