// `COLLECTION_TARGET=shared` against a real R2 binding (unified plan U09).
//
// Synthetic bytes only: no provider was contacted and no account, balance,
// token or device id appears here. What is checked is the contract — the
// objects are in the shared bucket before the terminal exists, the terminal
// states the month window the run asked for, and a run that could not be
// finished leaves no terminal.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
  type R2BucketLike,
} from "../../../packages/collection/src/index";
import { persistVPointPayRun, type VPointPaySharedRun } from "../src/shared-run";
import type { RawArtifact } from "../src/types";

const PRODUCER_VERSION = "vpoint-pay-worker-poc-v1";

function artifact(dataset: string, body: unknown): RawArtifact {
  return {
    dataset,
    filename: `${dataset}.json`,
    mediaType: "application/json",
    body: JSON.stringify(body),
  };
}

function run(overrides: Partial<VPointPaySharedRun> = {}): VPointPaySharedRun {
  const runId = overrides.runId ?? crypto.randomUUID();
  // The bodies carry the run id so each test writes its own objects: the
  // content-addressed store deduplicates identical bytes.
  return {
    runId,
    producerVersion: PRODUCER_VERSION,
    attemptId: `attempt-${runId}`,
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:02:00.000Z",
    status: "success",
    earliestMonth: "202607",
    latestMonth: "202609",
    failureCodes: [],
    artifacts: [
      artifact("balance", { balance: 0, inquiry_period: "202607", runId }),
      artifact("transactions-202607", { tran_list: [], runId }),
      artifact("collection-summary", {
        schemaVersion: "vpoint-pay-collection-summary-v1",
        transactionCount: 0,
        runId,
      }),
    ],
    ...overrides,
  };
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

async function digestOf(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("G1-02/G1-15 the V Point Pay run is written to the shared bucket, terminal last", () => {
  it("stores the artifacts content-addressed and states the month window", async () => {
    const input = run();
    expect((await persistVPointPayRun(env.DATA, input)).outcome).toBe("persisted");

    const read = await readTerminal(env.DATA, "v-point-pay", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    const manifest = read.manifest;
    expect(manifest.source).toBe("v-point-pay");
    expect(manifest.producer).toBe("collector-vpoint-pay");
    expect(manifest.producerVersion).toBe(PRODUCER_VERSION);
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("complete");
    expect(manifest.requestedScope).toEqual({
      scopeKind: "month_range",
      startValue: "202607",
      endValue: "202609",
      unitKeys: ["account"],
    });
    expect(manifest.ranges).toEqual([
      {
        rangeKey: "requested-months",
        rangeKind: "requested",
        precision: "month",
        basis: "source",
        startValue: "202607",
        endValue: "202609",
        unitKey: "account",
      },
    ]);
    expect(manifest.artifacts.map((entry) => [entry.artifactKey, entry.role])).toEqual([
      ["balance.json", "collector_derived"],
      ["collection-summary.json", "collector_summary"],
      ["transactions-202607.json", "collector_derived"],
    ]);
    expect(manifest.units).toEqual([
      { unitKey: "account", unitKind: "collection", artifactCount: 3, coverageStatus: "complete" },
    ]);
    expect(await verifyReferencedObjects(env.DATA, manifest, { streamHash: true })).toMatchObject({
      outcome: "ok",
      checked: 3,
      problems: [],
    });
    for (const entry of manifest.artifacts) {
      expect(entry.storageRef).toEqual({ store: "DATA", key: objectKey(entry.sha256) });
    }
    // Nothing was written under the legacy per-source layout (G1-15).
    expect((await env.DATA.list({ prefix: `raw/v-point-pay/${input.runId}` })).objects).toEqual([]);
  });

  it("answers the same run twice as a resend and a changed one as a conflict", async () => {
    const input = run();
    const first = await persistVPointPayRun(env.DATA, input);
    expect((await persistVPointPayRun(env.DATA, input)).outcome).toBe("already_persisted");
    const changed = await persistVPointPayRun(env.DATA, { ...input, latestMonth: "202610" });
    expect(changed.outcome).toBe("conflict");
    const read = await readTerminal(env.DATA, "v-point-pay", input.runId);
    expect(read.outcome === "found" && read.terminalDigest).toBe(first.terminalDigest);
  });
});

describe("G1-08/G1-09 an incomplete acquisition stays incomplete", () => {
  it("keeps a partial run partial with a safe code", async () => {
    const input = run({ status: "partial", failureCodes: ["provider_http_failed"] });
    expect((await persistVPointPayRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "v-point-pay", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(read.manifest.safeErrorCode).toBe("provider_http_failed");
  });

  it("keeps a failed run with no artifact a failure and states no month window", async () => {
    const input = run({
      status: "failed",
      failureCodes: ["credential_configuration_required"],
      artifacts: [],
      earliestMonth: null,
      latestMonth: null,
    });
    expect((await persistVPointPayRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "v-point-pay", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("credential_configuration_required");
    expect(read.manifest.artifacts).toEqual([]);
    expect(read.manifest.ranges).toEqual([]);
    expect(read.manifest.requestedScope.scopeKind).toBe("unspecified");
  });
});

describe("G1-01 a failed object write writes no terminal", () => {
  it("reports incomplete with a resumable checkpoint and leaves the terminal absent", async () => {
    const input = run();
    const failing = objectKey(await digestOf(input.artifacts[1]!.body));
    const result = await persistVPointPayRun(bucketFailingOn(failing), input);
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") return;
    expect(result.failedArtifactKey).toBe("transactions-202607.json");
    expect(result.checkpoint.pendingArtifactKeys).toContain("transactions-202607.json");
    expect(await env.DATA.head(terminalKey("v-point-pay", input.runId))).toBeNull();
  });
});
