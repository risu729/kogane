// Local entry point: serve the read-only API and the built client on Bun.
//
// Binding is loopback-only and deliberate. This surface renders real financial
// evidence and has no authentication, so it must not be reachable from the
// network. A deployed version belongs behind Cloudflare Access or the same
// bearer token as the ingestion API — see docs/evidence-browser.md.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "./api.ts";
import { openStore } from "./store.ts";

const CLIENT_DIR = join(import.meta.dir, "..", "web", "dist");
const HOSTNAME = "127.0.0.1";

/**
 * Serve the built client, falling back to index.html so that client-side
 * routes deep-link correctly. Returns undefined when the client has not been
 * built, which the caller turns into a 404 with a build hint.
 */
function clientHandler(): (request: Request) => Promise<Response | undefined> {
  return async (request: Request): Promise<Response | undefined> => {
    if (!existsSync(CLIENT_DIR)) return undefined;
    const url = new URL(request.url);
    // Reject any traversal attempt before it reaches the filesystem.
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("..") || pathname.includes("\0")) return undefined;
    const candidate = join(CLIENT_DIR, pathname);
    if (candidate.startsWith(CLIENT_DIR) && pathname !== "/") {
      const file = Bun.file(candidate);
      if (await file.exists()) return new Response(file);
    }
    const index = Bun.file(join(CLIENT_DIR, "index.html"));
    if (await index.exists()) return new Response(index);
    return undefined;
  };
}

const store = openStore();
const serveClient = clientHandler();
const app = createApi(store, {
  serveClient: async (request) =>
    (await serveClient(request)) ??
    new Response(
      "The client has not been built yet. Run `bun run build` (or `bun run dev` for the Vite dev server).\n",
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    ),
});

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 8787),
  hostname: HOSTNAME,
  fetch: app.fetch,
});

console.log(`kogane evidence browser on http://${HOSTNAME}:${server.port}/`);
if (!existsSync(CLIENT_DIR)) {
  console.log("client not built: run `bun run build`, or `bun run dev` for hot reload");
}
