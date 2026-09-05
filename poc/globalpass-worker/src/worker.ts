import { createDiagnostics, safeErrorDetails } from "../../collector-diagnostics/src/index";
import { logEvent, relayRunId, withRunId } from "./log-context";
import { Container, getContainer } from "@cloudflare/containers";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  artifactFilename,
  assertCanonicalMonths,
  GLOBALPASS_DATASET,
  GLOBALPASS_MEDIA_TYPE,
  GLOBALPASS_PAGINATION_STATUS,
  GLOBALPASS_SCHEMA_VERSION,
  parseMode,
  parseContainerProbeVariant,
  runPrefix,
  safeMonth,
  selectedMonthsForMode,
  strictCollectionStatus,
  type CollectionFailure,
  type CollectionManifest,
  type CollectionMode,
  type ContainerProbeVariant,
  type ContainerRecord,
  type StoredArtifact,
} from "./model";
import { runGlobalPassBrowserProbe } from "./browser-probe";
import { backfillStoredRuns, importStoredRun } from "./raw-evidence";
import type { RawEvidenceImportResult } from "./raw-evidence-types";
import { sanitizeGlobalPassActivityHtml } from "./sanitize";

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
const CONTAINER_ID = "prestia-globalpass-read-only-v20";
const CHROMIUM_TIMEZONE_PROBE_ID =
  "prestia-globalpass-chromium-timezone-probe-v1";
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
  ["v18", "prestia-globalpass-read-only-v18"],
  ["v19", "prestia-globalpass-read-only-v19"],
  ["v20", CONTAINER_ID],
  ["chromium-timezone", CHROMIUM_TIMEZONE_PROBE_ID],
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
    logEvent(
      "error",
      JSON.stringify({
        event: "globalpass-container-error",
        ...safeErrorDetails(error),
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
    if (request.method === "POST" && url.pathname === "/backfill-raw-evidence") {
      if (!(await validBearer(request, env.ADMIN_TRIGGER_TOKEN))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (url.searchParams.get("limit") !== "1") {
        return Response.json({ error: "limit_must_be_one" }, { status: 400 });
      }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (cursor !== undefined && !safeOpaque(cursor)) {
        return Response.json({ error: "cursor_invalid" }, { status: 400 });
      }
      try {
        return Response.json(
          await backfillStoredRuns(env.RAW_EVIDENCE_IMPORTER, cursor),
          { headers: { "cache-control": "no-store" } },
        );
      } catch {
        return Response.json(
          { error: "raw_evidence_backfill_failed" },
          { status: 502 },
        );
      }
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!(await validBearer(request, env.ADMIN_TRIGGER_TOKEN))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    let mode: CollectionMode;
    try {
      mode = parseMode(url.searchParams.get("mode"));
    } catch (error) {
      return Response.json(
        { error: redactError(error).slice(0, 300) },
        { status: 400 },
      );
    }
    try {
      const result = await runCollection(env, mode);
      return Response.json(publicCollectionResult(result), {
        status: result.status === "success" ? 200 : 502,
        headers: { "cache-control": "no-store" },
      });
    } catch {
      return Response.json(
        { error: "globalpass_collection_failed" },
        { status: 502 },
      );
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env, "daily");
    if (result.status !== "success") {
      throw new Error(`GLOBAL PASS collection incomplete; manifest=${result.manifestKey}`);
    }
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
  const containerId =
    variant === "chromium-native-all-tamia"
      ? CHROMIUM_TIMEZONE_PROBE_ID
      : CONTAINER_ID;
  const container = getContainer(env.COLLECTOR_CONTAINER, containerId);
  await container.startAndWaitForPorts();
  const response = await container.fetch(
    new Request("http://container/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        variant,
        relayToken: requiredSecret(env.RELAY_TOKEN, "RELAY_TOKEN"),
        relayUrl:
          variant === "chrome-stable-no-ua-all-cloudflare-gateway"
            ? `${env.RELAY_PUBLIC_URL}?network=cf-gateway`
            : env.RELAY_PUBLIC_URL,
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

type CollectionResult = CollectionManifest & {
  manifestKey: string;
  central: RawEvidenceImportResult;
};

async function runCollection(
  env: Env,
  mode: CollectionMode,
): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const container = getContainer(env.COLLECTOR_CONTAINER, CONTAINER_ID);

  const diagnostics = createDiagnostics("prestia-globalpass", runId);
  try {
    const result = await collectWithContainer(env, mode, container, startedAt, runId, diagnostics);
    diagnostics.finish(result.status);
    return result;
  } catch (error) {
    diagnostics.failure("collection", error);
    diagnostics.finish("failed");
    throw error;
  } finally {
    try {
      await diagnostics.step("container-destroy", () => container.destroy());
      logEvent(
        "log",
        JSON.stringify({
          event: "globalpass-collection-container-destroyed",
          runId,
          mode,
        }),
      );
    } catch (error) {
      logEvent(
        "warn",
        JSON.stringify({
          event: "globalpass-collection-container-destroy-failed",
          runId,
          mode,
          ...safeErrorDetails(error),
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
  diagnostics: ReturnType<typeof createDiagnostics>,
): Promise<CollectionResult> {
  const prefix = runPrefix(startedAt, runId);
  const artifacts: StoredArtifact[] = [];
  const failures: CollectionFailure[] = [];
  let availableMonths: string[] = [];
  let selectedMonths: string[] = [];
  let runtimeRevision: string | undefined;
  let metadataSeen = false;
  let containerErrorSeen = false;
  let streamStarted = false;
  const attemptedMonths = new Set<string>();

  try {
    await diagnostics.step("container-start", () => container.startAndWaitForPorts());
    const response = await diagnostics.step("container-request", async () => {
      const result = await container.fetch(
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
            relayUrl: withRunId(env.RELAY_PUBLIC_URL, runId),
          }),
        }),
      );
      if (!result.ok || !result.body) {
        throw Object.assign(new Error("GLOBAL PASS container request failed"), { httpStatus: result.status });
      }
      return result;
    });
    streamStarted = true;

    for await (const record of readNdjson(response.body!)) {
      if (record.type === "metadata") {
        if (metadataSeen || containerErrorSeen) throw new CollectionContractError();
        try {
          assertCanonicalMonths(record.availableMonths, "availableMonths");
          assertCanonicalMonths(record.selectedMonths, "selectedMonths");
        } catch {
          throw new CollectionContractError();
        }
        const expected = selectedMonthsForMode(mode, record.availableMonths);
        if (!sameStrings(record.selectedMonths, expected)) {
          throw new CollectionContractError();
        }
        availableMonths = [...record.availableMonths];
        selectedMonths = [...record.selectedMonths];
        runtimeRevision = record.runtimeRevision;
        metadataSeen = true;
        continue;
      }
      if (record.type === "error") {
        if (containerErrorSeen) throw new CollectionContractError();
        containerErrorSeen = true;
        diagnostics.failure("browser-collection", Object.assign(new Error(), { name: record.errorType }));
        failures.push({
          operation: record.operation,
          errorType: record.errorType,
          errorCode: record.errorCode,
        });
        continue;
      }
      if (!metadataSeen || containerErrorSeen) throw new CollectionContractError();
      const month = safeMonth(record.month);
      const expectedMonth = selectedMonths[attemptedMonths.size];
      if (
        month !== expectedMonth ||
        !selectedMonths.includes(month) ||
        attemptedMonths.has(month)
      ) {
        throw new CollectionContractError();
      }
      attemptedMonths.add(month);
      const artifactKey = artifactFilename(month);
      let sanitizedHtml: string;
      try {
        sanitizedHtml = sanitizeGlobalPassActivityHtml(record.html);
      } catch (error) {
        diagnostics.failure("artifact-write", error);
        failures.push(collectionFailure(
          "sanitization",
          error,
          "html_sanitization_failed",
          artifactKey,
        ));
        continue;
      }
      try {
        artifacts.push(await diagnostics.step("artifact-write", () => storeHtml(
          env.SNAPSHOTS,
          prefix,
          runId,
          month,
          sanitizedHtml,
        )));
      } catch (error) {
        failures.push(collectionFailure(
          "r2",
          error,
          "artifact_store_failed",
          artifactKey,
        ));
      }
    }
  } catch (error) {
    diagnostics.failure("browser-collection", error);
    failures.push(collectionFailure(
      streamStarted ? "contract" : "browser-collection",
      error,
      streamStarted ? "container_contract_invalid" : "browser_collection_failed",
    ));
  }

  if (!metadataSeen && failures.length === 0) {
    failures.push(collectionFailure(
      "contract",
      new CollectionContractError(),
      "container_contract_invalid",
    ));
  }
  const storedMonths = new Set(artifacts.map((artifact) => artifact.month));
  const failedArtifactKeys = new Set(
    failures.flatMap((failure) => failure.artifactKey ? [failure.artifactKey] : []),
  );
  for (const month of selectedMonths) {
    const artifactKey = artifactFilename(month);
    if (!storedMonths.has(month) && !failedArtifactKeys.has(artifactKey)) {
      failures.push({
        operation: "contract",
        errorType: "CollectionContractError",
        errorCode: "selected_month_missing",
        artifactKey,
      });
    }
  }
  const { status, captureComplete } = strictCollectionStatus(
    artifacts,
    failures,
    selectedMonths,
  );
  const manifest: CollectionManifest = {
    schemaVersion: GLOBALPASS_SCHEMA_VERSION,
    source: "prestia-globalpass",
    runtimeRevision,
    runId,
    mode,
    startedAt,
    completedAt: new Date().toISOString(),
    status,
    availableMonths,
    selectedMonths,
    captureComplete,
    paginationStatus: GLOBALPASS_PAGINATION_STATUS,
    artifacts,
    failures,
  };
  const manifestKey = `${prefix}/manifest.json`;
  await diagnostics.step("manifest-write", () => env.SNAPSHOTS.put(manifestKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { source: manifest.source, status, runId },
  }));
  const central = await importStoredRun(env.RAW_EVIDENCE_IMPORTER, manifestKey);
  logEvent(
    "log",
    JSON.stringify({
      event: "globalpass-collection-stored",
      runId,
      mode,
      status,
      artifactCount: artifacts.length,
      failureCount: failures.length,
      manifestKey,
      centralStatus: central.status,
      ...(central.status === "sealed" ? { centralRunId: central.centralRunId } : {
        centralDeferredReason: central.reason,
        centralNextOffset: central.nextOffset,
      }),
    }),
  );
  return { ...manifest, manifestKey, central };
}

async function storeHtml(
  bucket: R2Bucket,
  prefix: string,
  runId: string,
  month: string,
  html: string,
): Promise<StoredArtifact> {
  const body = new TextEncoder().encode(html);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", body));
  const key = `${prefix}/${artifactFilename(month)}`;
  await bucket.put(key, body, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      source: "prestia-globalpass",
      runId,
      dataset: GLOBALPASS_DATASET,
      sha256,
    },
  });
  return {
    dataset: GLOBALPASS_DATASET,
    month,
    key,
    mediaType: GLOBALPASS_MEDIA_TYPE,
    bytes: body.byteLength,
    sha256,
  };
}

async function* readNdjson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ContainerRecord> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
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
    exactKeys(record, [
      "type",
      "availableMonths",
      "selectedMonths",
      "browserVersion",
    ], ["runtimeRevision"]) &&
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
    exactKeys(record, ["type", "month", "html"]) &&
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
    exactKeys(record, ["type", "operation", "errorType", "errorCode"]) &&
    record["operation"] === "browser-collection" &&
    typeof record["errorType"] === "string" &&
    /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(record["errorType"]) &&
    record["errorCode"] === "browser_collection_failed"
  ) {
    return {
      type: "error",
      operation: record["operation"],
      errorType: record["errorType"],
      errorCode: record["errorCode"],
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
  const network = url.searchParams.get("network") ?? "tamia";
  if (!RELAY_HOSTS.has(hostname) || port !== 443) {
    return Response.json({ error: "Target denied" }, { status: 403 });
  }
  if (network !== "tamia" && network !== "cf-gateway") {
    return Response.json({ error: "Network denied" }, { status: 403 });
  }

  const runId = relayRunId(url);
  const relayId = crypto.randomUUID();
  let peerClosed = false;
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const binding = network === "cf-gateway" ? env.CF_EGRESS : env.MESH;
  const socket = (binding as VpcNetworkBinding).connect({ hostname, port });
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
        logEvent(
          "error",
          JSON.stringify({
            event: "globalpass-relay-read-error",
            phase: "relay",
            runId,
            relayId,
            peerClosed,
            ...safeErrorDetails(error),
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
        logEvent(
          "error",
          JSON.stringify({
            event: "globalpass-relay-write-error",
            phase: "relay",
            runId,
            relayId,
            peerClosed,
            ...safeErrorDetails(error),
          }),
        ),
      ),
    );
  });
  server.addEventListener("close", () => {
    peerClosed = true;
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

function collectionFailure(
  operation: CollectionFailure["operation"],
  error: unknown,
  errorCode: CollectionFailure["errorCode"],
  artifactKey?: string,
): CollectionFailure {
  return {
    operation,
    errorType: safeErrorType(error),
    errorCode,
    ...(artifactKey ? { artifactKey } : {}),
  };
}

function safeErrorType(error: unknown): string {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(candidate)
    ? candidate
    : "UnknownError";
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function safeOpaque(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !/[\x00-\x20\x7f]/u.test(value);
}

function publicCollectionResult(result: CollectionResult): object {
  return {
    runId: result.runId,
    mode: result.mode,
    status: result.status,
    captureComplete: result.captureComplete,
    paginationStatus: result.paginationStatus,
    availableMonthCount: result.availableMonths.length,
    selectedMonthCount: result.selectedMonths.length,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    manifestKey: result.manifestKey,
    central: {
      status: result.central.status,
      ...(result.central.status === "sealed"
        ? { centralRunId: result.central.centralRunId, sealed: result.central.sealed }
        : {
          reason: result.central.reason,
          artifactCount: result.central.artifactCount,
          nextOffset: result.central.nextOffset,
        }),
    },
  };
}

class CollectionContractError extends Error {
  constructor() {
    super("GLOBAL PASS container contract invalid");
    this.name = "CollectionContractError";
  }
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
