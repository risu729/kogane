import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledFailure,
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
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
    return Response.json({ error: "Not found" }, { status: 404 });
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
/** Module-only executor; the entrypoint exposes it solely through validated private RPC. */
export async function runSharedCollection(
  env: Env,
  window: {
    from: string;
    to: string;
  },
): Promise<SharedResult> {
  return withCollectionLease(env, "sony-bank", async () => {
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
    const status =
      failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial";
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
  });
}
function defaultWindow(now: Date): {
  from: string;
  to: string;
} {
  const to = now.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}
function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}

/** Private service-binding collection; public HTTP cannot invoke collection. */
export async function alarmCollection(
  env: Env,
  _cron: string,
  _scheduledTime: number,
): Promise<ScheduledResult> {
  try {
    const window = defaultWindow(new Date());
    return scheduledResult(await runSharedCollection(env, window));
  } catch (error) {
    return scheduledFailure(error);
  }
}
