// One Workers-runtime suite: the shared-mode write path against the real
// workerd/Miniflare R2 implementation rather than the in-memory fake the
// `test/` suite uses. Miniflare is configured directly instead of from
// `wrangler.jsonc`, because this Worker declares a Container and building its
// image is neither needed nor possible here — the Worker, not the container,
// writes the run.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-30",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["DATA"],
      },
    }),
  ],
  test: {
    include: ["worker-test/**/*.test.ts"],
  },
});
