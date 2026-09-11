import { logEvent, logFailure, logStage, type CollectionStage } from "./diagnostics";
import { timingSafeEqual } from "node:crypto";
import { collectionTarget } from "./collection-target";
import { extractVPointEmailCode, isCollectorRecipient } from "./email";
import { VPointSession } from "./session";
import { emailSessionRefFor, persistVPointPayEmailRun, persistVPointRun } from "./shared-run";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import { backfillStoredRuns, importStoredRun } from "./raw-evidence";
import {
  parseVPointPayEmail,
  prepareVPointPayEmail,
  shouldForwardToMailbox,
  storeVPointPayEmail,
} from "./vpoint-pay-email";
import {
  backfillStoredVPointPayEmails,
  importStoredVPointPayEmail,
} from "./vpoint-pay-raw-evidence";
import { reconcileVPointPayEmails } from "./vpoint-pay-reconcile";
import type {
  CollectionFailure,
  CollectionManifest,
  CollectionResult,
  RawArtifact,
  StoredArtifact,
} from "./types";
import { collectVPoint, VPointSessionExpiredError } from "./vpoint";
import type { PersistRunResult } from "../../../packages/collection/src/index";

export { VPointSession };

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
type CollectionOutcome =
  | { target: "legacy"; result: CollectionResult }
  | { target: "shared"; manifest: CollectionManifest; terminal: SharedTerminalSummary };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        source: "v-point",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    }
    if (request.method === "POST" && url.pathname === "/backfill-raw-evidence") {
      if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const queryNames = [...url.searchParams.keys()];
      if (
        queryNames.some((name) => name !== "limit" && name !== "cursor") ||
        url.searchParams.getAll("limit").length !== 1 ||
        url.searchParams.getAll("cursor").length > 1 ||
        url.searchParams.get("limit") !== "1"
      ) {
        return Response.json({ error: "limit_must_be_one" }, { status: 400 });
      }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (
        cursor !== undefined &&
        (cursor.length === 0 || cursor.length > 4_096 || /[\x00-\x20\x7f]/u.test(cursor))
      ) {
        return Response.json({ error: "cursor_invalid" }, { status: 400 });
      }
      try {
        return Response.json(await backfillStoredRuns(env.RAW_EVIDENCE_IMPORTER, cursor));
      } catch {
        return Response.json({ error: "raw_evidence_backfill_failed" }, { status: 502 });
      }
    }
    if (request.method === "POST" && url.pathname === "/backfill-vpoint-pay-email-raw-evidence") {
      if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const queryNames = [...url.searchParams.keys()];
      if (
        queryNames.some((name) => name !== "limit" && name !== "cursor") ||
        url.searchParams.getAll("limit").length !== 1 ||
        url.searchParams.getAll("cursor").length > 1 ||
        url.searchParams.get("limit") !== "1"
      ) {
        return Response.json({ error: "limit_must_be_one" }, { status: 400 });
      }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (
        cursor !== undefined &&
        (cursor.length === 0 || cursor.length > 4_096 || /[\x00-\x20\x7f]/u.test(cursor))
      ) {
        return Response.json({ error: "cursor_invalid" }, { status: 400 });
      }
      try {
        return Response.json(
          await backfillStoredVPointPayEmails(env.RAW_EVIDENCE_IMPORTER, cursor),
        );
      } catch {
        return Response.json(
          { error: "vpoint_pay_email_raw_evidence_backfill_failed" },
          { status: 502 },
        );
      }
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const outcome = await runCollection(env);
    const manifest = outcomeManifest(outcome);
    const pending = awaitingReauthentication(manifest);
    const persisted = outcome.target === "legacy" || outcome.terminal.persisted;
    return Response.json(publicResult(outcome), {
      status: pending ? 202 : manifest.status === "failed" || !persisted ? 502 : 200,
    });
  },

  async scheduled(_controller, env): Promise<void> {
    const outcome = await runCollection(env);
    const manifest = outcomeManifest(outcome);
    if (manifest.status === "failed" && !awaitingReauthentication(manifest)) {
      throw new Error(`V Point collection failed; ${runReference(outcome)}`);
    }
    // A run whose terminal was not written is not a stored run, whatever the
    // provider outcome was (G1-01).
    if (outcome.target === "shared" && !outcome.terminal.persisted) {
      throw new Error(`V Point run was not persisted; ${runReference(outcome)}`);
    }
  },

  async email(message, env, ctx): Promise<void> {
    const target = collectionTarget(env.COLLECTION_TARGET);
    const emailRunId = crypto.randomUUID();
    let persistFailure: string | null = null;
    let stage: CollectionStage = "email-receive";
    const onStage = (next: CollectionStage) => {
      stage = next;
      logStage(emailRunId, stage);
    };
    onStage(stage);
    try {
      const payRecipient = requiredSecret(
        env.VPOINT_PAY_EMAIL_RECIPIENT,
        "VPOINT_PAY_EMAIL_RECIPIENT",
      );
      const isPayTarget = isCollectorRecipient(message.to, [payRecipient]);
      const isTarget = isCollectorRecipient(message.to, [
        requiredSecret(env.VPOINT_EMAIL_RECIPIENT, "VPOINT_EMAIL_RECIPIENT"),
        payRecipient,
      ]);
      const raw = isTarget ? await new Response(message.raw).arrayBuffer() : null;
      onStage("email-parse");
      const payEmail = raw && isPayTarget ? await parseVPointPayEmail(raw) : null;
      if (payEmail) {
        onStage("email-store");
        if (target === "shared") {
          const prepared = await prepareVPointPayEmail({
            parsed: payEmail,
            envelopeFrom: message.from,
            envelopeTo: message.to,
            expectedRecipient: payRecipient,
          });
          const persisted = await persistVPointPayEmailRun(
            env.DATA,
            prepared,
            env.COLLECTOR_SCHEMA_VERSION,
          );
          logEvent({
            event: "vpoint-pay-email-persisted",
            runId: emailRunId,
            eventType: prepared.event.eventType,
            terminalOutcome: persisted.outcome,
            terminalKey: persisted.terminalKey,
            terminalDigest: persisted.terminalDigest,
          });
          // A redelivered notification is the same run with the same digest,
          // so `already_persisted` is the expected duplicate answer; anything
          // else wrote no terminal and must not pass as archived.
          if (persisted.outcome !== "persisted" && persisted.outcome !== "already_persisted") {
            persistFailure = persisted.outcome;
          }
        } else {
          const stored = await storeVPointPayEmail({
            bucket: env.VPOINT_PAY_SNAPSHOTS,
            parsed: payEmail,
            envelopeFrom: message.from,
            envelopeTo: message.to,
            expectedRecipient: payRecipient,
          });
          logEvent({
            event: "vpoint-pay-email-stored",
            runId: emailRunId,
            eventType: stored.event.eventType,
            duplicate: stored.duplicate,
          });
          ctx.waitUntil(
            importStoredVPointPayEmail(env.RAW_EVIDENCE_IMPORTER, stored.normalizedKey).catch(
              () => {
                logEvent({
                  event: "vpoint-pay-email-raw-evidence-import-failed",
                  runId: emailRunId,
                });
              },
            ),
          );
        }
      }

      let forwardError: unknown = null;
      if (shouldForwardToMailbox(payEmail)) {
        try {
          onStage("email-forward");
          await message.forward(
            requiredSecret(env.VPOINT_EMAIL_FORWARD_TO, "VPOINT_EMAIL_FORWARD_TO"),
          );
        } catch (error) {
          forwardError = error;
          logFailure(emailRunId, stage, error);
        }
      }

      if (raw) {
        onStage("email-code-parse");
        const code = await extractVPointEmailCode(raw);
        if (code) {
          const session = sessionStub(env);
          if (await session.hasPendingChallenge()) {
            onStage("email-auth-complete");
            await session.completeEmailCode(code, emailRunId);
            onStage("post-auth-collection");
            // One delivered mail, two sources: the notification run and this
            // V Point run stay separate runs that name the same acquisition
            // session, derived from the message bytes (03 §3, G1-16).
            const outcome = await runCollection(env, {
              parentRunId: emailRunId,
              ...(target === "shared"
                ? { acquisitionSessionRef: await emailSessionRefFor(new Uint8Array(raw)) }
                : {}),
            });
            if (outcomeManifest(outcome).status === "failed") {
              throw new Error(`V Point post-auth collection failed; ${runReference(outcome)}`);
            }
          }
        }
      }

      if (forwardError) {
        stage = "email-forward";
        throw forwardError;
      }
      if (persistFailure) {
        stage = "email-store";
        throw new Error(`V Point Pay notification was not persisted; outcome=${persistFailure}`);
      }
      logEvent({ event: "vpoint-email-handled", runId: emailRunId, status: "success" });
    } catch (error) {
      if (stage !== "email-forward") logFailure(emailRunId, stage, error);
      // oxlint-disable-next-line preserve-caught-error -- Raw mail/provider exceptions must not cross the handler boundary; safe diagnostics are already logged.
      throw new Error(`V Point email handling failed; runId=${emailRunId}; stage=${stage}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function runCollection(
  env: Env,
  acquisition?: { parentRunId?: string; acquisitionSessionRef?: string },
): Promise<CollectionOutcome> {
  const target = collectionTarget(env.COLLECTION_TARGET);
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const artifacts: StoredArtifact[] = [];
  const collected: RawArtifact[] = [];
  const failures: CollectionFailure[] = [];
  let historyTotal = 0;
  let historyPageCount = 0;
  let vMoneyHistoryTotal = 0;
  let vMoneyHistoryPageCount = 0;
  let emailReconciliation;
  const session = sessionStub(env);
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
    if (target === "shared") {
      // The shared target stores every artifact in one terminal-last run, so
      // there is nothing to write here; `persistRun` does the writing below.
      collected.push(...collection.artifacts);
    } else {
      for (const artifact of collection.artifacts) {
        try {
          artifacts.push(
            await storeArtifact({
              bucket: env.SNAPSHOTS,
              prefix,
              artifact,
            }),
          );
        } catch (error) {
          failures.push(failure(`r2:${artifact.dataset}`, error, runId, stage));
        }
      }
    }
    if (target === "legacy") {
      // The reconciliation lists the legacy V Point Pay email prefix. On the
      // shared target those notifications are content-addressed runs that no
      // prefix enumerates, so a report built from the legacy bucket alone
      // would under-count them; cross-source reconciliation belongs to the
      // Processor (03 §4, U08) rather than to a terminal artifact that would
      // state a coverage it does not have.
      try {
        onStage("email-reconcile");
        emailReconciliation = await reconcileVPointPayEmails({
          bucket: env.VPOINT_PAY_SNAPSHOTS,
          vPointArtifacts: collection.artifacts,
          runId,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        failures.push(failure("reconcile:vpoint-pay-email", error, runId, stage));
      }
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
  const storedCount = target === "shared" ? collected.length : artifacts.length;
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
    emailReconciliation,
  };
  if (target === "shared") {
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
  onStage("manifest-store");
  let manifestKey: string;
  try {
    manifestKey = await storeManifest({ bucket: env.SNAPSHOTS, prefix, manifest });
  } catch (error) {
    logFailure(runId, stage, error);
    // oxlint-disable-next-line preserve-caught-error -- logFailure records safe diagnostics without exposing the original provider error.
    throw new Error(`V Point manifest storage failed; runId=${runId}`);
  }
  onStage("central-import");
  const central = await importStoredRun(env.RAW_EVIDENCE_IMPORTER, manifestKey);
  logEvent({
    event: "vpoint-collection-stored",
    runId,
    status,
    historyTotal,
    historyPageCount,
    vMoneyHistoryTotal,
    vMoneyHistoryPageCount,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    emailReconciliation,
    manifestKey,
    centralStatus: "sealed",
    centralRunId: central.centralRunId,
  });
  return { target: "legacy", result: { ...manifest, manifestKey, central } };
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
  stage: CollectionStage,
): CollectionFailure {
  const detail = logFailure(runId, stage, error);
  return { operation, ...detail, message: detail.failureCode, stage };
}

function outcomeManifest(outcome: CollectionOutcome): CollectionManifest {
  return outcome.target === "legacy" ? outcome.result : outcome.manifest;
}

/** How a message names the run without quoting anything a provider sent. */
function runReference(outcome: CollectionOutcome): string {
  return outcome.target === "legacy"
    ? `manifest=${outcome.result.manifestKey}`
    : `terminal=${outcome.terminal.terminalKey}; outcome=${outcome.terminal.outcome}`;
}

function publicResult(outcome: CollectionOutcome): object {
  const manifest = outcomeManifest(outcome);
  return {
    runId: manifest.runId,
    status: manifest.status,
    historyTotal: manifest.historyTotal,
    historyPageCount: manifest.historyPageCount,
    artifactCount: manifest.artifacts.length,
    failureCount: manifest.failures.length,
    emailReconciliation: manifest.emailReconciliation,
    reauthenticationPending: awaitingReauthentication(manifest),
    ...(outcome.target === "legacy"
      ? {
          manifestKey: outcome.result.manifestKey,
          central: {
            centralRunId: outcome.result.central.centralRunId,
            sealed: outcome.result.central.sealed,
          },
        }
      : {
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
        }),
  };
}

function awaitingReauthentication(manifest: CollectionManifest): boolean {
  return (
    manifest.status === "failed" &&
    manifest.failures.length === 1 &&
    ["VPointReauthenticationPendingError", "VPointSessionExpiredError"].includes(
      manifest.failures[0]?.errorType ?? "",
    )
  );
}

class VPointReauthenticationPendingError extends Error {
  constructor() {
    super("V Point email reauthentication is pending");
    this.name = "VPointReauthenticationPendingError";
  }
}
