import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { persistSbiRun } from "../src/shared-run";
import { sha256Hex } from "../../../packages/collection/src/digest";
import { objectKey } from "../../../packages/collection/src/keys";
import type { Artifact } from "../src/types";
import { persistSbiAcquisition } from "../src/acquisition";
import type { SbiSharedRun } from "../src/shared-run";
import { terminalKey } from "../../../packages/collection/src/keys";
import { scheduledFailure } from "../../../packages/collection/src/schedule-result";
import type { R2BucketLike } from "../../../packages/collection/src/bucket";

it("keeps identical PDF bytes once while recording distinct document identities on a partial run", async () => {
  const bytes = new TextEncoder().encode("%PDF-native synthetic evidence");
  const hash = await sha256Hex(bytes);
  const artifacts: Artifact[] = ["a", "b"].map((letter) => ({
    artifactKey: `document-${"c".repeat(64)}-20990101-${letter.repeat(64)}-${hash}.pdf`,
    dataset: "delivered-document-pdf",
    role: "provider_document",
    mediaType: "application/pdf",
    unitKey: `mailbox-document-${letter.repeat(64)}`,
    bytes,
    body: null,
  }));
  const base = {
    producerVersion: "synthetic-mailbox-v1",
    attemptId: "synthetic-attempt",
    startedAt: "2099-01-02T00:00:00Z",
    completedAt: "2099-01-02T00:01:00Z",
    status: "partial" as const,
    scope: "domestic" as const,
    artifacts,
    failures: [{ scope: "mailbox" as const, code: "sbi_mailbox_document_unobserved" }],
    mailboxUnits: [
      ...artifacts.map((artifact) => ({
        unitKey: artifact.unitKey!,
        coverageStatus: "complete" as const,
      })),
      {
        unitKey: `mailbox-document-${"d".repeat(64)}`,
        coverageStatus: "partial" as const,
        safeErrorCode: "sbi_mailbox_document_unobserved" as const,
      },
    ],
  };
  const first = await persistSbiRun(env.DATA, { ...base, runId: "synthetic-mailbox-r2-first" });
  expect(first.outcome).toBe("persisted");
  if (first.outcome !== "persisted") throw new Error("synthetic_persistence_failed");
  expect(first.manifest.artifacts.map((artifact) => artifact.storageRef.key)).toEqual([
    objectKey(hash),
    objectKey(hash),
  ]);
  expect(first.objects.filter((object) => object.reused)).toHaveLength(1);
  expect(new Uint8Array(await (await env.DATA.get(objectKey(hash)))!.arrayBuffer())).toEqual(bytes);
  const second = await persistSbiRun(env.DATA, { ...base, runId: "synthetic-mailbox-r2-second" });
  expect(second.outcome).toBe("persisted");
  if (second.outcome !== "persisted") throw new Error("synthetic_persistence_failed");
  expect(second.objects.every((object) => object.reused)).toBe(true);
  const retry = await persistSbiRun(env.DATA, { ...base, runId: "synthetic-mailbox-r2-second" });
  expect(retry.outcome).toBe("already_persisted");
  expect(first.manifest.units.find((unit) => unit.unitKey === "domestic")?.coverageStatus).toBe(
    "complete",
  );
});

