import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client lives in web/ and builds to web/dist, which src/serve.ts serves.
// In development Vite serves the client and proxies /api to the Hono server, so
// the client talks to the same URLs in both modes and no environment switch
// leaks into the application code.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No source map: serve.ts would serve it, and it is a megabyte of
    // artifact on a surface that renders real financial evidence.
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env["PORT"] ?? 8787}`,
        changeOrigin: false,
      },
    },
  },
});
