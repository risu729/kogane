import { expect, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { persistSbiAcquisition } from "../src/acquisition";
import { collectMailbox, MAILBOX_INDEX_UNIT, type MailboxUnit } from "../src/mailbox";
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
    onProgress: () => {},
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
  return persistSbiAcquisition({
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
}

test("the longest accepted current list fits one mailbox terminal", async () => {
  const result = await acquire(999);
  expect(result.mailbox?.outcome).toBe("persisted");
  if (result.mailbox?.outcome !== "persisted") throw new Error("synthetic_persistence_failed");
  expect(result.mailbox.manifest.units).toHaveLength(1000);
  expect(result.runIds).toEqual(["synthetic-bound", "synthetic-bound-mailbox"]);
  expect(result.status).toBe("success");
});

test("a list one row past the terminal's unit capacity is a persisted refusal, not an unplannable terminal", async () => {
  // 1,000 rows plus the index unit would need 1,001 units; before the bound
  // was tied to that capacity the mailbox terminal could not be planned, so
  // nothing was archived, the cursor never moved and the code was generic.
  const result = await acquire(1000);
  expect(result.mailbox?.outcome).toBe("persisted");
  if (result.mailbox?.outcome !== "persisted") throw new Error("synthetic_persistence_failed");
  expect(result.mailbox.manifest.units).toEqual([
    expect.objectContaining({
      unitKey: MAILBOX_INDEX_UNIT,
      coverageStatus: "partial",
      safeErrorCode: "sbi_mailbox_response_unobserved",
    }),
  ]);
  expect(result.runIds).toEqual(["synthetic-bound", "synthetic-bound-mailbox"]);
  expect(result.status).toBe("partial");
  expect(result.failureCode).toBeUndefined();
});
