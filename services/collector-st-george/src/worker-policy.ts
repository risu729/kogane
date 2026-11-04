import { createHash, timingSafeEqual } from "node:crypto";
import {
  parseStGeorgeSnapshot,
  type StGeorgeSnapshot,
} from "../../../packages/parsers/src/st-george-contract";
import { sharedRunPersisted, type SharedRunInput } from "./shared-collection";
import type { PersistRunResult } from "../../../packages/collection/src/index";

import { safeFailureCode, type FailureCode } from "./result";

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
  | { status: "failed"; reason: FailureCode };
export function parseCollectionOutput(value: unknown): CollectionOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid-snapshot");
  const input = value as Record<string, unknown>;
  if (input.status === "failed") return { status: "failed", reason: safeFailureCode(input.reason) };
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
type StoredState =
  | { kind: "running" }
  | { kind: "blocked"; reason: FailureCode; runId?: string }
  | { kind: "pending"; run: Omit<SharedRunInput, "snapshot">; snapshotChunks: number };
export interface PublicRunResult {
  status: "stored" | "blocked" | "busy" | "failed" | "ready";
  reason?: FailureCode | "persistence-incomplete" | "persistence-pending";
  runId?: string;
  terminalKey?: string;
}

type PendingState = Extract<StoredState, { kind: "pending" }>;
type RetryPendingResult =
  | { status: "busy" }
  | {
      status: "refused";
      reason:
        | "invalid-request"
        | "not-pending"
        | "run-mismatch"
        | "invalid-pending"
        | "state-changed";
    }
  | { status: "failed"; reason: "state-unavailable" | "persistence-incomplete" }
  | { status: "stored"; runId: string; terminalKey: string }
  | { status: "blocked"; reason: FailureCode; runId: string; terminalKey: string };

const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  return (
    Reflect.ownKeys(value).length === keys.split(",").length &&
    Object.keys(value).sort().join(",") === keys
  );
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
/** Strict, owned metadata for this new path; legacy trigger/resume decoding is unchanged. */
function pendingState(value: unknown): PendingState | undefined {
  const state = record(value);
  if (!state || !exactKeys(state, "kind,run,snapshotChunks") || state.kind !== "pending") return;
  const run = record(state.run);
  if (
    !run ||
    !exactKeys(
      run,
      Object.hasOwn(run, "reason")
        ? "attemptId,completedAt,reason,runId,startedAt"
        : "attemptId,completedAt,runId,startedAt",
    )
  )
    return;
  if (
    typeof run.runId !== "string" ||
    !RUN_UUID.test(run.runId) ||
    typeof run.attemptId !== "string" ||
    !run.attemptId.startsWith("attempt-") ||
    !RUN_UUID.test(run.attemptId.slice(8)) ||
    !timestamp(run.startedAt) ||
    !timestamp(run.completedAt) ||
    run.completedAt < run.startedAt
  )
    return;
  const count = state.snapshotChunks;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 32) return;
  const hasReason = Object.hasOwn(run, "reason");
  if (
    hasReason
      ? count !== 0 || typeof run.reason !== "string" || safeFailureCode(run.reason) !== run.reason
      : count === 0
  )
    return;
  return {
    kind: "pending",
    run: {
      runId: run.runId,
      attemptId: run.attemptId,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      ...(hasReason ? { reason: safeFailureCode(run.reason) } : {}),
    },
    snapshotChunks: count,
  };
}

function samePending(left: PendingState, right: PendingState): boolean {
  return (
    left.snapshotChunks === right.snapshotChunks &&
    left.run.runId === right.run.runId &&
    left.run.attemptId === right.run.attemptId &&
    left.run.startedAt === right.run.startedAt &&
    left.run.completedAt === right.run.completedAt &&
    left.run.reason === right.run.reason
  );
}

