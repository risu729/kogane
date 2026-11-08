// Which collector a collection request reaches, and whether the Processor
// would start it (ADR 0048). The dispatch lane decides with these functions,
// and the schedules snapshot reports with the same ones, so the page that
// offers 収集を依頼 cannot disagree with the lane that runs it.
import { coreSourceId } from "../../../../packages/application/src/collection/index.ts";
import type { CollectorAction } from "../../../../packages/application/src/index.ts";
import {
  OPERATION_CONNECTIONS,
  type OperationConnection,
} from "../../../../packages/collection/src/operation-rpc.ts";
import type { ScheduleCollectionRequest } from "../../../../packages/collection/src/schedule-model.ts";

export function opsDispatchEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** The enabled connections; anything but a JSON array of strings enables none. */
export function collectorDispatchConnections(value: string | undefined): ReadonlySet<string> {
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string"))
      return new Set(parsed);
  } catch {
    /* A malformed list enables nothing; the safe direction is "do not call". */
  }
  return new Set();
}

/**
 * The one connection that serves a CORE source for an action: the named
 * collector job whose terminals register under that source. None, or an
 * ambiguous table, is no connection — never a guess.
 */
export function connectionFor(
  connections: readonly OperationConnection[],
  coreSource: string | null,
  action: CollectorAction,
): OperationConnection | null {
  if (coreSource === null) return null;
  const matches = connections.filter(
    (entry) => entry.action === action && coreSourceId(entry.terminalSource) === coreSource,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export interface CollectionTargetEnv {
  OPS_DISPATCH_ENABLED?: string | undefined;
  OPS_COLLECTOR_DISPATCH_CONNECTIONS?: string | undefined;
}

/**
 * What a collection request for this schedule job would be: the CORE source
 * id a request names, and whether the dispatch lane would start it. Null when
 * no collector connection serves a request for the job, or when the request's
 * source would resolve to a different connection than this job (the lane
 * resolves by source, never by job).
 *
 * `dispatch` is a closed code:
 *   * `enabled` — the lane runs and lists this connection;
 *   * `lane_disabled` — `OPS_DISPATCH_ENABLED` is off, so nothing is dispatched;
 *   * `connection_disabled` — the connection is not in
 *     `OPS_COLLECTOR_DISPATCH_CONNECTIONS`, so a request waits and expires.
 * `enabled` does not promise a start: a maintenance window, a held lease or a
 * missing collector binding still holds or declines a request.
 */
export function collectionRequestTarget(
  env: CollectionTargetEnv,
  scheduleId: string,
  connections: readonly OperationConnection[] = OPERATION_CONNECTIONS,
): ScheduleCollectionRequest | null {
  const connection = connections.find(
    (entry) => entry.connectionId === scheduleId && entry.action === "collect",
  );
  if (!connection) return null;
  const source = coreSourceId(connection.terminalSource);
  if (connectionFor(connections, source, "collect")?.connectionId !== scheduleId) return null;
  return {
    source: source!,
    dispatch: !opsDispatchEnabled(env.OPS_DISPATCH_ENABLED)
      ? "lane_disabled"
      : collectorDispatchConnections(env.OPS_COLLECTOR_DISPATCH_CONNECTIONS).has(scheduleId)
        ? "enabled"
        : "connection_disabled",
  };
}
