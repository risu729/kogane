// The executor side of an accepted collection or session-refresh request
// (issue #544, ADR 0048): the state transitions of `ops_collector_dispatches`
// (migration 0068) and the request row they move with.
//
// The Processor decides *whether* a request may start (connection, flag,
// expiry, maintenance, lease) and calls the collector; these services record
// what it decided and what came back, each as one guarded D1 batch. The rules
// they keep:
//
//   * one start per operation. The start is a guarded `waiting → started`
//     update; a second dispatch of the same operation, a re-sent request
//     under the same key and a raced tick all find the row started and do
//     nothing (G3-06, G3-14);
//   * waiting is not failing and starting is not completing: a wait records a
//     closed reason and a retry time; `completed` stages are written only from
//     CORE evidence (contracts/stages.json);
//   * after a start nothing is retried automatically. A failure, a collector
//     that cannot be heard from and a start nobody finished are terminal, so a
//     provider login is never repeated by this path (G3-11, ADR 0039).
//
// Identifiers, closed codes and timestamps only.
import type { CommandStore, PreparedWrite } from "../command/contract.ts";
import {
  type CollectorAction,
  type CollectorDispatchRow,
  collectorRunTrails,
  DISPATCH_COLUMNS,
  PUBLICATION_HORIZON_MS,
  readCollectorDispatch,
  type StageVerdict,
  storedRunIds,
  trailOutcome,
} from "./collector-trail.ts";
import { type OperationStage, recordDispatch, recordOperationStage } from "./requests.ts";

/** The named collector connection a request is bound to. */
export interface CollectorBinding {
  connectionId: string;
  terminalSource: string;
}

interface DispatchContext {
  store: CommandStore;
  operationId: string;
  action: CollectorAction;
  acceptedAt: string;
  expiresAt: string;
  now: string;
}

const TERMINAL_REQUEST = `('completed','failed','blocked')`;

/** The row as it is born: waiting, never started, nothing reported. */
function insertWaiting(
  context: DispatchContext,
  binding: CollectorBinding,
  reasonCode: string | null,
): PreparedWrite {
  return {
    sql: `INSERT INTO ops_collector_dispatches
      (operation_id,connection_id,action,terminal_source,state,reason_code,waits,starts,
       run_ids_json,accepted_at,expires_at,next_check_at_ms,updated_at)
      SELECT ?1,?2,?3,?4,'waiting',?5,0,0,'[]',?6,?7,0,?8
      WHERE EXISTS(SELECT 1 FROM ops_requests WHERE operation_id=?1)
      ON CONFLICT(operation_id) DO NOTHING`,
    binds: [
      context.operationId,
      binding.connectionId,
      context.action,
      binding.terminalSource,
      reasonCode,
      context.acceptedAt,
      context.expiresAt,
      context.now,
    ],
  };
}

/**
 * The request cannot start yet and nothing was contacted: another execution
 * holds the source, the provider is in maintenance, the connection is not
 * enabled for dispatch, or this tick already started one. The request keeps its
 * place and becomes available again at `retryAtMs`.
 */
export async function recordCollectorWait(
  input: DispatchContext & {
    binding: CollectorBinding;
    reasonCode: string;
    retryAtMs: number;
  },
): Promise<void> {
  const outcomes = await input.store.batch([
    insertWaiting(input, input.binding, input.reasonCode),
    {
      sql: `UPDATE ops_collector_dispatches SET reason_code=?2,waits=waits+1,
        connection_id=coalesce(connection_id,?3),terminal_source=coalesce(terminal_source,?4),
        updated_at=?5 WHERE operation_id=?1 AND state='waiting'`,
      binds: [
        input.operationId,
        input.reasonCode,
        input.binding.connectionId,
        input.binding.terminalSource,
        input.now,
      ],
    },
  ]);
  // A row another tick already started is not put back in the queue.
  if ((outcomes[1]?.changes ?? 0) !== 1) return;
  await recordDispatch({
    store: input.store,
    operationId: input.operationId,
    outcome: "retry",
    now: input.now,
    retryAtMs: input.retryAtMs,
    failureCode: input.reasonCode,
  });
}

