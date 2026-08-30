import { Container, getContainer } from "@cloudflare/containers";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  parseMode,
  parseContainerProbeVariant,
  runPrefix,
  safeMonth,
  type CollectionFailure,
  type CollectionManifest,
  type CollectionMode,
  type ContainerProbeVariant,
  type ContainerRecord,
  type StoredArtifact,
} from "./model";
import { runGlobalPassBrowserProbe } from "./browser-probe";

const GLOBALPASS_HOST = "www.debit.vpass.ne.jp";
const TURNSTILE_HOST = "challenges.cloudflare.com";
const TURNSTILE_HELPER_HOST = "brunhild.challenges.cloudflare.com";
const PROBE_EGRESS_HOST = "kogane-globalpass-collector-poc.takuanimal.workers.dev";
const RELAY_HOSTS = new Set([
  GLOBALPASS_HOST,
  TURNSTILE_HOST,
  TURNSTILE_HELPER_HOST,
  PROBE_EGRESS_HOST,
]);
const MAX_NDJSON_LINE_BYTES = 3 * 1024 * 1024;
const CONTAINER_ID = "prestia-globalpass-read-only-v18";
const STOPPABLE_CONTAINER_IDS = new Map([
  ["v9", "prestia-globalpass-read-only-v9"],
  ["v10", "prestia-globalpass-read-only-v10"],
  ["v11", "prestia-globalpass-read-only-v11"],
  ["v12", "prestia-globalpass-read-only-v12"],
  ["v13", "prestia-globalpass-read-only-v13"],
  ["v14", "prestia-globalpass-read-only-v14"],
  ["v15", "prestia-globalpass-read-only-v15"],
  ["v16", "prestia-globalpass-read-only-v16"],
  ["v17", "prestia-globalpass-read-only-v17"],
  ["v18", CONTAINER_ID],
]);

