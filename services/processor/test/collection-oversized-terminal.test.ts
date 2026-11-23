// A terminal the reader refuses as `terminal_too_large` is recorded under the
// digest of its bytes without ever holding those bytes whole.
//
// The reader refuses anything over 8 MiB, and an object of that kind can be
// any size R2 stores: larger than a Worker's memory, if something outside the
// collectors put it there. Reading it into one buffer to hash it would end the
// invocation at `collection_scan` on every tick, skip every later lane and
// never move the cursor. The bodies here are generated on demand, one chunk
// per read, and the generated object refuses `arrayBuffer()` the way a body
// larger than memory cannot be buffered; nothing synthetic resembles a
// provider's bytes.
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket.ts";
import type { R2ObjectBodyLike, R2ObjectLike } from "../../../packages/collection/src/bucket.ts";
import { sha256Hex } from "../../../packages/collection/src/digest.ts";
import { terminalKey } from "../../../packages/collection/src/keys.ts";
import { collectionScan, registerCollectionRun } from "../src/collection/index.ts";
import {
  collectionHarness,
  persistSyntheticRun,
  rows,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";

const MIB = 1024 * 1024;
const CHUNK = 64 * 1024;

/** Chunk `index` of a generated body: a fixed pattern stamped with its index. */
const PATTERN = Uint8Array.from({ length: CHUNK }, (_, at) => (at * 7 + 13) & 0xff);
function chunkAt(index: number, length: number): Uint8Array {
  const chunk = PATTERN.slice(0, length);
  if (length >= 4) new DataView(chunk.buffer).setUint32(0, index);
  return chunk;
}

function* chunksOf(size: number): Generator<Uint8Array> {
  for (let offset = 0, index = 0; offset < size; offset += CHUNK, index += 1) {
    yield chunkAt(index, Math.min(CHUNK, size - offset));
  }
}

/** SHA-256 of a generated body, computed independently of the code under test. */
function generatedDigest(size: number): string {
  const hash = createHash("sha256");
  for (const chunk of chunksOf(size)) hash.update(chunk);
  return hash.digest("hex");
}

/** What one `get` of the generated terminal did with its body. */
interface Reads {
  arrayBufferCalls: number;
  chunksPulled: number;
  bytesPulled: number;
  /** The most bytes the body's own queue ever held. */
  queuedHighWater: number;
}

/**
 * A stored object whose body is generated as it is read. `buffered` decides
 * whether `arrayBuffer()` works (an object small enough to buffer) or refuses
 * (one larger than the memory a Worker has).
 */
function generatedObject(key: string, size: number, buffered: boolean, reads: Reads) {
  const chunks = chunksOf(size);
  let queued = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks.next();
        if (next.done) {
          controller.close();
          return;
        }
        reads.chunksPulled += 1;
        reads.bytesPulled += next.value.byteLength;
        controller.enqueue(next.value);
        queued = Math.max(0, -(controller.desiredSize ?? 0));
        reads.queuedHighWater = Math.max(reads.queuedHighWater, queued);
      },
    },
    // Pull only when a read is waiting, so the body never runs ahead of its reader.
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
  const object: R2ObjectBodyLike = {
    key,
    size,
    etag: "etag-generated",
    checksums: {},
    httpMetadata: { contentType: "application/json" },
    body,
    async arrayBuffer() {
      reads.arrayBufferCalls += 1;
      if (!buffered) throw new Error("synthetic_body_exceeds_memory");
      const whole = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunksOf(size)) {
        whole.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return whole.buffer;
    },
  };
  return object;
}

/** The harness's bucket, with one terminal key served by a generated object. */
class GeneratedTerminalBucket extends FakeR2Bucket {
  readonly gets: Reads[] = [];

  constructor(
    readonly key: string,
    readonly size: number,
    readonly buffered: boolean,
  ) {
    super();
  }

  override async head(key: string): Promise<R2ObjectLike | null> {
    if (key !== this.key) return super.head(key);
    return generatedObject(key, this.size, this.buffered, this.fresh());
  }

  override async get(key: string): Promise<R2ObjectBodyLike | null> {
    if (key !== this.key) return super.get(key);
    const reads = this.fresh();
    this.gets.push(reads);
    return generatedObject(key, this.size, this.buffered, reads);
  }

