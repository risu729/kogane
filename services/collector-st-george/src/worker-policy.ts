import { createHash, timingSafeEqual } from "node:crypto";
import {
  parseStGeorgeSnapshot,
  type StGeorgeSnapshot,
} from "../../../packages/parsers/src/st-george-contract";
import { sharedRunPersisted, type SharedRunInput } from "./shared-collection";
import type { PersistRunResult } from "../../../packages/collection/src/index";

import { safeFailureCode, thrownFailureCode, type FailureCode } from "./result";
import { parseRunDiagnostic, type RunDiagnostic } from "./run-diagnostic";

export function authorized(request: Request, expected: string | undefined): boolean {
  if (!expected || expected.length < 32) return false;
  const provided = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export interface Credential {
  userId: string;
  securityNumber: string;
  password: string;
}
export function parseCredential(value: string | undefined): Credential {
  try {
    if (!value || value.length > 4096) throw new Error();
    const input: unknown = JSON.parse(value);
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error();
    const record = input as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "password,securityNumber,userId")
      throw new Error();
    for (const field of ["userId", "securityNumber", "password"]) {
      const text = record[field];
      if (
        typeof text !== "string" ||
        text.length === 0 ||
        text.length > 256 ||
        /[\r\n\0]/u.test(text)
      )
        throw new Error();
    }
    return {
      userId: record.userId as string,
      securityNumber: record.securityNumber as string,
      password: record.password as string,
    };
  } catch {
    throw new Error("invalid-credentials");
  }
}

export type CollectionOutput =
  | { status: "success"; snapshot: StGeorgeSnapshot }
  | { status: "failed"; reason: FailureCode; diagnostic?: RunDiagnostic };
export function parseCollectionOutput(value: unknown): CollectionOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid-snapshot");
  const input = value as Record<string, unknown>;
  if (input.status === "failed") {
    const diagnostic = parseRunDiagnostic(input.diagnostic);
    return {
      status: "failed",
      reason: safeFailureCode(input.reason),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
  if (input.status !== "success" || Object.keys(input).sort().join(",") !== "snapshot,status")
    throw new Error("invalid-snapshot");
  const snapshot = parseStGeorgeSnapshot(input.snapshot);
  // Bound the complete projection; durable storage splits it into 64 KiB chunks.
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 2 * 1024 * 1024)
    throw new Error("invalid-snapshot");
  return { status: "success", snapshot };
}

export interface StateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
  transaction<T>(closure: (storage: StateStorage) => Promise<T>): Promise<T>;
}
/**
 * A login refusal pauses later logins. The pause records which run caused it,
 * since when, and a salted PBKDF2 digest of the credential that run sent, so a
 * changed credential lifts it by itself. The credential itself is never kept.
 */
interface PausedState {
  kind: "paused";
  reason: FailureCode;
  runId?: string;
  since?: string;
  credential?: CredentialDigest;
}
type StoredState =
  | { kind: "running" }
  | PausedState
  /** Written before 2026-11-08; read as a pause without a credential digest. */
  | { kind: "blocked"; reason: FailureCode; runId?: string; since?: string }
  | {
      kind: "pending";
      run: Omit<SharedRunInput, "snapshot">;
      snapshotChunks: number;
      /** The digest of the credential this run sent, taken when its login was refused. */
      credential?: CredentialDigest;
    };
export interface PublicRunResult {
  status: "stored" | "blocked" | "paused" | "busy" | "failed";
  reason?: FailureCode | "persistence-incomplete" | "persistence-pending";
  runId?: string;
  terminalKey?: string;
}

export interface CredentialDigest {
  salt: string;
  hash: string;
}
/** The digest of the configured credential under `salt`, or null when it cannot be read. */
export type CredentialFingerprint = (salt: string) => Promise<string | null>;

/** A requested collection lifts a pause for one login at most this often. */
export const REQUESTED_LOGIN_SPACING_MS = 24 * 60 * 60 * 1000;

