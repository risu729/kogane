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