export class GlobalPassCollectorContainer extends Container<Env> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "30s";
  override enableInternet = true;
  override envVars = { TZ: "Asia/Tokyo" };

  override onStart(): void {
    console.log(JSON.stringify({ event: "globalpass-container-start" }));
  }

  override onStop(): void {
    console.log(JSON.stringify({ event: "globalpass-container-stop" }));
  }

  override onError(error: unknown): void {
    console.error(
      JSON.stringify({
        event: "globalpass-container-error",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "prestia-globalpass",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method === "GET" && url.pathname === "/egress") {
      return Response.json(
        {
          ip: request.headers.get("cf-connecting-ip"),
          country: request.cf?.country ?? null,
          colo: request.cf?.colo ?? null,
          asn: request.cf?.asn ?? null,
          httpProtocol: request.cf?.httpProtocol ?? null,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (
      request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
      url.pathname === "/tcp"
    ) {
      return relayTcp(request, env, ctx, url);
    }
    if (request.method === "POST" && url.pathname === "/browser-probe") {
      if (!(await validBearer(request, env.ADMIN_TRIGGER_TOKEN))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return Response.json(await runGlobalPassBrowserProbe(env), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method === "POST" && url.pathname === "/container-probe") {
      if (!(await validBearer(request, env.ADMIN_TRIGGER_TOKEN))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const variant = parseContainerProbeVariant(
          url.searchParams.get("variant"),
        );
        return await runContainerProbe(env, variant);
      } catch (error) {
        return Response.json(
          { error: redactError(error).slice(0, 300) },
          { status: 400 },
        );
      }
    }
    if (request.method === "POST" && url.pathname === "/container-stop") {
      if (!(await validBearer(request, env.ADMIN_TRIGGER_TOKEN))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const instance = url.searchParams.get("instance") ?? "";
      const containerId = STOPPABLE_CONTAINER_IDS.get(instance);
      if (!containerId) {
        return Response.json({ error: "Unknown container instance" }, { status: 400 });
      }
      const action = url.searchParams.get("action") ?? "stop";
      const container = getContainer(env.COLLECTOR_CONTAINER, containerId);
      if (action === "destroy") {
        await container.destroy();
        return Response.json({ destroyed: instance });
      }
      if (action !== "stop") {
        return Response.json({ error: "Unknown cleanup action" }, { status: 400 });
      }
      await container.stop();
      return Response.json({ stopped: instance });
    }
    if (request.method === "GET" && url.pathname === "/latest-manifest") {
      if (!(await validBearer(request, env.ADMIN_TRIGGER_TOKEN))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        return await latestManifestResponse(
          env.SNAPSHOTS,
          url.searchParams.get("date"),
        );
      } catch (error) {
        return Response.json(
          { error: redactError(error).slice(0, 300) },
          { status: 400 },
        );
      }
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!(await validBearer(request, env.ADMIN_TRIGGER_TOKEN))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      const mode = parseMode(url.searchParams.get("mode"));
      const result = await runCollection(env, mode);
      return Response.json(result, {
        status: result.status === "failed" ? 502 : 200,
      });
    } catch (error) {
      return Response.json(
        { error: redactError(error).slice(0, 300) },
        { status: 400 },
      );
    }
  },

  async scheduled(_controller, env): Promise<void> {
    await runCollection(env, "daily");
  },
} satisfies ExportedHandler<Env>;

async function latestManifestResponse(
  bucket: R2Bucket,
  requestedDate: string | null,
): Promise<Response> {
  const date = requestedDate ?? new Date().toISOString().slice(0, 10);
  if (!/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u.test(date)) {
    throw new Error("date must use YYYY-MM-DD");
  }
  const prefix = `raw/prestia-globalpass/${date.replaceAll("-", "/")}/`;
  const listed = await bucket.list({ prefix, limit: 1_000 });
  const latest = listed.objects
    .filter((object) => object.key.endsWith("/manifest.json"))
    .sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime())[0];
  if (!latest) {
    return Response.json({ error: "No manifest for date" }, { status: 404 });
  }
  const object = await bucket.get(latest.key);
  if (!object) {
    return Response.json({ error: "Manifest disappeared" }, { status: 404 });
  }
  return new Response(object.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-manifest-key": latest.key,
    },
  });
}

async function runContainerProbe(
  env: Env,
  variant: ContainerProbeVariant,
): Promise<Response> {
  const container = getContainer(env.COLLECTOR_CONTAINER, CONTAINER_ID);
  await container.startAndWaitForPorts();
  const response = await container.fetch(
    new Request("http://container/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        variant,
        relayToken: requiredSecret(env.RELAY_TOKEN, "RELAY_TOKEN"),
        relayUrl: env.RELAY_PUBLIC_URL,
      }),
    }),
  );
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function runCollection(
  env: Env,
  mode: CollectionMode,
): Promise<CollectionManifest & { manifestKey: string }> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const container = getContainer(env.COLLECTOR_CONTAINER, CONTAINER_ID);

  try {
    return await collectWithContainer(env, mode, container, startedAt, runId);
  } finally {
    try {
      await container.stop();
      console.log(
        JSON.stringify({
          event: "globalpass-collection-container-stopped",
          runId,
          mode,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "globalpass-collection-container-stop-failed",
          runId,
          mode,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }
}

async function collectWithContainer(
  env: Env,
  mode: CollectionMode,
  container: DurableObjectStub<GlobalPassCollectorContainer>,
  startedAt: string,
  runId: string,
): Promise<CollectionManifest & { manifestKey: string }> {
  const prefix = runPrefix(startedAt, runId);
  const artifacts: StoredArtifact[] = [];
  const failures: CollectionFailure[] = [];
  let availableMonths: string[] = [];
  let runtimeRevision: string | undefined;

  await container.startAndWaitForPorts();
  const response = await container.fetch(
    new Request("http://container/collect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode,
        user: requiredSecret(env.GLOBALPASS_ID, "GLOBALPASS_ID"),
        password: requiredSecret(
          env.GLOBALPASS_PASSWORD,
          "GLOBALPASS_PASSWORD",
        ),
        relayToken: requiredSecret(env.RELAY_TOKEN, "RELAY_TOKEN"),
        relayUrl: env.RELAY_PUBLIC_URL,
      }),
    }),
  );
  if (!response.ok || !response.body) {
    throw new Error(`GLOBAL PASS container failed with HTTP ${response.status}`);
  }

  for await (const record of readNdjson(response.body)) {
    if (record.type === "metadata") {
      availableMonths = record.availableMonths.map(safeMonth);
      runtimeRevision = record.runtimeRevision;
      continue;
    }
    if (record.type === "error") {
      failures.push({
        operation: "browser-collection",
        errorType: record.errorType,
        message: redactText(record.message).slice(0, 2_000),
      });
      continue;
    }
    try {
      artifacts.push(
        await storeHtml(
          env.SNAPSHOTS,
          prefix,
          safeMonth(record.month),
          record.html,
        ),
      );
    } catch (error) {
      failures.push({
        operation: `r2:${record.month}`,
        errorType: error instanceof Error ? error.name : "UnknownError",
        message: redactError(error).slice(0, 300),
      });
    }
  }

  const status =
    failures.length === 0
      ? "success"
      : artifacts.length === 0
        ? "failed"
        : "partial";
  const manifest: CollectionManifest = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    source: "prestia-globalpass",
    runtimeRevision,
    runId,
    mode,
    startedAt,
    completedAt: new Date().toISOString(),
    status,
    availableMonths,
    artifacts,
    failures,
  };
  const manifestKey = `${prefix}/manifest.json`;
  await env.SNAPSHOTS.put(manifestKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { source: manifest.source, status, runId },
  });
  console.log(
    JSON.stringify({
      event: "globalpass-collection-stored",
      runId,
      mode,
      status,
      artifactCount: artifacts.length,
      failureCount: failures.length,
      manifestKey,
    }),
  );
  return { ...manifest, manifestKey };
}

