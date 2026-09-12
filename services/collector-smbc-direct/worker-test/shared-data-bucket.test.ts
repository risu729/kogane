// U09 (G1-01, G1-02, G3-07): one finished SMBC Direct backfill run, re-read
// from a real Miniflare R2 staging bucket and written to a real Miniflare R2
// `DATA` bucket. The `test/` suite proves the decisions; this one proves they
// survive contact with workerd's R2.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import {
  dataBucket,
  manifestBytes,
  persistSharedRun,
  readStagedArtifacts,
} from "../src/shared-collection";
import { runPrefix, sha256Hex, storeBytes, storeJson } from "../src/storage";
import type { BackfillManifest, StoredArtifact } from "../src/types";

const RUN_ID = "44444444-4444-4444-8444-444444444444";
const STARTED_AT = "2026-09-01T00:00:00.000Z";
const PREFIX = runPrefix(STARTED_AT, RUN_ID);
const RANGE = { start: "2099-01-01", end: "2099-01-31" };

async function stage(): Promise<StoredArtifact[]> {
  const raw = await storeBytes({
    bucket: env.DATA,
    key: `${PREFIX}/transactions/20990101-20990131.raw.json.sjis`,
    bytes: new TextEncoder().encode('{"rows":[]}'),
    mediaType: "application/json; charset=Shift_JIS",
    artifact: { dataset: "transactions-raw", range: RANGE, transactionCount: 0 },
  });
  const normalized = await storeJson({
    bucket: env.DATA,
    key: `${PREFIX}/transactions/20990101-20990131.normalized.json`,
    value: { range: RANGE, transactions: [] },
    artifact: { dataset: "transactions-normalized", range: RANGE, transactionCount: 0 },
  });
  return [raw, normalized];
}

describe("SMBC Direct shared DATA bucket", () => {
  it("re-reads the staged run and finishes it with one terminal", async () => {
    const artifacts = await stage();
    const manifest: BackfillManifest = {
      schemaVersion: "smbc-direct-backfill-worker-poc-v1",
      source: "smbc-direct",
      runId: RUN_ID,
      startedAt: STARTED_AT,
      completedAt: "2026-09-01T00:10:00.000Z",
      status: "success",
      requestedRange: RANGE,
      completedChunks: 1,
      totalChunks: 1,
      transactionCount: 0,
      artifacts,
      failureCodes: [],
      logoutSucceeded: true,
    };

    const bytesByKey = await readStagedArtifacts(dataBucket(env.DATA), manifest);
    expect(bytesByKey.size).toBe(2);
    for (const artifact of artifacts) {
      expect(await sha256Hex(bytesByKey.get(artifact.key)!)).toBe(artifact.sha256);
    }

    const bucket = dataBucket(env.DATA);
    const summary = await persistSharedRun(bucket, {
      manifest,
      manifestBytes: manifestBytes(manifest),
      prefix: PREFIX,
      bytesByKey,
      identity: { attemptId: "attempt-0001", acquisitionSessionRef: "session-0001" },
    });
    expect(summary.outcome).toBe("persisted");
    expect(summary.terminalKey).toBe(terminalKey("smbc-direct", RUN_ID));
    expect(summary.waitingForHuman).toBe(false);

    const read = await readTerminal(bucket, "smbc-direct", RUN_ID);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.acquisitionSessionRef).toBe("session-0001");
    expect(read.manifest.requestedScope.scopeKind).toBe("date_range");
    expect(await verifyReferencedObjects(bucket, read.manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });

    for (const artifact of read.manifest.artifacts) {
      const object = await env.DATA.get(artifact.storageRef.key);
      expect(object).not.toBeNull();
      const text = await object!.text();
      expect(text).not.toContain("Cookie");
      expect(text).not.toContain("ciphertext");
    }
  });
});
