// `COLLECTION_TARGET=shared` against a real R2 binding (unified plan U09).
//
// The bytes are synthetic: no provider was contacted, no account, name,
// balance or token appears here. What is checked is the contract — every
// object is in the shared bucket before the terminal exists, the terminal says
// what the run actually was, and a run that could not be finished leaves no
// terminal at all.
import { env } from "cloudflare:workers";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
  type R2BucketLike,
} from "../../../packages/collection/src/index";
import {
  emailSessionRef,
  persistVPointPayEmailRun,
  persistVPointRun,
  vPointPayEmailRunPlan,
  type VPointSharedRun,
} from "../src/shared-run";
import { parseVPointPayEmail, prepareVPointPayEmail } from "../src/vpoint-pay-email";
import type { RawArtifact } from "../src/types";

const PRODUCER_VERSION = "vpoint-worker-poc-v2";

function artifact(dataset: string, body: unknown): RawArtifact {
  return {
    dataset,
    filename: `${dataset}.json`,
    mediaType: "application/json",
    body: JSON.stringify(body),
  };
}

function run(overrides: Partial<VPointSharedRun> = {}): VPointSharedRun {
  const runId = overrides.runId ?? crypto.randomUUID();
  // The bodies carry the run id so each test writes its own objects: the
  // content-addressed store deduplicates identical bytes, which would
  // otherwise make a later test reuse an earlier test's object.
  return {
    runId,
    producerVersion: PRODUCER_VERSION,
    attemptId: `attempt-${runId}`,
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:01:00.000Z",
    status: "success",
    failureCodes: [],
    artifacts: [
      artifact("balance-info", { status: { code: "0000" }, results: { point: 0, runId } }),
      artifact("history-page-0001", {
        status: { code: "0000" },
        results: { history: [], runId },
      }),
      artifact("collection-summary", {
        schemaVersion: "vpoint-collection-summary-v2",
        historyTotal: 0,
        runId,
      }),
    ],
    ...overrides,
  };
}

function notification(text: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: V Point Pay <info@prepaid.smbc-card.com>",
      "To: vpointpay@takuk.me",
      `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode("【VポイントPay】ご利用のお知らせ")))}?=`,
      "Date: Sun, 31 Aug 2026 12:00:00 +0900",
      "Message-ID: <synthetic@example.invalid>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
    ].join("\r\n"),
  );
}

async function prepareNotification() {
  const parsed = await parseVPointPayEmail(notification("◇利用金額：1円"));
  if (!parsed) throw new Error("fixture_not_parsed");
  return await prepareVPointPayEmail({
    parsed,
    envelopeFrom: "info@prepaid.smbc-card.com",
    envelopeTo: "vpointpay@takuk.me",
    expectedRecipient: "vpointpay@takuk.me",
  });
}

/** `env.DATA` with one object key that refuses to be written. */
function bucketFailingOn(key: string): R2BucketLike {
  const data = env.DATA as unknown as R2BucketLike;
  return {
    head: (target) => data.head(target),
    get: (target) => data.get(target),
    put: async (target, value, options) => {
      if (target === key) throw new Error("synthetic_put_failure");
      return await data.put(target, value, options);
    },
    list: (options) => data.list(options),
    createMultipartUpload: (target, options) => data.createMultipartUpload(target, options),
  };
}