async function storeHtml(
  bucket: R2Bucket,
  prefix: string,
  month: string,
  html: string,
): Promise<StoredArtifact> {
  const body = new TextEncoder().encode(html);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", body));
  const key = `${prefix}/activity-${month}.html`;
  await bucket.put(key, body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { dataset: "globalpass-activity", month, sha256 },
  });
  return { month, key, bytes: body.byteLength, sha256 };
}

async function* readNdjson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ContainerRecord> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        if (new TextEncoder().encode(line).byteLength > MAX_NDJSON_LINE_BYTES) {
          throw new Error("GLOBAL PASS container record exceeded byte limit");
        }
        buffer = buffer.slice(newline + 1);
        if (line) yield parseContainerRecord(line);
        newline = buffer.indexOf("\n");
      }
      if (new TextEncoder().encode(buffer).byteLength > MAX_NDJSON_LINE_BYTES) {
        throw new Error("GLOBAL PASS container record exceeded byte limit");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      if (new TextEncoder().encode(buffer).byteLength > MAX_NDJSON_LINE_BYTES) {
        throw new Error("GLOBAL PASS container record exceeded byte limit");
      }
      yield parseContainerRecord(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseContainerRecord(line: string): ContainerRecord {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("GLOBAL PASS container returned an invalid record");
  }
  const record: Record<string, unknown> = value;
  if (
    record["type"] === "metadata" &&
    Array.isArray(record["availableMonths"]) &&
    Array.isArray(record["selectedMonths"]) &&
    record["availableMonths"].every((item) => typeof item === "string") &&
    record["selectedMonths"].every((item) => typeof item === "string") &&
    typeof record["browserVersion"] === "string" &&
    (record["runtimeRevision"] === undefined ||
      (typeof record["runtimeRevision"] === "string" &&
        /^[a-z0-9-]{1,64}$/u.test(record["runtimeRevision"])))
  ) {
    return {
      type: "metadata",
      runtimeRevision:
        typeof record["runtimeRevision"] === "string"
          ? record["runtimeRevision"]
          : undefined,
      availableMonths: record["availableMonths"],
      selectedMonths: record["selectedMonths"],
      browserVersion: record["browserVersion"],
    };
  }
  if (
    record["type"] === "artifact" &&
    typeof record["month"] === "string" &&
    typeof record["html"] === "string"
  ) {
    return {
      type: "artifact",
      month: record["month"],
      html: record["html"],
    };
  }
  if (
    record["type"] === "error" &&
    typeof record["errorType"] === "string" &&
    typeof record["message"] === "string"
  ) {
    return {
      type: "error",
      errorType: record["errorType"],
      message: record["message"],
    };
  }
  throw new Error("GLOBAL PASS container returned an invalid record shape");
}

async function relayTcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (!(await validBearer(request, env.RELAY_TOKEN))) {
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
        console.error(
          JSON.stringify({
            event: "globalpass-relay-read-error",
            errorType: error instanceof Error ? error.name : "UnknownError",
          }),
        );
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
        console.error(
          JSON.stringify({
            event: "globalpass-relay-write-error",
            errorType: error instanceof Error ? error.name : "UnknownError",
          }),
        ),
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

async function validBearer(
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

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function redactError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : "Unknown error");
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/(token|cookie|password|usrId)=?[^\s,;]+/giu, "$1=[redacted]");
}
