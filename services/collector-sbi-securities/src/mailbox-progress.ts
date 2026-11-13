import { MailboxError } from "./mailbox-bootstrap";

interface ProgressDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

export interface MailboxProgress {
  nextIdentity: string | null;
  persistedRunId: string | null;
}

export async function readMailboxProgress(db: ProgressDatabase): Promise<MailboxProgress> {
  try {
    const row = await db
      .prepare("SELECT next_identity,persisted_run_id FROM sbi_mailbox_progress WHERE source=?")
      .bind("sbi-securities")
      .first<{ next_identity: string | null; persisted_run_id: string }>();
    if (row?.next_identity != null && !/^[a-f0-9]{64}$/u.test(row.next_identity)) throw new Error();
    return {
      nextIdentity: row?.next_identity ?? null,
      persistedRunId: row?.persisted_run_id ?? null,
    };
  } catch {
    throw new MailboxError("sbi_mailbox_progress_failed");
  }
}

/** Called only after terminal persistence under the existing source lease. */
export async function writeMailboxProgress(
  db: ProgressDatabase,
  next: string | null,
  runId: string,
  previousRunId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal?.aborted) throw new MailboxError("sbi_mailbox_lease_lost");
    if (next !== null && !/^[a-f0-9]{64}$/u.test(next)) throw new Error();
    const result = await db
      .prepare(
        "INSERT INTO sbi_mailbox_progress(source,next_identity,persisted_run_id) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET next_identity=excluded.next_identity,persisted_run_id=excluded.persisted_run_id WHERE sbi_mailbox_progress.persisted_run_id=?",
      )
      .bind("sbi-securities", next, runId, previousRunId ?? "")
      .run();
    if (result.meta.changes !== 1) {
      const current = await readMailboxProgress(db);
      if (current.persistedRunId !== runId || current.nextIdentity !== next) throw new Error();
    }
  } catch (error) {
    if (error instanceof MailboxError) throw error;
    throw new MailboxError("sbi_mailbox_progress_failed");
  }
}
