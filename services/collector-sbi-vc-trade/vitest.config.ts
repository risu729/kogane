import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // U09: the runtime suite exercises the shared path, so the var the
        // deployed config ships as "legacy" is overridden here. The legacy
        // path is covered by the `test/` suite and by the unchanged code.
        bindings: { COLLECTION_TARGET: "shared" },
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
