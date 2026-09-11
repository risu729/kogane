// U09 (G1-01, G1-02, G3-07): the GLOBAL PASS shared-mode run, written to a real
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
import {
  GLOBALPASS_DATASET,
  GLOBALPASS_MEDIA_TYPE,
  GLOBALPASS_PAGINATION_STATUS,
  GLOBALPASS_SCHEMA_VERSION,
  type CollectionManifest,
} from "../src/model";
import { NABLARCH_HIDDEN_SENTINEL } from "../src/sanitize";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SANITIZED_HTML = `<!doctype html><html><body>ご利用明細<input type="hidden" name="nablarch_hidden" value="${NABLARCH_HIDDEN_SENTINEL}"></body></html>`;

function manifest(runId: string): CollectionManifest {
  return {
    schemaVersion: GLOBALPASS_SCHEMA_VERSION,
    source: "prestia-globalpass",
    runId,
    mode: "daily",
    startedAt: "2099-02-01T18:17:00.000Z",
    completedAt: "2099-02-01T18:18:00.000Z",
    status: "success",
    availableMonths: ["2099-02", "2099-01"],
    selectedMonths: ["2099-02", "2099-01"],
    captureComplete: true,
    paginationStatus: GLOBALPASS_PAGINATION_STATUS,
    artifacts: [
      {
        dataset: GLOBALPASS_DATASET,
        month: "2099-02",
        key: `raw/prestia-globalpass/2099/02/01/${runId}/activity-2099-02.html`,
        mediaType: GLOBALPASS_MEDIA_TYPE,
        bytes: SANITIZED_HTML.length,
        sha256: "a".repeat(64),
      },
    ],
    failures: [],
  };
}

function inputOf(runId: string) {
  const value = manifest(runId);
  return {
    manifest: value,
    manifestJson: JSON.stringify(value),
    captures: [{ month: "2099-02", sanitizedHtml: SANITIZED_HTML }],
    identity: { attemptId: `attempt-${runId}` },
  };
}

describe("GLOBAL PASS shared DATA bucket", () => {
  it("stores every object and the terminal last, and R2 can re-verify them", async () => {
    const bucket = dataBucket(env.DATA);
    const summary = await persistSharedRun(bucket, inputOf(RUN_ID));
    expect(summary.outcome).toBe("persisted");
    expect(summary.terminalKey).toBe(terminalKey("prestia-globalpass", RUN_ID));

    const read = await readTerminal(bucket, "prestia-globalpass", RUN_ID);
    expect(read.outcome).toBe("found");
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.coverageStatus).toBe("partial");
    expect(await verifyReferencedObjects(bucket, read.manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });

    for (const artifact of read.manifest.artifacts) {
      const object = await env.DATA.get(artifact.storageRef.key);
      expect(object).not.toBeNull();
      const text = await object!.text();
      expect(text).not.toContain("jsessionid");
      expect(text).not.toContain("private-state");
    }
  });

  it("treats the same run written twice as a resend", async () => {
    const bucket = dataBucket(env.DATA);
    const input = inputOf("22222222-2222-4222-8222-222222222222");
    const first = await persistSharedRun(bucket, input);
    const second = await persistSharedRun(bucket, input);
    expect(first.outcome).toBe("persisted");
    expect(second.outcome).toBe("already_persisted");
    expect(second.terminalDigest).toBe(first.terminalDigest);
  });
});
