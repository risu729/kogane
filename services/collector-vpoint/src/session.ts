import { DurableObject } from "cloudflare:workers";
import {
  beginVPointEmailLogin,
  completeVPointEmailLogin,
  normalizeEmailCode,
  type VPointEmailChallengeState,
} from "./auth";
import { logAuthTrace, logEvent } from "./diagnostics";
import { extractVPointTextCode, isCollectorRecipient } from "./email";
import { runCollection } from "./collection-runtime";
import { emailSessionRef } from "./shared-run";
import {
  FUMI_MANIFEST_JSON,
  FUMI_MANIFEST_VERSION,
  FUMI_PLUGIN_ID,
  canonicalJson,
  freshAttempt,
  parseFumiOffer,
  parseFumiReceiptRequest,
  receipt,
  sha256,
  validTime,
  type FumiOfferRequest,
  type FumiReceipt,
  type FumiReceiptRequest,
} from "./fumi-offer";

const SESSION_KEY = "session-cookie";
const PENDING_KEY = "email-challenge";
const REQUESTING_KEY = "email-requesting";
const JOB_KEY = "fumi:job";
// The observed provider email states one minute, not the old two-minute cache TTL.
export const CHALLENGE_TTL_MS = 60_000;
const WATCHDOG_MS = 2 * 60_000;
const COLLECTION_WATCHDOG_MS = 15 * 60_000;
const receiptKey = (operationId: string) => `fumi:receipt:${operationId}`;
const sourceKey = (rawSha256: string) => `fumi:source:${rawSha256}`;
type JobStage =
  | "queued"
  | "authenticating"
  | "collection_queued"
  | "collecting"
  | "legacy_authenticating"
  | "legacy_waiting"
  | "legacy_collecting";
interface JobBase extends FumiReceiptRequest {
  sourceSha256: string;
  requestedAt: string;
  runId: string;
}
type Job =
  | (JobBase & { stage: "queued"; code: string; challenge: VPointEmailChallengeState })
  | (JobBase & { stage: Exclude<JobStage, "queued"> });
interface StoredReceipt {
  value: FumiReceipt;
  state: JobStage | "complete" | "failed" | "uncertain" | "no_claim" | "accepted_alias";
}
interface LegacyMetadata {
  sourceSha256: string;
  receivedAt: string;
  recipient: string;
}
export type LegacyCompletion =
  | (FumiReceiptRequest & { status: "authenticated" })
  | { status: "already_handled" | "not_applicable" };
export interface EmailChallengeResult {
  status: "created" | "pending";
  requestedAt: string;
}

function jobStage(job: JobBase, stage: Exclude<JobStage, "queued">): Job {
  // Never retain the code or provider challenge after the external attempt begins.
  return {
    schemaVersion: 1,
    operationId: job.operationId,
    requestSha256: job.requestSha256,
    sourceSha256: job.sourceSha256,
    requestedAt: job.requestedAt,
    runId: job.runId,
    stage,
  };
}
function fresh(requestedAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(requestedAt);
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp < CHALLENGE_TTL_MS;
}
function inRequestWindow(receivedAt: string, requestedAt: string, now: number): boolean {
  const received = Date.parse(receivedAt),
    requested = Date.parse(requestedAt);
  return (
    validTime(receivedAt) &&
    received >= requested &&
    received <= now &&
    received - requested < CHALLENGE_TTL_MS
  );
}

