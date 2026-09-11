// `COLLECTION_TARGET=shared` against a real R2 binding (unified plan U09).
//
// Synthetic bytes only: no provider was contacted and no account number,
// balance, holding or credential appears here. What is checked is the
// contract — the objects are in the shared bucket before the terminal exists,
// each scope is its own unit with its own coverage, and a run that could not
// be finished leaves no terminal.
import { env } from "cloudflare:workers";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
  type R2BucketLike,
} from "../../../packages/collection/src/index";
import { persistSbiRun, safeFailureCode, type SbiSharedRun } from "../src/shared-run";
import type { Artifact } from "../src/types";

const PRODUCER_VERSION = "sbi-worker-poc-v1";

function artifact(dataset: string, body: unknown, window?: { from: string; to: string }): Artifact {
  return {
    dataset,
    mediaType: "application/json",
    body,
    ...(window ? { window } : {}),
  };
}

function run(overrides: Partial<SbiSharedRun> = {}): SbiSharedRun {
  const runId = overrides.runId ?? crypto.randomUUID();
  // The bodies carry the run id so each test writes its own objects: the
  // content-addressed store deduplicates identical bytes.
  return {
    runId,
    producerVersion: PRODUCER_VERSION,
    attemptId: `attempt-${runId}`,
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:05:00.000Z",
    status: "success",
    scope: "all",
    window: { from: "2026-06-14", to: "2026-09-11" },
    failures: [],
    artifacts: [
      artifact("domestic-cash-positions", { format: "synthetic", runId }),
      artifact(
        "domestic-trade-records",
        { dataset: "domestic-trade-records", rows: [], runId },
        { from: "2026-06-14", to: "2026-09-11" },
      ),
      artifact("foreign-cash-positions", { dataset: "foreign-cash-positions", rows: [], runId }),
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

async function digestOf(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("G1-02/G1-15 the SBI Securities run is written to the shared bucket, terminal last", () => {
  it("stores every artifact content-addressed under the scope it belongs to", async () => {
    const input = run();
    expect((await persistSbiRun(env.DATA, input)).outcome).toBe("persisted");

    const read = await readTerminal(env.DATA, "sbi-securities", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    const manifest = read.manifest;
    expect(manifest.source).toBe("sbi-securities");
    expect(manifest.producer).toBe("collector-sbi-securities");
    expect(manifest.producerVersion).toBe(PRODUCER_VERSION);
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("complete");
    expect(manifest.requestedScope).toEqual({
      scopeKind: "date_range",
      startValue: "2026-06-14",
      endValue: "2026-09-11",
      unitKeys: ["domestic", "foreign"],
    });
    expect(
      manifest.artifacts.map((entry) => [entry.artifactKey, entry.role, entry.unitKey]),
    ).toEqual([
      ["domestic-cash-positions.json", "collector_derived", "domestic"],
      ["domestic-trade-records.json", "collector_derived", "domestic"],
      ["foreign-cash-positions.json", "collector_derived", "foreign"],
    ]);
    expect(manifest.units).toEqual([
      { unitKey: "domestic", unitKind: "scope", artifactCount: 2, coverageStatus: "complete" },
      { unitKey: "foreign", unitKind: "scope", artifactCount: 1, coverageStatus: "complete" },
    ]);
    expect(manifest.ranges).toEqual([
      {
        rangeKey: "requested-window",
        rangeKind: "requested",
        precision: "date",
        basis: "request",
        startValue: "2026-06-14",
        endValue: "2026-09-11",
      },
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
    expect((await env.DATA.list({ prefix: `raw/sbi-securities/${input.runId}` })).objects).toEqual(
      [],
    );
  });

  it("states no window and a full snapshot when the trigger named none", async () => {
    const { window: _window, ...rest } = run();
    const input: SbiSharedRun = {
      ...rest,
      artifacts: [artifact("domestic-cash-positions", { format: "synthetic", runId: rest.runId })],
      scope: "domestic",
    };
    expect((await persistSbiRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "sbi-securities", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    expect(read.manifest.requestedScope).toEqual({
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: ["domestic"],
    });
    expect(read.manifest.ranges).toEqual([]);
    expect(read.manifest.units.map((unit) => unit.unitKey)).toEqual(["domestic"]);
  });
});

describe("G1-08/G1-09 a per-scope failure stays visible in the terminal", () => {
  it("keeps a partial run partial and marks only the scope that failed", async () => {
    const input = run({
      status: "partial",
      failures: [{ scope: "foreign", code: "provider_http_failed" }],
      artifacts: [artifact("domestic-cash-positions", { format: "synthetic" })],
    });
    expect((await persistSbiRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "sbi-securities", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    expect(read.manifest.providerOutcome).toBe("partial");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(read.manifest.safeErrorCode).toBe("provider_http_failed");
    expect(read.manifest.units).toEqual([
      { unitKey: "domestic", unitKind: "scope", artifactCount: 1, coverageStatus: "complete" },
      {
        unitKey: "foreign",
        unitKind: "scope",
        artifactCount: 0,
        coverageStatus: "unknown",
        safeErrorCode: "provider_http_failed",
      },
    ]);
  });

  it("keeps a failed run with no artifact a failure, not an observation of zero", async () => {
    const input = run({
      status: "failed",
      artifacts: [],
      failures: [
        { scope: "domestic", code: "authentication_required" },
        { scope: "foreign", code: "authentication_required" },
      ],
    });
    expect((await persistSbiRun(env.DATA, input)).outcome).toBe("persisted");
    const read = await readTerminal(env.DATA, "sbi-securities", input.runId);
    if (read.outcome !== "found") throw new Error("terminal_missing");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("authentication_required");
    expect(read.manifest.artifacts).toEqual([]);
    expect(read.manifest.units.every((unit) => unit.coverageStatus === "unknown")).toBe(true);
  });

  it("reduces an exception to a machine code and never to provider text", () => {
    const secret = "session-id-and-account-number";
    expect(safeFailureCode(new Error(secret))).toBe("operation_failed");
    expect(safeFailureCode(Object.assign(new Error(secret), { httpStatus: 503 }))).toBe(
      "provider_http_failed",
    );
    expect(safeFailureCode(new Error("Missing Worker secret: SBI_CREDENTIAL_JSON"))).toBe(
      "credential_configuration_required",
    );
    expect(JSON.stringify(safeFailureCode(new Error(secret)))).not.toContain(secret);
  });
});

describe("G1-01 a failed object write writes no terminal", () => {
  it("reports incomplete with a resumable checkpoint and leaves the terminal absent", async () => {
    const input = run();
    const failing = objectKey(await digestOf(input.artifacts[2]!.body));
    const result = await persistSbiRun(bucketFailingOn(failing), input);
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") return;
    expect(result.failedArtifactKey).toBe("foreign-cash-positions.json");
    expect(result.checkpoint.pendingArtifactKeys).toContain("foreign-cash-positions.json");
    expect(await env.DATA.head(terminalKey("sbi-securities", input.runId))).toBeNull();
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
