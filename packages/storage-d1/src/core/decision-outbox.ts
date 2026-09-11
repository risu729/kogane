// The decision outbox dispatcher (architecture addendum A09, 12 §3; unified
// plan 05 §6, 01 §5).
//
// This is NOT the collector R2 import outbox. That one carries fetched
// evidence towards the central store; this one carries accepted internal
// judgements towards the read models. Mixing them into one "transaction queue"
// would hide that a decision is accepted long before every screen is current.
//
// Delivery is assumed duplicated, out of order and interrupted (12 §3): a row
// carries a lease so two dispatchers cannot run it at once, an attempt counter
// with backoff, and a `processed_at` that makes a second delivery a no-op. The
// processors themselves are idempotent, so even a lost lease cannot double a
// projection. The receipt turns `published` only when every row of its
// operation is processed — accepted is never published (addendum 10 §5).
//
// What changed with migration 0038: a processor no longer returns "some
// outcome" that the dispatcher treats as done. It returns one of four
// results, and only one of them closes the row:
//
//   pending(progress)   the work is running — a build that has not finished,
//                       a flag that is off. Retried, without burning the
//                       failure budget, and the row stays open.
//   completed(evidence) the downstream effect landed, with the reference that
//                       proves it (the snapshot, the swept runs).
//   retryable(code)     a transient failure; backoff, and the attempt counts.
//   blocked(code)       nothing will change without an operator: no processor
//                       is registered, or a declared budget was exceeded.
//
// `building`, an unregistered processor, a flag that is off and "the job was
// enqueued" are therefore never `completed` (05 §6, contracts/stages.json).
import type { D1Like } from "../d1.ts";
import { resolveIdentity } from "../../../identity/src/index.ts";
import { identitySweep } from "./identity-store.ts";

const LEASE_MS = 60_000;
const BATCH_DEFAULT = 20;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/** Bounded work per outbox row so one decision cannot monopolise a sweep. */
const SWEEP_RUNS = 8;
/** A pending poll is re-scheduled for the next tick, not backed off. */
const PENDING_RETRY_MS = 30_000;

export const OUTBOX_TARGETS = [
  "identity-projection",
  "balance-projection",
  "agent-notify",
] as const;
export type OutboxTarget = (typeof OUTBOX_TARGETS)[number];

export interface OutboxRow {
  id: number;
  decision_revision_id: string;
  principal: string;
  operation_id: string;
  target: string;
  attempts: number;
  /**
   * The CORE source revision this row's effect must be covered by, stamped on
   * the first claim. The decision's own write already bumped the revision, so
   * any snapshot at or above it carries the decision (05 §6).
   */
  required_source_revision: number | null;
}

/** A safe outcome code, never a message: it is logged and stored. */
export type OutboxCode =
  | "identity_swept"
  | "no_agent_transport"
  | "no_processor"
  | "projection_flag_off"
  | "projection_building"
  | "projection_behind_decision"
  | "projection_input_unstable"
  | "projection_input_unreadable"
  | "projection_writer_fenced"
  | "projection_budget_exceeded"
  | "balance_projection_active";

/**
 * The result contract every processor answers with. Consumers must handle all
 * four: only `completed` closes the row and can publish the receipt.
 */
export type ProcessorOutcome =
  | { status: "pending"; progress: string }
  | { status: "completed"; evidence: { code: OutboxCode; ref: string } }
  | { status: "retryable"; code: string }
  | { status: "blocked"; code: string };

export const pendingOutcome = (progress: string): ProcessorOutcome => ({
  status: "pending",
  progress,
});
export const completedOutcome = (code: OutboxCode, ref: string): ProcessorOutcome => ({
  status: "completed",
  evidence: { code, ref },
});
export const retryableOutcome = (code: string): ProcessorOutcome => ({
  status: "retryable",
  code,
});
export const blockedOutcome = (code: string): ProcessorOutcome => ({ status: "blocked", code });

export type OutboxProcessor = (db: D1Like, row: OutboxRow) => Promise<ProcessorOutcome>;

