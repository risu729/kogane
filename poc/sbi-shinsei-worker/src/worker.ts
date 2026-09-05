import { startTcpRelay } from "./tcp-relay";
import { ContainerResponseError, emitDiagnostic, failure, safeErrorType, stageDiagnostics } from "./diagnostics";
import { Container, getContainer } from "@cloudflare/containers";
import { createHash, timingSafeEqual } from "node:crypto";
import { collectSbiShinsei } from "./collector";
import { liveReadsEnabled } from "./read-allowlist";
import {
  backfillRawEvidence,
  importRawEvidence,
  RawEvidenceImportError,
} from "./raw-evidence";
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
    emitDiagnostic("log", { event: "sbi-shinsei-container-start" });
  }

  override onStop(): void {
    emitDiagnostic("log", { event: "sbi-shinsei-container-stop" });
  }

  override onError(error: unknown): void {
    emitDiagnostic("error", {
      event: "sbi-shinsei-container-error",
      errorType: safeErrorType(error),
    });
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
    if (request.method === "POST" && url.pathname === "/backfill-raw-evidence") {
      if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const limit = parseBackfillLimit(url.searchParams.get("limit"));
        return Response.json(await backfillRawEvidence({
          importer: env.RAW_EVIDENCE_IMPORTER,
          ...(cursor ? { cursor } : {}),
          ...(limit ? { limit } : {}),
        }));
      } catch (error) {
        return Response.json(
          { error: error instanceof RawEvidenceImportError
            ? "raw_evidence_import_failed"
            : "backfill_request_invalid" },
          { status: error instanceof RawEvidenceImportError ? 502 : 400 },
        );
      }
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (url.searchParams.size !== 0) {
      return Response.json(
        { error: "SBI Shinsei collection is a current snapshot and accepts no date range" },
        { status: 400 },
      );
    }

    try {
      const result = await runCollection(env);
      return Response.json(publicResult(result), {
        status: result.status === "failed" ? 503 : 200,
      });
    } catch (error) {
      return Response.json(
        { error: publicError(error) },
        { status: error instanceof RawEvidenceImportError ? 502 : 400 },
      );
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env);
    if (result.status === "failed") {
      throw new Error(
        `SBI Shinsei collection failed; manifest=${result.manifestKey}`,
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function runCollection(env: Env): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const diagnostic = stageDiagnostics(runId);
  const prefix = runPrefix(startedAt, runId);
  const artifacts = [];
  const failures: CollectionFailure[] = [];
  const container = getContainer(env.COLLECTOR_CONTAINER, `run-${runId}`);

  let stage = "credential-validation";
  try {
    const output = await diagnostic.step("collection", () => collectSbiShinsei({
      credentialJson: env.SBI_SHINSEI_CREDENTIAL_JSON,
      collectHandoff: async (credentialJson) => {
        stage = "container-start";
        await diagnostic.step(stage, () => container.startAndWaitForPorts());
        stage = "container-request";
        const relayUrl = new URL(env.RELAY_PUBLIC_URL);
        relayUrl.searchParams.set("runId", runId);
        const response = await diagnostic.step(stage, async () => {
          const response = await container.fetch(new Request("http://container/collect", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            credentialJson,
            relayToken: requiredSecret(env.RELAY_TOKEN, "RELAY_TOKEN"),
            relayUrl: relayUrl.href,
          }),
          }));
          if (!response.ok) throw new ContainerResponseError(response.status);
          return response;
        });
        stage = "container-response";
        const handoff = await diagnostic.step(stage, () => readBoundedText(response, MAX_CONTAINER_RESPONSE_BYTES));
        stage = "browser-handoff";
        return handoff;
      },
    }), value => value.failures.length === 0 ? "success" : value.artifacts.length === 0 ? "failed" : "partial");
    failures.push(...output.failures);
    for (const artifact of output.artifacts) {
      try {
        artifacts.push(await diagnostic.step("staging-write", () => storeArtifact({
          bucket: env.SNAPSHOTS,
          prefix,
          runId,
          artifact,
        })));
      } catch (error) {
        failures.push(failure(`r2:${artifact.dataset}`, error));
      }
    }
  } catch (error) {
    failures.push(failure("collect", error, stage));
  } finally {
    // Emit before teardown and before central import so a later failure cannot hide the cause.
    for (const entry of failures) {
      emitDiagnostic("error", { event: "sbi-shinsei-collection-failure", runId, phase: "collection", ...entry });
    }
    emitDiagnostic("log", { event: "sbi-shinsei-container-teardown-start", runId, phase: "teardown", collectionFailed: failures.length > 0 });
    try {
      await diagnostic.step("teardown", () => container.destroy());
      emitDiagnostic("log", {
        event: "sbi-shinsei-container-destroyed",
        runId,
        phase: "teardown",
      });
    } catch (error) {
      emitDiagnostic("warn", {
        event: "sbi-shinsei-container-destroy-failed",
        runId,
        phase: "teardown",
        errorType: safeErrorType(error),
      });
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
    liveReadsEnabled: liveReadsEnabled(),
    artifacts,
    failures,
  };
  const manifestKey = await diagnostic.step("manifest-write", () => storeManifest({
    bucket: env.SNAPSHOTS,
    prefix,
    manifest,
  })).catch(() => {
    emitDiagnostic("error", { event: "sbi-shinsei-manifest-write-failed", runId, phase: "manifest-write" });
    diagnostic.terminal("failed");
    throw new Error("manifest_write_failed");
  });
  // Source collection and central import are separate outcomes.
  diagnostic.terminal(status);
  try {
    await diagnostic.step("raw-evidence-import", () => importRawEvidence({
      importer: env.RAW_EVIDENCE_IMPORTER,
      manifestKey,
    }));
  } catch (error) {
    emitDiagnostic("error", {
      event: "sbi-shinsei-raw-evidence-import-failed",
      runId,
      phase: "raw-evidence-import",
      errorCode: "raw_evidence_import_failed",
    });
    throw error;
  }
  emitDiagnostic("log", {
    event: "sbi-shinsei-collection-stored",
    runId,
    status,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    liveReadsEnabled: manifest.liveReadsEnabled,
    manifestKey,
  });
  return { ...manifest, manifestKey };
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

  // Only the collector-generated UUID is eligible for correlation, never a URL/token.
  const runIdValue = url.searchParams.get("runId");
  const runId = runIdValue && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runIdValue)
    ? runIdValue : undefined;
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const socket = (env.MESH as VpcNetworkBinding).connect({ hostname, port });
  startTcpRelay({ socket, server, waitUntil: promise => ctx.waitUntil(promise), ...(runId ? { runId } : {}) });
  return new Response(null, { status: 101, webSocket: client });
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
    liveReadsEnabled: result.liveReadsEnabled,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    manifestKey: result.manifestKey,
  };
}

function parseBackfillLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (value !== "1") throw new Error("backfill_limit_must_be_one");
  return 1;
}
