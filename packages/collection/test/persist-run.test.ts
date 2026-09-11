import { describe, expect, test } from "bun:test";
import { objectKey, terminalKey } from "../src/keys";
import { readTerminal, verifyReferencedObjects } from "../src/reader";
import { encodeTerminal, terminalDigest } from "../src/digest";
import { persistRun, planManifest } from "../src/writer";
import { bytesOf, FakeR2Bucket, fakeSha256Hex } from "./fake-bucket";
import { SYNTHETIC_SOURCE, syntheticArtifact, syntheticPlan } from "./plan-fixtures";

describe("persistRun writes the terminal last", () => {
  // G1-02: every object is stored and verified, then the terminal is created,
  // and what it references is exactly what is in the bucket.
  test("G1-02 the terminal is created after every put and matches the stored objects", async () => {
    const bucket = new FakeR2Bucket();
    const plan = await syntheticPlan();
    const result = await persistRun(bucket, plan);

    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") throw new Error("unreachable");
    const key = terminalKey(SYNTHETIC_SOURCE, "run-001");
    expect(result.terminalKey).toBe(key);
    // The terminal is the last key written, after both objects.
    expect(bucket.putKeys.at(-1)).toBe(key);
    expect(bucket.putKeys).toHaveLength(3);
    expect(result.objects.every((entry) => !entry.reused)).toBe(true);

    const read = await readTerminal(bucket, SYNTHETIC_SOURCE, "run-001");
    expect(read.outcome).toBe("found");
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.terminalDigest).toBe(result.terminalDigest);
    const verified = await verifyReferencedObjects(bucket, read.manifest);
    expect(verified).toEqual({ outcome: "ok", checked: 2, problems: [] });
    for (const artifact of read.manifest.artifacts) {
      const stored = await bucket.head(artifact.storageRef.key);
      expect(stored?.size).toBe(artifact.byteSize);
      expect(stored?.customMetadata?.sha256).toBe(artifact.sha256);
    }
  });

  // G1-01: the run stops at a failed put. No terminal exists, so nothing
  // downstream may call the run persisted.
  test("G1-01 a failed last put leaves no terminal and returns a resumable checkpoint", async () => {
    const first = await syntheticArtifact("a.json", '{"a":1}');
    const second = await syntheticArtifact("b.json", '{"b":2}');
    const bucket = new FakeR2Bucket({ failPut: new Set([objectKey(second.sha256)]) });
    const plan = await syntheticPlan({ artifacts: [first, second] });

    const result = await persistRun(bucket, plan);
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") throw new Error("unreachable");
    expect(result.failedArtifactKey).toBe("b.json");
    expect(result.reasonCode).toBe("object_put_failed");
    expect(result.checkpoint.persistedArtifactKeys).toEqual(["a.json"]);
    expect(result.checkpoint.pendingArtifactKeys).toEqual(["b.json"]);
    expect(result.checkpoint.persistedKeys).toEqual([objectKey(first.sha256)]);
    expect(await bucket.head(result.terminalKey)).toBeNull();
    expect((await readTerminal(bucket, SYNTHETIC_SOURCE, "run-001")).outcome).toBe("missing");

    // Resuming re-uses the object the first attempt already stored and needs
    // no second fetch from the provider.
    bucket.faults = {};
    const resumed = await persistRun(bucket, plan);
    expect(resumed.outcome).toBe("persisted");
    if (resumed.outcome !== "persisted") throw new Error("unreachable");
    expect(resumed.objects.find((entry) => entry.artifactKey === "a.json")?.reused).toBe(true);
    expect(resumed.objects.find((entry) => entry.artifactKey === "b.json")?.reused).toBe(false);
  });

  // G1-03: a multipart upload that never completes must not be followed by a
  // terminal.
  test("G1-03 an unfinished multipart upload never reaches the terminal", async () => {
    const parts = [bytesOf("part-one-"), bytesOf("part-two")];
    const joined = bytesOf("part-one-part-two");
    const multipart = {
      artifactKey: "large.bin",
      sha256: await fakeSha256Hex(joined),
      byteSize: joined.byteLength,
      mediaType: "application/octet-stream",
      role: "provider_export",
      body: { kind: "multipart" as const, parts },
    };
    const bucket = new FakeR2Bucket({
      failMultipartComplete: new Set([objectKey(multipart.sha256)]),
    });
    const plan = await syntheticPlan({ artifacts: [multipart] });

    const result = await persistRun(bucket, plan);
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") throw new Error("unreachable");
    expect(result.reasonCode).toBe("multipart_incomplete");
    expect(bucket.putKeys).toEqual([]);
    expect(await bucket.head(result.terminalKey)).toBeNull();

    // Completed, the same plan stores the object and then the terminal; the
    // multipart object has no native checksum, so verification falls back to
    // the metadata R2 kept.
    bucket.faults = {};
    const completed = await persistRun(bucket, plan);
    expect(completed.outcome).toBe("persisted");
    expect(bucket.putKeys).toEqual([
      objectKey(multipart.sha256),
      terminalKey(SYNTHETIC_SOURCE, "run-001"),
    ]);
    const stored = await bucket.head(objectKey(multipart.sha256));
    expect(stored?.checksums.sha256).toBeUndefined();
    expect(stored?.customMetadata?.sha256).toBe(multipart.sha256);
    if (completed.outcome !== "persisted") throw new Error("unreachable");
    const read = await readTerminal(bucket, SYNTHETIC_SOURCE, "run-001");
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(await verifyReferencedObjects(bucket, read.manifest)).toEqual({
      outcome: "ok",
      checked: 1,
      problems: [],
    });
  });

  // G1-05: the same run written again is a resend, not a second run.
  test("G1-05 re-persisting the same run and digest is a no-op", async () => {
    const bucket = new FakeR2Bucket();
    const plan = await syntheticPlan();
    const first = await persistRun(bucket, plan);
    expect(first.outcome).toBe("persisted");
    const writesAfterFirst = [...bucket.putKeys];

    const second = await persistRun(bucket, plan);
    expect(second.outcome).toBe("already_persisted");
    if (second.outcome !== "already_persisted") throw new Error("unreachable");
    expect(second.terminalDigest).toBe(first.terminalDigest);
    expect(bucket.putKeys).toEqual(writesAfterFirst);
    const third = await persistRun(bucket, plan);
    expect(third.outcome).toBe("already_persisted");
    expect(bucket.putKeys).toEqual(writesAfterFirst);
  });

  // G1-06: the same run id with a different manifest is a conflict. Nothing is
  // overwritten and the caller is told which digest is already stored.
  test("G1-06 a different manifest for the same run conflicts and never overwrites", async () => {
    const bucket = new FakeR2Bucket();
    const plan = await syntheticPlan();
    const first = await persistRun(bucket, plan);
    expect(first.outcome).toBe("persisted");
    const storedBefore = await bucket.get(terminalKey(SYNTHETIC_SOURCE, "run-001"));
    const bytesBefore = new Uint8Array(await storedBefore!.arrayBuffer());

    const changed = await syntheticPlan({
      artifacts: [await syntheticArtifact("balance.json", '{"synthetic":"changed"}')],
    });
    const conflict = await persistRun(bucket, changed);
    expect(conflict.outcome).toBe("conflict");
    if (conflict.outcome !== "conflict") throw new Error("unreachable");
    expect(conflict.storedDigest).toBe(first.terminalDigest);
    expect(conflict.terminalDigest).not.toBe(first.terminalDigest);
    expect(conflict.reasonCode).toBe("terminal_digest_mismatch");

    const storedAfter = await bucket.get(terminalKey(SYNTHETIC_SOURCE, "run-001"));
    expect(new Uint8Array(await storedAfter!.arrayBuffer())).toEqual(bytesBefore);
  });

  test("a terminal that cannot be parsed conflicts rather than being replaced", async () => {
    const bucket = new FakeR2Bucket();
    const key = terminalKey(SYNTHETIC_SOURCE, "run-001");
    await bucket.seed(key, bytesOf("{not json"), { contentType: "application/json" });
    const result = await persistRun(bucket, await syntheticPlan());
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("unreachable");
    expect(result.storedDigest).toBeNull();
    expect(result.reasonCode).toBe("terminal_not_json");
    const stored = await bucket.get(key);
    expect(new TextDecoder().decode(new Uint8Array(await stored!.arrayBuffer()))).toBe("{not json");
  });

  // G1-07: a lost put response leaves the object in R2. The retry verifies and
  // reuses it; it never writes different bytes under the same digest key.
  test("G1-07 a lost put response is resolved by verifying the stored object", async () => {
    const bucket = new FakeR2Bucket();
    const artifact = await syntheticArtifact("balance.json", '{"synthetic":true}');
    const key = objectKey(artifact.sha256);
    // The first attempt stored the object and its response was lost.
    await bucket.seed(key, bytesOf('{"synthetic":true}'), {
      customMetadata: { sha256: artifact.sha256, byteSize: String(artifact.byteSize) },
    });
    const writesBefore = [...bucket.putKeys];

    const result = await persistRun(bucket, await syntheticPlan({ artifacts: [artifact] }));
    expect(result.outcome).toBe("persisted");
    if (result.outcome !== "persisted") throw new Error("unreachable");
    expect(result.objects).toEqual([
      {
        artifactKey: "balance.json",
        key,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
        reused: true,
      },
    ]);
    // Only the terminal was written; the object was not re-uploaded.
    expect(bucket.putKeys).toEqual([...writesBefore, terminalKey(SYNTHETIC_SOURCE, "run-001")]);
  });

  test("G1-07 different bytes under the same content key are refused, not overwritten", async () => {
    const artifact = await syntheticArtifact("balance.json", '{"synthetic":true}');
    const key = objectKey(artifact.sha256);
    // A shorter body is caught by size; a same-length body only by the digest.
    const sameLength = bytesOf('{"synthetic":tru3}');
    expect(sameLength.byteLength).toBe(artifact.byteSize);
    for (const [foreign, code] of [
      [bytesOf("different bytes entirely"), "object_size_mismatch"],
      [sameLength, "object_hash_mismatch"],
    ] as const) {
      const bucket = new FakeR2Bucket();
      await bucket.seed(key, foreign);

      const result = await persistRun(bucket, await syntheticPlan({ artifacts: [artifact] }));
      expect(result.outcome).toBe("incomplete");
      if (result.outcome !== "incomplete") throw new Error("unreachable");
      expect(result.reasonCode).toBe(code);
      expect(result.failedArtifactKey).toBe("balance.json");
      expect(await bucket.head(terminalKey(SYNTHETIC_SOURCE, "run-001"))).toBeNull();
      const stored = await bucket.get(key);
      expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([...foreign]);
    }
  });

  // G1-07 as a race: the object appears between the writer's HEAD and its
  // create-only put. The put returns null, the writer verifies the winner.
  test("G1-07 an object race is settled by verifying the winner, never by overwriting", async () => {
    const artifact = await syntheticArtifact("balance.json", '{"synthetic":true}');
    const key = objectKey(artifact.sha256);
    const sameLength = bytesOf('{"synthetic":tru3}');
    for (const [winner, expected] of [
      [bytesOf('{"synthetic":true}'), "persisted"],
      [sameLength, "incomplete"],
    ] as const) {
      const bucket = new FakeR2Bucket();
      bucket.faults = {
        beforePut: async (putKey) => {
          if (putKey === key && !bucket.entries.has(key)) await bucket.seed(key, winner);
        },
      };
      const result = await persistRun(bucket, await syntheticPlan({ artifacts: [artifact] }));
      expect(result.outcome).toBe(expected);
      const stored = await bucket.get(key);
      expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([...winner]);
      if (result.outcome === "persisted") {
        expect(result.objects[0]?.reused).toBe(true);
        // The writer's own put lost; only the terminal was written by it.
        expect(bucket.putKeys).toEqual([terminalKey(SYNTHETIC_SOURCE, "run-001")]);
      } else {
        if (result.outcome !== "incomplete") throw new Error("unreachable");
        expect(result.reasonCode).toBe("object_hash_mismatch");
        expect(bucket.putKeys).toEqual([]);
        expect(await bucket.head(terminalKey(SYNTHETIC_SOURCE, "run-001"))).toBeNull();
      }
    }
  });

  // G1-05 / G1-06 as a race: a second writer creates the terminal between
  // this writer's HEAD and its create-only put. The null result is re-read
  // and compared, so the same digest is a resend and any other is a conflict.
  test("G1-05 losing the terminal race to the same digest is a resend", async () => {
    const bucket = new FakeR2Bucket();
    const plan = await syntheticPlan();
    const key = terminalKey(SYNTHETIC_SOURCE, "run-001");
    const canonical = encodeTerminal(planManifest(plan));
    bucket.faults = {
      beforePut: async (putKey) => {
        if (putKey === key) await bucket.seed(key, canonical, { contentType: "application/json" });
      },
    };
    const result = await persistRun(bucket, plan);
    expect(result.outcome).toBe("already_persisted");
    if (result.outcome !== "already_persisted") throw new Error("unreachable");
    expect(result.terminalDigest).toBe(await terminalDigest(planManifest(plan)));
    expect(result.checkpoint.persistedKeys).toContain(key);
    // The objects were written by this writer; the terminal was not.
    expect(bucket.putKeys).not.toContain(key);
    expect(bucket.putKeys).toHaveLength(2);
    const stored = await bucket.get(key);
    expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([...canonical]);
  });

  test("G1-06 losing the terminal race to a different manifest is a conflict", async () => {
    const bucket = new FakeR2Bucket();
    const plan = await syntheticPlan();
    const other = await syntheticPlan({
      artifacts: [await syntheticArtifact("balance.json", '{"synthetic":"other"}')],
    });
    const key = terminalKey(SYNTHETIC_SOURCE, "run-001");
    const otherBytes = encodeTerminal(planManifest(other));
    bucket.faults = {
      beforePut: async (putKey) => {
        if (putKey === key) await bucket.seed(key, otherBytes, { contentType: "application/json" });
      },
    };
    const result = await persistRun(bucket, plan);
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("unreachable");
    expect(result.storedDigest).toBe(await terminalDigest(planManifest(other)));
    expect(result.reasonCode).toBe("terminal_digest_mismatch");
    expect(bucket.putKeys).not.toContain(key);
    const stored = await bucket.get(key);
    expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([...otherBytes]);
  });

  test("a stored terminal the reader would block is a conflict, not a resend", async () => {
    // Same manifest, but stored as pretty-printed JSON by something that is
    // not this writer. The reader blocks it; the writer must agree and never
    // report the run as already persisted.
    const bucket = new FakeR2Bucket();
    const plan = await syntheticPlan();
    const key = terminalKey(SYNTHETIC_SOURCE, "run-001");
    const pretty = bytesOf(JSON.stringify(planManifest(plan), null, 2));
    await bucket.seed(key, pretty, { contentType: "application/json" });
    const result = await persistRun(bucket, plan);
    expect(result.outcome).toBe("conflict");
    if (result.outcome !== "conflict") throw new Error("unreachable");
    expect(result.reasonCode).toBe("terminal_not_canonical");
    expect(result.storedDigest).toBeNull();
    const read = await readTerminal(bucket, SYNTHETIC_SOURCE, "run-001");
    expect(read.outcome).toBe("blocked");
    if (read.outcome !== "blocked") throw new Error("unreachable");
    expect(read.reasonCode).toBe("terminal_not_canonical");
    expect(bucket.putKeys).toEqual([]);
  });

  test("a multipart body is hashed even when single-part hashing is switched off", async () => {
    // R2 cannot check a multipart digest server-side, so the writer must.
    const parts = [bytesOf("part-one-"), bytesOf("part-two")];
    const lying = {
      artifactKey: "large.bin",
      sha256: "1".repeat(64),
      byteSize: 17,
      mediaType: "application/octet-stream",
      role: "provider_export",
      body: { kind: "multipart" as const, parts },
    };
    const bucket = new FakeR2Bucket();
    const result = await persistRun(bucket, await syntheticPlan({ artifacts: [lying] }), {
      verifyBodyDigest: false,
    });
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") throw new Error("unreachable");
    expect(result.reasonCode).toBe("artifact_digest_mismatch");
    expect(bucket.putKeys).toEqual([]);
    expect(bucket.entries.size).toBe(0);
  });

  test("a body that does not match its declared digest is never stored", async () => {
    const bucket = new FakeR2Bucket();
    const artifact = await syntheticArtifact("balance.json", '{"synthetic":true}');
    const lying = { ...artifact, body: { kind: "bytes" as const, bytes: bytesOf('{"other":1}') } };
    const result = await persistRun(bucket, await syntheticPlan({ artifacts: [lying] }));
    expect(result.outcome).toBe("incomplete");
    if (result.outcome !== "incomplete") throw new Error("unreachable");
    expect(result.reasonCode).toBe("artifact_size_mismatch");
    expect(bucket.putKeys).toEqual([]);
  });

  test("the stored terminal bytes are the canonical encoding of the manifest", async () => {
    const bucket = new FakeR2Bucket();
    const plan = await syntheticPlan();
    const result = await persistRun(bucket, plan);
    if (result.outcome !== "persisted") throw new Error("unreachable");
    const stored = await bucket.get(result.terminalKey);
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect([...bytes]).toEqual([...encodeTerminal(planManifest(plan))]);
    expect(await fakeSha256Hex(bytes)).toBe(await terminalDigest(planManifest(plan)));
    expect(stored?.customMetadata?.terminalDigest).toBe(result.terminalDigest);
  });
});
