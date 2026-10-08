// The Processor half of the operations API (unified plan 02 §5, U06 → U08,
// and issue #544 / ADR 0048 for the collector branch).
//
// The App accepts a request, stores it, and answers 202. Notifying the
// executor is a separate step that may be lost, so the request stays in
// `dispatch_state='dispatch_pending'` until someone actually took it, and
// this lane is the "someone" (02 §5). A dispatch that fails never deletes the
// request.
//
// The rule that shapes every branch below: **enqueueing is not completing**.
// `recordDispatch` moves the dispatch state; a stage is only recorded as
// `completed` by the code that holds that stage's evidence. A queued replay,
// a projection that will run on the next tick, a collector that was called —
// none of them writes a completed stage until CORE holds what proves it
// (contracts/stages.json `neverCompleteOn`, G5-18's sibling rule for lost
// work).
import {
  abandonStartedCollectorDispatches,
  claimCollectorStart,
  type CollectorAction,
  collectorActionForKind,
  type CollectorBinding,
  collectedDispatchesDue,
  expiresAtFor,
  operationRequestPayload,
  pendingDispatches,
  readCollectorDispatch,
  recordCollectorDeclined,
  recordCollectorOutcome,
  recordCollectorWait,
  recordDispatch,
  recordOperationStage,
  trackCollectorPublication,
  type CommandStore,
  type OperationReceipt,
} from "../../../../packages/application/src/index.ts";
import {
  coreSourceId,
  type RegistrationBudget,
} from "../../../../packages/application/src/collection/index.ts";
import {
  COLLECTOR_OPERATION_VERSION,
  collectorOperationResult,
  OPERATION_CONNECTIONS,
  type CollectorOperationRequest,
  type OperationConnection,
} from "../../../../packages/collection/src/operation-rpc.ts";
import { afterMaintenance } from "../../../../packages/collection/src/schedule-model.ts";
import { d1CommandStore } from "../../../../packages/storage-d1/src/core/command-store.ts";
import type { D1Like } from "../../../../packages/storage-d1/src/d1.ts";
import { registerCollectionRun, type CollectionEnv } from "../collection/index.ts";
import { maintenanceForSchedule } from "../schedule-store.ts";

/** Requests taken per tick. */
export const DEFAULT_DISPATCH_LIMIT = 5;
/** How long a collector request whose connection is not enabled waits before the next look. */
export const COLLECTOR_RETRY_MS = 3_600_000;
const RETRY_MS = 300_000;
/** A request waiting for a held lease or this tick's start budget looks again after this. */
export const COLLECTOR_WAIT_MS = 300_000;
/**
 * Collector calls started per invocation. A collection can take minutes and
 * the call is awaited inside the tick, exactly as the alarm awaits it, so the
 * lane starts one and leaves the rest waiting (`dispatch_deferred`).
 */
export const COLLECTOR_STARTS_PER_TICK = 1;
/** A start with no recorded outcome after this long is `uncertain` (the alarm's own bound). */
export const STARTED_UNCERTAIN_MS = 3_600_000;
/** How often a collected execution's trail is read again until it settles. */
export const TRACK_INTERVAL_MS = 300_000;
/** Collected executions whose trail is read per tick. */
export const TRACK_LIMIT = 5;

export interface DispatchEnv extends CollectionEnv {
  OPS_DISPATCH_ENABLED?: string | undefined;
  /**
   * A JSON array of connection ids (alarm job ids) whose collector the lane
   * may call. Absent, empty or malformed means none: an accepted collection
   * then waits with `collector_dispatch_disabled` until it expires, and no
   * provider is contacted (ADR 0048).
   */
  OPS_COLLECTOR_DISPATCH_CONNECTIONS?: string | undefined;
}

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

/** The named RPC a collector's `ScheduledCollection` entrypoint serves (ADR 0048). */
export interface CollectorRpc {
  runOperation(request: CollectorOperationRequest): Promise<unknown>;
}

