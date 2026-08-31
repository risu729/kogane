import { timingSafeEqual } from "node:crypto";
import { extractVPointEmailCode } from "./email";
import { VPointSession } from "./session";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
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
    const isTarget = message.to.toLowerCase() === requiredSecret(
      env.VPOINT_EMAIL_RECIPIENT,
      "VPOINT_EMAIL_RECIPIENT",
    ).toLowerCase();
    const raw = isTarget
      ? await new Response(message.raw).arrayBuffer()
      : null;
    const payEmail = raw ? await parseVPointPayEmail(raw) : null;
    if (payEmail) {
      const stored = await storeVPointPayEmail({
        bucket: env.VPOINT_PAY_SNAPSHOTS,
        parsed: payEmail,
      });
      console.log(JSON.stringify({
        event: "vpoint-pay-email-stored",
        eventType: stored.event.eventType,
        duplicate: stored.duplicate,
        rawKey: stored.rawKey,
      }));
    }

    let forwardError: unknown = null;
    if (shouldForwardToMailbox(payEmail)) {
      try {
        await message.forward(requiredSecret(
          env.VPOINT_EMAIL_FORWARD_TO,
          "VPOINT_EMAIL_FORWARD_TO",
        ));
      } catch (error) {
        forwardError = error;
      }
    }

    if (raw) {
      const code = await extractVPointEmailCode(raw);
      if (code) {
        const session = sessionStub(env);
        if (await session.hasPendingChallenge()) {
          await session.completeEmailCode(code);
          const result = await runCollection(env);
          if (result.status === "failed") {
            throw new Error(
              `V Point post-auth collection failed; manifest=${result.manifestKey}`,
            );
          }
        }
      }
    }

    if (forwardError) throw forwardError;
  },
} satisfies ExportedHandler<Env>;

async function runCollection(env: Env): Promise<CollectionResult> {
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

  try {
    const sessionCookie = await session.getSession();
    if (!sessionCookie) {
      await session.ensureEmailChallenge();
      throw new VPointReauthenticationPendingError();
    }
    const collection = await collectVPoint({
      sessionCookie,
    });
    historyTotal = collection.historyTotal;
    historyPageCount = collection.historyPageCount;
    vMoneyHistoryTotal = collection.vMoneyHistoryTotal;
    vMoneyHistoryPageCount = collection.vMoneyHistoryPageCount;
    for (const artifact of collection.artifacts) {
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
    try {
      emailReconciliation = await reconcileVPointPayEmails({
        bucket: env.VPOINT_PAY_SNAPSHOTS,
        vPointArtifacts: collection.artifacts,
        runId,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      failures.push(failure("reconcile:vpoint-pay-email", error));
    }
  } catch (error) {
    if (error instanceof VPointSessionExpiredError) {
      await session.invalidateSession();
      await session.ensureEmailChallenge();
    }
    failures.push(failure("collect", error));
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
  const manifestKey = await storeManifest({
    bucket: env.SNAPSHOTS,
    prefix,
    manifest,
  });
  console.log(JSON.stringify({
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
  }));
  return { ...manifest, manifestKey };
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
    .replace(/(cookie|session|token)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 300);
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
