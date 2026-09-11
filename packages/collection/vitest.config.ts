// One Workers-runtime suite: the R2 semantics the contract depends on, run
// against the real workerd/Miniflare R2 implementation rather than the
// in-memory fake in `test/`. Same setup as `services/raw-evidence`, minus the
// Wrangler configuration: this package is not a Worker, so the bucket binding
// is declared directly in the Miniflare options.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-02",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["DATA"],
      },
    }),
  ],
  test: {
    include: ["worker-test/**/*.test.ts"],
  },
});
