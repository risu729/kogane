// Shared by manual and alarm entrypoints (ADR 0039, amended by ADR 0085).
//
// One execution holds a source's lease at a time, so two provider logins for
// one source never overlap. While its action runs, the holder proves it is
// alive by writing `heartbeat_at` on D1's clock every minute. A lease whose
// heartbeat is ten minutes old belongs to an execution that stopped, and the
// Processor's tick frees it (services/processor/src/schedule-store.ts,
// `expireStaleLeases`); an uncertain occurrence is still never replayed.
//
// A live holder therefore stops itself well before that:
//   * after 13 minutes (below the 15-minute alarm limit), or when its
//     heartbeat finds the lease gone, or has failed to write for 3 minutes,
//     it aborts the `AbortSignal` its action receives;
//   * if the action has not settled 30 s later, the call fails with the
//     abort's code and `forceStop` (when given) ends the execution by force;
//   * the heartbeat keeps running until the action itself settles, so a lease
//     is freed only once its execution went silent, or once a holder that
//     ignored its stop could not write a heartbeat for ten minutes.
//
// A live call does not leave its own lease behind because one D1 statement
// failed: a claim whose answer was lost clears its own reference before it
// reports the failure, and the release is retried. Only when every attempt to
// clear fails does the lease stay held (logged) until the tick frees it. Both
// clear only this call's own reference, so neither can free a lease another
// execution holds.
export interface ScheduleLeaseDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>;
      /** D1's single-row read; used only to describe a refusal in the log. */
      first?<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

/** How many times a live call tries to clear its own reference. */
export const LEASE_RELEASE_ATTEMPTS = 3;

/** The lease's clocks (ADR 0085). The Processor's staleness rule is longer than all of them. */
export const LEASE_TIMING = {
  /** How often a holder writes its heartbeat. */
  heartbeatMs: 60_000,
  /** A holder whose heartbeat has not been written for this long stops itself. */
  heartbeatLossMs: 3 * 60_000,
  /** A holder stops itself this long after its claim. */
  deadlineMs: 13 * 60_000,
  /** How long an aborted action may take to settle before `forceStop`. */
  graceMs: 30_000,
} as const;
export type LeaseTiming = { readonly [K in keyof typeof LEASE_TIMING]: number };

/** Why a holder stopped itself; both mean the provider may already have been contacted. */
export const LEASE_ABORT_CODES = ["collection_deadline_exceeded", "collection_lease_lost"] as const;
export type LeaseAbortCode = (typeof LEASE_ABORT_CODES)[number];

/** The abort reason a holder's action receives, and what a stopped call rejects with. */
export class CollectionLeaseAbort extends Error {
  constructor(readonly code: LeaseAbortCode) {
    super(code);
    this.name = "CollectionLeaseAbort";
  }
}

/** The lease timestamp format, `YYYY-MM-DDTHH:MM:SS.sssZ`, taken on D1's clock. */
export const D1_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const RELEASE_OWN =
  "UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL,heartbeat_at=NULL WHERE source=? AND lease_ref=?";
const HEARTBEAT = `UPDATE collection_execution_leases SET heartbeat_at=${D1_NOW} WHERE source=? AND lease_ref=?`;

/**
 * Clears this call's own reference, retrying a failed statement. A statement
 * that ran clears the reference or finds it already gone; either way the
 * source no longer holds this call's lease. Only when every attempt failed is
 * the lease left held, and that is logged with a closed code; the Processor's
 * tick frees it once its heartbeat is stale.
 */
async function releaseOwnLease(
  db: ScheduleLeaseDatabase,
  source: string,
  ref: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= LEASE_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await db.prepare(RELEASE_OWN).bind(source, ref).run();
      return true;
    } catch {
      // Retried below; the last failure is logged once.
    }
  }
  console.error(
    JSON.stringify({
      event: "collection_lease_release_failed",
      source,
      attempts: LEASE_RELEASE_ATTEMPTS,
    }),
  );
  return false;
}

interface LeaseHolderRow {
  lease_ref: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  age_ms: number | null;
  silent_ms: number | null;
}
/**
 * Says who holds the lease a claim was refused on: its reference (the one the
 * operator's release names), when it was claimed and when it last proved
 * itself alive, with both ages on D1's clock. A failed read still logs the
 * refusal; the refusal itself never depends on this read.
 */
async function logLeaseBusy(db: ScheduleLeaseDatabase, source: string): Promise<void> {
  let holder: LeaseHolderRow | null = null;
  let read: "ok" | "unavailable" | "failed" = "unavailable";
  try {
    const statement = db
      .prepare(
        `SELECT lease_ref,started_at,heartbeat_at,
          CAST((julianday('now')-julianday(started_at))*86400000 AS INTEGER) AS age_ms,
          CAST((julianday('now')-julianday(heartbeat_at))*86400000 AS INTEGER) AS silent_ms
         FROM collection_execution_leases WHERE source=?`,
      )
      .bind(source);
    if (statement.first) {
      holder = await statement.first<LeaseHolderRow>();
      read = "ok";
    }
  } catch {
    read = "failed";
  }
  console.log(
    JSON.stringify({
      event: "collection_lease_busy",
      code: "collection_busy",
      source,
      holderRead: read,
      holderLeaseRef: holder?.lease_ref ?? null,
      holderStartedAt: holder?.started_at ?? null,
      holderHeartbeatAt: holder?.heartbeat_at ?? null,
      holderAgeMs: holder?.age_ms ?? null,
      holderSilentMs: holder?.silent_ms ?? null,
    }),
  );
}

