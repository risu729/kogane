// Local entry point: serve the read-only API and the built client on Bun.
//
// Binding is loopback-only and deliberate. This surface renders real financial
// evidence and has no authentication, so it must not be reachable from the
// network. A deployed version belongs behind Cloudflare Access or the same
// bearer token as the ingestion API — see docs/evidence-browser.md.

import { existsSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createApi } from "./api.ts";
import { openStore } from "./store.ts";
import { ingestFixtures } from "./ingest.ts";
import { runParsers } from "./parse.ts";

const CLIENT_DIR = join(import.meta.dir, "..", "web", "dist");
const HOSTNAME = "127.0.0.1";

/**
 * Serve the built client, falling back to index.html so that client-side
 * routes deep-link correctly. Returns undefined when the client has not been
 * built, which the caller turns into a 404 with a build hint.
 */
type ClientResult =
  | { kind: "response"; response: Response }
  | { kind: "not-built" }
  | { kind: "rejected"; reason: string };

/** A resolved path is inside the client directory, separator included. */
function isInside(candidate: string): boolean {
  return (
    candidate === CLIENT_DIR || candidate.startsWith(`${CLIENT_DIR}${sep}`)
  );
}

function clientHandler(): (request: Request) => Promise<ClientResult> {
  return async (request: Request): Promise<ClientResult> => {
    if (!existsSync(CLIENT_DIR)) return { kind: "not-built" };
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // A malformed escape must not throw out of the handler as a 500.
      return { kind: "rejected", reason: "malformed percent-encoding" };
    }
    if (pathname.includes("..") || pathname.includes("\0")) {
      return { kind: "rejected", reason: "path traversal" };
    }
    const candidate = join(CLIENT_DIR, pathname);
    if (isInside(candidate) && pathname !== "/") {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        // The lexical check above is not enough: Bun.file follows symlinks, so
        // a link inside the build output could otherwise read any file the
        // process can. Resolve first, then re-apply the containment test.
        let resolved: string;
        try {
          resolved = realpathSync(candidate);
        } catch {
          return { kind: "rejected", reason: "unresolvable path" };
        }
        if (!isInside(resolved)) {
          return {
            kind: "rejected",
            reason: "symlink outside the client build",
          };
        }
        return { kind: "response", response: new Response(file) };
      }
    }
    const index = Bun.file(join(CLIENT_DIR, "index.html"));
    if (await index.exists()) {
      return {
        kind: "response",
        response: new Response(index, {
          headers: {
            // The app document is the one page that executes script here.
            "content-security-policy":
              "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "cache-control": "no-store",
          },
        }),
      };
    }
    return { kind: "not-built" };
  };
}

// Preview always creates a fresh store from committed synthetic fixtures.
// It cannot relabel an existing store, even if state/ contains real evidence.
const demo = process.argv.includes("--demo");
const temporaryRoot = resolve(tmpdir());
const previewDir = demo
  ? mkdtempSync(join(temporaryRoot, "kogane-preview-"))
  : undefined;
const store = openStore(previewDir);
if (previewDir !== undefined) {
  process.on("exit", () => {
    store.db.close();
    const target = resolve(previewDir);
    if (
      dirname(target) === temporaryRoot &&
      basename(target).startsWith("kogane-preview-")
    ) {
      rmSync(target, { recursive: true, force: true });
    }
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  ingestFixtures(store, join(import.meta.dir, "..", "fixtures"));
  runParsers(store);
}
// Defence in depth for the read-only rule. The API refuses a write method
// before routing, but that is one middleware over a read-write handle; this
// makes a write impossible at the database rather than merely unrouted.
store.db.exec("PRAGMA query_only = ON");

const serveClient = clientHandler();
const app = createApi(store, {
  ...(demo ? { dataClassification: "synthetic" as const } : {}),
  serveClient: async (request) => {
    const result = await serveClient(request);
    if (result.kind === "response") return result.response;
    if (result.kind === "rejected") {
      return new Response(`404 not found: ${result.reason}\n`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(
      "The client has not been built yet. Run `bun run build` (or `bun run dev` for the Vite dev server).\n",
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
});

const PORT = Number(process.env["PORT"] ?? 8787);

/**
 * Only requests that addressed this loopback server are answered.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not a page whose
 * hostname re-resolves to 127.0.0.1: the browser would treat it as
 * same-origin and could read every balance here. Checking Host closes that.
 */
const ALLOWED_HOSTS = new Set<string>();

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  fetch: (request) => {
    const host = request.headers.get("host");
    if (host !== null && !ALLOWED_HOSTS.has(host)) {
      return new Response(
        `403 forbidden: this server answers only ${[...ALLOWED_HOSTS].join(", ")}\n`,
        {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }
    return app.fetch(request);
  },
});

for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
  ALLOWED_HOSTS.add(`${host}:${server.port}`);
}

console.log(`kogane evidence browser on http://${HOSTNAME}:${server.port}/`);
if (!existsSync(CLIENT_DIR)) {
  console.log(
    "client not built: run `bun run build`, or `bun run dev` for hot reload",
  );
}
