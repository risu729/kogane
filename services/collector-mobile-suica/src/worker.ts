import { timingSafeEqual } from "node:crypto";
import type { PersistRunResult } from "../../../packages/collection/src/index";
import {
  createDiagnostics,
  safeErrorDetails,
} from "../../../packages/collector-diagnostics/src/index";
import {
  bootstrapMobileSuicaSessionWithBrowser,
  checkBrowserPasskeyLogin,
  inspectBrowserBootstrap,
} from "./browser-bootstrap";
import { collectMobileSuica, parseSessionEnvelope } from "./mobile-suica";
import { persistMobileSuicaRun } from "./shared-run";
import type { CollectionFailure, CollectionManifest, RawArtifact, StoredArtifact } from "./types";
import { checkStoredJreCredential, parseStoredJreCredential } from "./webauthn";
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
  manifest: CollectionManifest;
  terminal: SharedTerminalSummary;
};
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "mobile-suica",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method === "POST" && url.pathname === "/credential-check") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const credential = parseStoredJreCredential(
        requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
      );
      const check = checkStoredJreCredential(credential);
      return Response.json(
        {
          ok: check.verified,
          rpId: credential.rpId,
          algorithm: "ES256",
          credentialIdBytes: check.credentialIdBytes,
          authenticatorDataBytes: check.authenticatorDataBytes,
          flags: check.flags,
          signCount: check.signCount,
          syncedAt: credential.syncedAt,
        },
        { status: check.verified ? 200 : 500 },
      );
    }
    if (request.method === "POST" && url.pathname === "/browser-bootstrap-inspect") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const credential = parseStoredJreCredential(
          requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
        );
        return Response.json(await inspectBrowserBootstrap(env.BROWSER, credential));
      } catch (error) {
        return Response.json(
          {
            ok: false,
            errorType: error instanceof Error ? error.name : "UnknownError",
            message: publicError(error),
          },
          { status: 502 },
        );
      }
    }
    if (request.method === "POST" && url.pathname === "/browser-login-check") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const credential = parseStoredJreCredential(
          requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
        );
        const result = await checkBrowserPasskeyLogin(env.BROWSER, credential);
        return Response.json(result, { status: result.ok ? 200 : 502 });
      } catch (error) {
        return Response.json(
          {
            ok: false,
            errorType: error instanceof Error ? error.name : "UnknownError",
            message: publicError(error),
          },
          { status: 502 },
        );
      }
    }
    if (request.method === "POST" && url.pathname === "/browser-session-check") {
      if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const credential = parseStoredJreCredential(
          requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
        );
        const session = parseSessionEnvelope(
          JSON.stringify(await bootstrapMobileSuicaSessionWithBrowser(env.BROWSER, credential)),
        );
        return Response.json({
          ok: true,
          capturedAt: session.capturedAt,
          cookieNames: session.cookieHeader
            .split(";")
            .map((part) => part.split("=", 1)[0]?.trim())
            .sort(),
          hasFormState: new URLSearchParams(session.formBody).has("baseVariable"),
        });
      } catch (error) {
        return Response.json(
          {
            ok: false,
            errorType: error instanceof Error ? error.name : "UnknownError",
            message: publicError(error),
          },
          { status: 502 },
        );
      }
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, secretBinding(env, "ADMIN_TRIGGER_TOKEN"))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const asOfDateJst = url.searchParams.get("asOf") ?? tokyoDate(new Date());
    if (!validDate(asOfDateJst)) {
      return Response.json({ error: "asOf must be a valid YYYY-MM-DD" }, { status: 400 });
    }
    const outcome = await runCollection(env, asOfDateJst);
    const manifest = outcomeManifest(outcome);
    const persisted = outcome.terminal.persisted;
    return Response.json(publicResult(outcome), {
      status: manifest.status === "success" && persisted ? 200 : 502,
    });
  },
  async scheduled(_controller, env): Promise<void> {
    const outcome = await runCollection(env, tokyoDate(new Date()));
    const manifest = outcomeManifest(outcome);
    if (manifest.status !== "success") {
      throw new Error(`Mobile Suica collection incomplete; ${runReference(outcome)}`);
    }
    // A run whose terminal was not written is not a stored run (G1-01).
    if (!outcome.terminal.persisted) {
      throw new Error(`Mobile Suica run was not persisted; ${runReference(outcome)}`);
    }
  },
} satisfies ExportedHandler<Env>;
async function runCollection(env: Env, asOfDateJst: string): Promise<CollectionOutcome> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const diagnostic = createDiagnostics("mobile-suica", runId);
  try {
    const artifacts: StoredArtifact[] = [];
    const collected: RawArtifact[] = [];
    const failures: CollectionFailure[] = [];
    let transactionCount = 0;
    let pageCount = 0;
    let complete = false;
    let capturedSessionAt: string | undefined;
    try {
      const credential = await diagnostic.step("configuration", () =>
        parseStoredJreCredential(
          requiredSecret(secretBinding(env, "JRE_ID_CREDENTIAL_JSON"), "JRE_ID_CREDENTIAL_JSON"),
        ),
      );
      const session = await diagnostic.step("browser-bootstrap", async () =>
        parseSessionEnvelope(
          JSON.stringify(await bootstrapMobileSuicaSessionWithBrowser(env.BROWSER, credential)),
        ),
      );
      capturedSessionAt = session.capturedAt;
      const collection = await diagnostic.step("history-collection", () =>
        collectMobileSuica({ session, asOfDateJst }),
      );
      transactionCount = collection.rows.length;
      pageCount = collection.pageCount;
      complete = collection.complete;
      if (!collection.complete) {
        diagnostic.failure("pagination", new Error("history_boundary_unproven"));
        failures.push({
          operation: "pagination",
          errorType: "HistoryBoundaryError",
          errorCode: "history_boundary_unproven",
        });
      }
      {
        // One terminal-last run replaces the per-artifact writes below.
        collected.push(...collection.artifacts);
      }
    } catch (error) {
      failures.push(failure("collect", error, "collection_failed"));
    }
    const completedAt = new Date().toISOString();
    const storedCount = collected.length;
    const status = failures.length === 0 ? "success" : storedCount === 0 ? "failed" : "partial";
    const manifest: CollectionManifest = {
      schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      source: "mobile-suica",
      runId,
      startedAt,
      completedAt,
      status,
      asOfDateJst,
      ...(capturedSessionAt ? { capturedSessionAt } : {}),
      transactionCount,
      pageCount,
      complete,
      artifacts,
      failures,
    };
    {
      const persisted = await diagnostic.step("terminal-write", () =>
        persistMobileSuicaRun(env.DATA, {
          runId,
          producerVersion: manifest.schemaVersion,
          attemptId: `attempt-${runId}`,
          startedAt,
          completedAt,
          status,
          asOfDateJst,
          complete,
          artifacts: collected,
          failureCodes: failures.map((entry) => entry.errorCode),
        }),
      );
      const succeeded =
        persisted.outcome === "persisted" || persisted.outcome === "already_persisted";
      const objects = persisted.outcome === "conflict" ? [] : persisted.objects;
      const described = new Map(collected.map((artifact) => [artifact.filename, artifact]));
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
          event: "mobile-suica-collection-persisted",
          runId,
          status,
          transactionCount,
          pageCount,
          artifactCount: collected.length,
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
        manifest: {
          ...manifest,
          artifacts: succeeded
            ? objects.map((object) => ({
                dataset: described.get(object.artifactKey)?.dataset ?? object.artifactKey,
                key: object.key,
                mediaType: described.get(object.artifactKey)?.mediaType ?? "application/json",
                sha256: object.sha256,
                bytes: object.byteSize,
              }))
            : [],
        },
        terminal,
      };
    }
  } catch (error) {
    diagnostic.finish("failed");
    throw error;
  }
}
function outcomeManifest(outcome: CollectionOutcome): CollectionManifest {
  return outcome.manifest;
}
/** How a message names the run without quoting anything a provider sent. */
function runReference(outcome: CollectionOutcome): string {
  return `terminal=${outcome.terminal.terminalKey}; outcome=${outcome.terminal.outcome}`;
}
function reasonCodeOf(result: PersistRunResult): string {
  return result.outcome === "conflict" || result.outcome === "incomplete"
    ? result.reasonCode
    : "persisted";
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
function secretBinding(env: Env, name: string): string | undefined {
  const value = Reflect.get(env, name);
  return typeof value === "string" ? value : undefined;
}
function tokyoDate(now: Date): string {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}
function failure(
  operation: CollectionFailure["operation"],
  error: unknown,
  errorCode: CollectionFailure["errorCode"],
  artifactKey?: string,
): CollectionFailure {
  return {
    operation,
    errorType: safeErrorDetails(error).errorType,
    errorCode,
    ...(artifactKey ? { artifactKey } : {}),
  };
}
function publicError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Unknown error";
  return value
    .replace(/(cookie|session|baseVariable|token|assertion)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 300);
}
function publicResult(outcome: CollectionOutcome): object {
  const manifest = outcomeManifest(outcome);
  return {
    runId: manifest.runId,
    status: manifest.status,
    asOfDateJst: manifest.asOfDateJst,
    transactionCount: manifest.transactionCount,
    pageCount: manifest.pageCount,
    artifactCount: manifest.artifacts.length,
    failureCount: manifest.failures.length,
    ...{
      terminal: {
        outcome: outcome.terminal.outcome,
        persisted: outcome.terminal.persisted,
        terminalKey: outcome.terminal.terminalKey,
        terminalDigest: outcome.terminal.terminalDigest,
        objectCount: outcome.terminal.objectCount,
        ...(outcome.terminal.reasonCode === undefined
          ? {}
          : { reasonCode: outcome.terminal.reasonCode }),
      },
    },
  };
}