export class VPointSession extends DurableObject<Env> {
  private authInFlight: Promise<EmailChallengeResult> | null = null;
  private readonly state: DurableObjectState;
  private readonly environment: Env;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.environment = env;
  }
  async getSession(): Promise<string | null> {
    return (await this.state.storage.get<string>(SESSION_KEY)) ?? null;
  }
  async invalidateSession(): Promise<void> {
    await this.state.storage.delete(SESSION_KEY);
  }
  async hasPendingChallenge(): Promise<boolean> {
    const pending = await this.state.storage.get<VPointEmailChallengeState>(PENDING_KEY);
    return Boolean(
      pending && fresh(pending.requestedAt) && !(await this.state.storage.get(JOB_KEY)),
    );
  }
  async ensureEmailChallenge(runId = crypto.randomUUID()): Promise<EmailChallengeResult> {
    const job = await this.state.storage.get<Job>(JOB_KEY);
    if (job) return { status: "pending", requestedAt: job.requestedAt };
    const pending = await this.state.storage.get<VPointEmailChallengeState>(PENDING_KEY);
    if (pending && fresh(pending.requestedAt))
      return { status: "pending", requestedAt: pending.requestedAt };
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.createEmailChallenge(runId);
    try {
      return await this.authInFlight;
    } finally {
      this.authInFlight = null;
    }
  }
  async fumiReceipt(value: unknown): Promise<FumiReceipt> {
    const input = parseFumiReceiptRequest(value);
    const found = await this.state.storage.get<StoredReceipt>(receiptKey(input.operationId));
    return found ? this.previous(found, input) : receipt(input, "not_found");
  }
  async fumiOffer(value: unknown): Promise<FumiReceipt> {
    const input = await parseFumiOffer(value);
    const manifestSha256 = await sha256(FUMI_MANIFEST_JSON);
    return this.state.storage.transaction(async (txn) => {
      const previous = await txn.get<StoredReceipt>(receiptKey(input.operationId));
      if (previous) return this.previous(previous, input);
      // Recheck after parsing/hashing and within the atomic claim transaction.
      if (!freshAttempt(input, Date.now())) return receipt(input, "retryable_error");
      if (
        input.pluginId !== FUMI_PLUGIN_ID ||
        input.manifestVersion !== FUMI_MANIFEST_VERSION ||
        input.manifestSha256 !== manifestSha256 ||
        input.input.subject === undefined ||
        input.input.text === undefined ||
        input.input.envelope === undefined
      )
        return this.recordNoClaim(txn, input, "rejected");
      const recipient = this.environment.VPOINT_EMAIL_RECIPIENT;
      const code = extractVPointTextCode(input.input.subject, input.input.text);
      if (!recipient) return this.recordNoClaim(txn, input, "rejected");
      if (!isCollectorRecipient(input.input.envelope.to, [recipient]) || !code)
        return this.recordNoClaim(txn, input, "not_applicable");
      return this.claim(
        txn,
        input,
        input.source.rawSha256,
        input.source.receivedAt,
        code,
        "owner",
        crypto.randomUUID(),
        input.attempt,
      );
    });
  }
  /** Legacy delivery retains synchronous auth/collection, under the same durable gate. */
  async completeEmailCode(
    code: string,
    runId: string,
    metadata: LegacyMetadata,
  ): Promise<LegacyCompletion> {
    if (
      !metadata ||
      !/^[a-f0-9]{64}$/.test(metadata.sourceSha256) ||
      !validTime(metadata.receivedAt)
    )
      throw new Error("Invalid legacy email identity");
    const normalized = normalizeEmailCode(code);
    const input: FumiReceiptRequest = {
      schemaVersion: 1,
      operationId: await sha256(`legacy-vpoint-email:${metadata.sourceSha256}`),
      requestSha256: await sha256(
        canonicalJson({
          sourceSha256: metadata.sourceSha256,
          recipient: metadata.recipient.trim().toLowerCase(),
          code: normalized,
        }),
      ),
    };
    const accepted = await this.state.storage.transaction(async (txn) => {
      const old = await txn.get<StoredReceipt>(receiptKey(input.operationId));
      if (old) return this.previous(old, input);
      const recipient = this.environment.VPOINT_EMAIL_RECIPIENT;
      if (!recipient || !isCollectorRecipient(metadata.recipient, [recipient]))
        return this.recordNoClaim(txn, input, "not_applicable");
      return this.claim(
        txn,
        input,
        metadata.sourceSha256,
        metadata.receivedAt,
        normalized,
        "legacy",
        runId,
      );
    });
    if (accepted.result === "not_applicable") return { status: "not_applicable" };
    if (accepted.result !== "handled") throw new Error("V Point email claim unavailable");
    const job = await this.state.storage.get<Job>(JOB_KEY);
    if (!job || job.operationId !== input.operationId || job.stage !== "queued")
      return { status: "already_handled" };
    if (!(await this.startJob(job, "legacy_authenticating"))) return { status: "already_handled" };
    try {
      const authenticated = await completeVPointEmailLogin({
        state: job.challenge,
        code: job.code,
        onTrace: (trace) => logAuthTrace(runId, trace),
      });
      const changed = await this.state.storage.transaction(async (txn) => {
        const current = await txn.get<Job>(JOB_KEY);
        if (
          !current ||
          current.operationId !== job.operationId ||
          current.stage !== "legacy_authenticating"
        )
          return false;
        await txn.put(SESSION_KEY, authenticated.sessionCookie);
        await txn.put(JOB_KEY, jobStage(job, "legacy_waiting"));
        await this.state.storage.setAlarm(Date.now() + WATCHDOG_MS);
        return true;
      });
      if (!changed) throw new Error("V Point email claim became uncertain");
      return { ...input, status: "authenticated" };
    } catch {
      await this.finishJob(job, "failed");
      throw new Error("V Point email authentication failed");
    }
  }
  async beginLegacyCollection(input: FumiReceiptRequest): Promise<boolean> {
    parseFumiReceiptRequest(input);
    return this.state.storage.transaction(async (txn) => {
      const job = await txn.get<Job>(JOB_KEY);
      if (
        !job ||
        job.operationId !== input.operationId ||
        job.requestSha256 !== input.requestSha256 ||
        job.stage !== "legacy_waiting"
      )
        return false;
      await txn.put(JOB_KEY, jobStage(job, "legacy_collecting"));
      await this.state.storage.setAlarm(Date.now() + COLLECTION_WATCHDOG_MS);
      return true;
    });
  }
  async finishLegacyCollection(input: FumiReceiptRequest, persisted: boolean): Promise<void> {
    parseFumiReceiptRequest(input);
    const job = await this.state.storage.get<Job>(JOB_KEY);
    if (
      job &&
      job.operationId === input.operationId &&
      job.requestSha256 === input.requestSha256 &&
      job.stage === "legacy_collecting"
    )
      await this.finishJob(job, persisted ? "complete" : "failed");
  }
  override async alarm(): Promise<void> {
    const job = await this.state.storage.get<Job>(JOB_KEY);
    if (!job) {
      await this.state.storage.transaction(async (txn) => {
        const pending = await txn.get<VPointEmailChallengeState>(PENDING_KEY);
        if (pending && !fresh(pending.requestedAt)) await txn.delete(PENDING_KEY);
      });
      return;
    }
    if (job.stage === "queued") {
      if (!fresh(job.requestedAt)) {
        await this.finishJob(job, "failed");
        return;
      }
      if (!(await this.startJob(job, "authenticating"))) return;
      try {
        const authenticated = await completeVPointEmailLogin({
          state: job.challenge,
          code: job.code,
          onTrace: (trace) => logAuthTrace(job.runId, trace),
        });
        await this.state.storage.transaction(async (txn) => {
          const current = await txn.get<Job>(JOB_KEY);
          if (
            !current ||
            current.operationId !== job.operationId ||
            current.stage !== "authenticating"
          )
            return;
          await txn.put(SESSION_KEY, authenticated.sessionCookie);
          await txn.put(JOB_KEY, jobStage(job, "collection_queued"));
          await this.state.storage.setAlarm(Date.now() + 1);
        });
      } catch {
        await this.finishJob(job, "failed");
      }
      return;
    }
    if (job.stage === "collection_queued") {
      if (!(await this.startJob(job, "collecting"))) return;
      try {
        const result = await runCollection(
          this.environment,
          { parentRunId: job.runId, acquisitionSessionRef: emailSessionRef(job.sourceSha256) },
          this,
        );
        await this.finishJob(
          job,
          result.manifest.status !== "failed" && result.terminal.persisted ? "complete" : "failed",
        );
      } catch {
        await this.finishJob(job, "failed");
      }
      return;
    }
    // A restart after an external attempt may have lost its response. Never replay it.
    await this.finishJob(job, "uncertain");
  }
  private previous(stored: StoredReceipt, input: FumiReceiptRequest): FumiReceipt {
    return stored.value.requestSha256 === input.requestSha256
      ? stored.value
      : receipt(input, "rejected");
  }
  private async recordNoClaim(
    txn: DurableObjectTransaction,
    input: FumiReceiptRequest,
    result: "not_applicable" | "rejected",
  ): Promise<FumiReceipt> {
    const value = receipt(input, result);
    await txn.put(receiptKey(input.operationId), {
      value,
      state: "no_claim",
    } satisfies StoredReceipt);
    return value;
  }
  private async claim(
    txn: DurableObjectTransaction,
    input: FumiReceiptRequest,
    sourceSha256: string,
    receivedAt: string,
    code: string,
    mode: "owner" | "legacy",
    runId = crypto.randomUUID(),
    attempt?: FumiOfferRequest["attempt"],
  ): Promise<FumiReceipt> {
    if (await txn.get<string>(sourceKey(sourceSha256))) {
      if (attempt && !freshAttempt({ attempt }, Date.now()))
        return receipt(input, "retryable_error");
      const value = receipt(input, "handled");
      await txn.put(receiptKey(input.operationId), {
        value,
        state: "accepted_alias",
      } satisfies StoredReceipt);
      return value;
    }
    if (await txn.get(JOB_KEY)) return receipt(input, "retryable_error");
    const requesting = await txn.get<{ requestedAt: string }>(REQUESTING_KEY);
    if (requesting && Date.now() - Date.parse(requesting.requestedAt) < WATCHDOG_MS)
      return receipt(input, "retryable_error");
    const pending = await txn.get<VPointEmailChallengeState>(PENDING_KEY),
      now = Date.now();
    if (
      !pending ||
      !fresh(pending.requestedAt, now) ||
      !inRequestWindow(receivedAt, pending.requestedAt, now)
    )
      return this.recordNoClaim(txn, input, "not_applicable");
    if (attempt && !freshAttempt({ attempt }, Date.now())) return receipt(input, "retryable_error");
    const value = receipt(input, "handled");
    const job: Job = {
      ...input,
      sourceSha256,
      requestedAt: pending.requestedAt,
      runId,
      stage: "queued",
      challenge: pending,
      code,
    };
    await txn.put({
      [JOB_KEY]: job,
      [receiptKey(input.operationId)]: { value, state: "queued" } satisfies StoredReceipt,
      [sourceKey(sourceSha256)]: input.operationId,
    });
    await txn.delete(PENDING_KEY);
    // SQLite alarm writes participate in the surrounding storage transaction.
    await this.state.storage.setAlarm(Date.now() + (mode === "owner" ? 1000 : WATCHDOG_MS));
    return value;
  }
  private async startJob(
    job: Job,
    stage: "authenticating" | "collecting" | "legacy_authenticating",
  ): Promise<boolean> {
    return this.state.storage.transaction(async (txn) => {
      const current = await txn.get<Job>(JOB_KEY);
      if (!current || current.operationId !== job.operationId || current.stage !== job.stage)
        return false;
      await txn.put(JOB_KEY, jobStage(job, stage));
      await txn.put(receiptKey(job.operationId), {
        value: receipt(job, "handled"),
        state: stage,
      } satisfies StoredReceipt);
      await this.state.storage.setAlarm(
        Date.now() + (stage === "collecting" ? COLLECTION_WATCHDOG_MS : WATCHDOG_MS),
      );
      return true;
    });
  }
  private async finishJob(job: JobBase, state: "complete" | "failed" | "uncertain"): Promise<void> {
    await this.state.storage.transaction(async (txn) => {
      const current = await txn.get<Job>(JOB_KEY);
      if (!current || current.operationId !== job.operationId) return;
      await txn.put(receiptKey(job.operationId), {
        value: receipt(job, "handled"),
        state,
      } satisfies StoredReceipt);
      await txn.delete(JOB_KEY);
      await this.state.storage.deleteAlarm();
    });
    logEvent({ event: "vpoint-owner-job", runId: job.runId, status: state });
  }
  private async createEmailChallenge(runId: string): Promise<EmailChallengeResult> {
    const token = crypto.randomUUID(),
      requestedAt = new Date().toISOString();
    const canStart = await this.state.storage.transaction(async (txn) => {
      if (await txn.get(JOB_KEY)) return false;
      const existing = await txn.get<{ token: string; requestedAt: string }>(REQUESTING_KEY);
      if (existing && Date.now() - Date.parse(existing.requestedAt) < WATCHDOG_MS) return false;
      await txn.put(REQUESTING_KEY, { token, requestedAt });
      await txn.delete(PENDING_KEY);
      return true;
    });
    if (!canStart) return { status: "pending", requestedAt };
    try {
      const memberNumber = this.environment.VPOINT_MEMBER_NUMBER;
      if (!memberNumber) throw new Error("Missing Worker secret: VPOINT_MEMBER_NUMBER");
      const challenge = await beginVPointEmailLogin({
        memberNumber,
        onTrace: (trace) => logAuthTrace(runId, trace),
      });
      const committed = await this.state.storage.transaction(async (txn) => {
        const requesting = await txn.get<{ token: string }>(REQUESTING_KEY);
        if (requesting?.token !== token || (await txn.get(JOB_KEY))) return false;
        await txn.put(PENDING_KEY, challenge.state);
        await txn.delete(REQUESTING_KEY);
        await this.state.storage.setAlarm(
          Math.max(Date.now() + 1, Date.parse(challenge.requestedAt) + CHALLENGE_TTL_MS),
        );
        return true;
      });
      if (!committed) throw new Error("V Point email challenge superseded");
      return { status: "created", requestedAt: challenge.requestedAt };
    } finally {
      await this.state.storage.transaction(async (txn) => {
        const requesting = await txn.get<{ token: string }>(REQUESTING_KEY);
        if (requesting?.token === token) await txn.delete(REQUESTING_KEY);
      });
    }
  }
}