/**
 * The request ends before any start: no connection serves it (`unsupported`)
 * or it waited past its expiry (`expired`). Nothing was contacted; the request
 * is `blocked` with the same closed code.
 */
export async function recordCollectorDeclined(
  input: DispatchContext & {
    binding: CollectorBinding | null;
    state: "expired" | "unsupported";
    reasonCode: string;
  },
): Promise<void> {
  // Born declined, or moved there from `waiting`; a started row is untouched.
  const outcomes = await input.store.batch([
    {
      sql: `INSERT INTO ops_collector_dispatches
        (operation_id,connection_id,action,terminal_source,state,reason_code,waits,starts,
         run_ids_json,accepted_at,expires_at,finished_at,next_check_at_ms,updated_at)
        SELECT ?1,?2,?3,?4,?5,?6,0,0,'[]',?7,?8,?9,0,?9
        WHERE EXISTS(SELECT 1 FROM ops_requests WHERE operation_id=?1)
        ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,
          reason_code=excluded.reason_code,finished_at=excluded.finished_at,
          updated_at=excluded.updated_at
        WHERE ops_collector_dispatches.state='waiting'`,
      binds: [
        input.operationId,
        input.binding?.connectionId ?? null,
        input.action,
        input.binding?.terminalSource ?? null,
        input.state,
        input.reasonCode,
        input.acceptedAt,
        input.expiresAt,
        input.now,
      ],
    },
  ]);
  if ((outcomes[0]?.changes ?? 0) !== 1) return;
  await recordDispatch({
    store: input.store,
    operationId: input.operationId,
    outcome: "failed",
    now: input.now,
    failureCode: input.reasonCode,
  });
}

/**
 * Claims the one start of this operation. True only for the caller whose
 * guarded update moved the row from `waiting` to `started`; that caller, and
 * nobody else, may call the collector. The request row moves to `running` and
 * `dispatched` in the same batch, bound to the connection.
 */
export async function claimCollectorStart(
  input: DispatchContext & { binding: CollectorBinding },
): Promise<boolean> {
  const outcomes = await input.store.batch([
    insertWaiting(input, input.binding, null),
    {
      sql: `UPDATE ops_collector_dispatches SET state='started',starts=1,started_at=?2,
        reason_code=NULL,connection_id=coalesce(connection_id,?3),
        terminal_source=coalesce(terminal_source,?4),updated_at=?2
        WHERE operation_id=?1 AND state='waiting' AND starts=0`,
      binds: [
        input.operationId,
        input.now,
        input.binding.connectionId,
        input.binding.terminalSource,
      ],
    },
    {
      sql: `UPDATE ops_requests SET status='running',dispatch_state='dispatched',
        dispatch_attempts=dispatch_attempts+1,available_at_ms=0,
        target_ref=coalesce(target_ref,?2),failure_code=NULL,updated_at=?3
        WHERE operation_id=?1 AND status NOT IN ${TERMINAL_REQUEST}
          AND EXISTS(SELECT 1 FROM ops_collector_dispatches d WHERE d.operation_id=?1
            AND d.state='started' AND d.started_at=?3)`,
      binds: [input.operationId, `collector:${input.binding.connectionId}`, input.now],
    },
  ]);
  return (outcomes[1]?.changes ?? 0) === 1;
}

export type CollectorOutcome =
  /** A collection whose terminal(s) the collector reports persisted. */
  | { kind: "collected"; runIds: readonly string[] }
  /** A session the collector reports renewed. */
  | { kind: "refreshed" }
  /** The collector's own closed failure code; terminal. */
  | { kind: "failed"; reasonCode: string }
  /** The call's outcome cannot be known; terminal, never replayed. */
  | { kind: "uncertain"; reasonCode: string };

