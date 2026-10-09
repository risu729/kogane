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
  const supplied = Array.isArray(v.runIds) ? v.runIds : [body.runId];
  const runIds = [
    ...new Set(supplied.filter((id): id is string => typeof id === "string" && RUN_ID.test(id))),
  ].slice(0, 100);
  const failed =
    !["success", "partial", "stored", "completed"].includes(String(body.status)) ||
    terminal.persisted === false ||
    (typeof body.persistence === "string" &&
      !["persisted", "already_persisted", "stored"].includes(body.persistence));
  return {
    status: failed ? "failed" : "completed",
    runIds,
    failureCode: failed ? "collection_failed" : null,
  };
}

/** What `withCollectionLease` throws when another execution holds the source. */
const LEASE_REFUSAL = "collection_busy_or_uncertain";

/**
 * The closed result of a collection that threw. A lease refusal happens before
 * the collector contacts anyone, so it is reported as `collection_busy` rather
 * than as a failed collection: the alarm's receipt and an operation can then
 * tell "another execution holds this source" from "the provider attempt
 * failed". Every other error stays `collection_failed`. No error text leaves.
 */
export function scheduledFailure(error: unknown, runIds: readonly string[] = []): ScheduledResult {
  const busy = error instanceof Error && error.message === LEASE_REFUSAL;
  return {
    status: "failed",
    runIds: [...runIds],
    failureCode: busy ? "collection_busy" : "collection_failed",
  };
}
