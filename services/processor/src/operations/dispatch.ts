// The Processor half of the operations API (unified plan 02 §5, U06 → U08).
//
// The App accepts a request, stores it, and answers 202. Notifying the
// executor is a separate step that may be lost, so the request stays in
// `dispatch_state='dispatch_pending'` until someone actually took it, and
// this cron lane is the "someone" (02 §5). A dispatch that fails never
// deletes the request.
//
// The rule that shapes every branch below: **enqueueing is not completing**.
// `recordDispatch` moves the dispatch state; a stage is only recorded as
// `completed` by the code that holds that stage's evidence. A queued replay,
// a projection that will run on the next tick, a collector call that does not
// exist yet — none of them writes a completed stage (contracts/stages.json
// `neverCompleteOn`, G5-18's sibling rule for lost work).
import {
  operationRequestPayload,
  pendingDispatches,
  recordDispatch,
  recordOperationStage,
  type CommandStore,
  type OperationReceipt,
} from "../../../../packages/application/src/index.ts";
import { d1CommandStore } from "../../../../packages/storage-d1/src/core/command-store.ts";
import type { D1Like } from "../../../../packages/storage-d1/src/d1.ts";
import { registerCollectionRun, type CollectionEnv } from "../collection/index.ts";

/** Requests taken per tick. */
export const DEFAULT_DISPATCH_LIMIT = 5;
/** How long a request that cannot be dispatched yet waits before the next try. */
export const COLLECTOR_RETRY_MS = 3_600_000;
const RETRY_MS = 300_000;

export interface DispatchEnv extends CollectionEnv {
  OPS_DISPATCH_ENABLED?: string | undefined;
}

export function opsDispatchEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export interface DispatchSummary {
  enabled: boolean;
  status: "skipped" | "dispatched";
  claimed: number;
  dispatched: number;
  retried: number;
  failed: number;
  /** Kinds whose executor is a later work item; recorded, never completed. */
  awaiting: number;
}

export interface DispatchOptions {
  limit?: number;
  now?: () => Date;
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
 *   * `collection` and an unattended `session-refresh` — a collector runs
 *     them over a Service Binding, which is U09's work. Until then the
 *     request stays `dispatch_pending` with a safe code saying why, so the
 *     work is visible instead of silently completed or silently dropped.
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
  for (const receipt of pending) {
    const outcome = await dispatchOne(env, store, receipt, now);
    if (outcome === "dispatched") summary.dispatched += 1;
    else if (outcome === "failed") summary.failed += 1;
    else if (outcome === "awaiting") summary.awaiting += 1;
    else summary.retried += 1;
  }
  return summary;
}

type OneOutcome = "dispatched" | "retry" | "failed" | "awaiting";

async function dispatchOne(
  env: DispatchEnv,
  store: CommandStore,
  receipt: OperationReceipt,
  now: () => Date,
): Promise<OneOutcome> {
  const at = now();
  switch (receipt.kind) {
    case "import":
      return dispatchImport(env, store, receipt, at);
    case "replay":
      return dispatchReplay(env, store, receipt, at);
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
      return awaitCollector(store, receipt, at);
  }
}

/** A stored terminal, re-registered in process. */
async function dispatchImport(
  env: DispatchEnv,
  store: CommandStore,
  receipt: OperationReceipt,
  at: Date,
): Promise<OneOutcome> {
  const payload = await operationRequestPayload(store, receipt.operationId);
  const source = typeof payload?.source === "string" ? payload.source : null;
  const runId = typeof payload?.runId === "string" ? payload.runId : null;
  if (!source || !runId) return fail(store, receipt, "operation_payload_invalid", at);

  const result = await registerCollectionRun(env, { source, runId });
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

/**
 * A request whose executor is a collector. The Service Binding call is U09;
 * until it exists the request stays pending with a code that says so — never
 * completed, never quietly dropped.
 */
async function awaitCollector(
  store: CommandStore,
  receipt: OperationReceipt,
  at: Date,
): Promise<OneOutcome> {
  await recordDispatch({
    store,
    operationId: receipt.operationId,
    outcome: "retry",
    now: at.toISOString(),
    retryAtMs: at.valueOf() + COLLECTOR_RETRY_MS,
    failureCode: "awaiting_collector_dispatch",
  });
  return "awaiting";
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
