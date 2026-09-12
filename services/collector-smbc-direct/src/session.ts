import { DurableObject } from "cloudflare:workers";
import { createDiagnostics } from "../../../packages/collector-diagnostics/src/index";
import { decryptJson, encryptJson, parseCredentials } from "./crypto";
import { japanToday, monthRanges, validateDate } from "./dates";
import { isResumable } from "./progress";
import {
  dataBucket,
  manifestBytes,
  persistSharedRun,
  readStagedArtifacts,
  sharedRunPersisted,
} from "./shared-collection";
import {
  ApprovalNotCompletedError,
  DirectProfile,
  finishLogin,
  qrDataUrl,
  startLogin,
  type DirectOrigins,
} from "./smbc";
import { runPrefix, storeBytes, storeJson, storeManifest } from "./storage";
import type {
  AuthenticatedSession,
  BackfillManifest,
  BackfillProgress,
  ChallengeState,
  EncryptedPayload,
  FinishChallengeResult,
  StartChallengeResult,
  StoredArtifact,
} from "./types";
const INITIAL_PROGRESS: BackfillProgress = {
  phase: "idle",
  createdAt: null,
  challengeExpiresAt: null,
  runId: null,
  startedAt: null,
  completedAt: null,
  from: null,
  to: null,
  nextRange: null,
  completedChunks: 0,
  totalChunks: 0,
  transactionCount: 0,
  artifactCount: 0,
  retryCount: 0,
  lastErrorCode: null,
  logoutSucceeded: null,
  manifestKey: null,
};
const CHUNKS_PER_ALARM = 3;
const MAX_RETRIES = 3;
export class SmbcBackfillSession extends DurableObject<Env> {
  #operationTail: Promise<void> = Promise.resolve();
  async getStatus(): Promise<BackfillProgress> {
    return { ...INITIAL_PROGRESS, ...(await this.ctx.storage.get<BackfillProgress>("progress")) };
  }
  async startChallenge(): Promise<StartChallengeResult> {
    return this.#exclusive(async () => {
      const progress = await this.getStatus();
      if (progress.phase === "running") throw new Error("backfill_already_running");
      const existing = await this.#loadChallenge();
      if (existing && Date.parse(existing.expiresAt) > Date.now()) {
        return {
          phase: "waiting_for_approval",
          qrSvgDataUrl: qrDataUrl(existing.appUrl),
          appUrl: existing.appUrl,
          expiresAt: existing.expiresAt,
        };
      }
      const { state, qrSvgDataUrl } = await startLogin(
        this.#origins(),
        this.#credentials(),
        this.env.TAMIA,
      );
      const encrypted = await encryptJson(state, this.env.SESSION_ENCRYPTION_KEY);
      const resumable = isResumable(progress);
      const next: BackfillProgress = resumable
        ? {
            ...progress,
            phase: "waiting_for_approval",
            createdAt: state.createdAt,
            challengeExpiresAt: state.expiresAt,
            completedAt: null,
            nextRange:
              progress.from && progress.to
                ? (monthRanges(progress.from, progress.to)[progress.completedChunks] ?? null)
                : null,
            retryCount: 0,
            lastErrorCode: null,
            logoutSucceeded: null,
          }
        : {
            ...INITIAL_PROGRESS,
            phase: "waiting_for_approval",
            createdAt: state.createdAt,
            challengeExpiresAt: state.expiresAt,
          };
      await this.ctx.storage.put({ challenge: encrypted, progress: next });
      return {
        phase: "waiting_for_approval",
        qrSvgDataUrl,
        appUrl: state.appUrl,
        expiresAt: state.expiresAt,
      };
    });
  }
  async finishAndStart(): Promise<FinishChallengeResult> {
    return this.#exclusive(async () => {
      const current = await this.getStatus();
      if (current.phase === "running") return { phase: current.phase, progress: current };
      const from = validateDate(this.env.DEFAULT_BACKFILL_FROM, "from");
      const to = japanToday();
      const ranges = monthRanges(from, to);
      const challenge = await this.#loadChallenge();
      if (!challenge) throw new Error("challenge_missing");
      let profile: DirectProfile;
      try {
        profile = await finishLogin(
          this.#origins(),
          this.#credentials(),
          challenge,
          this.env.TAMIA,
        );
      } catch (error) {
        if (error instanceof ApprovalNotCompletedError) {
          const waiting: BackfillProgress = {
            ...current,
            phase: "idle",
            challengeExpiresAt: null,
            lastErrorCode: "approval_not_completed_generate_new_qr",
          };
          await this.ctx.storage.put("progress", waiting);
          await this.ctx.storage.delete("challenge");
          return { phase: waiting.phase, progress: waiting };
        }
        throw error;
      }
      if (
        isResumable(current) &&
        current.from === from &&
        current.to === to &&
        current.runId &&
        current.startedAt
      ) {
        const artifacts = (await this.ctx.storage.get<StoredArtifact[]>("artifacts")) ?? [];
        const resumed: BackfillProgress = {
          ...current,
          phase: "running",
          completedAt: null,
          challengeExpiresAt: null,
          nextRange: ranges[current.completedChunks] ?? null,
          artifactCount: artifacts.length,
          retryCount: 0,
          lastErrorCode: null,
          logoutSucceeded: null,
        };
        await this.ctx.storage.put({
          progress: resumed,
          session: await encryptJson(profile.export(), this.env.SESSION_ENCRYPTION_KEY),
          artifacts,
          failureCodes: [],
          // A resume is a new authenticated session, so it opens a new
          // generation. `runSessionRef` is not touched: the run keeps the
          // generation that opened it (12 §4).
          sessionRef: `session-${crypto.randomUUID()}`,
        });
        await this.ctx.storage.delete("challenge");
        await this.ctx.storage.setAlarm(Date.now());
        return { phase: resumed.phase, progress: resumed };
      }
      const startedAt = new Date().toISOString();
      const runId = crypto.randomUUID();
      const diagnostic = createDiagnostics("smbc-direct", runId);
      const prefix = runPrefix(startedAt, runId);
      const artifacts: StoredArtifact[] = [];
      const session = await encryptJson(profile.export(), this.env.SESSION_ENCRYPTION_KEY);
      const progress: BackfillProgress = {
        ...INITIAL_PROGRESS,
        phase: "running",
        runId,
        startedAt,
        from,
        to,
        nextRange: ranges[0] ?? null,
        totalChunks: ranges.length,
        artifactCount: 0,
      };
      // A fresh run opens a new session generation and pins it to the run, so
      // the terminal names the acquisition session the backfill started with
      // even if a later resume authenticates again (12 §4).
      const sessionRef = `session-${crypto.randomUUID()}`;
      await this.ctx.storage.put({
        progress,
        session,
        artifacts,
        failureCodes: [],
        sessionRef,
        runSessionRef: sessionRef,
      });
      await this.ctx.storage.delete("challenge");
      try {
        const balance = await diagnostic.step("balance-collection", () => profile.getBalance());
        upsertArtifact(
          artifacts,
          await storeBytes({
            bucket: this.env.DATA,
            key: `${prefix}/balance.raw.json.sjis`,
            bytes: balance.rawBytes,
            mediaType: balance.rawContentType,
            artifact: { dataset: "balance-raw" },
          }),
        );
        upsertArtifact(
          artifacts,
          await storeJson({
            bucket: this.env.DATA,
            key: `${prefix}/balance.normalized.json`,
            value: {
              observedAt: startedAt,
              currency: balance.currency,
              amount: balance.amount,
            },
            artifact: { dataset: "balance-normalized" },
          }),
        );
        progress.artifactCount = artifacts.length;
        progress.manifestKey = await storeManifest(
          this.env.DATA,
          prefix,
          this.#manifest(progress, artifacts, []),
        );
        await this.ctx.storage.put({ progress, artifacts });
        await this.ctx.storage.setAlarm(Date.now());
        return { phase: progress.phase, progress };
      } catch (error) {
        await this.#fail(progress, artifacts, [classifyError(error)], profile);
        throw error;
      }
    });
  }
  override async alarm(): Promise<void> {
    await this.#exclusive(async () => {
      let progress = await this.getStatus();
      if (
        progress.phase !== "running" ||
        !progress.from ||
        !progress.to ||
        !progress.startedAt ||
        !progress.runId
      ) {
        return;
      }
      const ranges = monthRanges(progress.from, progress.to);
      const artifacts = (await this.ctx.storage.get<StoredArtifact[]>("artifacts")) ?? [];
      const failureCodes = (await this.ctx.storage.get<string[]>("failureCodes")) ?? [];
      const encrypted = await this.ctx.storage.get<EncryptedPayload>("session");
      if (!encrypted) {
        await this.#fail(progress, artifacts, [...failureCodes, "session_missing"]);
        return;
      }
      const profile = DirectProfile.import(
        this.#origins(),
        this.#credentials(),
        await decryptJson<AuthenticatedSession>(encrypted, this.env.SESSION_ENCRYPTION_KEY),
        this.env.TAMIA,
      );
      const diagnostic = createDiagnostics("smbc-direct", progress.runId);
      const prefix = runPrefix(progress.startedAt, progress.runId);
      let stage = "transactions-collection";
      try {
        for (let index = 0; index < CHUNKS_PER_ALARM; index += 1) {
          const range = ranges[progress.completedChunks];
          if (!range) break;
          stage = "transactions-collection";
          const result = await diagnostic.step(stage, () => profile.getTransactions(range));
          const rangeName = `${range.start.replaceAll("-", "")}-${range.end.replaceAll("-", "")}`;
          stage = "artifact-write";
          const rawArtifact = await storeBytes({
            bucket: this.env.DATA,
            key: `${prefix}/transactions/${rangeName}.raw.json.sjis`,
            bytes: result.rawBytes,
            mediaType: result.rawContentType,
            artifact: {
              dataset: "transactions-raw",
              range,
              transactionCount: result.transactions.length,
            },
          });
          // Preserve a successfully stored provider response even when writing
          // its normalized counterpart fails. A terminal partial manifest can
          // then describe the exact R2 prefix instead of leaving an unlisted
          // raw object that no strict importer can accept.
          upsertArtifact(artifacts, rawArtifact);
          const normalizedArtifact = await storeJson({
            bucket: this.env.DATA,
            key: `${prefix}/transactions/${rangeName}.normalized.json`,
            value: {
              range,
              depositsTotal: result.depositsTotal,
              withdrawalsTotal: result.withdrawalsTotal,
              transactions: result.transactions,
            },
            artifact: {
              dataset: "transactions-normalized",
              range,
              transactionCount: result.transactions.length,
            },
          });
          upsertArtifact(artifacts, normalizedArtifact);
          progress = {
            ...progress,
            completedChunks: progress.completedChunks + 1,
            nextRange: ranges[progress.completedChunks + 1] ?? null,
            transactionCount: progress.transactionCount + result.transactions.length,
            artifactCount: artifacts.length,
            retryCount: 0,
            lastErrorCode: null,
          };
          stage = "progress-persist";
          await this.ctx.storage.put({
            progress,
            artifacts,
            session: await encryptJson(profile.export(), this.env.SESSION_ENCRYPTION_KEY),
          });
          stage = "manifest-write";
          progress.manifestKey = await storeManifest(
            this.env.DATA,
            prefix,
            this.#manifest(progress, artifacts, failureCodes),
          );
          await this.ctx.storage.put("progress", progress);
        }
        if (progress.completedChunks >= ranges.length) {
          let logoutSucceeded = false;
          try {
            await diagnostic.step("logout", () => profile.logout());
            logoutSucceeded = true;
          } catch {
            failureCodes.push("logout_failed");
          }
          const completed: BackfillProgress = {
            ...progress,
            phase: failureCodes.length === 0 ? "success" : "partial",
            completedAt: new Date().toISOString(),
            nextRange: null,
            logoutSucceeded,
          };
          completed.manifestKey = await storeManifest(
            this.env.DATA,
            prefix,
            this.#manifest(completed, artifacts, failureCodes),
          );
          await this.ctx.storage.put({ progress: completed, artifacts, failureCodes });
          await this.ctx.storage.delete("session");
          await this.ctx.storage.deleteAlarm();
          await this.#finishRun(completed, artifacts, failureCodes);
          diagnostic.finish(completed.phase === "success" ? "success" : "partial");
          console.log(
            JSON.stringify({
              message: "smbc_backfill_complete",
              runId: completed.runId,
              status: completed.phase,
              completedChunks: completed.completedChunks,
              transactionCount: completed.transactionCount,
              artifactCount: completed.artifactCount,
            }),
          );
          return;
        }
        await this.ctx.storage.setAlarm(Date.now());
      } catch (error) {
        if (stage !== "transactions-collection") diagnostic.failure(stage, error);
        const errorCode = classifyError(error);
        const retryCount = progress.retryCount + 1;
        const retrying: BackfillProgress = { ...progress, retryCount, lastErrorCode: errorCode };
        await this.ctx.storage.put({
          progress: retrying,
          artifacts,
          session: await encryptJson(profile.export(), this.env.SESSION_ENCRYPTION_KEY),
        });
        diagnostic.retry(stage, retryCount, retryCount <= MAX_RETRIES);
        if (retryCount <= MAX_RETRIES) {
          await this.ctx.storage.setAlarm(Date.now() + 2 ** retryCount * 2000);
          return;
        }
        await this.#fail(retrying, artifacts, [...failureCodes, errorCode], profile);
      }
    });
  }
  async #fail(
    progress: BackfillProgress,
    artifacts: StoredArtifact[],
    failureCodes: string[],
    profile?: DirectProfile,
  ): Promise<void> {
    let logoutSucceeded = false;
    if (profile) {
      try {
        await profile.logout();
        logoutSucceeded = true;
      } catch {
        if (!failureCodes.includes("logout_failed")) failureCodes.push("logout_failed");
      }
    }
    const failed: BackfillProgress = {
      ...progress,
      phase: artifacts.length > 2 ? "partial" : "failed",
      completedAt: new Date().toISOString(),
      nextRange: null,
      artifactCount: artifacts.length,
      lastErrorCode: failureCodes.at(-1) ?? "unexpected_error",
      logoutSucceeded,
    };
    if (failed.startedAt && failed.runId) {
      const prefix = runPrefix(failed.startedAt, failed.runId);
      failed.manifestKey = await storeManifest(
        this.env.DATA,
        prefix,
        this.#manifest(failed, artifacts, failureCodes),
      );
    }
    await this.ctx.storage.put({ progress: failed, artifacts, failureCodes });
    await this.ctx.storage.delete("session");
    await this.ctx.storage.deleteAlarm();
    if (failed.manifestKey && failed.runId) {
      await this.#finishRun(failed, artifacts, failureCodes);
    }
    if (failed.runId)
      createDiagnostics("smbc-direct", failed.runId).finish(
        failed.phase === "partial" ? "partial" : "failed",
      );
    console.error(
      JSON.stringify({
        message: "smbc_backfill_failed",
        runId: failed.runId,
        status: failed.phase,
        errorCode: failed.lastErrorCode,
      }),
    );
  }
  #manifest(
    progress: BackfillProgress,
    artifacts: StoredArtifact[],
    failureCodes: string[],
  ): BackfillManifest {
    if (!progress.runId || !progress.startedAt || !progress.from || !progress.to) {
      throw new Error("manifest_progress_invalid");
    }
    const status: BackfillManifest["status"] =
      progress.phase === "success"
        ? "success"
        : progress.phase === "partial"
          ? "partial"
          : progress.phase === "failed"
            ? "failed"
            : "running";
    return {
      schemaVersion: this.env.COLLECTOR_SCHEMA_VERSION,
      source: "smbc-direct",
      runId: progress.runId,
      startedAt: progress.startedAt,
      completedAt: progress.completedAt,
      status,
      requestedRange: { start: progress.from, end: progress.to },
      completedChunks: progress.completedChunks,
      totalChunks: progress.totalChunks,
      transactionCount: progress.transactionCount,
      artifacts,
      failureCodes,
      logoutSucceeded: progress.logoutSucceeded,
    };
  }
  async #loadChallenge(): Promise<ChallengeState | null> {
    const encrypted = await this.ctx.storage.get<EncryptedPayload>("challenge");
    return encrypted
      ? decryptJson<ChallengeState>(encrypted, this.env.SESSION_ENCRYPTION_KEY)
      : null;
  }
  #origins(): DirectOrigins {
    return {
      baseURL: this.env.SMBC_DIRECT_BASE_URL,
      loginURL: this.env.SMBC_DIRECT_LOGIN_BASE_URL,
    };
  }
  #credentials() {
    return parseCredentials(this.env.SMBC_CREDENTIAL_JSON);
  }
  /**
   * U09: finish the run where `COLLECTION_TARGET` says. In legacy mode this is
   * the central importer call, unchanged. In shared mode the run's own bytes
   * are re-read from the staging bucket, verified against the manifest and
   * written into DATA with the `terminal-v1` manifest last — one terminal per
   * backfill run, whether it succeeded, ended partial or failed — and the
   * importer is not called (G1-15).
   */
  async #finishRun(
    progress: BackfillProgress,
    artifacts: StoredArtifact[],
    failureCodes: string[],
  ): Promise<void> {
    if (!progress.manifestKey || !progress.runId || !progress.startedAt) return;
    const manifest = this.#manifest(progress, artifacts, failureCodes);
    const prefix = runPrefix(progress.startedAt, progress.runId);
    const acquisitionSessionRef = await this.ctx.storage.get<string>("runSessionRef");
    try {
      const staging = dataBucket(this.env.DATA);
      const summary = await persistSharedRun(dataBucket(this.env.DATA), {
        manifest,
        manifestBytes: manifestBytes(manifest),
        prefix,
        bytesByKey: await readStagedArtifacts(staging, manifest),
        identity: {
          attemptId: `attempt-${crypto.randomUUID()}`,
          ...(acquisitionSessionRef === undefined ? {} : { acquisitionSessionRef }),
        },
      });
      console[sharedRunPersisted(summary) ? "log" : "error"](
        JSON.stringify({
          message: "smbc_shared_persist",
          runId: progress.runId,
          status: manifest.status,
          collectionTarget: "shared",
          sharedOutcome: summary.outcome,
          terminalKey: summary.terminalKey,
          terminalDigest: summary.terminalDigest,
          objectCount: summary.objectCount,
          waitingForHuman: summary.waitingForHuman,
          ...(summary.reasonCode ? { errorCode: summary.reasonCode } : {}),
        }),
      );
    } catch (error) {
      // No terminal exists, so the run is not reported persisted (G1-01). The
      // staging bucket still holds every byte, so a repeat finishes it.
      console.error(
        JSON.stringify({
          message: "smbc_shared_persist_failed",
          runId: progress.runId,
          errorCode: safeSharedErrorCode(error),
        }),
      );
    }
  }
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
const FIXED_COLLECTION_FAILURE_CODES = new Set([
  "_formid_field_missing",
  "_token_field_missing",
  "account_detail_body_missing",
  "account_detail_body_too_large",
  "aifcdt3_form_missing",
  "aifcdtl_form_missing",
  "balance_body_missing",
  "balance_body_too_large",
  "balance_invalid",
  "balance_value_missing",
  "continue_session_body_missing",
  "continue_session_body_too_large",
  "deposits_total_invalid",
  "directheaderform_form_missing",
  "tpaltop_form_missing",
  "transaction_amount_invalid",
  "transaction_balance_invalid",
  "transaction_count_invalid",
  "transaction_date_invalid",
  "transaction_direction_invalid",
  "transactions_body_missing",
  "transactions_body_too_large",
  "transactions_json_invalid",
  "transactions_rejected",
  "transactions_service_time_unavailable",
  "transactions_stop_flag_invalid",
  "withdrawals_total_invalid",
]);
const COLLECTION_HTTP_FAILURE_CODE =
  /^(?:account_detail|balance|continue_session|transactions)_http_[1-5][0-9]{2}$/u;
export function classifyError(error: unknown): string {
  if (error instanceof DOMException) return "crypto_error";
  if (error instanceof SyntaxError) return "json_parse_failed";
  if (error instanceof TypeError) return "type_error";
  if (error instanceof Error) {
    const code = error.message.toLowerCase();
    if (FIXED_COLLECTION_FAILURE_CODES.has(code) || COLLECTION_HTTP_FAILURE_CODE.test(code)) {
      return code;
    }
  }
  return "unexpected_error";
}
/** Only an allowlisted machine code ever reaches a log line. */
function safeSharedErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]{1,64}$/u.test(message) ? message : "shared_persist_failed";
}
function upsertArtifact(artifacts: StoredArtifact[], artifact: StoredArtifact): void {
  const index = artifacts.findIndex((candidate) => candidate.key === artifact.key);
  if (index === -1) artifacts.push(artifact);
  else artifacts[index] = artifact;
}
