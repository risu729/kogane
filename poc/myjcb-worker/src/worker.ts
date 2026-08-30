import { timingSafeEqual } from "node:crypto";
import { collectConnection, parseCredentials } from "./collector";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type {
  CollectionFailure,
  CollectionManifest,
  ConnectionSummary,
  StoredArtifact,
} from "./types";
import { HumanRequiredError } from "./types";

type MyJcbEnv = Env & {
  readonly MYJCB_CONNECTIONS_JSON?: string;
  readonly ADMIN_TRIGGER_TOKEN?: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "myjcb",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await runCollection(env, "manual");
    return Response.json({
      runId: result.manifest.runId,
      status: result.manifest.status,
      connectionCount: result.manifest.connections.length,
      artifactCount: result.manifest.artifacts.length,
      failureCount: result.manifest.failures.length,
      manifestKey: result.manifestKey,
    }, { status: result.manifest.status === "failed" ? 502 : 200 });
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env, "scheduled");
    if (result.manifest.status === "failed") {
      throw new Error(`MyJCB collection failed; manifest=${result.manifestKey}`);
    }
  },
} satisfies ExportedHandler<MyJcbEnv>;

async function runCollection(
  env: MyJcbEnv,
  trigger: CollectionManifest["trigger"],
): Promise<{ manifest: CollectionManifest; manifestKey: string }> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const credentials = parseCredentials(requiredSecret(
    env.MYJCB_CONNECTIONS_JSON,
    "MYJCB_CONNECTIONS_JSON",
  ));
  const artifacts: StoredArtifact[] = [];
  const connections: ConnectionSummary[] = [];
  const failures: CollectionFailure[] = [];

  for (const credential of credentials) {
    try {
      const collected = await collectConnection({
        browserBinding: env.BROWSER,
        credential,
      });
      let stored = 0;
      for (const artifact of collected.artifacts) {
        try {
          artifacts.push(await storeArtifact({
            bucket: env.SNAPSHOTS,
            prefix,
            connectionId: credential.connectionId,
            artifact,
          }));
          stored += 1;
        } catch (error) {
          failures.push(failure(credential.connectionId, `r2:${artifact.dataset}`, error));
        }
      }
      connections.push({
        ...collected.summary,
        status: stored === collected.artifacts.length ? "success" : "partial",
        artifactCount: stored,
      });
    } catch (error) {
      const humanRequired = error instanceof HumanRequiredError;
      connections.push({
        connectionId: credential.connectionId,
        bootstrapMode: credential.bootstrapMode,
        status: humanRequired ? "human-required" : "failed",
        cardCount: 0,
        periodCount: 0,
        artifactCount: 0,
        blocker: publicError(error),
      });
      failures.push(failure(credential.connectionId, "collect", error));
    }
  }

  const completedAt = new Date().toISOString();
  const manifest: CollectionManifest = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    source: "myjcb",
    runId,
    startedAt,
    completedAt,
    status: failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial",
    trigger,
    connections,
    artifacts,
    failures,
  };
  const manifestKey = await storeManifest({ bucket: env.SNAPSHOTS, prefix, manifest });
  console.log(JSON.stringify({
    event: "myjcb-collection-stored",
    runId,
    status: manifest.status,
    connectionCount: connections.length,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    manifestKey,
  }));
  return { manifest, manifestKey };
}

function authorized(request: Request, expected: string | undefined): boolean {
  const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu)?.[1];
  if (!provided || !expected) return false;
  const left = new TextEncoder().encode(provided);
  const right = new TextEncoder().encode(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}

function failure(
  connectionId: string,
  operation: string,
  error: unknown,
): CollectionFailure {
  return {
    connectionId,
    operation,
    errorType: error instanceof Error ? error.name : "UnknownError",
    message: publicError(error),
  };
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/(password|userId|cookie|csrf|token|otp)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 300);
}