export interface DispatchSummary {
  enabled: boolean;
  status: "skipped" | "dispatched";
  claimed: number;
  dispatched: number;
  retried: number;
  failed: number;
  /** Collector requests that wait this tick: nothing was contacted. */
  awaiting: number;
  /** Collector calls started (at most `COLLECTOR_STARTS_PER_TICK`). */
  started: number;
  /** Collector requests that ended before a start: expired or unsupported. */
  declined: number;
  /** Collected executions whose trail was read this tick. */
  tracked: number;
  published: number;
  unpublished: number;
  /** Starts with no outcome after `STARTED_UNCERTAIN_MS`, now `uncertain`. */
  abandoned: number;
}

export interface DispatchOptions {
  limit?: number;
  now?: () => Date;
  /**
   * The cron invocation's registration budget, shared with the scan lane, so
   * an `import` counts against the same bound as every other registration.
   */
  budget?: RegistrationBudget;
  /**
   * The collector binding of a connection: the Processor's
   * `SCHEDULE_<WORKSPACE>` service binding, the one the alarm calls. Absent
   * means no binding, and a collector request is declined
   * (`collector_binding_missing`) rather than guessed at.
   */
  collectors?: (connection: OperationConnection) => CollectorRpc | null;
  /** The connection table; the closed mirror of config/alarm-jobs.json unless a test names its own. */
  connections?: readonly OperationConnection[];
}

/**
 * One pass over the undispatched requests.
 *
 * Each kind has exactly one executor:
 *
 *   * `import` — re-register a stored terminal, in process (U08). The stage
 *     it completes is `registered`, and only when CORE says so.
 *   * `replay` — start the replay plan the acceptance already created (0040
 *     links it by `operation_id`). Starting it is a dispatch, not a parse.
 *   * `projection` — the balance projection lane rebuilds on its own tick;
 *     dispatch records that it was handed over and nothing else.
 *   * `collection` and an unattended `session-refresh` — the collector of
 *     the request's named connection, over the private RPC the alarm uses,
 *     at most once per operation (`dispatchCollector`). Afterwards the same
 *     lane follows the reported runs to CORE publication or a closed reason
 *     (`trackCollectors`).
 */
export async function dispatchOperations(
  env: DispatchEnv,
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const enabled = opsDispatchEnabled(env.OPS_DISPATCH_ENABLED);
  const summary: DispatchSummary = {
    enabled,
    status: enabled ? "dispatched" : "skipped",
    claimed: 0,
    dispatched: 0,
    retried: 0,
    failed: 0,
    awaiting: 0,
    started: 0,
    declined: 0,
    tracked: 0,
    published: 0,
    unpublished: 0,
    abandoned: 0,
  };
  if (!enabled) return summary;

  const now = options.now ?? (() => new Date());
  const store = d1CommandStore(env.DB as D1Like);
  const nowDate = now();
  const pending = await pendingDispatches({
    store,
    nowMs: nowDate.valueOf(),
    limit: Math.max(1, options.limit ?? DEFAULT_DISPATCH_LIMIT),
  });
  summary.claimed = pending.length;
  const collectors: CollectorContext = {
    connections: options.connections ?? OPERATION_CONNECTIONS,
    enabled: collectorDispatchConnections(env.OPS_COLLECTOR_DISPATCH_CONNECTIONS),
    resolve: options.collectors ?? (() => null),
    startsLeft: COLLECTOR_STARTS_PER_TICK,
    now,
  };
  for (const receipt of pending) {
    const outcome = await dispatchOne(env, store, receipt, now, options.budget, collectors);
    if (outcome === "dispatched") summary.dispatched += 1;
    else if (outcome === "failed") summary.failed += 1;
    else if (outcome === "awaiting") summary.awaiting += 1;
    else if (outcome === "started") summary.started += 1;
    else if (outcome === "declined") summary.declined += 1;
    else if (outcome === "retry") summary.retried += 1;
  }
  await trackCollectors(store, now, summary);
  return summary;
}

type OneOutcome = "dispatched" | "retry" | "failed" | "awaiting" | "started" | "declined" | "none";

interface CollectorContext {
  connections: readonly OperationConnection[];
  enabled: ReadonlySet<string>;
  resolve: (connection: OperationConnection) => CollectorRpc | null;
  /** Collector calls this invocation may still start. */
  startsLeft: number;
  /** The lane's clock; the outcome is stamped when the collector answered. */
  now: () => Date;
}

