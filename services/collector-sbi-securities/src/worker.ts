import type { PersistRunResult } from "../../../packages/collection/src/index";
import {
  createDiagnostics,
  safeErrorDetails,
} from "../../../packages/collector-diagnostics/src/index";
import { parseCredential } from "./auth";
import { parseHandshakeKey, secretEquals } from "./crypto";
import { collectMainSiteArtifacts } from "./main-site";
import { collectDomesticArtifacts, collectForeignArtifacts } from "./sbi";
import { persistSbiRun, safeFailureCode, type SharedFailure } from "./shared-run";
import type {
  Artifact,
  ArtifactManifest,
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
/** What the shared target recorded about the run's terminal (03 §2). */
interface SharedTerminalSummary {
  outcome: PersistRunResult["outcome"];
  /** True only for `persisted` and `already_persisted`; nothing else is a finished run. */
  persisted: boolean;
  terminalKey: string;
  terminalDigest: string;
  objectCount: number;
  reasonCode?: string;
}
/**
 * A finished run, in the shape its storage target produced: the legacy path
 * ends at the collector manifest plus the central import, the shared path at
 * the terminal in the DATA bucket.
 */
type CollectionOutcome = {
  target: "shared";
} & CollectionManifest & {
    terminal: SharedTerminalSummary;
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
      const window = parseWindow(url.searchParams.get("from"), url.searchParams.get("to"));
      const result = await runCollection(env, scope, window);
      const persisted = result.terminal.persisted;
      // The discriminator is internal: the legacy response body stays exactly
      // what it was, and the shared one is told apart by its `terminal`.
      const { target: _target, ...body } = result;
      return Response.json(body, {
        status: result.status === "failed" || !persisted ? 502 : 200,
      });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error ? redactError(error.message).slice(0, 300) : "Collection failed",
        },
        { status: 400 },
      );
    }
  },
  async scheduled(_controller, env): Promise<void> {
    await runCollection(env, "all");
  },
} satisfies ExportedHandler<Env>;
async function runCollection(
  env: Env,
  scope: CollectionScope,
  window?: {
    from: string;
    to: string;
  },
): Promise<CollectionOutcome> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const diagnostic = createDiagnostics("sbi-securities", runId);
  try {
    const endpoints = SBI_ENDPOINTS;
    const credential = await diagnostic.step("configuration", () =>
      parseCredential(requiredSecret(env.SBI_CREDENTIAL_JSON, "SBI_CREDENTIAL_JSON")),
    );
    const handshakeKey = await diagnostic.step("configuration", () =>
      parseHandshakeKey(requiredSecret(env.SBI_HANDSHAKE_KEY_JSON, "SBI_HANDSHAKE_KEY_JSON")),
    );
    const artifacts: Artifact[] = [];
    const failures: CollectionFailure[] = [];
    const safeFailures: SharedFailure[] = [];
    if (scope === "all" || scope === "domestic") {
      try {
        const domestic = await diagnostic.step("domestic-collection", () =>
          collectDomesticArtifacts({
            endpoints,
            credential,
            handshakeKey,
          }),
        );
        artifacts.push(...domestic.artifacts);
        const mainSiteBaseUrl = endpoints.mainSiteBaseUrl;
        if (mainSiteBaseUrl) {
          try {
            artifacts.push(
              ...(await diagnostic.step("main-site-collection", () =>
                collectMainSiteArtifacts({
                  session: domestic.session,
                  mainSiteBaseUrl,
                  ...(window ?? {}),
                }),
              )),
            );
          } catch (error) {
            failures.push(failure("domestic", "main-site", error));
            safeFailures.push({ scope: "domestic", code: safeFailureCode(error) });
          }
        }
      } catch (error) {
        failures.push(failure("domestic", "passkey-mts", error));
        safeFailures.push({ scope: "domestic", code: safeFailureCode(error) });
      }
    }
    if (scope === "all" || scope === "foreign") {
      try {
        artifacts.push(
          ...(await diagnostic.step("foreign-collection", () =>
            collectForeignArtifacts({
              endpoints,
              credential,
              handshakeKey,
              ...(window ?? {}),
            }),
          )),
        );
      } catch (error) {
        failures.push(failure("foreign", "passkey-graphql", error));
        safeFailures.push({ scope: "foreign", code: safeFailureCode(error) });
      }
    }
    const artifactManifests: ArtifactManifest[] = [];
    const completedAt = new Date().toISOString();
    // The shared target stores every collected artifact in one terminal-last
    // run, so what it collected is what it will store.
    const storedCount = artifacts.length;
    const status = failures.length === 0 ? "success" : storedCount === 0 ? "failed" : "partial";
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
    {
      const persisted = await diagnostic.step("terminal-write", () =>
        persistSbiRun(env.DATA, {
          runId,
          producerVersion: manifest.schemaVersion,
          attemptId: `attempt-${runId}`,
          startedAt,
          completedAt,
          status,
          scope,
          ...(window === undefined ? {} : { window }),
          artifacts,
          failures: safeFailures,
        }),
      );
      const succeeded =
        persisted.outcome === "persisted" || persisted.outcome === "already_persisted";
      const objects = persisted.outcome === "conflict" ? [] : persisted.objects;
      const described = new Map<string, Artifact>(
        artifacts.map((artifact) => [`${artifact.dataset}.json`, artifact]),
      );
      const terminal: SharedTerminalSummary = {
        outcome: persisted.outcome,
        persisted: succeeded,
        terminalKey: persisted.terminalKey,
        terminalDigest: persisted.terminalDigest,
        objectCount: objects.length,
        ...(succeeded ? {} : { reasonCode: reasonCodeOf(persisted) }),
      };
      console.log(
        JSON.stringify({
          event: "sbi-collection-persisted",
          runId,
          scope,
          status,
          artifactCount: artifacts.length,
          failureCount: failures.length,
          terminalOutcome: terminal.outcome,
          terminalKey: terminal.terminalKey,
          terminalDigest: terminal.terminalDigest,
          objectCount: terminal.objectCount,
          ...(terminal.reasonCode === undefined ? {} : { reasonCode: terminal.reasonCode }),
        }),
      );
      diagnostic.finish(succeeded ? status : "failed");
      return {
        target: "shared",
        ...manifest,
        artifacts: succeeded
          ? objects.map((object) => {
              const source = described.get(object.artifactKey);
              return {
                dataset: source?.dataset ?? object.artifactKey,
                key: object.key,
                sha256: object.sha256,
                bytes: object.byteSize,
                ...(source?.window ? { window: source.window } : {}),
              };
            })
          : [],
        terminal,
      };
    }
  } catch (error) {
    diagnostic.finish("failed");
    throw error;
  }
}
function reasonCodeOf(result: PersistRunResult): string {
  return result.outcome === "conflict" || result.outcome === "incomplete"
    ? result.reasonCode
    : "persisted";
}
function authorized(request: Request, expected: string | undefined): boolean {
  const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu)?.[1];
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
):
  | {
      from: string;
      to: string;
    }
  | undefined {
  if (from === null && to === null) return undefined;
  if (!from || !to) throw new Error("from and to must be specified together");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(from) || !/^\d{4}-\d{2}-\d{2}$/u.test(to) || from > to) {
    throw new Error("from and to must be a valid YYYY-MM-DD range");
  }
  const days =
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000,
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
    errorType: safeErrorDetails(error).errorType,
    message: JSON.stringify(safeErrorDetails(error)),
  };
}
function redactError(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [redacted]")
    .replace(/(token|sid|cookie)=?[^\s,;]+/giu, "$1=[redacted]");
}
