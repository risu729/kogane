// The Workers-runtime suite: the shared-target writes go through the real
// workerd/Miniflare R2 implementation, not an in-memory fake, because "the
// terminal is written last and only after every object verified" is a claim
// about R2 semantics. The bindings come from the deployed Wrangler config, so
// the suite runs against the same `DATA` binding the Worker will have.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["worker-test/**/*.test.ts"],
  },
});
