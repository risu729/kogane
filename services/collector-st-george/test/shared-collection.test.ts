import { describe, expect, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/index";
import {
  artifactRequest,
  createRunRequest,
  hasProviderArtifact,
} from "../../../packages/application/src/collection/descriptors";
import {
  buildSharedRunPlan,
  persistSharedRun,
  type SharedRunInput,
} from "../src/shared-collection";
import { snapshot } from "./fixture";

function input(): SharedRunInput {
  return {
    runId: "00000000-0000-4000-8000-000000000000",
    attemptId: "attempt-synthetic",
    startedAt: "2026-09-12T07:59:00.000Z",
    completedAt: "2026-09-12T08:00:00.000Z",
    snapshot: snapshot(),
  };
}
describe("St.George shared evidence", () => {
  test("terminal-last evidence registers with partial coverage and explicit redacted lineage", async () => {
    const bucket = new FakeR2Bucket();
    const run = input();
    const result = await persistSharedRun(bucket, run);
    expect(result.outcome).toBe("persisted");
    expect(bucket.putKeys.at(-1)).toBe(result.terminalKey);
    const read = await readTerminal(bucket, "st-george", run.runId);
    if (read.outcome !== "found") throw new Error("terminal missing");
    expect(read.manifest.providerOutcome).toBe("success");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(hasProviderArtifact(read.manifest)).toBe(true);
    expect(createRunRequest(read.manifest)).toMatchObject({
      sourceId: "st-george",
      producerId: "collector-st-george",
    });
    const artifact = read.manifest.artifacts.find(
      (value) => value.artifactKey === "account-snapshot.json",
    )!;
    expect(artifactRequest(read.manifest, artifact, new Map())).toMatchObject({
      artifactRole: "sanitized_provider_capture",
      payloadFidelity: "transformed",
      lineageDisposition: "source_not_retained_for_security",
    });
    const manifestArtifact = read.manifest.artifacts.find(
      (value) => value.artifactKey === "manifest.json",
    )!;
    const manifestBody = await bucket.get(manifestArtifact.storageRef.key);
    const manifest = JSON.parse(new TextDecoder().decode(await manifestBody!.arrayBuffer()));
    expect(manifest.artifacts[0]).toMatchObject({
      dataset: "account-snapshot",
      key: "account-snapshot.json",
    });
    expect((await persistSharedRun(bucket, run)).outcome).toBe("already_persisted");
  });
  test("a failed authentication has no provider artifact and cannot seal as empty account data", async () => {
    const { snapshot: _snapshot, ...base } = input();
    const bucket = new FakeR2Bucket();
    await persistSharedRun(bucket, { ...base, reason: "authentication-challenge" });
    const read = await readTerminal(bucket, "st-george", base.runId);
    if (read.outcome !== "found") throw new Error("terminal missing");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(hasProviderArtifact(read.manifest)).toBe(false);
    expect(read.manifest.safeErrorCode).toBe("authentication-challenge");
  });
  test("rejects undeclared credential fields before preparing any persisted bytes", async () => {
    const run = input();
    const tainted = { ...run.snapshot!, cookie: "synthetic-secret" };
    await expect(buildSharedRunPlan({ ...run, snapshot: tainted })).rejects.toThrow(
      "invalid-st-george-snapshot",
    );
  });
});