it("keeps every durable run reference when mailbox collection or cursor commit throws", async () => {
  for (const cursorFailure of [false, true]) {
    const runId = `synthetic-acquisition-${cursorFailure ? "cursor" : "mailbox"}`;
    const core: SbiSharedRun = {
      runId,
      producerVersion: "synthetic-v1",
      attemptId: `attempt-${runId}`,
      acquisitionSessionRef: runId,
      startedAt: "2020-01-02T00:00:00Z",
      completedAt: "2020-01-02T00:01:00Z",
      scope: "foreign",
      status: "success",
      artifacts: [],
      failures: [],
    };
    const ids: string[] = [];
    const result = await persistSbiAcquisition({
      bucket: env.DATA,
      core,
      signal: new AbortController().signal,
      onRunPersisted: (id) => ids.push(id),
      mailbox: async () => {
        expect(await env.DATA.head(terminalKey("sbi-securities", runId))).not.toBeNull();
        if (!cursorFailure) throw new Error("synthetic collection refusal");
        return {
          ...core,
          runId: `${runId}-mailbox`,
          mailboxUnits: [{ unitKey: "mailbox-index", coverageStatus: "complete" }],
        };
      },
      onMailboxPersisted: async () => {
        throw new Error("synthetic cursor refusal");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.runIds).toEqual(cursorFailure ? [runId, `${runId}-mailbox`] : [runId]);
    expect(ids).toEqual(result.runIds);
    expect(scheduledFailure(new Error("collection_lease_lost"), ids).runIds).toEqual(result.runIds);
  }
});

it("an aborted lease starts no mailbox and leaves its cursor untouched after core persistence", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  let committed = false;
  const core: SbiSharedRun = {
    runId: "synthetic-aborted-acquisition",
    producerVersion: "synthetic-v1",
    attemptId: "synthetic-attempt",
    acquisitionSessionRef: "synthetic-session",
    startedAt: "2020-01-02T00:00:00Z",
    completedAt: "2020-01-02T00:01:00Z",
    scope: "foreign",
    status: "success",
    artifacts: [],
    failures: [],
  };
  const result = await persistSbiAcquisition({
    bucket: env.DATA,
    core,
    signal: controller.signal,
    mailbox: async () => {
      started = true;
      return core;
    },
    onMailboxPersisted: async () => {
      committed = true;
    },
  });
  expect(result.runIds).toEqual([core.runId]);
  expect(result.status).toBe("failed");
  expect(started).toBe(false);
  expect(committed).toBe(false);
});

it("R2 persistence failures report only proven durable terminals and never advance the mailbox cursor", async () => {
  for (const failCore of [false, true]) {
    const runId = `synthetic-r2-failure-${failCore ? "core" : "mailbox"}`;
    const refusedKey = terminalKey("sbi-securities", failCore ? runId : `${runId}-mailbox`);
    const bucket: R2BucketLike = {
      head: (key) => env.DATA.head(key),
      get: (key) => env.DATA.get(key),
      list: (options) => env.DATA.list(options),
      createMultipartUpload: (key, options) => env.DATA.createMultipartUpload(key, options),
      put: async (key, value, options) => {
        if (key === refusedKey) throw new Error("synthetic write refusal");
        return env.DATA.put(key, value, options);
      },
    };
    let started = false;
    let committed = false;
    const core: SbiSharedRun = {
      runId,
      producerVersion: "synthetic-v1",
      attemptId: `attempt-${runId}`,
      acquisitionSessionRef: runId,
      startedAt: "2020-01-02T00:00:00Z",
      completedAt: "2020-01-02T00:01:00Z",
      scope: "foreign",
      status: "success",
      artifacts: [],
      failures: [],
    };
    const result = await persistSbiAcquisition({
      bucket,
      core,
      signal: new AbortController().signal,
      mailbox: async () => {
        started = true;
        return {
          ...core,
          runId: `${runId}-mailbox`,
          mailboxUnits: [{ unitKey: "mailbox-index", coverageStatus: "complete" }],
        };
      },
      onMailboxPersisted: async () => {
        committed = true;
      },
    });
    expect(result.runIds).toEqual(failCore ? [] : [runId]);
    expect(result.status).toBe("failed");
    expect(started).toBe(!failCore);
    expect(committed).toBe(false);
    expect(await env.DATA.head(refusedKey)).toBeNull();
  }
});

it("the aggregate preserves persistence-normalized partial financial coverage", async () => {
  const result = await persistSbiAcquisition({
    bucket: env.DATA,
    signal: new AbortController().signal,
    core: {
      runId: "synthetic-normalized-core",
      producerVersion: "synthetic-v1",
      attemptId: "synthetic-attempt",
      startedAt: "2020-01-02T00:00:00Z",
      completedAt: "2020-01-02T00:01:00Z",
      scope: "domestic",
      status: "success",
      artifacts: [
        {
          artifactKey: "account-assets-history-2099.json",
          dataset: "account-assets-history",
          mediaType: "application/json",
          body: {},
        },
      ],
      failures: [],
    },
  });
  expect(result.status).toBe("partial");
  if (result.core.outcome !== "persisted") throw new Error("synthetic_core_not_persisted");
  expect(result.core.manifest.providerOutcome).toBe("partial");
});