  private fresh(): Reads {
    return { arrayBufferCalls: 0, chunksPulled: 0, bytesPulled: 0, queuedHighWater: 0 };
  }
}

/** A harness whose bucket serves `run-oversized`'s terminal as a generated object. */
async function oversizedHarness(size: number, buffered: boolean) {
  const harness: CollectionHarness = collectionHarness();
  const key = terminalKey(SOURCE, "run-oversized");
  const bucket = new GeneratedTerminalBucket(key, size, buffered);
  harness.bucket = bucket;
  harness.env.EVIDENCE = bucket as unknown as CollectionHarness["env"]["EVIDENCE"];
  // A placeholder so the key is listed; every `get` of it returns the generated object.
  await bucket.seed(key, new TextEncoder().encode("{}"), { contentType: "application/json" });
  return { harness, bucket, key };
}

interface RunRow {
  id: number;
  run_id: string;
  terminal_digest: string;
  blocked_code: string | null;
}

function runRow(harness: CollectionHarness, runId: string): RunRow[] {
  return rows<RunRow>(
    harness.db,
    "SELECT id, run_id, terminal_digest, blocked_code FROM collection_runs WHERE run_id = ?",
    runId,
  );
}

test("a terminal larger than memory is blocked under its streamed digest, never buffered", async () => {
  const size = 64 * MIB + 3;
  const { harness, bucket } = await oversizedHarness(size, false);
  await persistSyntheticRun(harness, { run: { runId: "run-later" } });

  const summary = await collectionScan(harness.env);
  // The oversized terminal is a verdict, not a failure, and the page goes on.
  expect(summary).toMatchObject({ listed: 2, blocked: 1, registered: 1, failed: 0 });
  const [row] = runRow(harness, "run-oversized");
  expect(row?.blocked_code).toBe("terminal_too_large");
  expect(row?.terminal_digest).toBe(generatedDigest(size));

  // The reader's `get` stopped at the size; the digest's `get` streamed every
  // byte, one chunk per read, and never asked for the whole body.
  expect(bucket.gets).toHaveLength(2);
  const [readerGet, digestGet] = bucket.gets;
  expect(readerGet).toMatchObject({ arrayBufferCalls: 0, bytesPulled: 0 });
  expect(digestGet).toMatchObject({
    arrayBufferCalls: 0,
    bytesPulled: size,
    chunksPulled: Math.ceil(size / CHUNK),
  });
  expect(digestGet!.queuedHighWater).toBeLessThanOrEqual(1);

  // A later sweep answers from the same row: one identity for the same bytes.
  await collectionScan(harness.env);
  expect(runRow(harness, "run-oversized")).toHaveLength(1);
});

test("the streamed digest is the digest the buffered read recorded before", async () => {
  // Just over the reader's cap, small enough that the earlier code could
  // buffer it: what that code recorded is what the streamed digest finds.
  const size = 8 * MIB + 1;
  const { harness, bucket, key } = await oversizedHarness(size, true);
  const earlier = await bucket.get(key);
  const buffered = await sha256Hex(new Uint8Array(await earlier!.arrayBuffer()));
  expect(buffered).toBe(generatedDigest(size));

  expect(
    await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-oversized" }),
  ).toMatchObject({ outcome: "blocked", code: "terminal_too_large", recorded: false });
  const [row] = runRow(harness, "run-oversized");
  expect(row?.terminal_digest).toBe(buffered);
  // Registration itself never buffered it.
  expect(bucket.gets.slice(1).map((reads) => reads.arrayBufferCalls)).toEqual([0, 0]);

  // The same bytes again are the row already recorded, not a second identity.
  expect(
    await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-oversized" }),
  ).toMatchObject({ outcome: "blocked", code: "terminal_too_large", recorded: true });
  expect(runRow(harness, "run-oversized")).toHaveLength(1);
});

test("a corrupt terminal under the cap keeps the digest of its stored bytes", async () => {
  const harness = collectionHarness();
  const key = terminalKey(SOURCE, "run-corrupt");
  const bytes = new TextEncoder().encode('{"not":"a manifest"');
  await harness.bucket.seed(key, bytes, { contentType: "application/json" });

  expect(
    await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-corrupt" }),
  ).toMatchObject({ outcome: "blocked", code: "terminal_not_json" });
  const [row] = runRow(harness, "run-corrupt");
  expect(row?.terminal_digest).toBe(await sha256Hex(bytes));
});