describe("G1-02/G1-15 the V Point run is written to the shared bucket, terminal last", () => {
  it("stores every artifact content-addressed and states them in the terminal", async () => {
    const input = run();
    const result = await persistVPointRun(env.DATA, input);
    expect(result.outcome).toBe("persisted");

    const read = await readTerminal(env.DATA, "v-point", input.runId);
    expect(read.outcome).toBe("found");
    if (read.outcome !== "found") return;
    const manifest = read.manifest;
    expect(manifest.source).toBe("v-point");
    expect(manifest.producer).toBe("collector-vpoint");
    expect(manifest.producerVersion).toBe(PRODUCER_VERSION);
    expect(manifest.attemptId).toBe(input.attemptId);
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("complete");
    expect(manifest.persistenceComplete).toBe(true);
    expect(manifest.safeErrorCode).toBeUndefined();
    expect(manifest.requestedScope).toEqual({
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: ["account"],
    });
    expect(manifest.units).toEqual([
      {
        unitKey: "account",
        unitKind: "collection",
        artifactCount: 3,
        coverageStatus: "complete",
      },
    ]);
    expect(manifest.artifacts.map((entry) => [entry.artifactKey, entry.role])).toEqual([
      ["balance-info.json", "collector_derived"],
      ["collection-summary.json", "collector_summary"],
      ["history-page-0001.json", "collector_derived"],
    ]);

    // Every reference resolves to bytes that are really in the bucket.
    expect(await verifyReferencedObjects(env.DATA, manifest, { streamHash: true })).toMatchObject({
      outcome: "ok",
      checked: 3,
      problems: [],
    });
    for (const entry of manifest.artifacts) {
      expect(entry.storageRef).toEqual({ store: "DATA", key: objectKey(entry.sha256) });
      const stored = await env.DATA.get(entry.storageRef.key);
      expect(stored).not.toBeNull();
      expect((await stored!.arrayBuffer()).byteLength).toBe(entry.byteSize);
    }
    // Nothing was written under the legacy per-source layout (G1-15).
    expect((await env.DATA.list({ prefix: `raw/v-point/${input.runId}` })).objects).toEqual([]);
  });

  it("is idempotent for the same run and never overwrites a different one", async () => {
    const input = run();
    const first = await persistVPointRun(env.DATA, input);
    const again = await persistVPointRun(env.DATA, input);
    expect(again.outcome).toBe("already_persisted");
    expect(again.terminalDigest).toBe(first.terminalDigest);

    const changed = await persistVPointRun(env.DATA, {
      ...input,
      artifacts: [artifact("balance-info", { status: { code: "0000" }, results: { point: 1 } })],
    });
    expect(changed.outcome).toBe("conflict");
    const read = await readTerminal(env.DATA, "v-point", input.runId);
    expect(read.outcome === "found" && read.terminalDigest).toBe(first.terminalDigest);
  });
});

