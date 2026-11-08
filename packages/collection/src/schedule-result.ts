import { LEASE_ABORT_CODES, type LeaseAbortCode } from "./schedule-lease";

export interface ScheduledResult {
  status: "completed" | "failed";
  runIds: string[];
  failureCode: string | null;
}
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
/** Return only closed operational outcomes and exact persisted run references. */
export function scheduledResult(value: unknown): ScheduledResult {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const terminal = (v.terminal && typeof v.terminal === "object" ? v.terminal : {}) as Record<
    string,
    unknown
  >;
  const body = (
    v.body && typeof v.body === "object"
      ? v.body
      : v.manifest && typeof v.manifest === "object"
        ? v.manifest
        : v
  ) as Record<string, unknown>;
  // A run whose terminal was not written is not a persisted run, whatever its
  // provider outcome: its id is not reported, so no history or operation trail
  // links to a run that does not exist (ADR 0039, ADR 0048).
  const unwritten =
    terminal.persisted === false ||
    (typeof body.persistence === "string" &&
      !["persisted", "already_persisted", "stored"].includes(body.persistence));
  const supplied = Array.isArray(v.runIds) ? v.runIds : unwritten ? [] : [body.runId];
  const runIds = [
    ...new Set(supplied.filter((id): id is string => typeof id === "string" && RUN_ID.test(id))),
  ].slice(0, 100);
  const failed =
    !["success", "partial", "stored", "completed"].includes(String(body.status)) || unwritten;
  return {
    status: failed ? "failed" : "completed",
    runIds,
    failureCode: failed ? "collection_failed" : null,
  };
}

/** What `withCollectionLease` throws when another execution holds the source. */
const LEASE_REFUSAL = "collection_busy_or_uncertain";

/**
 * Whether a closed failure code means the holder stopped itself after it may
 * have contacted the provider (ADR 0085): the outcome is uncertain, like a
 * dispatch whose answer was lost, and it is never replayed.
 */
export function isLeaseAbortCode(code: string | null): code is LeaseAbortCode {
  return code !== null && (LEASE_ABORT_CODES as readonly string[]).includes(code);
}

/**
 * The closed result of a collection that threw. A lease refusal happens before
 * the collector contacts anyone, so it is reported as `collection_busy` rather
 * than as a failed collection: the alarm's receipt and an operation can then
 * tell "another execution holds this source" from "the provider attempt
 * failed". A holder that stopped itself reports its own closed code
 * (`collection_deadline_exceeded`, `collection_lease_lost`). Every other error
 * stays `collection_failed`. No error text leaves.
 */
export function scheduledFailure(error: unknown, runIds: readonly string[] = []): ScheduledResult {
  const message = error instanceof Error ? error.message : null;
  return {
    status: "failed",
    runIds: [...runIds],
    failureCode:
      message === LEASE_REFUSAL
        ? "collection_busy"
        : isLeaseAbortCode(message)
          ? message
          : "collection_failed",
  };
}
