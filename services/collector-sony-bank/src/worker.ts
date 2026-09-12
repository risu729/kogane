import { timingSafeEqual } from "node:crypto";
import { atStage, emitDiagnostic, failure } from "./diagnostics";
import { persistSharedRun, sharedBucket, sharedRunDiagnostic } from "./shared-collection";
import { collectSonyBank, parseCredential } from "./sony-bank";
import type { CollectionFailure, CollectionManifest, RawArtifact } from "./types";
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
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    try {
      const window = parseWindow(url.searchParams.get("from"), url.searchParams.get("to"));
      {
        const shared = await runSharedCollection(env, window);
        return Response.json(shared, { status: sharedRunFailed(shared) ? 502 : 200 });
      }
    } catch (error) {
      return Response.json({ error: publicError(error) }, { status: 400 });
    }
  },
  async scheduled(_controller, env): Promise<void> {
    const window = defaultWindow(new Date());
    {
      const shared = await runSharedCollection(env, window);
      // A run whose terminal was not written is not a finished run (G1-01).
      if (sharedRunFailed(shared)) {
        throw new Error(`Sony Bank shared collection did not complete; run=${shared.runId}`);
      }
      return;
    }
  },
} satisfies ExportedHandler<Env>;
interface SharedResult {
  readonly runId: string;
  readonly status: CollectionManifest["status"];
  readonly window: {
    from: string;
    to: string;
  };
  readonly transactionCount: number;
  readonly artifactCount: number;
  readonly failureCount: number;
  readonly persistence: string;
  readonly terminalKey: string;
}
function sharedRunFailed(result: SharedResult): boolean {
  return (
    result.status === "failed" ||
    (result.persistence !== "persisted" && result.persistence !== "already_persisted")
  );
}
/**
 * The shared-target run (unified plan U09): the same collection, persisted to
 * the common DATA bucket through `packages/collection` with the terminal
 * written last. Nothing is written to the per-source bucket and the importer
 * is never called, so the run's bytes exist once (G1-15).
 */
async function runSharedCollection(
  env: Env,
  window: {
    from: string;
    to: string;
  },
): Promise<SharedResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const failures: CollectionFailure[] = [];
  let artifacts: readonly RawArtifact[] = [];
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
    artifacts = collection.artifacts;
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
  const input = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    runId,
    startedAt,
    completedAt,
    status,
    window,
    transactionCount,
    artifacts,
    failures,
  } as const;
  const outcome = await persistSharedRun(sharedBucket(env.DATA), input);
  emitDiagnostic(
    outcome.result.outcome === "persisted" || outcome.result.outcome === "already_persisted"
      ? "log"
      : "error",
    sharedRunDiagnostic(input, outcome),
  );
  return {
    runId,
    status,
    window,
    transactionCount,
    artifactCount: outcome.artifactCount,
    failureCount: failures.length,
    persistence: outcome.result.outcome,
    terminalKey: outcome.result.terminalKey,
  };
}
function parseWindow(
  from: string | null,
  to: string | null,
): {
  from: string;
  to: string;
} {
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
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000,
    ) + 1;
  if (days > 366) throw new Error("a trigger window must not exceed 366 days");
  return { from, to };
}
function defaultWindow(now: Date): {
  from: string;
  to: string;
} {
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
