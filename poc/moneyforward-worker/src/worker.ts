import { timingSafeEqual } from "node:crypto";
import { collectMoneyForward } from "./moneyforward";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type { CollectionFailure, CollectionManifest } from "./types";
import { parseCredential } from "./webauthn";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "moneyforward-me",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      }, { headers: { "cache-control": "no-store" } });
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
      headers: { "cache-control": "no-store" },
    });
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env);
    if (result.status === "failed") {
      throw new Error(`Money Forward collection failed; manifest=${result.manifestKey}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function runCollection(
  env: Env,
): Promise<CollectionManifest & { manifestKey: string }> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const artifacts = [];
  const failures: CollectionFailure[] = [];
  let accountDetailCount = 0;
  let monthlyFragmentCount = 0;
  try {
    const collection = await collectMoneyForward({
      credential: parseCredential(requiredSecret(
        env.MONEYFORWARD_CREDENTIAL_JSON,
        "MONEYFORWARD_CREDENTIAL_JSON",
      )),
    });
    accountDetailCount = collection.accountDetailCount;
    monthlyFragmentCount = collection.monthlyFragmentCount;
    for (const artifact of collection.artifacts) {
      try {
        artifacts.push(await storeArtifact({ bucket: env.SNAPSHOTS, prefix, artifact }));
      } catch (error) {
        failures.push(failure(`r2:${artifact.dataset}`, error));
      }
    }
  } catch (error) {
    failures.push(failure("collect", error));
  }
  const completedAt = new Date().toISOString();
  const status = failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial";
  const manifest: CollectionManifest = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    source: "moneyforward-me",
    runId,
    startedAt,
    completedAt,
    status,
    accountDetailCount,
    monthlyFragmentCount,
    artifacts,
    failures,
  };
  const manifestKey = await storeManifest({ bucket: env.SNAPSHOTS, prefix, manifest });
  console.log(JSON.stringify({
    event: "moneyforward-collection-stored",
    runId,
    status,
    accountDetailCount,
    monthlyFragmentCount,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    manifestKey,
  }));
  return { ...manifest, manifestKey };
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
    .replace(/(cookie|csrf|token|challenge|credential)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 300);
}

function publicResult(result: CollectionManifest & { manifestKey: string }): object {
  return {
    runId: result.runId,
    status: result.status,
    accountDetailCount: result.accountDetailCount,
    monthlyFragmentCount: result.monthlyFragmentCount,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    manifestKey: result.manifestKey,
  };
}
