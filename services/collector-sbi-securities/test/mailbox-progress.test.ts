import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readMailboxProgress, writeMailboxProgress } from "../src/mailbox-progress";

test("cursor commits compare the previous durable run and identical retries are idempotent", async () => {
  const sql = new Database(":memory:");
  sql.exec(
    "CREATE TABLE dataset_snapshot_policies(source_id TEXT,dataset TEXT,parser_name TEXT,policy_id TEXT,required_parser_version TEXT,replaces_previous_on_complete_empty INTEGER,unit_scope TEXT,snapshot_selection INTEGER)",
  );
  sql.exec(
    readFileSync(
      new URL(
        "../../../packages/storage-d1/migrations/core/0099_sbi_document_unit_eligibility.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const db = {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          const statement = sql.prepare(text);
          const args = values as (string | null)[];
          return {
            async first<T>() {
              return statement.get(...args) as T | null;
            },
            async run() {
              return { meta: { changes: statement.run(...args).changes } };
            },
          };
        },
      };
    },
  };
  expect(await readMailboxProgress(db)).toEqual({ nextIdentity: null, persistedRunId: null });
  await writeMailboxProgress(db, "a".repeat(64), "synthetic-run-1", null);
  await writeMailboxProgress(db, "a".repeat(64), "synthetic-run-1", null);
  await expect(writeMailboxProgress(db, "b".repeat(64), "synthetic-stale", null)).rejects.toThrow(
    "sbi_mailbox_progress_failed",
  );
  expect(await readMailboxProgress(db)).toEqual({
    nextIdentity: "a".repeat(64),
    persistedRunId: "synthetic-run-1",
  });
  await writeMailboxProgress(db, null, "synthetic-run-2", "synthetic-run-1");
  expect(await readMailboxProgress(db)).toEqual({
    nextIdentity: null,
    persistedRunId: "synthetic-run-2",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    writeMailboxProgress(
      db,
      "c".repeat(64),
      "synthetic-aborted",
      "synthetic-run-2",
      controller.signal,
    ),
  ).rejects.toThrow("sbi_mailbox_lease_lost");
  expect(await readMailboxProgress(db)).toEqual({
    nextIdentity: null,
    persistedRunId: "synthetic-run-2",
  });
  sql.close();
});