/**
 * Failures after which another unattended login could make things worse: the
 * bank refused the credentials, or it asked for a person (challenge, OTP,
 * locked account). An HTTP 401/403/429 from the bank, its "Request error" page
 * and an unknown page also block unless a validated diagnostic says the run
 * failed before the login click with no login POST observed. Otherwise each
 * may be how the bank answers a wrong password, so retrying daily could lock
 * the account. These pause later
 * logins until the credential changes or an operator requests a collection.
 * Every other failure (a container or browser crash, a network error, a
 * deadline) is recorded as a failed run and the next scheduled run tries again.
 */
const LOGIN_BLOCKING_CODES: ReadonlySet<FailureCode> = new Set([
  "login-rejected",
  "authentication-challenge",
  "human-required",
  "http-denied",
  "bank-request-error",
  "unexpected-route",
]);
const PRE_SUBMIT_RETRY_CODES: ReadonlySet<FailureCode> = new Set([
  "http-denied",
  "bank-request-error",
  "unexpected-route",
]);
/**
 * Container stages that end before the login button is clicked. The POST count
 * matches one exact URL, so after the click a zero count does not prove that no
 * credential left the browser; only a failure in one of these stages does.
 */
const PRE_SUBMIT_STAGES: ReadonlySet<string> = new Set([
  "request-validation",
  "profile-create",
  "relay-start",
  "display-start",
  "browser-start",
  "browser-ready",
  "browser-connect",
  "extractor-load",
  "login-navigate",
  "login-state",
  "login-form",
  "credential-user-id",
  "credential-security-number",
  "credential-password",
  "login-pre-submit-state",
]);
export function blocksLaterLogins(reason: FailureCode, diagnostic?: RunDiagnostic): boolean {
  if (!LOGIN_BLOCKING_CODES.has(reason)) return false;
  return !(
    PRE_SUBMIT_RETRY_CODES.has(reason) &&
    diagnostic?.loginPostCount === 0 &&
    PRE_SUBMIT_STAGES.has(diagnostic.stage)
  );
}

/** What `withCollectionLease` throws when another execution holds the source. */
const LEASE_REFUSAL = "collection_busy_or_uncertain";

export interface TriggerOptions {
  /** An accepted operations-API collection request; the alarm never sets it. */
  operatorRequested?: boolean;
}

/**
 * Serializes attempts in one object. The durable attempt marker is written
 * before any provider request; one left by a reset object is logged and
 * cleared, because the collection lease, not the marker, keeps a second login
 * from overlapping the interrupted one. Nothing here waits for a resume: a
 * pause ends when the credential changes or an operator requests a collection.
 */
