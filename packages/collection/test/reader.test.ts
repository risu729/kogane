import { describe, expect, test } from "bun:test";
import { objectKey, terminalKey } from "../src/keys";
import {
  listTerminals,
  readTerminal,
  readTerminalPage,
  verifyReferencedObjects,
} from "../src/reader";
import { persistRun, planManifest } from "../src/writer";
import { bytesOf, FakeR2Bucket } from "./fake-bucket";
import { SYNTHETIC_SOURCE, syntheticArtifact, syntheticPlan } from "./plan-fixtures";

async function persist(bucket: FakeR2Bucket, runId: string): Promise<void> {
  const result = await persistRun(
    bucket,
    await syntheticPlan({
      run: { runId },
      artifacts: [await syntheticArtifact("balance.json", `{"run":"${runId}"}`)],
    }),
  );
  expect(result.outcome).toBe("persisted");
}

describe("terminal scan", () => {
  // G1-12: a run whose terminal is confirmed after a newer run's terminal
  // still has to be found. The scan walks the whole prefix, so an older run id
  // written later is returned like any other.
  test("G1-12 a late terminal for an older run is still found by the bounded scan", async () => {
    const bucket = new FakeR2Bucket();
    await persist(bucket, "2026-09-02T00-00-00-000Z");
    const newestSeen = terminalKey(SYNTHETIC_SOURCE, "2026-09-02T00-00-00-000Z");
    // The older run finishes afterwards and sorts before the key a
    // lexicographic watermark would have stopped at.
    await persist(bucket, "2026-09-01T00-00-00-000Z");

    const page = await listTerminals(bucket, { source: SYNTHETIC_SOURCE });
    expect(page.terminals.map((ref) => ref.runId)).toEqual([
      "2026-09-01T00-00-00-000Z",
      "2026-09-02T00-00-00-000Z",
    ]);
    expect(page.truncated).toBe(false);
    expect(page.cursor).toBeNull();
    // A watermark scan keyed on the newest key already seen would miss it.
    const missedByWatermark = page.terminals.filter((ref) => ref.key > newestSeen);
    expect(missedByWatermark).toHaveLength(0);
    expect(page.terminals.some((ref) => ref.key < newestSeen)).toBe(true);
  });

  test("the scan is paged by cursor and covers every source when none is named", async () => {
    const bucket = new FakeR2Bucket();
    for (const runId of ["run-a", "run-b", "run-c"]) await persist(bucket, runId);
    const first = await listTerminals(bucket, { limit: 2 });
    expect(first.truncated).toBe(true);
    expect(first.cursor).not.toBeNull();
    const seen = [...first.terminals.map((ref) => ref.runId)];
    let cursor = first.cursor;
    let pages = 1;
    while (cursor !== null && pages < 10) {
      const next = await listTerminals(bucket, { limit: 2, cursor });
      seen.push(...next.terminals.map((ref) => ref.runId));
      cursor = next.cursor;
      pages += 1;
    }
    expect(seen.sort()).toEqual(["run-a", "run-b", "run-c"]);
    // Content objects live outside `runs/`, so the scan never lists them.
    expect(first.skipped).toBe(0);
  });

  // G1-13: one corrupt terminal blocks its own run and nothing else.
  test("G1-13 a corrupt terminal is reported blocked and the scan continues", async () => {
    const bucket = new FakeR2Bucket();
    await persist(bucket, "run-a");
    await persist(bucket, "run-c");
    await bucket.seed(
      terminalKey(SYNTHETIC_SOURCE, "run-b"),
      bytesOf('{"manifestVersion":"terminal-v1"}'),
      {
        contentType: "application/json",
      },
    );

    const page = await readTerminalPage(bucket, { source: SYNTHETIC_SOURCE });
    expect(page.entries.map((entry) => [entry.ref.runId, entry.result.outcome])).toEqual([
      ["run-a", "found"],
      ["run-b", "blocked"],
      ["run-c", "found"],
    ]);
    expect(page.blocked.map((ref) => ref.runId)).toEqual(["run-b"]);
    const blocked = page.entries[1]!.result;
    expect(blocked.outcome).toBe("blocked");
    if (blocked.outcome !== "blocked") throw new Error("unreachable");
    expect(blocked.reasonCode).toBe("invalid_persistence_complete");
  });

  test("a terminal stored under the wrong run key is blocked, not trusted", async () => {
    const bucket = new FakeR2Bucket();
    await persist(bucket, "run-a");
    const stored = await bucket.get(terminalKey(SYNTHETIC_SOURCE, "run-a"));
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    await bucket.seed(terminalKey(SYNTHETIC_SOURCE, "run-elsewhere"), bytes, {
      contentType: "application/json",
    });
    const read = await readTerminal(bucket, SYNTHETIC_SOURCE, "run-elsewhere");
    expect(read.outcome).toBe("blocked");
    if (read.outcome !== "blocked") throw new Error("unreachable");
    expect(read.reasonCode).toBe("terminal_identity_mismatch");
  });

  test("a missing run reads as missing rather than throwing", async () => {
    const bucket = new FakeR2Bucket();
    expect(await readTerminal(bucket, SYNTHETIC_SOURCE, "never-ran")).toEqual({
      outcome: "missing",
      key: terminalKey(SYNTHETIC_SOURCE, "never-ran"),
    });
  });
});

describe("verifyReferencedObjects", () => {
  test("reports each referenced object that is missing or does not match", async () => {
    const bucket = new FakeR2Bucket();
    const present = await syntheticArtifact("present.json", '{"a":1}');
    const removed = await syntheticArtifact("removed.json", '{"b":2}');
    const plan = await syntheticPlan({ artifacts: [present, removed] });
    expect((await persistRun(bucket, plan)).outcome).toBe("persisted");

    bucket.entries.delete(objectKey(removed.sha256));
    const manifest = planManifest(plan);
    const result = await verifyReferencedObjects(bucket, manifest);
    expect(result.outcome).toBe("blocked");
    expect(result.checked).toBe(2);
    expect(result.problems).toEqual([
      {
        artifactKey: "removed.json",
        key: objectKey(removed.sha256),
        reasonCode: "object_missing",
        expectedSha256: removed.sha256,
        expectedByteSize: removed.byteSize,
        observedByteSize: null,
      },
    ]);
  });

  test("falls back to streaming the body when metadata cannot prove the digest", async () => {
    const bucket = new FakeR2Bucket();
    const artifact = await syntheticArtifact("opaque.json", '{"a":1}');
    const plan = await syntheticPlan({ artifacts: [artifact] });
    const manifest = planManifest(plan);
    // An object stored without the digest metadata and without a native
    // checksum, as a multipart write from an older writer would be.
    bucket.entries.set(objectKey(artifact.sha256), {
      bytes: bytesOf('{"a":1}'),
      etag: "etag-seed",
      uploaded: new Date(1_700_000_000_000),
      contentType: "application/octet-stream",
      customMetadata: undefined,
      nativeSha256: null,
    });

    const withoutStreaming = await verifyReferencedObjects(bucket, manifest);
    expect(withoutStreaming.problems[0]?.reasonCode).toBe("object_digest_unverifiable");
    const withStreaming = await verifyReferencedObjects(bucket, manifest, { streamHash: true });
    expect(withStreaming).toEqual({ outcome: "ok", checked: 1, problems: [] });
  });
});
