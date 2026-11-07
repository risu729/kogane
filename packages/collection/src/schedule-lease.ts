// Shared by manual and alarm entrypoints. An interrupted call never expires
// into another provider login. The operator must explicitly clear an old lease.
//
// A live call never leaves its own lease behind because one D1 statement
// failed: a claim whose answer was lost clears its own reference before it
// reports the failure, and the release is retried. Both clear only this call's
// own reference, so neither can free a lease another execution holds.
export interface ScheduleLeaseDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }> };
  };
}

/** How many times a live call tries to clear its own reference. */
export const LEASE_RELEASE_ATTEMPTS = 3;

const RELEASE_OWN =
  "UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL WHERE source=? AND lease_ref=?";

/**
 * Clears this call's own reference, retrying a failed statement. A statement
 * that ran clears the reference or finds it already gone; either way the
 * source no longer holds this call's lease. Only when every attempt failed is
 * the lease left held, and that is logged with a closed code (the operator's
 * stopped-execution release is then the way out, as for a dead process).
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

export async function withCollectionLease<T>(
  env: { SCHEDULE_DB?: ScheduleLeaseDatabase },
  source: string,
  action: () => Promise<T>,
): Promise<T> {
  const db = env.SCHEDULE_DB;
  // Existing isolated fixtures/deployments without the new binding retain their behavior.
  if (!db) return action();
  const ref = crypto.randomUUID(),
    now = new Date().toISOString();
  await db
    .prepare(
      "INSERT OR IGNORE INTO collection_execution_leases(source, lease_ref, started_at) VALUES(?,NULL,NULL)",
    )
    .bind(source)
    .run();
  let claim: { meta: { changes: number } };
  try {
    claim = await db
      .prepare(
        "UPDATE collection_execution_leases SET lease_ref=?,started_at=? WHERE source=? AND lease_ref IS NULL",
      )
      .bind(ref, now, source)
      .run();
  } catch (error) {
    // The claim may have committed even though its answer was lost. Nothing
    // has contacted a provider yet, so clear this call's own reference (if it
    // was written) and report the claim's failure.
    await releaseOwnLease(db, source, ref);
    throw error;
  }
  if (claim.meta.changes !== 1) throw new Error("collection_busy_or_uncertain");
  try {
    return await action();
  } finally {
    // A failed release does not replace the action's own outcome: what the
    // collection did is still what it did. The held lease is logged instead.
    await releaseOwnLease(db, source, ref);
  }
}
