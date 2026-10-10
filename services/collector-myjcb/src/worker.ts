import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledFailure,
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import { createDiagnostics } from "../../../packages/collector-diagnostics/src/index";
import { collectConnection, connectionStopCode, parseCredentialSecrets } from "./collector";
import {
  connectionErrorCode,
  persistSharedRun,
  sharedBucket,
  logSharedRunDiagnostic,
  type SharedConnectionRun,
} from "./shared-collection";
import type { CollectionFailure, CollectionManifest } from "./types";
type MyJcbEnv = Env & {
  readonly MYJCB_CONNECTIONS_JSON?: string;
  readonly MYJCB_CONNECTION_SECRET_NAMES?: string;
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
    return Response.json({ error: "Not found" }, { status: 404 });
  },
  async scheduled(_controller, env): Promise<void> {
    {
      const shared = await runSharedCollection(env, "scheduled");
      // A run whose terminal was not written is not a finished run (G1-01).
      if (sharedRunFailed(shared)) {
        throw new Error(`MyJCB shared collection did not complete; run=${shared.runId}`);
      }
      return;
    }
  },
} satisfies ExportedHandler<MyJcbEnv>;
interface SharedResult {
  readonly runId: string;
  readonly status: CollectionManifest["status"];
  readonly connectionCount: number;
  readonly artifactCount: number;
  readonly failureCount: number;
  readonly blockers: readonly {
    connectionId: string;
    code: string;
  }[];
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
 * written last. The per-source bucket is not written and the importer is not
 * called, so the run's bytes exist once (G1-15). A connection that needs a
 * human stays a reported state on its own unit and is never retried here
 * (G3-10, G3-11).
 */
/** Module-only executor; the entrypoint exposes it solely through validated private RPC. */
export async function runSharedCollection(
  env: MyJcbEnv,
  trigger: CollectionManifest["trigger"],
): Promise<SharedResult> {
  return withCollectionLease(env, "myjcb", async () => {
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    const diagnostic = createDiagnostics("myjcb", runId);
    try {
      const credentials = await diagnostic.step("configuration", () =>
        parseCredentialSecrets(connectionSecretValues(env)),
      );
      const connections: SharedConnectionRun[] = [];
      const failures: CollectionFailure[] = [];
      let artifactCount = 0;
      for (const credential of credentials) {
        try {
          const collected = await diagnostic.step("connection-collection", () =>
            collectConnection({
              browserBinding: env.BROWSER,
              credential,
              diagnostic,
            }),
          );
          artifactCount += collected.artifacts.length;
          connections.push({ summary: collected.summary, artifacts: collected.artifacts });
          // A connection that stopped at a month keeps the months before it
          // and is recorded as a failure with its stage and position
          // (ADR 0005's amendment).
          const { stopCode, stopPosition } = collected.summary;
          if (stopCode !== undefined) {
            failures.push({
              connectionId: credential.connectionId,
              operation: "collect",
              code: stopCode,
              ...(stopPosition === undefined ? {} : { position: stopPosition }),
            });
          }
        } catch (error) {
          // Stopped before its first credit month: nothing is kept.
          const code = connectionStopCode(error);
          connections.push({
            summary: {
              connectionId: credential.connectionId,
              bootstrapMode: credential.bootstrapMode,
              status: code === "human_required" ? "human-required" : "failed",
              cardCount: 0,
              periodCount: 0,
              artifactCount: 0,
              stopCode: code,
              capturedMonthCount: 0,
            },
            artifacts: [],
          });
          failures.push({ connectionId: credential.connectionId, operation: "collect", code });
        }
      }
      const completedAt = new Date().toISOString();
      // A connection that reports itself partial makes the run partial even
      // without a failure (ADR 0026).
      const whole =
        failures.length === 0 &&
        connections.every((connection) => connection.summary.status === "success");
      const status = whole ? "success" : artifactCount === 0 ? "failed" : "partial";
      const input = {
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
        runId,
        startedAt,
        completedAt,
        status,
        trigger,
        connections,
        failures,
      } as const;
      const outcome = await diagnostic.step("artifact-write", () =>
        persistSharedRun(sharedBucket(env.DATA), input),
      );
      logSharedRunDiagnostic(input, outcome);
      diagnostic.finish(status);
      return {
        runId,
        status,
        connectionCount: connections.length,
        artifactCount: outcome.artifactCount,
        failureCount: failures.length,
        // The blocker is reported as a code, never as upstream text.
        blockers: connections.flatMap((connection) =>
          connection.summary.status === "success"
            ? []
            : [
                {
                  connectionId: connection.summary.connectionId,
                  // The unit's code: the stop code, or for a connection that
                  // ran to the end but kept months unread,
                  // `scheduled_payments_page` or `collector_partial`.
                  code: connectionErrorCode(connection.summary) ?? "collector_partial",
                },
              ],
        ),
        persistence: outcome.result.outcome,
        terminalKey: outcome.result.terminalKey,
      };
    } catch (error) {
      diagnostic.finish("failed");
      throw error;
    }
  });
}
function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}
function connectionSecretValues(env: MyJcbEnv): string[] {
  const names =
    env.MYJCB_CONNECTION_SECRET_NAMES?.split(",")
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

/** Private service-binding collection; public HTTP cannot invoke collection. */
export async function alarmCollection(
  env: Env,
  _cron: string,
  _scheduledTime: number,
): Promise<ScheduledResult> {
  try {
    return scheduledResult(await runSharedCollection(env, "scheduled"));
  } catch (error) {
    return scheduledFailure(error);
  }
}
