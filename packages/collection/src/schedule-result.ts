import { RUN_ID } from "./keys";
import { LEASE_ABORT_CODES, type LeaseAbortCode } from "./schedule-lease";

export interface ScheduledResult {
  status: "completed" | "failed";
  runIds: string[];
  failureCode: string | null;
}
/**
 * At most this many run references leave one result: the Processor refuses an
 * answer with more (`collectorOperationResult`), and an operation stores no
 * more (migration 0068).
 */
export const MAX_RUN_IDS = 100;

/**
 * The closed code of a collection that persisted more distinct runs than one
 * result may carry. Such a result is `failed`, never a `completed` that lists
 * a subset: the Processor follows a completed operation's reported runs to
 * publication, and a subset would let it state a verdict (`published`,
 * `unpublished`) for a collection whose other runs it never looked at. Every
 * run's terminal is still in the bucket and the collection scan registers it
 * like any other; only the result's links stop at the first
 * {@link MAX_RUN_IDS}.
 */
export const RUN_IDS_OVER_LIMIT = "run_ids_over_limit";

/**
 * The run ids a result may name: ids a terminal key can carry
 * (`runs/<source>/<runId>/terminal.json`, keys.ts `RUN_ID`), each once, in
 * the order given. Anything else names no persisted run.
 */
function distinctRunIds(values: readonly unknown[]): string[] {
  return [
    ...new Set(values.filter((id): id is string => typeof id === "string" && RUN_ID.test(id))),
  ];
}

/**
 * The result of a collection that finished after persisting these runs:
 * `completed` with every distinct run id, or, past {@link MAX_RUN_IDS},
 * `failed` with {@link RUN_IDS_OVER_LIMIT} and the first {@link MAX_RUN_IDS}.
 */
export function scheduledCompletion(runIds: readonly unknown[]): ScheduledResult {
  const distinct = distinctRunIds(runIds);
  return distinct.length > MAX_RUN_IDS
    ? { status: "failed", runIds: distinct.slice(0, MAX_RUN_IDS), failureCode: RUN_IDS_OVER_LIMIT }
    : { status: "completed", runIds: distinct, failureCode: null };
}

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
  // The verdict comes first: a listed run id does not outrank it.
  const supplied = unwritten ? [] : Array.isArray(v.runIds) ? v.runIds : [body.runId];
  const failed =
    !["success", "partial", "stored", "completed"].includes(String(body.status)) || unwritten;
  if (!failed) return scheduledCompletion(supplied);
  return {
    status: "failed",
    runIds: distinctRunIds(supplied).slice(0, MAX_RUN_IDS),
    failureCode: "collection_failed",
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
 *
 * The runs it still persisted are listed once each, at most the first
 * {@link MAX_RUN_IDS}, and the failure keeps its own code (a lease abort must
 * stay uncertain). A failed operation is not followed to publication, so a
 * shorter list states no verdict about the runs past it, whose terminals the
 * collection scan registers like any other.
 */
export function scheduledFailure(error: unknown, runIds: readonly string[] = []): ScheduledResult {
  const message = error instanceof Error ? error.message : null;
  return {
    status: "failed",
    runIds: distinctRunIds(runIds).slice(0, MAX_RUN_IDS),
    failureCode:
      message === LEASE_REFUSAL
        ? "collection_busy"
        : isLeaseAbortCode(message)
          ? message
          : "collection_failed",
  };
}
