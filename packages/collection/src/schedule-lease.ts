// Shared by manual and alarm entrypoints. An interrupted call never expires
// into another provider login. The operator must explicitly clear an old lease.
export interface ScheduleLeaseDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }> };
  };
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
  const claim = await db
    .prepare(
      "UPDATE collection_execution_leases SET lease_ref=?,started_at=? WHERE source=? AND lease_ref IS NULL",
    )
    .bind(ref, now, source)
    .run();
  if (claim.meta.changes !== 1) throw new Error("collection_busy_or_uncertain");
  try {
    return await action();
  } finally {
    await db
      .prepare(
        "UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL WHERE source=? AND lease_ref=?",
      )
      .bind(source, ref)
      .run();
  }
}
