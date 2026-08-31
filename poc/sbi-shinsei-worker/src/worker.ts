import { Container, getContainer } from "@cloudflare/containers";
import { createHash, timingSafeEqual } from "node:crypto";
import { collectSbiShinsei } from "./collector";
import { liveReadsEnabled } from "./read-allowlist";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type {
  CollectionFailure,
  CollectionManifest,
  CollectionResult,
} from "./types";

const MAX_CONTAINER_RESPONSE_BYTES = 10 * 1024 * 1024;
const RELAY_HOSTS = new Set([
  "bk.web.sbishinseibank.co.jp",
  "www.sbishinseibank.co.jp",
  "distribute.cafisbrain.com",
  "diproxy.cafisbrain.com",
  "platform-websdk.transmitsecurity.io",
]);

export class SbiShinseiCollectorContainer extends Container<Env> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "30s";
  override enableInternet = true;
  override envVars = { TZ: "Asia/Tokyo" };

  override onStart(): void {
    console.log(JSON.stringify({ event: "sbi-shinsei-container-start" }));
  }

  override onStop(): void {
    console.log(JSON.stringify({ event: "sbi-shinsei-container-stop" }));
  }

  override onError(error: unknown): void {
    console.error(JSON.stringify({
      event: "sbi-shinsei-container-error",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "sbi-shinsei",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
        liveReadsEnabled: liveReadsEnabled(),
      });
    }
    if (
      request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
      url.pathname === "/tcp"
    ) {
      return relayTcp(request, env, ctx, url);
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const window = parseWindow(
        url.searchParams.get("from"),
        url.searchParams.get("to"),
      );
      const result = await runCollection(env, window);
      return Response.json(publicResult(result), {
        status: result.status === "failed" ? 503 : 200,
      });
    } catch (error) {
      return Response.json({ error: publicError(error) }, { status: 400 });
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env, defaultWindow(new Date()));
    if (result.status === "failed") {
      throw new Error(
        `SBI Shinsei collection failed; manifest=${result.manifestKey}`,
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function runCollection(
  env: Env,
  window: { from: string; to: string },
): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const artifacts = [];
  const failures: CollectionFailure[] = [];
  const container = getContainer(env.COLLECTOR_CONTAINER, `run-${runId}`);

  try {
    const output = await collectSbiShinsei({
      window,
      credentialJson: env.SBI_SHINSEI_CREDENTIAL_JSON,
      collectHandoff: async (credentialJson) => {
        await container.startAndWaitForPorts();
        const response = await container.fetch(new Request("http://container/collect", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            credentialJson,
            relayToken: requiredSecret(env.RELAY_TOKEN, "RELAY_TOKEN"),
            relayUrl: env.RELAY_PUBLIC_URL,
          }),
        }));
        if (!response.ok) {
          throw new Error(`SBI Shinsei container failed with HTTP ${response.status}`);
        }
        return readBoundedText(response, MAX_CONTAINER_RESPONSE_BYTES);
      },
    });
    for (const artifact of output.artifacts) {
      try {
        artifacts.push(await storeArtifact({
          bucket: env.SNAPSHOTS,
          prefix,
          artifact,
        }));
      } catch (error) {
        failures.push(failure(`r2:${artifact.dataset}`, error));
      }
    }
  } catch (error) {
    failures.push(failure("collect", error));
  } finally {
    try {
      await container.destroy();
      console.log(JSON.stringify({
        event: "sbi-shinsei-container-destroyed",
        runId,
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: "sbi-shinsei-container-destroy-failed",
        runId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      }));
    }
  }

  const completedAt = new Date().toISOString();
  const status =
    failures.length === 0
      ? "success"
      : artifacts.length === 0
        ? "failed"
        : "partial";
  const manifest: CollectionManifest = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    source: "sbi-shinsei",
    runId,
    startedAt,
    completedAt,
    status,
    window,
    liveReadsEnabled: liveReadsEnabled(),
    artifacts,
    failures,
  };
  const manifestKey = await storeManifest({
    bucket: env.SNAPSHOTS,
    prefix,
    manifest,
  });
  console.log(JSON.stringify({
    event: "sbi-shinsei-collection-stored",
    runId,
    status,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    liveReadsEnabled: manifest.liveReadsEnabled,
    manifestKey,
  }));
  return { ...manifest, manifestKey };
}

