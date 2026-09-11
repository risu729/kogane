// One Workers-runtime suite: the shared-mode write path against the real
// workerd/Miniflare R2 implementation rather than the in-memory fake the
// `test/` suite uses. Both buckets are declared directly instead of from
// `wrangler.jsonc`, because this suite exercises the storage step of a finished
// backfill run, not the Access-gated Worker around it.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-31",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["DATA", "SNAPSHOTS"],
      },
    }),
  ],
  test: {
    include: ["worker-test/**/*.test.ts"],
  },
});