async function dispatchOne(
  env: DispatchEnv,
  store: CommandStore,
  receipt: OperationReceipt,
  now: () => Date,
  budget: RegistrationBudget | undefined,
  collectors: CollectorContext,
): Promise<OneOutcome> {
  const at = now();
  switch (receipt.kind) {
    case "import":
      return dispatchImport(env, store, receipt, at, budget);
    case "replay":
      return dispatchReplay(env, store, receipt, at);
    case "collection":
    case "session-refresh":
      return dispatchCollector(env, store, receipt, at, collectors);
    case "projection":
      // The projection lane runs every tick from CORE; handing the request
      // over is all there is to do. `projected` is completed by whoever
      // publishes the snapshot (U11), never here.
      await recordDispatch({
        store,
        operationId: receipt.operationId,
        outcome: "dispatched",
        now: at.toISOString(),
        targetRef: `projection:${receipt.operationId}`,
      });
      return "dispatched";
    default:
      return "none";
  }
}

/** A stored terminal, re-registered in process. */
async function dispatchImport(
  env: DispatchEnv,
  store: CommandStore,
  receipt: OperationReceipt,
  at: Date,
  budget: RegistrationBudget | undefined,
): Promise<OneOutcome> {
  const payload = await operationRequestPayload(store, receipt.operationId);
  const source = typeof payload?.source === "string" ? payload.source : null;
  const runId = typeof payload?.runId === "string" ? payload.runId : null;
  if (!source || !runId) return fail(store, receipt, "operation_payload_invalid", at);

  const result = await registerCollectionRun(
    env,
    { source, runId },
    budget === undefined ? {} : { budget },
  );
  const iso = at.toISOString();
  switch (result.outcome) {
    case "registered":
    case "already_registered": {
      const target = result.fetchRunId === null ? null : `run:${result.fetchRunId}`;
      await recordDispatch({
        store,
        operationId: receipt.operationId,
        outcome: "dispatched",
        now: iso,
        ...(target === null ? {} : { targetRef: target }),
      });
      // CORE holds the registration: this is the one stage this executor may
      // call complete, and it does so because the evidence exists.
      await recordOperationStage({
        store,
        operationId: receipt.operationId,
        stage: "registered",
        state: "completed",
        now: iso,
        ...(target === null ? {} : { evidenceRef: target }),
      });
      return "dispatched";
    }
    case "pending":
      await recordOperationStage({
        store,
        operationId: receipt.operationId,
        stage: "registered",
        state: "pending",
        now: iso,
        evidenceRef: `run:${result.fetchRunId}`,
      });
      await recordDispatch({
        store,
        operationId: receipt.operationId,
        outcome: "retry",
        now: iso,
        retryAtMs: at.valueOf() + RETRY_MS,
      });
      return "retry";
    case "blocked":
      await recordOperationStage({
        store,
        operationId: receipt.operationId,
        stage: "registered",
        state: "blocked",
        now: iso,
        failureCode: result.code,
      });
      return fail(store, receipt, result.code, at);
    case "retryable":
      await recordDispatch({
        store,
        operationId: receipt.operationId,
        outcome: "retry",
        now: iso,
        retryAtMs: at.valueOf() + RETRY_MS,
        failureCode: result.code,
      });
      return "retry";
    case "deferred":
      // This tick's registration budget was spent before the run started.
      // Nothing was registered; the request waits for a later tick.
      await recordDispatch({
        store,
        operationId: receipt.operationId,
        outcome: "retry",
        now: iso,
        retryAtMs: at.valueOf() + RETRY_MS,
        failureCode: "registration_deferred",
      });
      return "retry";
    default:
      // No terminal at that key: the run never finished persisting, so there
      // is nothing to re-register. The request is kept and retried rather
      // than failed, because the collector may still be running.
      await recordDispatch({
        store,
        operationId: receipt.operationId,
        outcome: "retry",
        now: iso,
        retryAtMs: at.valueOf() + RETRY_MS,
        failureCode: "terminal_not_found",
      });
      return "retry";
  }
}

