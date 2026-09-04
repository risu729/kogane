import { timingSafeEqual } from "node:crypto";
import { collectMobileSuica, parseSessionEnvelope } from "./mobile-suica";
import { backfillStoredRuns, importStoredRun } from "./raw-evidence";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type { CollectionFailure, CollectionManifest, CollectionResult, StoredArtifact } from "./types";
import { checkStoredJreCredential, parseStoredJreCredential } from "./webauthn";
import {
  bootstrapMobileSuicaSessionWithBrowser,
  checkBrowserPasskeyLogin,
  inspectBrowserBootstrap,
} from "./browser-bootstrap";

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
    if (request.method === "POST" && url.pathname === "/credential-check") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const credential = parseStoredJreCredential(
        requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
      );
      const check = checkStoredJreCredential(credential);
      return Response.json({
        ok: check.verified,
        rpId: credential.rpId,
        algorithm: "ES256",
        credentialIdBytes: check.credentialIdBytes,
        authenticatorDataBytes: check.authenticatorDataBytes,
        flags: check.flags,
        signCount: check.signCount,
        syncedAt: credential.syncedAt,
      }, { status: check.verified ? 200 : 500 });
    }
    if (request.method === "POST" && url.pathname === "/browser-bootstrap-inspect") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const credential = parseStoredJreCredential(
          requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
        );
        return Response.json(await inspectBrowserBootstrap(env.BROWSER, credential));
      } catch (error) {
        return Response.json({
          ok: false,
          errorType: error instanceof Error ? error.name : "UnknownError",
          message: publicError(error),
        }, { status: 502 });
      }
    }
    if (request.method === "POST" && url.pathname === "/browser-login-check") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const credential = parseStoredJreCredential(
          requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
        );
        const result = await checkBrowserPasskeyLogin(env.BROWSER, credential);
        return Response.json(result, { status: result.ok ? 200 : 502 });
      } catch (error) {
        return Response.json({
          ok: false,
          errorType: error instanceof Error ? error.name : "UnknownError",
          message: publicError(error),
        }, { status: 502 });
      }
    }
    if (request.method === "POST" && url.pathname === "/browser-session-check") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const credential = parseStoredJreCredential(
          requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
        );
        const session = parseSessionEnvelope(JSON.stringify(
          await bootstrapMobileSuicaSessionWithBrowser(env.BROWSER, credential),
        ));
        return Response.json({
          ok: true,
          capturedAt: session.capturedAt,
          cookieNames: session.cookieHeader.split(";").map((part) => part.split("=", 1)[0]?.trim()).sort(),
          hasFormState: new URLSearchParams(session.formBody).has("baseVariable"),
        });
      } catch (error) {
        return Response.json({
          ok: false,
          errorType: error instanceof Error ? error.name : "UnknownError",
          message: publicError(error),
        }, { status: 502 });
      }
    }
    if (request.method === "POST" && url.pathname === "/backfill-raw-evidence") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (url.searchParams.get("limit") !== "1") {
        return Response.json({ error: "limit_must_be_one" }, { status: 400 });
      }
      try {
        const cursor = url.searchParams.get("cursor") ?? undefined;
        return Response.json(await backfillStoredRuns(env.RAW_EVIDENCE_IMPORTER, cursor));
      } catch {
        return Response.json({ error: "raw_evidence_backfill_failed" }, { status: 502 });
      }
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
      status: result.status === "success" ? 200 : 502,
    });
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env, tokyoDate(new Date()));
    if (result.status !== "success") {
      throw new Error(`Mobile Suica collection incomplete; manifest=${result.manifestKey}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function runCollection(env: Env, asOfDateJst: string): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const artifacts: StoredArtifact[] = [];
  const failures: CollectionFailure[] = [];
  let transactionCount = 0;
  let pageCount = 0;
  let complete = false;
  let capturedSessionAt: string | undefined;

  try {
    const credential = parseStoredJreCredential(
      requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
    );
    const session = parseSessionEnvelope(JSON.stringify(
      await bootstrapMobileSuicaSessionWithBrowser(env.BROWSER, credential),
    ));
    capturedSessionAt = session.capturedAt;
    const collection = await collectMobileSuica({ session, asOfDateJst });
    transactionCount = collection.rows.length;
    pageCount = collection.pageCount;
    complete = collection.complete;
    if (!collection.complete) {
      failures.push({
        operation: "pagination",
        errorType: "HistoryBoundaryError",
        errorCode: "history_boundary_unproven",
      });
    }
    for (const artifact of collection.artifacts) {
      try {
        artifacts.push(await storeArtifact({ bucket: env.SNAPSHOTS, prefix, runId, artifact }));
      } catch (error) {
        failures.push(failure("r2", error, "artifact_store_failed", artifact.filename));
      }
    }
  } catch (error) {
    failures.push(failure("collect", error, "collection_failed"));
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
    complete,
    artifacts,
    failures,
  };
  const manifestKey = await storeManifest({ bucket: env.SNAPSHOTS, prefix, manifest });
  const central = await importStoredRun(env.RAW_EVIDENCE_IMPORTER, manifestKey);
  console.log(JSON.stringify({
    event: "mobile-suica-collection-stored",
    runId,
    status,
    transactionCount,
    pageCount,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    manifestKey,
    centralStatus: central.status,
    centralRunId: central.centralRunId,
  }));
  return { ...manifest, manifestKey, central };
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

function failure(
  operation: CollectionFailure["operation"],
  error: unknown,
  errorCode: CollectionFailure["errorCode"],
  artifactKey?: string,
): CollectionFailure {
  return {
    operation,
    errorType: error instanceof Error ? error.name : "UnknownError",
    errorCode,
    ...(artifactKey ? { artifactKey } : {}),
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
    central: {
      status: result.central.status,
      centralRunId: result.central.centralRunId,
      sealed: result.central.sealed,
    },
  };
}