export class CollectionCoordinator {
  private active = false;
  constructor(
    private readonly storage: StateStorage,
    private readonly collect: (runId: string) => Promise<CollectionOutput>,
    private readonly persist: (run: SharedRunInput) => Promise<PersistRunResult>,
    private readonly fingerprint: CredentialFingerprint = async () => null,
    private readonly now: () => number = Date.now,
  ) {}
  async trigger(options: TriggerOptions = {}): Promise<PublicRunResult> {
    if (this.active) return { status: "busy" };
    this.active = true;
    try {
      let state = await this.storage.get<StoredState>("state");
      if (state?.kind === "running") {
        // The object was reset during an attempt. Its lease outlived it, so no
        // other attempt can still be running once this one holds the lease.
        logBlockEvent({ event: "st-george-interrupted-attempt-cleared" });
        state = undefined;
      }
      // Put back if the lease is refused after a requested lift, so a busy
      // source neither loses its pause nor spends the day's requested login.
      let restore: { pause: StoredState; requestedLoginAt: number | undefined } | undefined;
      if (state?.kind === "paused" || state?.kind === "blocked") {
        const requestedLoginAt = await this.storage.get<number>("requestedLoginAt");
        const lift = blocksLaterLogins(state.reason)
          ? await this.liftCause(state, options)
          : "not-a-login-refusal";
        if (lift === "requested-collection") restore = { pause: state, requestedLoginAt };
        if (lift === null) {
          logBlockEvent({
            event: "st-george-collection-skipped-paused",
            reason: state.reason,
            pausedRunId: state.runId ?? null,
            pausedSince: state.since ?? null,
            liftedBy: "credential-change-or-requested-collection",
          });
          return {
            status: "paused",
            reason: state.reason,
            ...(state.runId ? { runId: state.runId } : {}),
          };
        }
        logBlockEvent({
          event: "st-george-pause-lifted",
          reason: state.reason,
          pausedRunId: state.runId ?? null,
          cause: lift,
        });
        state = undefined;
      }
      let run: SharedRunInput;
      let pending: Extract<StoredState, { kind: "pending" }>;
      if (state?.kind === "pending") {
        pending = state;
        run = await this.readPending(pending);
      } else {
        const startedAt = new Date(this.now()).toISOString();
        const runId = crypto.randomUUID();
        const attemptId = `attempt-${crypto.randomUUID()}`;
        // This must finish before any container or provider request starts.
        await this.storage.put("state", { kind: "running" });
        let output: CollectionOutput;
        try {
          output = parseCollectionOutput(await this.collect(runId));
        } catch (error) {
          if (error instanceof Error && error.message === LEASE_REFUSAL) {
            // Another execution holds the source; nothing was contacted.
            if (restore) {
              await this.storage.put("state", restore.pause);
              if (restore.requestedLoginAt === undefined)
                await this.storage.delete("requestedLoginAt");
              else await this.storage.put("requestedLoginAt", restore.requestedLoginAt);
            } else await this.storage.delete("state");
            return { status: "busy" };
          }
          output = {
            status: "failed",
            reason: thrownFailureCode(error),
          };
        }
        run = {
          runId,
          attemptId,
          startedAt,
          completedAt: new Date(this.now()).toISOString(),
          ...(output.status === "success"
            ? { snapshot: output.snapshot }
            : {
                reason: output.reason,
                ...(output.diagnostic ? { diagnostic: output.diagnostic } : {}),
              }),
        };
        // The digest is taken in the trigger that sent the credential, so a
        // secret changed before a late persist cannot be mistaken for it.
        const credential =
          run.reason !== undefined && blocksLaterLogins(run.reason, run.diagnostic)
            ? await this.digest()
            : undefined;
        // Save validated financial evidence, never the credential or browser session.
        pending = await this.writePending(run, credential);
      }
      let result: PersistRunResult;
      try {
        result = await this.persist(run);
      } catch {
        return { status: "failed", reason: "persistence-incomplete", runId: run.runId };
      }
      if (!sharedRunPersisted(result))
        return { status: "failed", reason: "persistence-incomplete", runId: run.runId };
      if (run.reason !== undefined) {
        const paused = blocksLaterLogins(run.reason, run.diagnostic);
        const credential = pending.credential;
        await this.finishPending(
          pending,
          paused
            ? {
                kind: "paused",
                reason: run.reason,
                runId: run.runId,
                since: run.completedAt,
                ...(credential ? { credential } : {}),
              }
            : undefined,
        );
        if (paused)
          logBlockEvent({
            event: "st-george-collection-paused",
            reason: run.reason,
            pausedRunId: run.runId,
            pausedSince: run.completedAt,
            liftedBy: "credential-change-or-requested-collection",
          });
        return {
          status: paused ? "blocked" : "failed",
          reason: run.reason,
          runId: run.runId,
          terminalKey: result.terminalKey,
        };
      }
      await this.finishPending(pending);
      return { status: "stored", runId: run.runId, terminalKey: result.terminalKey };
    } finally {
      this.active = false;
    }
  }
  /**
   * Why a login pause may end now, or null. A changed credential always lifts
   * it. A requested collection lifts it for one login, at most once per
   * `REQUESTED_LOGIN_SPACING_MS`, whoever sends the request.
   */
  private async liftCause(
    state: PausedState | Extract<StoredState, { kind: "blocked" }>,
    options: TriggerOptions,
  ): Promise<string | null> {
    if (state.kind === "paused" && state.credential) {
      const current = await this.fingerprint(state.credential.salt);
      if (current !== null && current !== state.credential.hash) return "credential-changed";
    }
    if (options.operatorRequested !== true) return null;
    const last = await this.storage.get<number>("requestedLoginAt");
    const now = this.now();
    if (typeof last === "number" && now - last < REQUESTED_LOGIN_SPACING_MS) return null;
    await this.storage.put("requestedLoginAt", now);
    return "requested-collection";
  }
  private async digest(): Promise<CredentialDigest | undefined> {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = btoa(String.fromCharCode(...bytes));
    const hash = await this.fingerprint(salt);
    return hash === null ? undefined : { salt, hash };
  }
  private chunkKey(runId: string, index: number): string {
    return `pending:${runId}:${index}`;
  }
  private async writePending(
    run: SharedRunInput,
    credential?: CredentialDigest,
  ): Promise<Extract<StoredState, { kind: "pending" }>> {
    const { snapshot, ...metadata } = run;
    const bytes =
      snapshot === undefined
        ? new Uint8Array()
        : new TextEncoder().encode(JSON.stringify(snapshot));
    const chunkSize = 64 * 1024;
    const pending = {
      kind: "pending" as const,
      run: metadata,
      snapshotChunks: Math.ceil(bytes.length / chunkSize),
      ...(credential ? { credential } : {}),
    };
    // Metadata and all chunks commit atomically; no network request occurs in this transaction.
    await this.storage.transaction(async (storage) => {
      for (let index = 0; index < pending.snapshotChunks; index++) {
        await storage.put(
          this.chunkKey(run.runId, index),
          bytes.slice(index * chunkSize, (index + 1) * chunkSize),
        );
      }
      await storage.put("state", pending);
    });
    return pending;
  }
  private async readPending(
    pending: Extract<StoredState, { kind: "pending" }>,
  ): Promise<SharedRunInput> {
    if (pending.snapshotChunks === 0) return pending.run;
    if (
      !Number.isInteger(pending.snapshotChunks) ||
      pending.snapshotChunks < 0 ||
      pending.snapshotChunks > 32
    )
      throw new Error("invalid-snapshot");
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < pending.snapshotChunks; index++) {
      const chunk = await this.storage.get<Uint8Array>(this.chunkKey(pending.run.runId, index));
      if (!(chunk instanceof Uint8Array) || chunk.length > 64 * 1024)
        throw new Error("invalid-snapshot");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const snapshot = parseStGeorgeSnapshot(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    return { ...pending.run, snapshot };
  }
  private async finishPending(
    pending: Extract<StoredState, { kind: "pending" }>,
    state?: StoredState,
  ): Promise<void> {
    await this.storage.transaction(async (storage) => {
      if (state === undefined) await storage.delete("state");
      else await storage.put("state", state);
      for (let index = 0; index < pending.snapshotChunks; index++)
        await storage.delete(this.chunkKey(pending.run.runId, index));
    });
  }
}

/** Fixed event names, closed codes, run UUIDs and timestamps only. */
function logBlockEvent(
  fields: { event: string; reason?: FailureCode } & Record<string, string | null>,
): void {
  try {
    console.warn(JSON.stringify(fields));
  } catch {
    /* A diagnostic must not change the run. */
  }
}

const PBKDF2_ITERATIONS = 100_000;
/**
 * A salted PBKDF2-SHA-256 digest of the parsed credential fields, so a
 * re-pasted secret with other whitespace or key order is the same credential.
 */
export async function credentialDigest(credential: Credential, salt: string): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      JSON.stringify([credential.userId, credential.securityNumber, credential.password]),
    ),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)),
      iterations: PBKDF2_ITERATIONS,
    },
    material,
    256,
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
