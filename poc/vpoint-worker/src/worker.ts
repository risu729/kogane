import { logEvent, logFailure, logStage, type CollectionStage } from "./diagnostics";
import { timingSafeEqual } from "node:crypto";
import { extractVPointEmailCode, isCollectorRecipient } from "./email";
import { VPointSession } from "./session";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import { backfillStoredRuns, importStoredRun } from "./raw-evidence";
import {
  parseVPointPayEmail,
  shouldForwardToMailbox,
  storeVPointPayEmail,
} from "./vpoint-pay-email";
import { reconcileVPointPayEmails } from "./vpoint-pay-reconcile";
import type {
  CollectionFailure,
  CollectionManifest,
  CollectionResult,
} from "./types";
import { collectVPoint, VPointSessionExpiredError } from "./vpoint";

export { VPointSession };

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
      if (queryNames.some((name) => name !== "limit" && name !== "cursor") ||
          url.searchParams.getAll("limit").length !== 1 ||
          url.searchParams.getAll("cursor").length > 1 ||
          url.searchParams.get("limit") !== "1") {
        return Response.json({ error: "limit_must_be_one" }, { status: 400 });
      }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4_096 ||
          /[\x00-\x20\x7f]/u.test(cursor))) {
        return Response.json({ error: "cursor_invalid" }, { status: 400 });
      }
      try {
        return Response.json(await backfillStoredRuns(
          env.RAW_EVIDENCE_IMPORTER,
          cursor,
        ));
      } catch {
        return Response.json({ error: "raw_evidence_backfill_failed" }, { status: 502 });
      }
    }
    if (request.method !== "POST" || url.pathname !== "/trigger") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await runCollection(env);
    const pending = awaitingReauthentication(result);
    return Response.json(publicResult(result), {
      status: pending ? 202 : result.status === "failed" ? 502 : 200,
    });
  },

  async scheduled(_controller, env): Promise<void> {
    const result = await runCollection(env);
    if (result.status === "failed" && !awaitingReauthentication(result)) {
      throw new Error(`V Point collection failed; manifest=${result.manifestKey}`);
    }
  },

  async email(message, env): Promise<void> {
    const emailRunId = crypto.randomUUID();
    let stage: CollectionStage = "email-receive";
    const onStage = (next: CollectionStage) => { stage = next; logStage(emailRunId, stage); };
    onStage(stage);
    try {
      const isTarget = isCollectorRecipient(message.to, [
        requiredSecret(env.VPOINT_EMAIL_RECIPIENT, "VPOINT_EMAIL_RECIPIENT"),
        requiredSecret(
          env.VPOINT_PAY_EMAIL_RECIPIENT,
          "VPOINT_PAY_EMAIL_RECIPIENT",
        ),
      ]);
      const raw = isTarget
        ? await new Response(message.raw).arrayBuffer()
        : null;
      onStage("email-parse");
      const payEmail = raw ? await parseVPointPayEmail(raw) : null;
      if (payEmail) {
        onStage("email-store");
        const stored = await storeVPointPayEmail({
          bucket: env.VPOINT_PAY_SNAPSHOTS,
          parsed: payEmail,
        });
        logEvent({
          event: "vpoint-pay-email-stored",
          runId: emailRunId,
          eventType: stored.event.eventType,
          duplicate: stored.duplicate,
          rawKey: stored.rawKey,
        });
      }

      let forwardError: unknown = null;
      if (shouldForwardToMailbox(payEmail)) {
        try {
          onStage("email-forward");
          await message.forward(requiredSecret(
            env.VPOINT_EMAIL_FORWARD_TO,
            "VPOINT_EMAIL_FORWARD_TO",
          ));
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
            const result = await runCollection(env, emailRunId);
            if (result.status === "failed") {
              throw new Error(
                `V Point post-auth collection failed; manifest=${result.manifestKey}`,
              );
            }
          }
        }
      }

      if (forwardError) { stage = "email-forward"; throw forwardError; }
      logEvent({ event: "vpoint-email-handled", runId: emailRunId, status: "success" });
    } catch (error) {
      if (stage !== "email-forward") logFailure(emailRunId, stage, error);
      throw new Error(`V Point email handling failed; runId=${emailRunId}; stage=${stage}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function runCollection(env: Env, parentRunId?: string): Promise<CollectionResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const prefix = runPrefix(startedAt, runId);
  const artifacts = [];
  const failures: CollectionFailure[] = [];
  let historyTotal = 0;
  let historyPageCount = 0;
  let vMoneyHistoryTotal = 0;
  let vMoneyHistoryPageCount = 0;
  let emailReconciliation;
  const session = sessionStub(env);
  let stage: CollectionStage = "session-load";
  const onStage = (next: CollectionStage) => { stage = next; logStage(runId, stage); };
  onStage(stage);
  if (parentRunId) logEvent({ event: "vpoint-post-auth-collection", runId, parentRunId });

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
    for (const artifact of collection.artifacts) {
      try {
        artifacts.push(await storeArtifact({
          bucket: env.SNAPSHOTS,
          prefix,
          artifact,
        }));
      } catch (error) {
        failures.push(failure(`r2:${artifact.dataset}`, error, runId, stage));
      }
    }
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
  const status = failures.length === 0
    ? "success"
    : artifacts.length === 0
      ? "failed"
      : "partial";
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
  onStage("manifest-store");
  let manifestKey: string;
  try {
    manifestKey = await storeManifest({ bucket: env.SNAPSHOTS, prefix, manifest });
  } catch (error) {
    logFailure(runId, stage, error);
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
  return { ...manifest, manifestKey, central };
}

function sessionStub(env: Env): DurableObjectStub<VPointSession> {
  return env.VPOINT_SESSION.get(env.VPOINT_SESSION.idFromName("primary"));
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

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}

function failure(operation: string, error: unknown, runId: string, stage: CollectionStage): CollectionFailure {
  const detail = logFailure(runId, stage, error);
  return { operation, ...detail, message: detail.failureCode, stage };
}

function publicResult(result: CollectionResult): object {
  return {
    runId: result.runId,
    status: result.status,
    historyTotal: result.historyTotal,
    historyPageCount: result.historyPageCount,
    artifactCount: result.artifacts.length,
    failureCount: result.failures.length,
    emailReconciliation: result.emailReconciliation,
    reauthenticationPending: awaitingReauthentication(result),
    manifestKey: result.manifestKey,
    central: {
      centralRunId: result.central.centralRunId,
      sealed: result.central.sealed,
    },
  };
}

function awaitingReauthentication(result: CollectionResult): boolean {
  return result.status === "failed" &&
    result.failures.length === 1 &&
    [
      "VPointReauthenticationPendingError",
      "VPointSessionExpiredError",
    ].includes(result.failures[0]?.errorType ?? "");
}

class VPointReauthenticationPendingError extends Error {
  constructor() {
    super("V Point email reauthentication is pending");
    this.name = "VPointReauthenticationPendingError";
  }
}
