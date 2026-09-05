import { createDiagnostics, safeErrorDetails } from "../../collector-diagnostics/src/index";
import { collectConnection, parseCredentialSecrets } from "./collector";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type {
  CollectionFailure,
  CollectionManifest,
  ConnectionSummary,
  StoredArtifact,
} from "./types";
import { HumanRequiredError, StopConditionError } from "./types";

type MyJcbEnv = Env & {
  readonly MYJCB_CONNECTIONS_JSON?: string;
  readonly MYJCB_CONNECTION_SECRET_NAMES?: string;
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
    if (!await authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await runCollection(env, "manual");
    return Response.json({
      runId: result.manifest.runId,
      status: result.manifest.status,
      connectionCount: result.manifest.connections.length,
      artifactCount: result.manifest.artifacts.length,
      failureCount: result.manifest.failures.length,
      blockers: result.manifest.connections.flatMap((connection) =>
        connection.blocker === undefined
          ? []
          : [{ connectionId: connection.connectionId, code: connection.blocker }]
      ),
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
  const diagnostic = createDiagnostics("myjcb", runId);
  try {
    const prefix = runPrefix(startedAt, runId);
    const credentials = await diagnostic.step("configuration", () => parseCredentialSecrets(connectionSecretValues(env)));
    const artifacts: StoredArtifact[] = [];
    const connections: ConnectionSummary[] = [];
    const failures: CollectionFailure[] = [];

    for (const credential of credentials) {
      try {
        const collected = await diagnostic.step("connection-collection", () => collectConnection({
          browserBinding: env.BROWSER,
          credential,
          diagnostic,
        }));
        let stored = 0;
        for (const artifact of collected.artifacts) {
          try {
            artifacts.push(await diagnostic.step("artifact-write", () => storeArtifact({
              bucket: env.SNAPSHOTS,
              prefix,
              connectionId: credential.connectionId,
              artifact,
            })));
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
    const manifestKey = await diagnostic.step("manifest-write", () => storeManifest({ bucket: env.SNAPSHOTS, prefix, manifest }));
    console.log(JSON.stringify({
      event: "myjcb-collection-stored",
      runId,
      status: manifest.status,
      connectionCount: connections.length,
      artifactCount: artifacts.length,
      failureCount: failures.length,
      manifestKey,
    }));
    diagnostic.finish(manifest.status);
    return { manifest, manifestKey };
  } catch (error) {
    diagnostic.finish("failed");
    throw error;
  }
}

async function authorized(request: Request, expected: string | undefined): Promise<boolean> {
  const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu)?.[1];
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (!hasTimingSafeEqual(crypto.subtle)) {
    throw new Error("Worker runtime omitted crypto.subtle.timingSafeEqual");
  }
  return crypto.subtle.timingSafeEqual(left, right);
}

function hasTimingSafeEqual(
  subtle: SubtleCrypto,
): subtle is SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean;
} {
  return typeof Reflect.get(subtle, "timingSafeEqual") === "function";
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}

function connectionSecretValues(env: MyJcbEnv): string[] {
  const names = env.MYJCB_CONNECTION_SECRET_NAMES
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean) ?? [];
  if (names.length === 0) {
    return [requiredSecret(env.MYJCB_CONNECTIONS_JSON, "MYJCB_CONNECTIONS_JSON")];
  }
  if (names.length > 16 || new Set(names).size !== names.length) {
    throw new Error("MYJCB_CONNECTION_SECRET_NAMES must contain 1 to 16 unique names");
  }
  return names.map((name) => {
    if (!/^MYJCB_ACCOUNT_[A-Z0-9_]{1,48}_JSON$/u.test(name)) {
      throw new Error("MYJCB connection secret name is invalid");
    }
    const value = Reflect.get(env, name);
    if (typeof value !== "string" || value === "") {
      throw new Error(`Missing Worker secret binding: ${name}`);
    }
    return value;
  });
}

function failure(
  connectionId: string,
  operation: string,
  error: unknown,
): CollectionFailure {
  return {
    connectionId,
    operation,
    errorType: safeErrorDetails(error).errorType,
    message: publicError(error),
  };
}

function publicError(error: unknown): string {
  if (error instanceof HumanRequiredError) return `human-required:${error.reason}`;
  if (error instanceof StopConditionError) return error.code;
  if (error instanceof SyntaxError || error instanceof TypeError) {
    return "Collector configuration or response schema is invalid";
  }
  return "Collector operation failed";
}