/**
 * Re-runs the identity projection for the parse runs the decision affects. The
 * sweep only creates identity runs that are missing and seals them once, so
 * running it twice for the same decision changes nothing. The evidence is the
 * number of runs it sealed, which is what a reader can check against
 * `identity_run_seals`.
 */
export const identityProjectionProcessor: OutboxProcessor = async (db) => {
  const swept = await identitySweep(db, resolveIdentity, SWEEP_RUNS);
  return completedOutcome("identity_swept", `identity-runs:${String(swept.identifiedRuns)}`);
};

/**
 * No agent notification transport exists yet, and none is configured to exist:
 * there is no downstream state that could still become current, so the row is
 * closed honestly rather than left pending for ever. That is not the same as
 * an unregistered processor, which is blocked.
 */
export const agentNotifyProcessor: OutboxProcessor = async () =>
  completedOutcome("no_agent_transport", "agent-notify:none");

/**
 * `balance-projection` deliberately has no default. A07 owns that projection
 * (`balanceProjectionOutboxProcessor` in `balance-projection-job.ts`, over
 * `balance_read_snapshots` / `current_balance_projection` / `scope_relations`
 * from migration 0030) and is handed in through `dispatchDecisionOutbox`'s
 * `processors` argument — which is why the dispatcher takes one rather than
 * hard-coding the map. A build that forgets to pass it leaves the row
 * `blocked(no_processor)`: the receipt stays `accepted`, because nothing
 * updated the read model (05 §6).
 */
export const DEFAULT_PROCESSORS: Partial<Record<OutboxTarget, OutboxProcessor>> = {
  "identity-projection": identityProjectionProcessor,
  "agent-notify": agentNotifyProcessor,
};

export interface OutboxDispatchOptions {
  limit?: number;
  now?: number;
  processors?: Partial<Record<OutboxTarget, OutboxProcessor>>;
}

