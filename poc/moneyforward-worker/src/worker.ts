import { logEvent, logFailure, logStage, type Stage } from "./diagnostics";
import { timingSafeEqual } from "node:crypto";
import { collectMoneyForward } from "./moneyforward";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type { CollectionFailure, CollectionManifest } from "./types";
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

async function runCollection(env: Env): Promise<CollectionManifest & { manifestKey: string }> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const artifacts = [];
  const failures: CollectionFailure[] = [];
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
    onStage("artifact-store");
    for (const artifact of collection.artifacts) {
      try {
        artifacts.push(await storeArtifact({ bucket: env.SNAPSHOTS, prefix, artifact }));
      } catch (error) {
        failures.push(failure(`r2:${artifact.dataset}`, error, runId, stage));
      }
    }
  } catch (error) {
    failures.push(failure("collect", error, runId, stage));
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
  onStage("manifest-store");
  let manifestKey: string;
  try {
    manifestKey = await storeManifest({ bucket: env.SNAPSHOTS, prefix, manifest });
  } catch (error) {
    logFailure(runId, stage, error);
    // oxlint-disable-next-line preserve-caught-error -- The original cause may contain private provider data; logFailure records safe diagnostics.
    throw new Error(`Money Forward manifest storage failed; runId=${runId}`);
  }
  logEvent({
    event: "moneyforward-collection-stored",
    runId,
    status,
    accountDetailCount,
    monthlyFragmentCount,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    manifestKey,
  });
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

function failure(
  operation: string,
  error: unknown,
  runId: string,
  stage: Stage,
): CollectionFailure {
  const detail = logFailure(runId, stage, error);
  return { operation, ...detail, message: detail.failureCode, stage };
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
