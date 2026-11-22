// The streamed SHA-256 against the one-buffer `sha256Hex`, under Bun.
//
// Bun has no `crypto.DigestStream`, so this suite covers the `Bun.CryptoHasher`
// path; `worker-test/r2-terminal.test.ts` covers the Workers path against real
// R2 bodies. Every input is synthetic.
import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/digest";
import { digestOfStream, sha256HexOfStream } from "../src/stream-digest";

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= chunks.length) controller.close();
      else controller.enqueue(chunks[next++]!);
    },
  });
}

/** Deterministic synthetic bytes. */
function bytes(length: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length }, (_, at) => (at * 31 + seed * 17) & 0xff);
}

/** Split `whole` at the given cut points, each chunk a view into a larger buffer. */
function split(whole: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const bounds = [0, ...cuts, whole.byteLength];
  return bounds.slice(1).map((end, index) => {
    const start = bounds[index]!;
    // An offset view over a padded buffer, as a stream may hand out.
    const padded = new Uint8Array(end - start + 8);
    padded.set(whole.subarray(start, end), 3);
    return padded.subarray(3, 3 + end - start);
  });
}

describe("sha256HexOfStream", () => {
  test("is the SHA-256 of the empty stream", async () => {
    expect(await sha256HexOfStream(streamOf([]))).toBe(await sha256Hex(new Uint8Array()));
    expect(await sha256HexOfStream(streamOf([new Uint8Array()]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("equals sha256Hex of the concatenated bytes, however the stream is chunked", async () => {
    for (const length of [1, 55, 56, 63, 64, 65, 4096, 100_003]) {
      const whole = bytes(length, length);
      const expected = await sha256Hex(whole);
      const chunkings = [
        [],
        [Math.floor(length / 2)],
        Array.from({ length: Math.floor(length / 7) }, (_, at) => (at + 1) * 7).filter(
          (cut) => cut < length,
        ),
        [0, 0, length],
      ];
      for (const cuts of chunkings) {
        expect(await sha256HexOfStream(streamOf(split(whole, cuts)))).toBe(expected);
      }
    }
  });

  test("digestOfStream counts every byte it hashes, empty chunks included", async () => {
    for (const length of [0, 1, 64, 4097, 100_003]) {
      const whole = bytes(length, 3);
      const cuts = [0, Math.floor(length / 3), Math.floor(length / 3), length];
      expect(await digestOfStream(streamOf(split(whole, cuts)))).toEqual({
        sha256: await sha256Hex(whole),
        byteSize: length,
      });
    }
  });

  test("propagates a body that fails mid-stream instead of returning a digest", async () => {
    let pulls = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(bytes(10));
        else controller.error(new Error("synthetic_read_failure"));
      },
    });
    await expect(sha256HexOfStream(failing)).rejects.toThrow("synthetic_read_failure");
  });
});