export interface OutboxDispatchResult {
  claimed: number;
  processed: number;
  failed: number;
  /** Rows whose work is still running; the row stays open on purpose. */
  waiting: number;
  /** Rows nothing will move without an operator. */
  blocked: number;
  published: number;
  outcomes: Record<string, number>;
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * One bounded pass. Called once per scheduled run; a failure of one row never
 * stops the others, and nothing here retries in a loop inside one invocation.
 */
export async function dispatchDecisionOutbox(
  db: D1Like,
  options: OutboxDispatchOptions = {},
): Promise<OutboxDispatchResult> {
  const limit = options.limit ?? BATCH_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("decision_outbox_batch_invalid");
  const nowMs = options.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const processors = { ...DEFAULT_PROCESSORS, ...options.processors };
  const token = crypto.randomUUID();
  // One claim statement: a row is leased only while it is unprocessed, due,
  // unleased (or its lease expired), not blocked, and under the attempt
  // budget. Polls of work that is still running are excluded from that budget,
  // so a long build cannot exhaust the retries a real failure needs.
  await db
    .prepare(
      `UPDATE decision_outbox SET lease_token=?1,lease_until_ms=?2,attempts=attempts+1
       WHERE id IN (SELECT id FROM decision_outbox WHERE processed_at IS NULL
        AND available_at_ms<=?3 AND lease_until_ms<=?3 AND blocked_code IS NULL
        AND attempts-pending_polls<?4 ORDER BY id LIMIT ?5)`,
    )
    .bind(token, nowMs + LEASE_MS, nowMs, MAX_ATTEMPTS, limit)
    .run();
  // The revision a claimed row must be covered by, stamped once. Reading it
  // after the claim is sound because the decision's own write already moved
  // the revision past its own change.
  await db
    .prepare(
      `UPDATE decision_outbox
       SET required_source_revision=(SELECT source_revision FROM core_source_revision WHERE id=1)
       WHERE lease_token=?1 AND processed_at IS NULL AND required_source_revision IS NULL`,
    )
    .bind(token)
    .run();
  const claimed = await db
    .prepare(
      `SELECT id,decision_revision_id,principal,operation_id,target,attempts,
        required_source_revision FROM decision_outbox
       WHERE lease_token=?1 AND processed_at IS NULL ORDER BY id`,
    )
    .bind(token)
    .all<OutboxRow>();
  const result: OutboxDispatchResult = {
    claimed: claimed.results.length,
    processed: 0,
    failed: 0,
    waiting: 0,
    blocked: 0,
    published: 0,
    outcomes: {},
  };
  const operations = new Map<string, { principal: string; operationId: string }>();
  const count = (key: string) => {
    result.outcomes[key] = (result.outcomes[key] ?? 0) + 1;
  };
  for (const row of claimed.results) {
    const processor = processors[row.target as OutboxTarget];
    let outcome: ProcessorOutcome;
    try {
      outcome = processor ? await processor(db, row) : blockedOutcome("no_processor");
    } catch (error) {
      // Safe codes only: never an exception message, a provider value or an
      // amount (addendum 12 §5).
      outcome = retryableOutcome(
        error instanceof Error ? error.constructor.name.slice(0, 64) : "unknown",
      );
    }
    if (outcome.status === "completed") {
      // The `processed_at IS NULL` condition is what makes a duplicate
      // delivery a no-op instead of a rewrite.
      const done = await db
        .prepare(
          `UPDATE decision_outbox SET processed_at=?1,outcome=?2,last_error_code=NULL,
            progress_code=NULL,evidence_ref=?5,applied_source_revision=?6,
            lease_token=NULL,lease_until_ms=0 WHERE id=?3 AND lease_token=?4 AND processed_at IS NULL`,
        )
        .bind(
          nowIso,
          outcome.evidence.code,
          row.id,
          token,
          outcome.evidence.ref.slice(0, 256),
          row.required_source_revision,
        )
        .run();
      if (done.meta.changes === 1) {
        result.processed++;
        count(outcome.evidence.code);
        operations.set(`${row.principal} ${row.operation_id}`, {
          principal: row.principal,
          operationId: row.operation_id,
        });
      } else {
        count("already_processed");
      }
      continue;
    }
    if (outcome.status === "pending") {
      // Still running. The row stays open, the poll does not count as a
      // failure, and nothing of the operation is published.
      result.waiting++;
      count(`pending:${outcome.progress}`);
      await db
        .prepare(
          `UPDATE decision_outbox SET progress_code=?1,pending_polls=pending_polls+1,
            available_at_ms=?2,lease_token=NULL,lease_until_ms=0
           WHERE id=?3 AND lease_token=?4 AND processed_at IS NULL`,
        )
        .bind(outcome.progress.slice(0, 64), nowMs + PENDING_RETRY_MS, row.id, token)
        .run();
      continue;
    }
    if (outcome.status === "blocked") {
      result.blocked++;
      count(`blocked:${outcome.code}`);
      await db
        .prepare(
          `UPDATE decision_outbox SET blocked_code=?1,last_error_code=?1,
            lease_token=NULL,lease_until_ms=0
           WHERE id=?2 AND lease_token=?3 AND processed_at IS NULL`,
        )
        .bind(outcome.code.slice(0, 64), row.id, token)
        .run();
      continue;
    }
    result.failed++;
    count(`retryable:${outcome.code}`);
    await db
      .prepare(
        `UPDATE decision_outbox SET last_error_code=?1,available_at_ms=?2,lease_token=NULL,lease_until_ms=0
         WHERE id=?3 AND lease_token=?4 AND processed_at IS NULL`,
      )
      .bind(outcome.code.slice(0, 64), nowMs + backoffMs(row.attempts), row.id, token)
      .run();
  }
  // `accepted` becomes `published` only for operations whose every outbox row
  // is processed. Bounded to the operations this pass touched.
  for (const { principal, operationId } of operations.values()) {
    const publish = await db
      .prepare(
        `UPDATE operation_receipts SET status='published',published_at=?1
         WHERE principal=?2 AND operation_id=?3 AND status='accepted'
         AND EXISTS(SELECT 1 FROM decision_outbox o WHERE o.principal=?2 AND o.operation_id=?3)
         AND NOT EXISTS(SELECT 1 FROM decision_outbox o WHERE o.principal=?2 AND o.operation_id=?3 AND o.processed_at IS NULL)`,
      )
      .bind(nowIso, principal, operationId)
      .run();
    result.published += publish.meta.changes;
  }
  return result;
}
