// U09 (G1-01, G1-02, G3-07): the SBI Shinsei shared-mode run, written to a real
// Miniflare R2 `DATA` bucket. The `test/` suite proves the decisions; this one
// proves they survive contact with workerd's R2: create-only puts, native
// checksums, and the terminal arriving last.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import { dataBucket, persistSharedRun } from "../src/shared-collection";
import type { CollectionManifest, RawArtifact } from "../src/types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_BODY = JSON.stringify({
  header: { adapterResultCode: "0", newToken: "synthetic-next-csrf-token" },
  responseParam: { totalCreditBalance: "300000" },
});

const ARTIFACTS: RawArtifact[] = [
  {
    dataset: "top-accounts-balance-and-activity",
    filename: "raw-top-accounts-balance-and-activity.json",
    mediaType: "application/json",
    body: PROVIDER_BODY,
  },
];

function manifest(overrides: Partial<CollectionManifest> = {}): CollectionManifest {
  return {
    schemaVersion: "sbi-shinsei-worker-poc-v1",
    source: "sbi-shinsei",
    runId: RUN_ID,
    startedAt: "2026-08-31T21:00:00.000Z",
    completedAt: "2026-08-31T21:01:00.000Z",
    status: "success",
    liveReadsEnabled: true,
    artifacts: [],
    failures: [],
    ...overrides,
  };
}

describe("SBI Shinsei shared DATA bucket", () => {
  it("stores every object and the terminal last, and R2 can re-verify them", async () => {
    const bucket = dataBucket(env.DATA);
    const summary = await persistSharedRun(bucket, {
      manifest: manifest(),
      artifacts: ARTIFACTS,
      identity: { attemptId: "attempt-0001", operationId: "op-0001" },
    });
    expect(summary.outcome).toBe("persisted");
    expect(summary.terminalKey).toBe(terminalKey("sbi-shinsei", RUN_ID));

    const read = await readTerminal(bucket, "sbi-shinsei", RUN_ID);
    expect(read.outcome).toBe("found");
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.operationId).toBe("op-0001");
    expect(await verifyReferencedObjects(bucket, read.manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });

    for (const artifact of read.manifest.artifacts) {
      const object = await env.DATA.get(artifact.storageRef.key);
      expect(object).not.toBeNull();
      const text = await object!.text();
      expect(text).not.toContain("newToken");
      expect(text).not.toContain("synthetic-next-csrf-token");
    }
  });

  it("treats the same run written twice as a resend", async () => {
    const bucket = dataBucket(env.DATA);
    const input = {
      manifest: manifest({ runId: "22222222-2222-4222-8222-222222222222" }),
      artifacts: ARTIFACTS,
      identity: { attemptId: "attempt-0002" },
    };
    const first = await persistSharedRun(bucket, input);
    const second = await persistSharedRun(bucket, input);
    expect(first.outcome).toBe("persisted");
    expect(second.outcome).toBe("already_persisted");
    expect(second.terminalDigest).toBe(first.terminalDigest);
  });
});
