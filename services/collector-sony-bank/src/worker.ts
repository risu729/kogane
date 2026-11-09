import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledFailure,
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import { atStage, emitDiagnostic, failure } from "./diagnostics";
import { persistSharedRun, sharedBucket, sharedRunDiagnostic } from "./shared-collection";
import { collectSonyBank, parseCredential, type Supplement } from "./sony-bank";
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
  readonly runIds: string[];
  readonly status: CollectionManifest["status"];
  readonly window: {
    from: string | null;
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
    let supplements: Supplement[] = [];
    try {
      const credential = await atStage("credential", async () =>
        parseCredential(requiredSecret(env.SONY_BANK_CREDENTIAL_JSON, "SONY_BANK_CREDENTIAL_JSON")),
      );
      const collection = await collectSonyBank({
        credential,
        from: window.from,
        to: window.to,
        runId,
        includeRetainedHistory: true,
        includeSupplementaryData: true,
      });
      transactionCount = collection.transactionCount;
      artifacts = collection.artifacts;
      supplements = collection.supplements;
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
      window: { from: null, to: window.to },
      transactionCount,
      artifacts,
      failures,
      acquisitionSessionRef: runId,
    } as const;
    const outcome = await persistSharedRun(sharedBucket(env.DATA), input);
    emitDiagnostic(
      outcome.result.outcome === "persisted" || outcome.result.outcome === "already_persisted"
        ? "log"
        : "error",
      sharedRunDiagnostic(input, outcome),
    );
    const persisted = [outcome];
    const runIds =
      outcome.result.outcome === "persisted" || outcome.result.outcome === "already_persisted"
        ? [runId]
        : [];
    let supplementalPersistenceFailed = false;
    for (const supplement of supplements) {
      const supplementalInput = {
        ...input,
        runId: crypto.randomUUID(),
        acquisitionSessionRef: runId,
        status:
          supplement.failures.length === 0
            ? "success"
            : supplement.artifacts.length === 0
              ? "failed"
              : "partial",
        window: supplement.window,
        transactionCount: 0,
        artifacts: supplement.artifacts,
        failures: supplement.failures,
      } as const;
      try {
        const supplementalOutcome = await persistSharedRun(
          sharedBucket(env.DATA),
          supplementalInput,
        );
        persisted.push(supplementalOutcome);
        emitDiagnostic("log", sharedRunDiagnostic(supplementalInput, supplementalOutcome));
        if (
          supplementalOutcome.result.outcome === "persisted" ||
          supplementalOutcome.result.outcome === "already_persisted"
        )
          runIds.push(supplementalInput.runId);
      } catch {
        supplementalPersistenceFailed = true;
        emitDiagnostic("error", {
          event: "sony-bank-supplement-persistence-failed",
          reason: "persistence_failed",
        });
      }
    }
    const allPersisted =
      !supplementalPersistenceFailed &&
      persisted.every(
        (entry) =>
          entry.result.outcome === "persisted" || entry.result.outcome === "already_persisted",
      );
    return {
      runId,
      runIds,
      status:
        status === "success" && supplements.some((entry) => entry.failures.length > 0)
          ? "partial"
          : status,
      window: { from: null, to: window.to },
      transactionCount,
      artifactCount: persisted.reduce((sum, entry) => sum + entry.artifactCount, 0),
      failureCount:
        failures.length + supplements.reduce((sum, entry) => sum + entry.failures.length, 0),
      persistence: allPersisted ? outcome.result.outcome : "incomplete",
      terminalKey: outcome.result.terminalKey,
    };
  });
}
/**
 * Yesterday's JST date and the JST month it falls in, from that month's first
 * day. The bank's dates are Japanese calendar dates, so the window is computed
 * in JST whatever the Worker's UTC clock says, and it ends on the last finished
 * JST day: a window ending today would mark a day still in progress `complete`,
 * and a month's last day would never be requested again once the next run's
 * window starts on the new month. On the first of a month the run therefore
 * requests the whole previous month; the new month's first day comes the next day.
 * The scheduled run additionally requests all retained history through the same
 * end date, so any later successful run recovers missed month-end dates.
 */
export function defaultWindow(now: Date): {
  from: string;
  to: string;
} {
  const to = new Date(now.getTime() + (9 - 24) * 60 * 60 * 1000).toISOString().slice(0, 10);
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
    const result = await runSharedCollection(env, window);
    return result.persistence === "incomplete"
      ? scheduledFailure(new Error("collection_failed"), result.runIds)
      : scheduledResult(result);
  } catch (error) {
    return scheduledFailure(error);
  }
}
