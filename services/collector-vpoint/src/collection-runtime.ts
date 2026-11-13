import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledFailure,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import type { PersistRunResult } from "../../../packages/collection/src/index";
import { logEvent, logFailure, logStage, type CollectionStage } from "./diagnostics";
import type { VPointSession, EmailChallengeResult } from "./session";
import { vPointScheduledResult } from "./scheduled-result";
import { persistVPointRun, TerminalPersistenceError } from "./shared-run";
import type { CollectionFailure, CollectionManifest, RawArtifact, StoredArtifact } from "./types";
import { collectVPoint, VPointSessionExpiredError } from "./vpoint";

export interface SessionAccess {
  getSession(): Promise<string | null>;
  invalidateSession(): Promise<void>;
  ensureEmailChallenge(runId?: string): Promise<EmailChallengeResult>;
}
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
/** Module-only executor; the entrypoint exposes it solely through validated private RPC. */
export async function runCollection(
  env: Env,
  acquisition?: {
    parentRunId?: string;
    acquisitionSessionRef?: string;
  },
  sessionAccess?: SessionAccess,
): Promise<CollectionOutcome> {
  return withCollectionLease(env, "vpoint", async () => {
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();

    const artifacts: StoredArtifact[] = [];
    const collected: RawArtifact[] = [];
    const failures: CollectionFailure[] = [];
    let historyTotal = 0;
    let historyPageCount = 0;
    let vMoneyHistoryTotal = 0;
    let vMoneyHistoryPageCount = 0;
    const session = sessionAccess ?? sessionStub(env);
    let stage: CollectionStage = "session-load";
    const onStage = (next: CollectionStage) => {
      stage = next;
      logStage(runId, stage);
    };
    onStage(stage);
    if (acquisition?.parentRunId) {
      logEvent({
        event: "vpoint-post-auth-collection",
        runId,
        parentRunId: acquisition.parentRunId,
      });
    }
    try {
      const sessionCookie = await session.getSession();
      if (!sessionCookie) {
        onStage("email-challenge-request");
        await session.ensureEmailChallenge(runId);
        throw new VPointReauthenticationPendingError();
      }
      const collection = await collectVPoint({
        sessionCookie,
        onStage,
      });
      historyTotal = collection.historyTotal;
      historyPageCount = collection.historyPageCount;
      vMoneyHistoryTotal = collection.vMoneyHistoryTotal;
      vMoneyHistoryPageCount = collection.vMoneyHistoryPageCount;
      onStage("artifact-store");
      {
        // The shared target stores every artifact in one terminal-last run, so
        // there is nothing to write here; `persistRun` does the writing below.
        collected.push(...collection.artifacts);
      }
    } catch (error) {
      failures.push(failure("collect", error, runId, stage));
      if (error instanceof VPointSessionExpiredError) {
        try {
          onStage("session-invalidate");
          await session.invalidateSession();
          onStage("email-challenge-request");
          await session.ensureEmailChallenge(runId);
        } catch (authError) {
          failures.push(failure("reauthenticate", authError, runId, stage));
        }
      }
    }
    const completedAt = new Date().toISOString();
    const storedCount = collected.length;
    const status = failures.length === 0 ? "success" : storedCount === 0 ? "failed" : "partial";
    const manifest: CollectionManifest = {
      schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      source: "v-point",
      runId,
      startedAt,
      completedAt,
      status,
      historyTotal,
      historyPageCount,
      vMoneyHistoryTotal,
      vMoneyHistoryPageCount,
      artifacts,
      failures,
    };
    {
      return await persistSharedRun({
        env,
        manifest,
        collected,
        onStage,
        ...(acquisition?.acquisitionSessionRef === undefined
          ? {}
          : { acquisitionSessionRef: acquisition.acquisitionSessionRef }),
      });
    }
  });
}
/**
 * Writes the run into the shared DATA bucket: every artifact first, the
 * terminal last (03 §2). A run that could not be finished writes no terminal
 * and is never reported as persisted (G1-01); the reason is a machine code and
 * the pending artifact keys are a count, never provider text.
 */