/** Starts the replay plan the acceptance created. Starting is not parsing. */
async function dispatchReplay(
  env: DispatchEnv,
  store: CommandStore,
  receipt: OperationReceipt,
  at: Date,
): Promise<OneOutcome> {
  const iso = at.toISOString();
  const plan = await store.first<{ id: number; status: string }>(
    "SELECT id,status FROM observation_replay_plans WHERE operation_id=?1",
    [receipt.operationId],
  );
  if (!plan) return fail(store, receipt, "replay_plan_missing", at);
  // Only a plan still waiting is started; one already running, paused or
  // cancelled keeps the state a person or an earlier dispatch gave it.
  await store.batch([
    {
      sql: "UPDATE observation_replay_plans SET status='running',updated_at_ms=?2 WHERE id=?1 AND status='planned'",
      binds: [plan.id, at.valueOf()],
    },
  ]);
  await recordDispatch({
    store,
    operationId: receipt.operationId,
    outcome: "dispatched",
    now: iso,
    targetRef: `plan:${plan.id}`,
  });
  return "dispatched";
}

// ── the collector branch (ADR 0048) ─────────────────────────────────────

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

const LEASE_HELD = `SELECT 1 AS held FROM collection_execution_leases
 WHERE source=?1 AND lease_ref IS NOT NULL`;

/**
 * An accepted collection or unattended session refresh. In order, every
 * check before the call contacts nobody:
 *
 *   1. an execution that already left `waiting` is never started again;
 *   2. no connection serves the source and action → `unsupported`;
 *   3. not started within `COLLECTOR_START_TTL_MS` of acceptance → `expired`;
 *   4. the connection is not in `OPS_COLLECTOR_DISPATCH_CONNECTIONS` → waits;
 *   5. no collector binding → `unsupported` (`collector_binding_missing`);
 *   6. the provider's maintenance window is open → waits until it closes;
 *   7. another execution holds the source's lease → waits (read only: this
 *      path never takes, releases or replaces a lease);
 *   8. this tick already started a collector → waits for the next tick.
 *
 * Then the start is claimed (one per operation) and the collector called
 * once. Its answer is recorded as it is; nothing after a start is retried.
 */
