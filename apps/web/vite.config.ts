import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is this workspace and builds to `dist/`, which the local pipeline
// experiment's `src/serve.ts` and the two evidence-browser Worker configs
// serve. In development Vite serves the client and proxies /api to the Hono
// server, so the client talks to the same URLs in both modes and no
// environment switch leaks into the application code.
//
// Keep Vite's default of no source map: serve.ts would serve it, and it is a
// megabyte of artifact on a surface that renders real financial evidence.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { __EVIDENCE_BROWSER__: JSON.stringify(mode === "evidence") },
  server: {
    proxy: {
      // The object form keeps changeOrigin off; the string shorthand turns it on.
      "/api": {
        target: `http://127.0.0.1:${process.env["PORT"] ?? 8787}`,
      },
    },
  },
}));