async function persistSharedRun(options: {
  env: Env;
  manifest: CollectionManifest;
  collected: RawArtifact[];
  onStage: (stage: CollectionStage) => void;
  acquisitionSessionRef?: string;
}): Promise<CollectionOutcome> {
  const { env, manifest } = options;
  options.onStage("terminal-store");
  const persisted = await persistVPointRun(env.DATA, {
    runId: manifest.runId,
    producerVersion: manifest.schemaVersion,
    attemptId: `attempt-${manifest.runId}`,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    status: manifest.status,
    artifacts: options.collected,
    failureCodes: manifest.failures.map((entry) => entry.failureCode ?? ""),
    ...(options.acquisitionSessionRef === undefined
      ? {}
      : { acquisitionSessionRef: options.acquisitionSessionRef }),
  });
  const succeeded = persisted.outcome === "persisted" || persisted.outcome === "already_persisted";
  const objects = persisted.outcome === "conflict" ? [] : persisted.objects;
  const terminal: SharedTerminalSummary = {
    outcome: persisted.outcome,
    persisted: succeeded,
    terminalKey: persisted.terminalKey,
    terminalDigest: persisted.terminalDigest,
    objectCount: objects.length,
    ...(succeeded ? {} : { reasonCode: reasonCodeOf(persisted) }),
  };
  const described = new Map(options.collected.map((artifact) => [artifact.filename, artifact]));
  const stored: StoredArtifact[] = succeeded
    ? objects.map((object) => ({
        dataset: described.get(object.artifactKey)?.dataset ?? object.artifactKey,
        key: object.key,
        mediaType: described.get(object.artifactKey)?.mediaType ?? "application/json",
        sha256: object.sha256,
        bytes: object.byteSize,
      }))
    : [];
  logEvent({
    event: "vpoint-collection-persisted",
    runId: manifest.runId,
    status: manifest.status,
    historyTotal: manifest.historyTotal,
    historyPageCount: manifest.historyPageCount,
    vMoneyHistoryTotal: manifest.vMoneyHistoryTotal,
    vMoneyHistoryPageCount: manifest.vMoneyHistoryPageCount,
    artifactCount: options.collected.length,
    failureCount: manifest.failures.length,
    terminalOutcome: terminal.outcome,
    terminalKey: terminal.terminalKey,
    terminalDigest: terminal.terminalDigest,
    objectCount: terminal.objectCount,
    ...(terminal.reasonCode === undefined ? {} : { reasonCode: terminal.reasonCode }),
  });
  return { target: "shared", manifest: { ...manifest, artifacts: stored }, terminal };
}
function reasonCodeOf(result: PersistRunResult): string {
  return result.outcome === "conflict" || result.outcome === "incomplete"
    ? result.reasonCode
    : "persisted";
}
function sessionStub(env: Env): DurableObjectStub<VPointSession> {
  return env.VPOINT_SESSION.get(env.VPOINT_SESSION.idFromName("primary"));
}
function failure(
  operation: string,
  error: unknown,
  runId: string,
  stage: CollectionStage,
): CollectionFailure {
  const detail = logFailure(runId, stage, error);
  return { operation, ...detail, message: detail.failureCode, stage };
}
export function outcomeManifest(outcome: CollectionOutcome): CollectionManifest {
  return outcome.manifest;
}
/** How a message names the run without quoting anything a provider sent. */
export function runReference(outcome: CollectionOutcome): string {
  return `terminal=${outcome.terminal.terminalKey}; outcome=${outcome.terminal.outcome}`;
}
class VPointReauthenticationPendingError extends Error {
  constructor() {
    super("V Point email reauthentication is pending");
    this.name = "VPointReauthenticationPendingError";
  }
}

/** Private service-binding collection; public HTTP cannot invoke collection. */
export async function alarmCollection(
  env: Env,
  _cron: string,
  _scheduledTime: number,
): Promise<ScheduledResult> {
  try {
    const outcome = await runCollection(env);
    return vPointScheduledResult(outcome);
  } catch (error) {
    if (error instanceof TerminalPersistenceError)
      return { status: "failed", runIds: [], failureCode: "terminal_persistence_failed" };
    return scheduledFailure(error);
  }
}