function snapshotRun(pending: PendingState, chunks: Uint8Array[]): SharedRunInput {
  if (pending.snapshotChunks === 0) return { ...pending.run };
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const snapshot = parseStGeorgeSnapshot(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  return { ...pending.run, snapshot };
}

/** A durable attempt marker prevents a restart from replaying an uncertain login. */
export class CollectionCoordinator {
  private active = false;
  constructor(
    private readonly storage: StateStorage,
    private readonly collect: (runId: string) => Promise<CollectionOutput>,
    private readonly persist: (run: SharedRunInput) => Promise<PersistRunResult>,
  ) {}
  /** Internal only: no route/RPC calls this, and the run id is not an authorization credential. */
  async retryPending(input: unknown): Promise<RetryPendingResult> {
    let expectedRunId: string;
    try {
      const request = record(input);
      const id = request?.expectedRunId;
      if (
        !request ||
        !exactKeys(request, "expectedRunId") ||
        typeof id !== "string" ||
        !RUN_UUID.test(id)
      )
        return { status: "refused", reason: "invalid-request" };
      expectedRunId = id;
    } catch {
      return { status: "refused", reason: "invalid-request" };
    }
    if (this.active) return { status: "busy" };
    this.active = true;
    try {
      const selected = await this.storage.transaction(async (storage) => {
        const raw = await storage.get<unknown>("state");
        if (record(raw)?.kind !== "pending") return { reason: "not-pending" as const };
        const pending = pendingState(raw);
        if (!pending) return { reason: "invalid-pending" as const };
        if (pending.run.runId !== expectedRunId) return { reason: "run-mismatch" as const };
        const chunks = await this.retryChunks(storage, pending);
        if (!chunks) return { reason: "invalid-pending" as const };
        try {
          return { pending, chunks, run: snapshotRun(pending, chunks) };
        } catch {
          return { reason: "invalid-pending" as const };
        }
      });
      if ("reason" in selected) return { status: "refused", reason: selected.reason };
      let result: PersistRunResult;
      try {
        result = await this.persist(selected.run);
      } catch {
        return { status: "failed", reason: "persistence-incomplete" };
      }
      if (!sharedRunPersisted(result))
        return { status: "failed", reason: "persistence-incomplete" };
      // Only storage operations occur inside the retriable transaction. Never repeat external persistence here.
      const finished = await this.storage.transaction(async (storage) => {
        const current = pendingState(await storage.get<unknown>("state"));
        if (!current || !samePending(selected.pending, current)) return false;
        const chunks = await this.retryChunks(storage, current);
        if (
          !chunks ||
          chunks.some((chunk, index) => {
            const saved = selected.chunks[index];
            return (
              !saved ||
              chunk.byteLength !== saved.byteLength ||
              chunk.some((byte, offset) => byte !== saved[offset])
            );
          })
        )
          return false;
        const run = selected.pending.run;
        if (run.reason === undefined) await storage.delete("state");
        else await storage.put("state", { kind: "blocked", reason: run.reason, runId: run.runId });
        for (let index = 0; index < current.snapshotChunks; index++)
          await storage.delete(this.chunkKey(run.runId, index));
        return true;
      });
      if (!finished) return { status: "refused", reason: "state-changed" };
      const run = selected.pending.run;
      return run.reason === undefined
        ? { status: "stored", runId: run.runId, terminalKey: result.terminalKey }
        : {
            status: "blocked",
            reason: run.reason,
            runId: run.runId,
            terminalKey: result.terminalKey,
          };
    } catch {
      return { status: "failed", reason: "state-unavailable" };
    } finally {
      this.active = false;
    }
  }
  /** Inspect every bounded slot, including absent slots: do not erase changed or residual evidence. */
  private async retryChunks(
    storage: StateStorage,
    pending: PendingState,
  ): Promise<Uint8Array[] | undefined> {
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < 32; index++) {
      const value = await storage.get<unknown>(this.chunkKey(pending.run.runId, index));
      if (index >= pending.snapshotChunks) {
        if (value !== undefined) return;
      } else {
        if (
          !(value instanceof Uint8Array) ||
          value.byteLength === 0 ||
          value.byteLength > 64 * 1024
        )
          return;
        chunks.push(value.slice());
      }
    }
    return chunks;
  }
  async resume(): Promise<PublicRunResult> {
    if (this.active) return { status: "busy" };
    this.active = true;
    try {
      const state = await this.storage.get<StoredState>("state");
      if (state?.kind === "pending") return { status: "failed", reason: "persistence-pending" };
      await this.storage.delete("state");
      return { status: "ready" };
    } finally {
      this.active = false;
    }
  }
  async trigger(): Promise<PublicRunResult> {
    if (this.active) return { status: "busy" };
    this.active = true;
    try {
      let state = await this.storage.get<StoredState>("state");
      if (state?.kind === "running") {
        state = { kind: "blocked", reason: "collection-interrupted" };
        await this.storage.put("state", state);
      }
      if (state?.kind === "blocked")
        return {
          status: "blocked",
          reason: state.reason,
          ...(state.runId ? { runId: state.runId } : {}),
        };
      let run: SharedRunInput;
      let pending: Extract<StoredState, { kind: "pending" }>;
      if (state?.kind === "pending") {
        pending = state;
        run = await this.readPending(pending);
      } else {
        const startedAt = new Date().toISOString();
        const runId = crypto.randomUUID();
        const attemptId = `attempt-${crypto.randomUUID()}`;
        // This must finish before any container or provider request starts.
        await this.storage.put("state", { kind: "running" });
        let output: CollectionOutput;
        try {
          output = parseCollectionOutput(await this.collect(runId));
        } catch (error) {
          output = {
            status: "failed",
            reason: safeFailureCode(error instanceof Error ? error.message : null),
          };
        }
        run = {
          runId,
          attemptId,
          startedAt,
          completedAt: new Date().toISOString(),
          ...(output.status === "success"
            ? { snapshot: output.snapshot }
            : { reason: output.reason }),
        };
        // Save validated financial evidence, never the credential or browser session.
        pending = await this.writePending(run);
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
        await this.finishPending(pending, {
          kind: "blocked",
          reason: run.reason,
          runId: run.runId,
        });
        return {
          status: "blocked",
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
  private chunkKey(runId: string, index: number): string {
    return `pending:${runId}:${index}`;
  }
  private async writePending(
    run: SharedRunInput,
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
