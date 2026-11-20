import { expect, test } from "bun:test";
import { scheduledResult } from "../../../packages/collection/src/schedule-result";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { persistSbiAcquisition } from "../src/acquisition";
import { collectMailbox, MAILBOX_INDEX_UNIT, type MailboxUnit } from "../src/mailbox";
import { MAX_MAILBOX_ROWS } from "../src/mailbox-contract";
import type { MailboxApi } from "../src/mailbox-http";
import type { SbiSharedRun } from "../src/shared-run";
import type { Artifact } from "../src/types";
import { mailboxDetailFixture, mailboxList, mailboxRow, mailboxSummary } from "./mailbox-fixture";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const pdf = new TextEncoder().encode("%PDF-synthetic");

/** One synthetic acquisition whose current mailbox list has `count` supported rows. */
async function acquire(count: number) {
  const rows = Array.from({ length: count }, (_, index) => mailboxRow(`synthetic-${index}`));
  const artifacts: Artifact[] = [];
  const units: MailboxUnit[] = [];
  const failures: { scope: "mailbox"; code: string }[] = [];
  const progress: (string | null)[] = [];
  await collectMailbox({
    client: {
      async open() {},
      async api(kind: MailboxApi) {
        if (kind === "summary") return encode(mailboxSummary(rows.length));
        if (kind === "list") return encode(mailboxList(rows));
        if (kind === "detail") return encode(mailboxDetailFixture());
        return pdf;
      },
    },
    retain: (artifact) => artifacts.push(artifact),
    onUnit: (unit) => units.push(unit),
    onError: (error) => failures.push({ scope: "mailbox", code: error.code }),
    deadline: Date.now() + 600_000,
    signal: new AbortController().signal,
    startIdentity: null,
    onProgress: (next) => progress.push(next),
  });
  const core: SbiSharedRun = {
    runId: "synthetic-bound",
    producerVersion: "synthetic-v1",
    attemptId: "attempt-synthetic-bound",
    acquisitionSessionRef: "synthetic-bound",
    startedAt: "2099-01-02T00:00:00Z",
    completedAt: "2099-01-02T00:01:00Z",
    scope: "foreign",
    status: "success",
    artifacts: [],
    failures: [],
  };
  const result = await persistSbiAcquisition({
    bucket: new FakeR2Bucket(),
    core,
    signal: new AbortController().signal,
    mailbox: async () => ({
      ...core,
      runId: "synthetic-bound-mailbox",
      attemptId: "attempt-synthetic-bound-mailbox",
      scope: "domestic",
      status: failures.length === 0 ? "success" : artifacts.length === 0 ? "failed" : "partial",
      artifacts,
      failures,
      mailboxUnits: units,
    }),
  });
  return { ...result, progress };
}

test("the longest accepted current list fits one mailbox terminal", async () => {
  expect(MAX_MAILBOX_ROWS).toBe(999);
  const result = await acquire(MAX_MAILBOX_ROWS);
  expect(result.mailbox?.outcome).toBe("persisted");
  if (result.mailbox?.outcome !== "persisted") throw new Error("synthetic_persistence_failed");
  expect(result.mailbox.manifest.units).toHaveLength(1000);
  expect(result.runIds).toEqual(["synthetic-bound", "synthetic-bound-mailbox"]);
  expect(result.status).toBe("success");
  // Every row was walked, so the committed pointer restarts the cycle.
  expect(result.progress).toEqual([null]);
});

test("a list one row past the terminal's unit capacity is a persisted refusal, not an unplannable terminal", async () => {
  // 1,000 rows plus the index unit would need 1,001 units; before the bound
  // was tied to that capacity the mailbox terminal could not be planned, so
  // nothing was archived, the cursor never moved and the code was generic.
  const result = await acquire(MAX_MAILBOX_ROWS + 1);
  expect(result.mailbox?.outcome).toBe("persisted");
  if (result.mailbox?.outcome !== "persisted") throw new Error("synthetic_persistence_failed");
  expect(result.mailbox.manifest.units).toEqual([
    expect.objectContaining({
      unitKey: MAILBOX_INDEX_UNIT,
      coverageStatus: "partial",
      safeErrorCode: "sbi_mailbox_rows_over_bound",
    }),
  ]);
  // The run itself states the closed code an operator reads; no document is
  // archived, so the run failed rather than claiming partial coverage.
  expect(result.mailbox.manifest.providerOutcome).toBe("failed");
  expect(result.mailbox.manifest.safeErrorCode).toBe("sbi_mailbox_rows_over_bound");
  // No row was walked: the pointer is not reported, so the worker leaves the
  // stored cursor where it was instead of skipping or restarting.
  expect(result.progress).toEqual([]);
  expect(result.runIds).toEqual(["synthetic-bound", "synthetic-bound-mailbox"]);
  expect(result.status).toBe("partial");
  expect(result.failureCode).toBeUndefined();
  // The financial terminal succeeded, so the collection's scheduled or
  // operation result stays completed with both runs; the refusal is read from
  // the mailbox run's own registration, not from a failed collection.
  expect(scheduledResult({ status: result.status, runIds: result.runIds })).toEqual({
    status: "completed",
    runIds: ["synthetic-bound", "synthetic-bound-mailbox"],
    failureCode: null,
  });
});
