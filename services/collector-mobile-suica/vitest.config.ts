// The Workers-runtime suite: the shared-target writes go through the real
// workerd/Miniflare R2 implementation, not an in-memory fake, because "the
// terminal is written last and only after every object verified" is a claim
// about R2 semantics. The bindings come from the deployed Wrangler config, so
// the suite runs against the same `DATA` binding the Worker will have; the
// service binding is stubbed and remote bindings are off, because the shared
// target calls neither the importer nor a browser.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The deployed config binds a remote Browser Rendering session, which a
      // test may not open: this suite exercises storage, not a browser.
      remoteBindings: false,
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