function parseWindow(
  from: string | null,
  to: string | null,
): { from: string; to: string } {
  if (from === null && to === null) return defaultWindow(new Date());
  if (!from || !to) throw new Error("from and to must be specified together");
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(to) ||
    from > to ||
    !validDate(from) ||
    !validDate(to)
  ) {
    throw new Error("from and to must be a valid YYYY-MM-DD range");
  }
  const days = Math.floor(
    (Date.parse(`${to}T00:00:00.000Z`) -
      Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  ) + 1;
  if (days > 731) {
    throw new Error("a trigger window must not exceed 731 days");
  }
  return { from, to };
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximumBytes) {
    throw new Error("SBI Shinsei container response exceeded byte limit");
  }
  if (!response.body) throw new Error("SBI Shinsei container response was empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error("SBI Shinsei container response exceeded byte limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function defaultWindow(now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

function validDate(value: string): boolean {
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function authorized(request: Request, expected: string | undefined): boolean {
  const provided = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/iu)?.[1];
  if (!provided || !expected) return false;
  const left = new TextEncoder().encode(provided);
  const right = new TextEncoder().encode(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function relayTcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (!(await validRelayBearer(request, env.RELAY_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const hostname = url.searchParams.get("host") ?? "";
  const port = Number(url.searchParams.get("port"));
  if (!RELAY_HOSTS.has(hostname) || port !== 443) {
    return Response.json({ error: "Target denied" }, { status: 403 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const socket = (env.MESH as VpcNetworkBinding).connect({ hostname, port });
  const writer = socket.writable.getWriter();
  let writeChain = Promise.resolve();

  ctx.waitUntil(
    (async () => {
      const reader = socket.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          server.send(value);
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: "sbi-shinsei-relay-read-error",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }));
      } finally {
        reader.releaseLock();
        try {
          server.close(1000, "upstream closed");
        } catch {}
      }
    })(),
  );

  server.addEventListener("message", (event) => {
    writeChain = writeChain.then(async () => {
      await writer.write(await websocketBytes(event.data));
    });
    ctx.waitUntil(
      writeChain.catch((error) =>
        console.error(JSON.stringify({
          event: "sbi-shinsei-relay-write-error",
          errorType: error instanceof Error ? error.name : "UnknownError",
        })),
      ),
    );
  });
  server.addEventListener("close", () => {
    ctx.waitUntil(
      writeChain
        .then(() => writer.close())
        .catch(() => undefined)
        .finally(() => socket.close()),
    );
  });
  return new Response(null, { status: 101, webSocket: client });
}

async function websocketBytes(
  data: string | ArrayBuffer | Blob,
): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

async function validRelayBearer(
  request: Request,
  expected: string | undefined,
): Promise<boolean> {
  if (!expected || expected.length < 32) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

interface VpcNetworkBinding extends Fetcher {
  connect(address: SocketAddress | string, options?: SocketOptions): Socket;
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}

function failure(operation: string, error: unknown): CollectionFailure {
  return {
    operation,
    errorType: error instanceof Error ? error.name : "UnknownError",
    message: publicError(error),
  };
}

function publicError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Unknown error";
  return value
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(
      /(password|accountNumber|branchNumber|cookie|csrf|token)=?[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .slice(0, 300);
}

function publicResult(result: CollectionResult): object {
  return {
    runId: result.runId,
    status: result.status,
    window: result.window,
    liveReadsEnabled: result.liveReadsEnabled,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    manifestKey: result.manifestKey,
  };
}
