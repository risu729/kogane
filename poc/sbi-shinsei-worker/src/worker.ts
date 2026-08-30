import { timingSafeEqual } from "node:crypto";
import { collectSbiShinsei } from "./collector";
import { liveReadsEnabled } from "./read-allowlist";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type {
  CollectionFailure,
  CollectionManifest,
  CollectionResult,
} from "./types";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "sbi-shinsei",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
        liveReadsEnabled: liveReadsEnabled(),
      });
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const window = parseWindow(
        url.searchParams.get("from"),
        url.searchParams.get("to"),
      );
      const result = await runCollection(env, window);
      return Response.json(publicResult(result), {
        status: result.status === "failed" ? 503 : 200,
      });
    } catch (error) {
      return Response.json({ error: publicError(error) }, { status: 400 });
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env, defaultWindow(new Date()));
    if (result.status === "failed") {
      throw new Error(
        `SBI Shinsei collection failed; manifest=${result.manifestKey}`,
      );
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

  try {
    const output = await collectSbiShinsei({ window });
    for (const artifact of output.artifacts) {
      try {
        artifacts.push(await storeArtifact({
          bucket: env.SNAPSHOTS,
          prefix,
          artifact,
        }));
      } catch (error) {
        failures.push(failure(`r2:${artifact.dataset}`, error));
      }
    }
  } catch (error) {
    failures.push(failure("collect", error));
  }

  const completedAt = new Date().toISOString();
  const status =
    failures.length === 0
      ? "success"
      : artifacts.length === 0
        ? "failed"
        : "partial";
  const manifest: CollectionManifest = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    source: "sbi-shinsei",
    runId,
    startedAt,
    completedAt,
    status,
    window,
    liveReadsEnabled: liveReadsEnabled(),
    artifacts,
    failures,
  };
  const manifestKey = await storeManifest({
    bucket: env.SNAPSHOTS,
    prefix,
    manifest,
  });
  console.log(JSON.stringify({
    event: "sbi-shinsei-collection-stored",
    runId,
    status,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    liveReadsEnabled: manifest.liveReadsEnabled,
    manifestKey,
  }));
  return { ...manifest, manifestKey };
}

function parseWindow(
  from: string | null,
  to: string | null,
): { from: string; to: string } {
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
  const days = Math.floor(
    (Date.parse(`${to}T00:00:00.000Z`) -
      Date.parse(`${from}T00:00:00.000Z`)) /
      86_400_000,
  ) + 1;
  if (days > 731) {
    throw new Error("a trigger window must not exceed 731 days");
  }
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
  const provided = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/iu)?.[1];
  if (!provided || !expected) return false;
  const left = new TextEncoder().encode(provided);
  const right = new TextEncoder().encode(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
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
    .replace(
      /(password|accountNumber|branchNumber|cookie|csrf|token)=?[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .slice(0, 300);
}

function publicResult(result: CollectionResult): object {
  return {
    runId: result.runId,
    status: result.status,
    window: result.window,
    liveReadsEnabled: result.liveReadsEnabled,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    manifestKey: result.manifestKey,
  };
}