describe("G1-08/G1-09 an incomplete acquisition stays incomplete", () => {
  it("keeps a partial run partial with a safe code", async () => {
    const input = run({
      status: "partial",
      failureCodes: ["provider_http_failed"],
    });
    expect((await persistVPointRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "v-point", input.runId);
    expect(read.outcome === "found" && read.manifest.providerOutcome).toBe("partial");
    expect(read.outcome === "found" && read.manifest.coverageStatus).toBe("partial");
    expect(read.outcome === "found" && read.manifest.safeErrorCode).toBe("provider_http_failed");
  });

  it("keeps a failed run with no artifact a failure, not an observation of zero", async () => {
    const input = run({
      status: "failed",
      failureCodes: ["authentication_required"],
      artifacts: [],
    });
    expect((await persistVPointRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "v-point", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("authentication_required");
    expect(read.manifest.artifacts).toEqual([]);
    expect(read.manifest.units[0]?.artifactCount).toBe(0);
  });

  it("falls back to a machine code when the run reports none", async () => {
    const input = run({ status: "failed", failureCodes: [""], artifacts: [] });
    expect((await persistVPointRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "v-point", input.runId);
    expect(read.outcome === "found" && read.manifest.safeErrorCode).toBe("collector_failed");
  });
});

describe("G1-01 a failed object write writes no terminal", () => {
  it("reports incomplete with a resumable checkpoint and leaves the terminal absent", async () => {
    const input = run();
    const summary = input.artifacts[2]!;
    const bytes = new TextEncoder().encode(summary.body);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const result = await persistVPointRun(bucketFailingOn(objectKey(digest)), input);
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") return;
    expect(result.failedArtifactKey).toBe("collection-summary.json");
    expect(result.checkpoint.pendingArtifactKeys).toContain("collection-summary.json");
    expect(await env.DATA.head(terminalKey("v-point", input.runId))).toBeNull();
    expect((await readTerminal(env.DATA, "v-point", input.runId)).outcome).toBe("missing");
  });
});

describe("G1-16 one delivered mail, two sources, one session", () => {
  it("persists the notification pair as its own run derived from the message", async () => {
    const prepared = await prepareNotification();
    const result = await persistVPointPayEmailRun(env.DATA, prepared, PRODUCER_VERSION);
    expect(result.outcome).toBe("persisted");

    const read = await readTerminal(env.DATA, "v-point-pay-email", prepared.event.id);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    const manifest = read.manifest;
    expect(manifest.source).toBe("v-point-pay-email");
    expect(manifest.runId).toBe(prepared.event.id);
    expect(manifest.providerOutcome).toBe("success");
    expect(
      manifest.artifacts.map((entry) => [entry.artifactKey, entry.role, entry.mediaType]),
    ).toEqual([
      ["normalized-event.json", "collector_derived", "application/json"],
      ["notification.eml", "user_capture", "message/rfc822"],
    ]);
    expect(manifest.units).toEqual([
      {
        unitKey: "notification",
        unitKind: "message",
        artifactCount: 2,
        coverageStatus: "complete",
      },
    ]);
    expect(manifest.transformations).toEqual([
      {
        transformationId: "normalized-event",
        stepKind: "extracted",
        transformerId: "vpoint-pay-email-parser",
        transformerVersion: "vpoint-pay-email-event-v2",
        inputArtifactKeys: ["notification.eml"],
        outputArtifactKey: "normalized-event.json",
      },
    ]);
    expect(await verifyReferencedObjects(env.DATA, manifest, { streamHash: true })).toMatchObject({
      outcome: "ok",
      checked: 2,
      problems: [],
    });

    // The message bytes are kept exactly as they arrived.
    const eml = manifest.artifacts.find((entry) => entry.artifactKey === "notification.eml")!;
    const stored = await env.DATA.get(eml.storageRef.key);
    expect(new Uint8Array((await stored!.arrayBuffer()) as ArrayBuffer)).toEqual(prepared.raw);
  });

  it("answers a redelivery of the same message as a resend", async () => {
    const prepared = await prepareNotification();
    await persistVPointPayEmailRun(env.DATA, prepared, PRODUCER_VERSION);
    const again = await persistVPointPayEmailRun(
      env.DATA,
      await prepareNotification(),
      PRODUCER_VERSION,
    );
    expect(again.outcome).toBe("already_persisted");
  });

  it("gives the V Point run of the same mail the same acquisition session ref", async () => {
    const prepared = await prepareNotification();
    const plan = await vPointPayEmailRunPlan(prepared, PRODUCER_VERSION);
    const sessionRef = emailSessionRef(prepared.outerMessageSha256);
    expect(plan.run.acquisitionSessionRef).toBe(sessionRef);

    const input = run({ acquisitionSessionRef: sessionRef });
    await persistVPointRun(env.DATA, input);
    const ledger = await readTerminal(env.DATA, "v-point", input.runId);
    expect(ledger.outcome === "found" && ledger.manifest.acquisitionSessionRef).toBe(sessionRef);
    // Same session, still two runs of two sources.
    expect(ledger.outcome === "found" && ledger.manifest.source).toBe("v-point");
    expect(plan.run.source).toBe("v-point-pay-email");
    expect(plan.run.runId).not.toBe(input.runId);
  });
});

describe("R2BucketLike is what packages/collection claims it is", () => {
  it("accepts the Workers R2Bucket binding without a cast", () => {
    // Checked by `tsc --noEmit` over this suite: the deployed `DATA` binding
    // type must be assignable to the contract's minimal interface.
    expectTypeOf<R2Bucket>().toExtend<R2BucketLike>();
    expectTypeOf(env.DATA).toExtend<R2BucketLike>();
  });
});
