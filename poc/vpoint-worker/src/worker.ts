import { timingSafeEqual } from "node:crypto";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type {
  CollectionFailure,
  CollectionManifest,
  CollectionResult,
} from "./types";
import { collectVPoint } from "./vpoint";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "v-point",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await runCollection(env);
    return Response.json(publicResult(result), {
      status: result.status === "failed" ? 502 : 200,
    });
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env);
    if (result.status === "failed") {
      throw new Error(`V Point collection failed; manifest=${result.manifestKey}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function runCollection(env: Env): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const artifacts = [];
  const failures: CollectionFailure[] = [];
  let historyTotal = 0;
  let historyPageCount = 0;

  try {
    const collection = await collectVPoint({
      sessionCookie: requiredSecret(
        env.VPOINT_SESSION_COOKIE,
        "VPOINT_SESSION_COOKIE",
      ),
    });
    historyTotal = collection.historyTotal;
    historyPageCount = collection.historyPageCount;
    for (const artifact of collection.artifacts) {
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
  }

  const completedAt = new Date().toISOString();
  const status = failures.length === 0
    ? "success"
    : artifacts.length === 0
      ? "failed"
      : "partial";
  const manifest: CollectionManifest = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    source: "v-point",
    runId,
    startedAt,
    completedAt,
    status,
    historyTotal,
    historyPageCount,
    artifacts,
    failures,
  };
  const manifestKey = await storeManifest({
    bucket: env.SNAPSHOTS,
    prefix,
    manifest,
  });
  console.log(JSON.stringify({
    event: "vpoint-collection-stored",
    runId,
    status,
    historyTotal,
    historyPageCount,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    manifestKey,
  }));
  return { ...manifest, manifestKey };
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
    .replace(/(cookie|session|token)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 300);
}

function publicResult(result: CollectionResult): object {
  return {
    runId: result.runId,
    status: result.status,
    historyTotal: result.historyTotal,
    historyPageCount: result.historyPageCount,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    manifestKey: result.manifestKey,
  };
}
