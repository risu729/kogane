// The evidence browser's HTTP surface: a Hono app serving a read-only JSON API
// plus the built React client.
//
// Hono is used because the same app object runs on Bun locally and on
// Cloudflare Workers later, which is where the rest of Kogane already lives.
// Only the store binding and the static-file serving differ between the two.
//
// Three rules hold for every route here:
//
//   * Read-only. There is no route that writes, and any method other than GET
//     or HEAD is refused before routing. The browser observes the store.
//   * Nothing derived is stored. "Latest balance" and every other current-state
//     view is computed per request by queries.ts and thrown away.
//   * Raw evidence goes out verbatim, and is never treated as an active
//     document. See the /api/raw handler.

import { Hono } from "hono";
import type { ApiMetadata } from "../shared/api-contract.ts";
import { readRawObject, sha256Hex, type Store } from "./store.ts";
import {
  artifactDetail,
  artifacts,
  balanceHistory,
  currentTransactions,
  isObservationKind,
  latestBalances,
  observationDetail,
  overview,
  positionsWithValuations,
  rawObjectMeta,
} from "./queries.ts";

export interface ApiOptions {
  /** Set only when startup created an isolated store entirely from known fixtures. */
  dataClassification?: "synthetic";
  /** Serves the built client. Omitted in tests, which exercise the API alone. */
  serveClient?: (request: Request) => Response | Promise<Response> | undefined;
}

function parseId(value: string): number | undefined {
  // Only a plain non-negative integer. "1e3", "0x10", " 1", "1.5" and "-1" are
  // all rejected rather than coerced into a row id.
  if (!/^\d+$/u.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function createApi(store: Store, options: ApiOptions = {}): Hono {
  const app = new Hono();

  // Refused before any route runs, so a write can never reach a handler even
  // if one were added carelessly later.
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.text("405 method not allowed: this browser is read-only\n", 405);
    }
    await next();
    // Responses carry financial evidence. The HTTP cache is a persistence path
    // the client cannot see or clear, so nothing here may be stored by it.
    if (c.req.path.startsWith("/api/")) {
      c.header("cache-control", "no-store");
      c.header("x-content-type-options", "nosniff");
    }
  });

  app.get("/api/meta", (c) =>
    c.json({
      apiVersion: 1,
      source: {
        kind: "local-store",
        classification: options.dataClassification ?? "unknown",
      },
      capabilities: {
        readOnly: true,
        rawEvidence: true,
        liveCollectors: false,
      },
    } satisfies ApiMetadata),
  );

  app.get("/api/overview", (c) => c.json(overview(store)));

  app.get("/api/transactions", (c) => c.json({ transactions: currentTransactions(store) }));

  app.get("/api/balances", (c) =>
    c.json({ latest: latestBalances(store), history: balanceHistory(store) }),
  );

  app.get("/api/positions", (c) => c.json({ positions: positionsWithValuations(store) }));

  app.get("/api/artifacts", (c) => c.json({ artifacts: artifacts(store) }));

  app.get("/api/artifacts/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "not an artifact id" }, 404);
    const detail = artifactDetail(store, id);
    if (!detail) return c.json({ error: `no artifact with id ${id}` }, 404);
    return c.json(detail);
  });

  app.get("/api/observations/:kind/:id", (c) => {
    const kind = c.req.param("kind");
    if (!isObservationKind(kind)) {
      return c.json({ error: `unknown observation kind: ${kind}` }, 404);
    }
    const id = parseId(c.req.param("id"));
    if (id === undefined) return c.json({ error: "not an observation id" }, 404);
    const detail = observationDetail(store, kind, id);
    if (!detail) return c.json({ error: `no ${kind} observation with id ${id}` }, 404);
    return c.json(detail);
  });

  // Raw evidence, byte for byte.
  //
  // The bytes go out exactly as stored, but are never treated as an active
  // document. Captured evidence can be attacker-authored HTML: rendered inline
  // it would run its own script in this origin and could read every other page
  // here, which is the whole financial dataset. `sandbox` denies it an origin
  // and scripts; `nosniff` stops the browser inferring a type the source never
  // declared.
  app.get("/api/raw/:sha256", (c) => {
    const sha256 = c.req.param("sha256");
    if (!/^[0-9a-f]{64}$/u.test(sha256)) {
      return c.json({ error: "not a sha256 digest" }, 404);
    }
    const meta = rawObjectMeta(store, sha256);
    if (!meta) return c.json({ error: `no raw object with sha256 ${sha256}` }, 404);
    let bytes: Uint8Array;
    try {
      bytes = readRawObject(store, meta.sha256);
    } catch (error) {
      return c.json(
        {
          error: `raw object ${meta.sha256} is recorded but unreadable`,
          detail: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
    // The digest is the identity of these bytes, and this route is the one
    // place the claim "this is the evidence" is made. Re-hashing turns that
    // claim into a check: a blob corrupted or replaced on disk is reported
    // rather than served under the digest it no longer has.
    const actual = sha256Hex(bytes);
    if (actual !== meta.sha256) {
      return c.json(
        {
          error: `raw object ${meta.sha256} does not match its stored bytes`,
          detail: `the blob on disk hashes to ${actual}`,
        },
        500,
      );
    }
    // The stored content type is provider-derived and reaches a header, so it
    // is validated first: a CR or LF in it would otherwise split the response.
    const declared = meta.content_type.trim();
    const contentType = /^[ -~]+$/u.test(declared) ? declared : "application/octet-stream";
    // An exact copy of the view's bytes: `readRawObject` returns a Buffer whose
    // underlying pool may be larger than the object, so the range matters.
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-disposition": "inline",
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
        "x-kogane-sha256": meta.sha256,
      },
    });
  });

  app.all("/api/*", (c) => c.json({ error: "no such endpoint" }, 404));

  if (options.serveClient) {
    const serveClient = options.serveClient;
    app.get("*", async (c) => {
      const response = await serveClient(c.req.raw);
      return response ?? c.text("404 not found\n", 404);
    });
  }

  return app;
}
