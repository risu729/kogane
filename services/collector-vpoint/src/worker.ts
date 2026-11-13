import { logEvent, logFailure, logStage, type CollectionStage } from "./diagnostics";
import { extractVPointEmailCode, isCollectorRecipient } from "./email";
import { VPointSession } from "./session";
import { awaitingReauthentication } from "./scheduled-result";
import { emailSessionRefFor, persistVPointPayEmailRun } from "./shared-run";
import {
  parseVPointPayEmail,
  prepareVPointPayEmail,
  shouldForwardToMailbox,
} from "./vpoint-pay-email";
import { runCollection, outcomeManifest, runReference } from "./collection-runtime";
export { VPointSession };
export { runCollection, alarmCollection } from "./collection-runtime";
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
    return Response.json({ error: "Not found" }, { status: 404 });
  },
  async scheduled(_controller, env): Promise<void> {
    const outcome = await runCollection(env);
    const manifest = outcomeManifest(outcome);
    if (manifest.status === "failed" && !awaitingReauthentication(manifest)) {
      throw new Error(`V Point collection failed; ${runReference(outcome)}`);
    }
    // A run whose terminal was not written is not a stored run, whatever the
    // provider outcome was (G1-01).
    if (!outcome.terminal.persisted) {
      throw new Error(`V Point run was not persisted; ${runReference(outcome)}`);
    }
  },
  async email(message, env, _ctx): Promise<void> {
    const emailRunId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
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
        {
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
          onStage("email-auth-complete");
          const acquisitionSessionRef = await emailSessionRefFor(new Uint8Array(raw));
          const accepted = await session.completeEmailCode(code, emailRunId, {
            sourceSha256: acquisitionSessionRef.slice("email-".length),
            receivedAt,
            recipient: message.to,
          });
          if (accepted.status === "authenticated") {
            onStage("post-auth-collection");
            const claim = {
              schemaVersion: accepted.schemaVersion,
              operationId: accepted.operationId,
              requestSha256: accepted.requestSha256,
            };
            if (!(await session.beginLegacyCollection(claim)))
              throw new Error("V Point email claim became uncertain");
            let persisted = false;
            try {
              // One delivered mail, two sources: the notification run and this
              // V Point run stay separate runs that name the same acquisition
              // session, derived from the message bytes (03 §3, G1-16).
              const outcome = await runCollection(env, {
                parentRunId: emailRunId,
                acquisitionSessionRef,
              });
              if (outcomeManifest(outcome).status === "failed") {
                throw new Error(`V Point post-auth collection failed; ${runReference(outcome)}`);
              }
              // A run whose terminal was not written is not a stored run,
              // whatever the provider outcome was (G1-01).
              if (!outcome.terminal.persisted) {
                throw new Error(
                  `V Point post-auth run was not persisted; ${runReference(outcome)}`,
                );
              }
              persisted = true;
            } finally {
              await session.finishLegacyCollection(claim, persisted);
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
function sessionStub(env: Env): DurableObjectStub<VPointSession> {
  return env.VPOINT_SESSION.get(env.VPOINT_SESSION.idFromName("primary"));
}
function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}
