const DESTINATIONS = {
  "/bridge/tls-peet": { hostname: "tls.peet.ws", port: 443 },
  "/bridge/vpass": { hostname: "www.smbc-card.com", port: 443 },
  "/bridge/cloudflare-trace": { hostname: "www.cloudflare.com", port: 443 },
  "/bridge/ipify": { hostname: "api.ipify.org", port: 443 },
} as const;

const MAX_TOTAL_BYTES_PER_DIRECTION = 16 * 1024 * 1024;
const MAX_QUEUED_CLIENT_BYTES = 512 * 1024;
const MAX_CONNECTION_MILLISECONDS = 90_000;

type DestinationPath = keyof typeof DESTINATIONS;

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function destinationPath(value: string): DestinationPath | null {
  return Object.hasOwn(DESTINATIONS, value) ? (value as DestinationPath) : null;
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function validBearer(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const [providedHash, expectedHash] = await Promise.all([
    digest(provided),
    digest(expected),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function messageBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  return null;
}

async function bridge(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: DestinationPath,
): Promise<Response> {
  if (typeof env.BRIDGE_TOKEN !== "string" || env.BRIDGE_TOKEN.length < 32) {
    return jsonResponse({ error: "bridge disabled" }, 503);
  }
  if (!(await validBearer(request, env.BRIDGE_TOKEN))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse({ error: "websocket upgrade required" }, 426);
  }

  const destination = DESTINATIONS[path];
  const socket = await env.TAMIA.connect(destination);
  await socket.opened;

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.binaryType = "arraybuffer";
  server.accept({ allowHalfOpen: true });

  const writer = socket.writable.getWriter();
  let clientBytes = 0;
  let targetBytes = 0;
  let queuedClientBytes = 0;
  let writeQueue = Promise.resolve();
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (code: number, reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        if (server.readyState === WebSocket.OPEN) server.close(code, reason);
      } catch {
        // The peer may already have closed the WebSocket.
      }
      try {
        writer.releaseLock();
      } catch {
        // A queued write may still own the lock while the socket closes.
      }
      try {
        await socket.close();
      } catch {
        // Closing an already-closed VPC socket is harmless for this probe.
      }
      console.log(
        JSON.stringify({
          event: "bridge-closed",
          path,
          clientBytes,
          targetBytes,
          code,
        }),
      );
    })();
    return shutdownPromise;
  };

  server.addEventListener("message", (event) => {
    const chunk = messageBytes(event.data);
    if (!chunk) {
      ctx.waitUntil(shutdown(1003, "binary frames required"));
      return;
    }
    clientBytes += chunk.byteLength;
    queuedClientBytes += chunk.byteLength;
    if (
      clientBytes > MAX_TOTAL_BYTES_PER_DIRECTION ||
      queuedClientBytes > MAX_QUEUED_CLIENT_BYTES
    ) {
      ctx.waitUntil(shutdown(1009, "bridge byte limit exceeded"));
      return;
    }

    writeQueue = writeQueue
      .then(async () => {
        await writer.write(chunk);
      })
      .catch(async () => {
        await shutdown(1011, "target write failed");
      })
      .finally(() => {
        queuedClientBytes -= chunk.byteLength;
      });
    ctx.waitUntil(writeQueue);
  });

  server.addEventListener("close", () => {
    ctx.waitUntil(shutdown(1000, "client closed"));
  });
  server.addEventListener("error", () => {
    ctx.waitUntil(shutdown(1011, "websocket error"));
  });

  const targetPump = (async () => {
    const reader = socket.readable.getReader();
    try {
      while (server.readyState === WebSocket.OPEN) {
        const { done, value } = await reader.read();
        if (done) break;
        targetBytes += value.byteLength;
        if (targetBytes > MAX_TOTAL_BYTES_PER_DIRECTION) {
          await shutdown(1009, "bridge byte limit exceeded");
          return;
        }
        server.send(value);
      }
      await shutdown(1000, "target closed");
    } catch {
      await shutdown(1011, "target read failed");
    } finally {
      reader.releaseLock();
    }
  })();
  ctx.waitUntil(targetPump);
  ctx.waitUntil(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        ctx.waitUntil(shutdown(1008, "bridge lifetime exceeded"));
        resolve();
      }, MAX_CONNECTION_MILLISECONDS);
    }),
  );

  console.log(JSON.stringify({ event: "bridge-opened", path }));
  return new Response(null, { status: 101, webSocket: client });
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.search !== "") {
    return jsonResponse({ error: "not found" }, 404);
  }
  if (url.pathname === "/") {
    return jsonResponse({
      enabled: typeof env.BRIDGE_TOKEN === "string",
      destinations: Object.keys(DESTINATIONS),
      acceptsCredentials: false,
    });
  }
  const path = destinationPath(url.pathname);
  if (!path) return jsonResponse({ error: "not found" }, 404);
  return bridge(request, env, ctx, path);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "bridge-error",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return jsonResponse({ error: "bridge unavailable" }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
