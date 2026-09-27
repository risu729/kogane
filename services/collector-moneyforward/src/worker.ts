import { timingSafeEqual } from "node:crypto";
import { logEvent, logFailure, logStage, type Stage } from "./diagnostics";
import { collectMoneyForward } from "./moneyforward";
import { persistSharedRun, sharedBucket, sharedRunDiagnostic } from "./shared-collection";
import type { CollectionFailure, CollectionManifest, RawArtifact } from "./types";
import { parseCredential } from "./webauthn";
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          source: "moneyforward-me",
          schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    {
      const shared = await runSharedCollection(env);
      return Response.json(shared, {
        status: sharedRunFailed(shared) ? 502 : 200,
        headers: { "cache-control": "no-store" },
      });
    }
  },
  async scheduled(_controller, env): Promise<void> {
    {
      const shared = await runSharedCollection(env);
      // A run whose terminal was not written is not a finished run (G1-01).
      if (sharedRunFailed(shared)) {
        throw new Error("Money Forward shared collection did not complete");
      }
      return;
    }
  },
} satisfies ExportedHandler<Env>;
interface SharedResult {
  readonly runId: string;
  readonly status: CollectionManifest["status"];
  readonly accountDetailCount: number;
  readonly monthlyFragmentCount: number;
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
 * written last. The per-source bucket is not written and the importer is not
 * called, so the run's bytes exist once (G1-15).
 */
async function runSharedCollection(env: Env): Promise<SharedResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const failures: CollectionFailure[] = [];
  let artifacts: readonly RawArtifact[] = [];
  let accountDetailCount = 0;
  let monthlyFragmentCount = 0;
  let stage: Stage = "credential-load";
  const onStage = (next: Stage) => {
    stage = next;
    logStage(runId, stage);
  };
  onStage(stage);
  try {
    const collection = await collectMoneyForward({
      onStage,
      credential: parseCredential(
        requiredSecret(env.MONEYFORWARD_CREDENTIAL_JSON, "MONEYFORWARD_CREDENTIAL_JSON"),
      ),
    });
    accountDetailCount = collection.accountDetailCount;
    monthlyFragmentCount = collection.monthlyFragmentCount;
    artifacts = collection.artifacts;
  } catch (error) {
    failures.push(failure("collect", error, runId, stage));
  }
  const completedAt = new Date().toISOString();
  const status = failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial";
  const input = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    runId,
    startedAt,
    completedAt,
    status,
    accountDetailCount,
    monthlyFragmentCount,
    artifacts,
    failures,
  } as const;
  const outcome = await persistSharedRun(sharedBucket(env.DATA), input);
  logEvent(sharedRunDiagnostic(input, outcome));
  return {
    runId,
    status,
    accountDetailCount,
    monthlyFragmentCount,
    artifactCount: outcome.artifactCount,
    failureCount: failures.length,
    persistence: outcome.result.outcome,
    terminalKey: outcome.result.terminalKey,
  };
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
  operation: string,
  error: unknown,
  runId: string,
  stage: Stage,
): CollectionFailure {
  const detail = logFailure(runId, stage, error);
  return { operation, ...detail, message: detail.failureCode, stage };
}
