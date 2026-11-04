import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledFailure,
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import type { PersistRunResult } from "../../../packages/collection/src/index";
import {
  createDiagnostics,
  safeErrorDetails,
} from "../../../packages/collector-diagnostics/src/index";
import { parseCredential } from "./auth";
import { parseHandshakeKey } from "./crypto";
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
    return Response.json({ error: "Not found" }, { status: 404 });
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
  return withCollectionLease(env, "sbi-securities", async () => {
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
  });
}
function reasonCodeOf(result: PersistRunResult): string {
  return result.outcome === "conflict" || result.outcome === "incomplete"
    ? result.reasonCode
    : "persisted";
}
function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
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

/** Private service-binding collection; public HTTP cannot invoke collection. */
export async function alarmCollection(
  env: Env,
  _cron: string,
  _scheduledTime: number,
): Promise<ScheduledResult> {
  try {
    return scheduledResult(await runCollection(env, "all"));
  } catch (error) {
    return scheduledFailure(error);
  }
}