export interface CollectionLeaseOptions {
  /**
   * Ends the execution by force when its aborted action has not settled
   * within the grace period: `ctx.abort(code)` in a Durable Object. It
   * receives the abort's code because a reset object answers its in-flight
   * calls with the `ctx.abort` reason as the error message, so the caller
   * still sees `collection_deadline_exceeded` or `collection_lease_lost`.
   * A plain Worker call needs none; its call fails and its invocation ends.
   */
  forceStop?: (code: LeaseAbortCode) => void;
  /** Test seam: shorter clocks. */
  timing?: LeaseTiming;
}

export async function withCollectionLease<T>(
  env: { SCHEDULE_DB?: ScheduleLeaseDatabase },
  source: string,
  action: (signal: AbortSignal) => Promise<T>,
  options: CollectionLeaseOptions = {},
): Promise<T> {
  const db = env.SCHEDULE_DB;
  // Existing isolated fixtures/deployments without the new binding retain their behavior.
  if (!db) return action(new AbortController().signal);
  const timing = options.timing ?? LEASE_TIMING;
  const ref = crypto.randomUUID(),
    now = new Date().toISOString();
  await db
    .prepare(
      "INSERT OR IGNORE INTO collection_execution_leases(source, lease_ref, started_at) VALUES(?,NULL,NULL)",
    )
    .bind(source)
    .run();
  // The claim writes the first heartbeat; it was sent no earlier than this.
  const claimSentMs = Date.now();
  let claim: { meta: { changes: number } };
  try {
    claim = await db
      .prepare(
        `UPDATE collection_execution_leases SET lease_ref=?,started_at=?,heartbeat_at=${D1_NOW} WHERE source=? AND lease_ref IS NULL`,
      )
      .bind(ref, now, source)
      .run();
  } catch (error) {
    // The claim may have committed even though its answer was lost. Nothing
    // has contacted a provider yet, so clear this call's own reference (if it
    // was written) and report the claim's failure.
    console.error(
      JSON.stringify({
        event: "collection_lease_claim_failed",
        source,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
    await releaseOwnLease(db, source, ref);
    throw error;
  }
  if (claim.meta.changes !== 1) {
    await logLeaseBusy(db, source);
    throw new Error("collection_busy_or_uncertain");
  }

  const controller = new AbortController();
  const timers: ReturnType<typeof setTimeout>[] = [];
  // When the last heartbeat that was written had been sent (isolate clock).
  // The send time, not the answer's arrival: D1 wrote it at or after this
  // moment, so the holder never counts a heartbeat as newer than it is.
  let lastBeatMs = claimSentMs;
  // Once the action settled, nothing more is aborted or forced: a heartbeat
  // answer that arrives after the release must not stop anything.
  let settled = false;
  let forceFired = false;
  let forced: (error: CollectionLeaseAbort) => void = () => undefined;
  const forcedStop = new Promise<never>((_, reject) => {
    forced = reject;
  });
  // Only ever rejected deliberately below; never left unhandled.
  forcedStop.catch(() => undefined);
  const abort = (code: LeaseAbortCode) => {
    if (settled || controller.signal.aborted) return;
    const reason = new CollectionLeaseAbort(code);
    controller.abort(reason);
    timers.push(
      setTimeout(() => {
        if (settled) return;
        forceFired = true;
        forced(reason);
        options.forceStop?.(code);
      }, timing.graceMs),
    );
  };
  const heartbeat = setInterval(() => {
    if (settled) return;
    // Checked on every tick, so a heartbeat whose answer never comes still
    // counts as missing.
    if (Date.now() - lastBeatMs >= timing.heartbeatLossMs) abort("collection_lease_lost");
    // A new heartbeat is sent every tick even while an earlier one is still
    // unanswered: a stalled statement must not stop the lease from proving
    // its holder alive for as long as the action runs.
    const sentMs = Date.now();
    db.prepare(HEARTBEAT)
      .bind(source, ref)
      .run()
      .then(
        (result) => {
          // Released by the operator, or freed by the tick: someone else may run.
          if (result.meta.changes !== 1) abort("collection_lease_lost");
          else lastBeatMs = Math.max(lastBeatMs, sentMs);
        },
        () => {
          if (Date.now() - lastBeatMs >= timing.heartbeatLossMs) abort("collection_lease_lost");
        },
      );
  }, timing.heartbeatMs);
  timers.push(setTimeout(() => abort("collection_deadline_exceeded"), timing.deadlineMs));

  // A synchronous throw is a rejection like any other, so the lease is released.
  const running = new Promise<T>((resolve, reject) => {
    try {
      resolve(action(controller.signal));
    } catch (error) {
      reject(error);
    }
  });
  // The heartbeat and the lease end with the action itself, never earlier:
  // a call that failed by force keeps its lease alive while its action lives.
  const finished = running.then(
    () => undefined,
    () => undefined,
  );
  const released = finished.then(async () => {
    settled = true;
    clearInterval(heartbeat);
    for (const timer of timers) clearTimeout(timer);
    // A failed release does not replace the action's own outcome: what the
    // collection did is still what it did. The held lease is logged instead.
    await releaseOwnLease(db, source, ref);
  });
  try {
    const result = await Promise.race([running, forcedStop]);
    // A stopped holder cannot become successful by resolving during the grace
    // period. Its stop remains uncertain even when the action swallows it.
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    // An action that failed because its holder stopped reports why it stopped.
    const reason: unknown = controller.signal.reason;
    if (controller.signal.aborted && reason instanceof CollectionLeaseAbort) throw reason;
    throw error;
  } finally {
    // A settled action returns once its lease is released; a forced stop
    // returns at once and the lease is released when its action settles.
    if (!forceFired) await released;
  }
}
