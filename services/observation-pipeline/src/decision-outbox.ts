// The decision outbox dispatcher (architecture addendum A09, 12 §3).
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
import { resolveIdentity } from "../../../poc/observation-pipeline/src/identity/index.ts";
import { identitySweep } from "./identity-store.ts";

const LEASE_MS = 60_000;
const BATCH_DEFAULT = 20;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/** Bounded work per outbox row so one decision cannot monopolise a sweep. */
const SWEEP_RUNS = 8;

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
}

/** A safe outcome code, never a message: it is logged and stored. */
export type OutboxOutcome =
  | "identity_swept"
  | "skipped_no_projection"
  // A07's balance projection: already current, sealed on this tick, or still
  // building within this tick's write budget.
  | "balance_projection_current"
  | "balance_projection_rebuilt"
  | "balance_projection_rebuilding"
  | "skipped_no_consumer";

export type OutboxProcessor = (db: D1Database, row: OutboxRow) => Promise<OutboxOutcome>;

/**
 * Re-runs the identity projection for the parse runs the decision affects. The
 * sweep only creates identity runs that are missing and seals them once, so
 * running it twice for the same decision changes nothing.
 */
export const identityProjectionProcessor: OutboxProcessor = async (db) => {
  await identitySweep(db, resolveIdentity, SWEEP_RUNS);
  return "identity_swept";
};

/** No agent notification transport exists yet; the row is closed honestly. */
export const agentNotifyProcessor: OutboxProcessor = async () => "skipped_no_consumer";

/**
 * `balance-projection` deliberately has no default. A07 owns that projection
 * (`balanceProjectionOutboxProcessor` in `balance-projection-job.ts`, over
 * `balance_read_snapshots` / `current_balance_projection` / `scope_relations`
 * from migration 0030) and is handed in through `dispatchDecisionOutbox`'s
 * `processors` argument — which is why the dispatcher takes one rather than
 * hard-coding the map. A build that forgets to pass it closes the row as
 * `skipped_no_consumer`, an honest "nobody handled this", instead of a
 * placeholder quietly reporting a projection that never ran.
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
  db: D1Database,
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
  // unleased (or its lease expired) and under the attempt budget.
  await db
    .prepare(
      `UPDATE decision_outbox SET lease_token=?1,lease_until_ms=?2,attempts=attempts+1
       WHERE id IN (SELECT id FROM decision_outbox WHERE processed_at IS NULL
        AND available_at_ms<=?3 AND lease_until_ms<=?3 AND attempts<?4 ORDER BY id LIMIT ?5)`,
    )
    .bind(token, nowMs + LEASE_MS, nowMs, MAX_ATTEMPTS, limit)
    .run();
  const claimed = await db
    .prepare(
      `SELECT id,decision_revision_id,principal,operation_id,target,attempts FROM decision_outbox
       WHERE lease_token=?1 AND processed_at IS NULL ORDER BY id`,
    )
    .bind(token)
    .all<OutboxRow>();
  const result: OutboxDispatchResult = {
    claimed: claimed.results.length,
    processed: 0,
    failed: 0,
    published: 0,
    outcomes: {},
  };
  const operations = new Map<string, { principal: string; operationId: string }>();
  for (const row of claimed.results) {
    const processor = processors[row.target as OutboxTarget];
    let outcome: OutboxOutcome | null = null;
    let errorCode: string | null = null;
    try {
      outcome = processor ? await processor(db, row) : "skipped_no_consumer";
    } catch (error) {
      // Safe codes only: never an exception message, a provider value or an
      // amount (addendum 12 §5).
      errorCode = error instanceof Error ? error.constructor.name.slice(0, 64) : "unknown";
    }
    if (outcome !== null) {
      // The `processed_at IS NULL` condition is what makes a duplicate
      // delivery a no-op instead of a rewrite.
      const done = await db
        .prepare(
          `UPDATE decision_outbox SET processed_at=?1,outcome=?2,last_error_code=NULL,
            lease_token=NULL,lease_until_ms=0 WHERE id=?3 AND lease_token=?4 AND processed_at IS NULL`,
        )
        .bind(nowIso, outcome, row.id, token)
        .run();
      if (done.meta.changes === 1) {
        result.processed++;
        result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
        operations.set(`${row.principal} ${row.operation_id}`, {
          principal: row.principal,
          operationId: row.operation_id,
        });
      } else {
        result.outcomes.already_processed = (result.outcomes.already_processed ?? 0) + 1;
      }
      continue;
    }
    result.failed++;
    await db
      .prepare(
        `UPDATE decision_outbox SET last_error_code=?1,available_at_ms=?2,lease_token=NULL,lease_until_ms=0
         WHERE id=?3 AND lease_token=?4 AND processed_at IS NULL`,
      )
      .bind(errorCode, nowMs + backoffMs(row.attempts), row.id, token)
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
