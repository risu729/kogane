import { parseCredential } from "./auth";
import { parseHandshakeKey, secretEquals } from "./crypto";
import { collectMainSiteArtifacts } from "./main-site";
import {
  collectDomesticArtifacts,
  collectForeignArtifacts,
} from "./sbi";
import {
  runPrefix,
  storeArtifact,
  storeManifest,
} from "./storage";
import type {
  Artifact,
  CollectionFailure,
  CollectionManifest,
  CollectionScope,
  SbiEndpoints,
} from "./types";

const SBI_ENDPOINTS: SbiEndpoints = {
  authEntryUrl: "https://login.sbisec.co.jp/login/entry",
  mtsBaseUrl: "https://apli.sbisec.co.jp",
  foreignStockBaseUrl: "https://fstockapp.sbisec.co.jp",
  mainSiteBaseUrl: "https://www.sbisec.co.jp",
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "sbi-securities",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      const scope = parseScope(url.searchParams.get("scope"));
      const window = parseWindow(
        url.searchParams.get("from"),
        url.searchParams.get("to"),
      );
      if (scope === "all") {
        return Response.json(
          { error: "Use the dispatcher /enqueue endpoint for scope=all" },
          { status: 400 },
        );
      }
      const result = await runCollection(env, scope, window);
      return Response.json(result, {
        status: result.status === "failed" ? 502 : 200,
      });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? redactError(error.message).slice(0, 300)
              : "Collection failed",
        },
        { status: 400 },
      );
    }
  },

} satisfies ExportedHandler<Env>;

async function runCollection(
  env: Env,
  scope: CollectionScope,
  window?: { from: string; to: string },
): Promise<CollectionManifest & { manifestKey: string }> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const endpoints = SBI_ENDPOINTS;
  const credential = parseCredential(
    requiredSecret(env.SBI_CREDENTIAL_JSON, "SBI_CREDENTIAL_JSON"),
  );
  const handshakeKey = parseHandshakeKey(
    requiredSecret(env.SBI_HANDSHAKE_KEY_JSON, "SBI_HANDSHAKE_KEY_JSON"),
  );
  const artifacts: Artifact[] = [];
  const failures: CollectionFailure[] = [];

  if (scope === "all" || scope === "domestic") {
    try {
      const domestic = await collectDomesticArtifacts({
        endpoints,
        credential,
        handshakeKey,
      });
      artifacts.push(...domestic.artifacts);
      if (endpoints.mainSiteBaseUrl) {
        try {
          artifacts.push(
            ...(await collectMainSiteArtifacts({
              session: domestic.session,
              mainSiteBaseUrl: endpoints.mainSiteBaseUrl,
              ...(window ?? {}),
            })),
          );
        } catch (error) {
          failures.push(failure("domestic", "main-site", error));
        }
      }
    } catch (error) {
      failures.push(failure("domestic", "passkey-mts", error));
    }
  }

  if (scope === "all" || scope === "foreign") {
    try {
      artifacts.push(
        ...(await collectForeignArtifacts({
          endpoints,
          credential,
          handshakeKey,
          ...(window ?? {}),
        })),
      );
    } catch (error) {
      failures.push(failure("foreign", "passkey-graphql", error));
    }
  }

  const artifactManifests = [];
  for (const artifact of artifacts) {
    try {
      artifactManifests.push(
        await storeArtifact({
          bucket: env.SNAPSHOTS,
          prefix,
          artifact,
        }),
      );
    } catch (error) {
      failures.push(
        failure(
          artifact.dataset.startsWith("foreign") ? "foreign" : "domestic",
          `r2:${artifact.dataset}`,
          error,
        ),
      );
    }
  }
  const completedAt = new Date().toISOString();
  const status =
    failures.length === 0
      ? "success"
      : artifactManifests.length === 0
        ? "failed"
        : "partial";
  const manifest: CollectionManifest = {
    schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
    source: "sbi-securities",
    runId,
    scope,
    startedAt,
    completedAt,
    status,
    artifacts: artifactManifests,
    failures,
  };
  const manifestKey = await storeManifest({
    bucket: env.SNAPSHOTS,
    prefix,
    manifest,
  });
  console.log(
    JSON.stringify({
      event: "sbi-collection-stored",
      runId,
      scope,
      status,
      artifactCount: artifactManifests.length,
      failureCount: failures.length,
      manifestKey,
    }),
  );
  return { ...manifest, manifestKey };
}

function authorized(request: Request, expected: string | undefined): boolean {
  const provided = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/iu)?.[1];
  return Boolean(provided && expected && secretEquals(provided, expected));
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}

function parseScope(value: string | null): CollectionScope {
  if (value === null || value === "all") return "all";
  if (value === "domestic" || value === "foreign") return value;
  throw new Error("scope must be all, domestic, or foreign");
}

function parseWindow(
  from: string | null,
  to: string | null,
): { from: string; to: string } | undefined {
  if (from === null && to === null) return undefined;
  if (!from || !to) throw new Error("from and to must be specified together");
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(to) ||
    from > to
  ) {
    throw new Error("from and to must be a valid YYYY-MM-DD range");
  }
  const days =
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1;
  if (days > 90) throw new Error("a trigger window must not exceed 90 days");
  return { from, to };
}

function failure(
  scope: "domestic" | "foreign",
  operation: string,
  error: unknown,
): CollectionFailure {
  return {
    scope,
    operation,
    errorType: error instanceof Error ? error.name : "UnknownError",
    message:
      error instanceof Error
        ? redactError(error.message).slice(0, 300)
        : "Unknown error",
  };
}

function redactError(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/(token|sid|cookie)=?[^\s,;]+/giu, "$1=[redacted]");
}