/** Records what the collector answered for a started operation. */
export async function recordCollectorOutcome(
  input: { store: CommandStore; operationId: string; now: string; nowMs: number } & {
    outcome: CollectorOutcome;
  },
): Promise<void> {
  const { store, operationId, now, outcome } = input;
  switch (outcome.kind) {
    case "collected": {
      const runIds = [...new Set(outcome.runIds)].slice(0, 100);
      const moved = await store.batch([
        {
          sql: `UPDATE ops_collector_dispatches SET state='collected',run_ids_json=json(?2),
            collected_at=?3,next_check_at_ms=?4,updated_at=?3
            WHERE operation_id=?1 AND state='started'`,
          binds: [operationId, JSON.stringify(runIds), now, input.nowMs],
        },
      ]);
      if ((moved[0]?.changes ?? 0) !== 1) return;
      // The collector reports a terminal written after every object: that is
      // the `persisted` stage's evidence (contracts/stages.json).
      await recordOperationStage({
        store,
        operationId,
        stage: "persisted",
        state: "completed",
        now,
        evidenceRef: runIds.length === 1 ? `run:${runIds[0]}` : `runs:${runIds.length}`,
      });
      return;
    }
    case "refreshed":
      // A refresh has no stages: its progress is its status (0040).
      await store.batch([
        {
          sql: `UPDATE ops_collector_dispatches SET state='refreshed',finished_at=?2,updated_at=?2
            WHERE operation_id=?1 AND state='started'`,
          binds: [operationId, now],
        },
        {
          sql: `UPDATE ops_requests SET status='completed',updated_at=?2
            WHERE operation_id=?1 AND kind='session-refresh' AND status='running'
              AND EXISTS(SELECT 1 FROM ops_collector_dispatches d
                WHERE d.operation_id=?1 AND d.state='refreshed')`,
          binds: [operationId, now],
        },
      ]);
      return;
    default:
      await store.batch([
        {
          sql: `UPDATE ops_collector_dispatches SET state=?2,reason_code=?3,finished_at=?4,updated_at=?4
            WHERE operation_id=?1 AND state='started'`,
          binds: [operationId, outcome.kind, outcome.reasonCode, now],
        },
        failRequest(operationId, outcome.reasonCode, now),
      ]);
  }
}

function failRequest(operationId: string, failureCode: string, now: string): PreparedWrite {
  return {
    sql: `UPDATE ops_requests SET status='failed',failure_code=?2,updated_at=?3
      WHERE operation_id=?1 AND status NOT IN ${TERMINAL_REQUEST}`,
    binds: [operationId, failureCode, now],
  };
}

/**
 * Starts that never recorded an outcome — the Processor stopped mid-call —
 * become `uncertain` once they are older than `startedBefore`. The provider
 * may have been contacted, so the request is never started again; a lease the
 * collector left behind stays for the operator (ADR 0039). Returns how many.
 */
export async function abandonStartedCollectorDispatches(input: {
  store: CommandStore;
  startedBefore: string;
  now: string;
  limit: number;
}): Promise<number> {
  const stale = await input.store.all<{ operation_id: string }>(
    `SELECT operation_id FROM ops_collector_dispatches
      WHERE state='started' AND started_at<?1 ORDER BY started_at,operation_id LIMIT ?2`,
    [input.startedBefore, input.limit],
  );
  for (const row of stale)
    await input.store.batch([
      {
        sql: `UPDATE ops_collector_dispatches SET state='uncertain',reason_code='dispatch_uncertain',
          finished_at=?2,updated_at=?2 WHERE operation_id=?1 AND state='started'`,
        binds: [row.operation_id, input.now],
      },
      failRequest(row.operation_id, "dispatch_uncertain", input.now),
    ]);
  return stale.length;
}

