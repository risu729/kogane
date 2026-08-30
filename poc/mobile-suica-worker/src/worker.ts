import { timingSafeEqual } from "node:crypto";
import { collectMobileSuica, parseSessionEnvelope } from "./mobile-suica";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type { CollectionFailure, CollectionManifest, CollectionResult } from "./types";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "mobile-suica",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const asOfDateJst = url.searchParams.get("asOf") ?? tokyoDate(new Date());
    if (!validDate(asOfDateJst)) {
      return Response.json({ error: "asOf must be a valid YYYY-MM-DD" }, { status: 400 });
    }
    const result = await runCollection(env, asOfDateJst);
    return Response.json(publicResult(result), {
      status: result.status === "failed" ? 502 : 200,
    });
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env, tokyoDate(new Date()));
    if (result.status === "failed") {
      throw new Error(`Mobile Suica collection failed; manifest=${result.manifestKey}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function runCollection(env: Env, asOfDateJst: string): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const artifacts = [];
  const failures: CollectionFailure[] = [];
  let transactionCount = 0;
  let pageCount = 0;
  let capturedSessionAt: string | undefined;

  try {
    const session = parseSessionEnvelope(
      requiredSecret(secretBinding(env, "MOBILE_SUICA_SESSION_JSON"), "MOBILE_SUICA_SESSION_JSON"),
    );
    capturedSessionAt = session.capturedAt;
    const collection = await collectMobileSuica({ session, asOfDateJst });
    transactionCount = collection.rows.length;
    pageCount = collection.pageCount;
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
    source: "mobile-suica",
    runId,
    startedAt,
    completedAt,
    status,
    asOfDateJst,
    ...(capturedSessionAt ? { capturedSessionAt } : {}),
    transactionCount,
    pageCount,
    artifacts,
    failures,
  };
  const manifestKey = await storeManifest({ bucket: env.SNAPSHOTS, prefix, manifest });
  console.log(JSON.stringify({
    event: "mobile-suica-collection-stored",
    runId,
    status,
    transactionCount,
    pageCount,
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

function secretBinding(env: Env, name: string): string | undefined {
  const value = Reflect.get(env, name);
  return typeof value === "string" ? value : undefined;
}

function tokyoDate(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
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
    .replace(/(cookie|session|baseVariable|token|assertion)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 300);
}

function publicResult(result: CollectionResult): object {
  return {
    runId: result.runId,
    status: result.status,
    asOfDateJst: result.asOfDateJst,
    transactionCount: result.transactionCount,
    pageCount: result.pageCount,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    manifestKey: result.manifestKey,
  };
}
