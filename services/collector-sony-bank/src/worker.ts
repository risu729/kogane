import { atStage, emitDiagnostic, failure } from "./diagnostics";
import { timingSafeEqual } from "node:crypto";
import { collectSonyBank, parseCredential } from "./sony-bank";
import { backfillStoredRuns, importStoredRun } from "./raw-evidence";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type { CollectionFailure, CollectionManifest, CollectionResult } from "./types";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "sony-bank",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (request.method === "POST" && url.pathname === "/backfill-raw-evidence") {
      try {
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const limit = parseBackfillLimit(url.searchParams.get("limit"));
        return Response.json(
          await backfillStoredRuns(env.RAW_EVIDENCE_IMPORTER, {
            ...(cursor ? { cursor } : {}),
            ...(limit ? { limit } : {}),
          }),
        );
      } catch (error) {
        return Response.json({ error: stableError(error) }, { status: 502 });
      }
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    try {
      const window = parseWindow(url.searchParams.get("from"), url.searchParams.get("to"));
      const result = await runCollection(env, window);
      return Response.json(publicResult(result), {
        status: result.status === "failed" ? 502 : 200,
      });
    } catch (error) {
      return Response.json({ error: publicError(error) }, { status: 400 });
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env, defaultWindow(new Date()));
    if (result.status === "failed") {
      throw new Error(`Sony Bank collection failed; manifest=${result.manifestKey}`);
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
  let transactionCount = 0;

  try {
    const credential = await atStage("credential", async () =>
      parseCredential(requiredSecret(env.SONY_BANK_CREDENTIAL_JSON, "SONY_BANK_CREDENTIAL_JSON")),
    );
    const collection = await collectSonyBank({
      credential,
      from: window.from,
      to: window.to,
      runId,
    });
    transactionCount = collection.transactionCount;
    for (const artifact of collection.artifacts) {
      try {
        artifacts.push(
          await storeArtifact({
            bucket: env.SNAPSHOTS,
            prefix,
            runId,
            artifact,
          }),
        );
      } catch (error) {
        failures.push(failure(`r2:${artifact.dataset}`, error));
      }
    }
  } catch (error) {
    failures.push(failure("collect", error));
  }

  for (const entry of failures) {
    emitDiagnostic("error", {
      event: "sony-bank-collection-failure",
      runId,
      phase: "collection",
      ...entry,
    });
  }
  const completedAt = new Date().toISOString();
  const status = failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial";
  const manifest: CollectionManifest = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    source: "sony-bank",
    runId,
    startedAt,
    completedAt,
    status,
    window,
    transactionCount,
    artifacts,
    failures,
  };
  const manifestKey = await storeManifest({
    bucket: env.SNAPSHOTS,
    prefix,
    manifest,
  }).catch(() => {
    emitDiagnostic("error", {
      event: "sony-bank-manifest-write-failed",
      runId,
      phase: "manifest-write",
    });
    throw new Error("manifest_write_failed");
  });
  const central = await importStoredRun(env.RAW_EVIDENCE_IMPORTER, manifestKey).catch(() => {
    emitDiagnostic("error", {
      event: "sony-bank-raw-evidence-import-failed",
      runId,
      phase: "raw-evidence-import",
    });
    throw new Error("raw_evidence_import_failed");
  });
  emitDiagnostic("log", {
    event: "sony-bank-collection-stored",
    runId,
    status,
    transactionCount,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    manifestKey,
    centralStatus: central.status,
    ...(central.status === "sealed" ? { centralRunId: central.centralRunId } : {}),
  });
  return { ...manifest, manifestKey, central };
}

function parseWindow(from: string | null, to: string | null): { from: string; to: string } {
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
  const days =
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ) + 1;
  if (days > 366) throw new Error("a trigger window must not exceed 366 days");
  return { from, to };
}

function defaultWindow(now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

function validDate(value: string): boolean {
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
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

function publicError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Unknown error";
  return value
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/(password|loginPwd|cookie|csrf|token)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 300);
}

function publicResult(result: CollectionResult): object {
  return {
    runId: result.runId,
    status: result.status,
    window: result.window,
    transactionCount: result.transactionCount,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    manifestKey: result.manifestKey,
    central:
      result.central.status === "sealed"
        ? {
            status: result.central.status,
            centralRunId: result.central.centralRunId,
            sealed: result.central.sealed,
          }
        : {
            status: result.central.status,
            reason: result.central.reason,
            nextOffset: result.central.nextOffset,
          },
  };
}

function parseBackfillLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (value !== "1") throw new Error("backfill_limit_must_be_one");
  return 1;
}

function stableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "request_failed";
  const match = message.match(/(?:^|: )([a-z0-9_-]{1,100})$/u);
  return match?.[1] ?? "request_failed";
}