/** Collected executions whose trail is due for another look, oldest check first. */
export async function collectedDispatchesDue(input: {
  store: CommandStore;
  nowMs: number;
  limit: number;
}): Promise<CollectorDispatchRow[]> {
  return input.store.all<CollectorDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM ops_collector_dispatches
      WHERE state='collected' AND next_check_at_ms<=?1
      ORDER BY next_check_at_ms,operation_id LIMIT ?2`,
    [input.nowMs, input.limit],
  );
}

export type TrackingResult = "published" | "unpublished" | "pending";

/**
 * Reads the trail of one collected execution and records what it supports:
 * the stage ladder, then `published` when every reported run has settled and
 * one was adopted, or `unpublished` with the closed reason when none was — or
 * when nothing settled within `PUBLICATION_HORIZON_MS` of collection
 * (`publication_not_observed`). Otherwise the next look is `checkIntervalMs`
 * away. `projected` (READ) is not traced here and stays as it is.
 */
export async function trackCollectorPublication(input: {
  store: CommandStore;
  operationId: string;
  now: string;
  nowMs: number;
  checkIntervalMs: number;
}): Promise<TrackingResult> {
  const { store, operationId, now, nowMs } = input;
  const row = await readCollectorDispatch(store, operationId);
  if (row === null || row.state !== "collected" || row.collected_at === null) return "pending";
  const runs =
    row.terminal_source === null
      ? []
      : await collectorRunTrails(store, row.terminal_source, storedRunIds(row));
  const outcome = trailOutcome(runs);
  const horizonPassed = nowMs - Date.parse(row.collected_at) >= PUBLICATION_HORIZON_MS;

  const verdicts: [OperationStage, StageVerdict][] = [
    ["registered", outcome.registered],
    ["parsed", outcome.parsed],
    ["adopted", outcome.adopted],
  ];
  if (!outcome.settled && horizonPassed) {
    // Stop watching: the first stage nobody reached carries the reason.
    const first = verdicts.find(([, verdict]) => verdict.state === "pending");
    if (first) first[1] = { state: "blocked", failureCode: "publication_not_observed" };
  }
  await syncStages(store, operationId, verdicts, now);

  if (outcome.settled && outcome.published) {
    await store.batch([
      {
        sql: `UPDATE ops_collector_dispatches SET state='published',published_at=?2,finished_at=?2,
          updated_at=?2 WHERE operation_id=?1 AND state='collected'`,
        binds: [operationId, now],
      },
    ]);
    return "published";
  }
  if (outcome.settled || horizonPassed) {
    const reasonCode = outcome.settled
      ? (outcome.reasonCode ?? "not_adopted")
      : "publication_not_observed";
    await store.batch([
      {
        sql: `UPDATE ops_collector_dispatches SET state='unpublished',reason_code=?2,finished_at=?3,
          updated_at=?3 WHERE operation_id=?1 AND state='collected'`,
        binds: [operationId, reasonCode, now],
      },
      failRequest(operationId, reasonCode, now),
    ]);
    return "unpublished";
  }
  await store.batch([
    {
      sql: `UPDATE ops_collector_dispatches SET next_check_at_ms=?2,updated_at=?3
        WHERE operation_id=?1 AND state='collected'`,
      binds: [operationId, nowMs + input.checkIntervalMs, now],
    },
  ]);
  return "pending";
}

/**
 * Writes a stage only when its verdict differs from what is stored, so a trail
 * read every few minutes does not inflate the attempt counter of a stage that
 * did not move. A `completed` stage is never reopened (0040 trigger).
 */
async function syncStages(
  store: CommandStore,
  operationId: string,
  verdicts: readonly [OperationStage, StageVerdict][],
  now: string,
): Promise<void> {
  const stored = await store.all<{ stage: string; state: string; failure_code: string | null }>(
    "SELECT stage,state,failure_code FROM ops_request_stages WHERE operation_id=?1",
    [operationId],
  );
  for (const [stage, verdict] of verdicts) {
    const current = stored.find((row) => row.stage === stage);
    if (current?.state === "completed") continue;
    if (verdict.state === "pending") continue;
    if (verdict.state === "completed") {
      await recordOperationStage({
        store,
        operationId,
        stage,
        state: "completed",
        now,
        evidenceRef: verdict.evidenceRef,
      });
      continue;
    }
    if (current?.state === "blocked" && current.failure_code === verdict.failureCode) continue;
    await recordOperationStage({
      store,
      operationId,
      stage,
      state: "blocked",
      now,
      failureCode: verdict.failureCode,
    });
  }
}