async function dispatchCollector(
  env: DispatchEnv,
  store: CommandStore,
  receipt: OperationReceipt,
  at: Date,
  collectors: CollectorContext,
): Promise<OneOutcome> {
  const action = collectorActionForKind(receipt.kind)!;
  const iso = at.toISOString();
  const nowMs = at.valueOf();
  const acceptedAt = receipt.acceptedAt;
  const expiresAt = expiresAtFor(acceptedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const context = {
    store,
    operationId: receipt.operationId,
    action,
    acceptedAt,
    expiresAt,
    now: iso,
  };

  const existing = await readCollectorDispatch(store, receipt.operationId);
  if (existing !== null && existing.state !== "waiting") {
    // The execution already left the queue (a decline whose request update
    // did not land). Bring the request row in step; never call again.
    const declined = existing.state === "expired" || existing.state === "unsupported";
    await recordDispatch({
      store,
      operationId: receipt.operationId,
      outcome: declined ? "failed" : "dispatched",
      now: iso,
      ...(declined && existing.reason_code !== null ? { failureCode: existing.reason_code } : {}),
    });
    return declined ? "declined" : "none";
  }

  const connection = connectionFor(collectors.connections, receipt.source, action);
  if (connection === null) {
    await recordCollectorDeclined({
      ...context,
      binding: null,
      state: "unsupported",
      reasonCode: action === "collect" ? "collection_unsupported" : "session_refresh_unsupported",
    });
    return "declined";
  }
  const binding: CollectorBinding = {
    connectionId: connection.connectionId,
    terminalSource: connection.terminalSource,
  };
  if (nowMs >= expiresAtMs) {
    await recordCollectorDeclined({
      ...context,
      binding,
      state: "expired",
      reasonCode: "operation_expired",
    });
    return "declined";
  }
  const wait = async (reasonCode: string, retryAtMs: number): Promise<OneOutcome> => {
    await recordCollectorWait({
      ...context,
      binding,
      reasonCode,
      // Never past the expiry, so an expiring request is declined on time.
      retryAtMs: Math.min(retryAtMs, expiresAtMs),
    });
    return "awaiting";
  };
  if (!collectors.enabled.has(connection.connectionId))
    return wait("collector_dispatch_disabled", nowMs + COLLECTOR_RETRY_MS);
  const rpc = collectors.resolve(connection);
  if (rpc === null) {
    await recordCollectorDeclined({
      ...context,
      binding,
      state: "unsupported",
      reasonCode: "collector_binding_missing",
    });
    return "declined";
  }
  const maintenanceEnd = afterMaintenance(
    nowMs,
    await maintenanceForSchedule(env.DB as unknown as D1Database, {
      source: connection.source,
      kind: action === "collect" ? "collection" : "keepalive",
    }),
  );
  if (maintenanceEnd > nowMs) return wait("provider_maintenance", maintenanceEnd);
  if ((await store.first<{ held: number }>(LEASE_HELD, [connection.source])) !== null)
    return wait("collection_lease_held", nowMs + COLLECTOR_WAIT_MS);
  if (collectors.startsLeft <= 0) return wait("dispatch_deferred", nowMs + COLLECTOR_WAIT_MS);

  if (!(await claimCollectorStart({ ...context, binding }))) return "none";
  collectors.startsLeft -= 1;
  const request: CollectorOperationRequest = {
    version: COLLECTOR_OPERATION_VERSION,
    operationId: receipt.operationId,
    connectionId: connection.connectionId,
    source: connection.source,
    action,
    requestedAtMs: nowMs,
  };
  let answer: unknown;
  let threw = false;
  try {
    answer = await rpc.runOperation(request);
  } catch {
    // The call may have reached the provider before it failed; the outcome
    // is unknown and is never replayed (ADR 0039).
    threw = true;
  }
  const result = threw ? null : collectorOperationResult(answer);
  const done = collectors.now();
  await recordCollectorOutcome({
    store,
    operationId: receipt.operationId,
    now: done.toISOString(),
    nowMs: done.valueOf(),
    outcome:
      result === null
        ? {
            kind: "uncertain",
            reasonCode: threw ? "dispatch_uncertain" : "collector_result_invalid",
          }
        : result.status === "completed"
          ? action === "collect"
            ? { kind: "collected", runIds: result.runIds }
            : { kind: "refreshed" }
          : {
              kind: "failed",
              reasonCode: result.failureCode ?? "collection_failed",
              runIds: result.runIds,
            },
  });
  return "started";
}

/**
 * Follows started and collected executions: a start nobody finished becomes
 * `uncertain`, and each collected execution due for a look has its trail read
 * and recorded until it is `published` or `unpublished`.
 */
async function trackCollectors(
  store: CommandStore,
  now: () => Date,
  summary: DispatchSummary,
): Promise<void> {
  const at = now();
  summary.abandoned = await abandonStartedCollectorDispatches({
    store,
    startedBefore: new Date(at.valueOf() - STARTED_UNCERTAIN_MS).toISOString(),
    now: at.toISOString(),
    limit: TRACK_LIMIT,
  });
  const due = await collectedDispatchesDue({ store, nowMs: at.valueOf(), limit: TRACK_LIMIT });
  for (const row of due) {
    const tracked = await trackCollectorPublication({
      store,
      operationId: row.operation_id,
      now: at.toISOString(),
      nowMs: at.valueOf(),
      checkIntervalMs: TRACK_INTERVAL_MS,
    });
    summary.tracked += 1;
    if (tracked === "published") summary.published += 1;
    else if (tracked === "unpublished") summary.unpublished += 1;
  }
}

async function fail(
  store: CommandStore,
  receipt: OperationReceipt,
  failureCode: string,
  at: Date,
): Promise<OneOutcome> {
  await recordDispatch({
    store,
    operationId: receipt.operationId,
    outcome: "failed",
    now: at.toISOString(),
    failureCode,
  });
  return "failed";
}
