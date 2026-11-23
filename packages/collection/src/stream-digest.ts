// SHA-256 of a byte stream, read chunk by chunk and never held whole.
//
// Web Crypto's `crypto.subtle.digest` takes one buffer, so hashing an object
// with it means reading the whole object into memory first. That is fine for
// what the reader accepts (a terminal of at most 8 MiB) and not for what it
// refuses: a terminal over the cap can be any size R2 stores, larger than a
// Worker's memory. This module hashes such a body as it is read.
//
// In Workers the hash is Cloudflare's `crypto.DigestStream`, the runtime's
// Web Crypto extension: a `WritableStream` whose `digest` resolves once the
// stream is closed. Bun has no `DigestStream`, so the Bun tests (and any Bun
// script) hash through `Bun.CryptoHasher` instead. Both are the plain SHA-256
// of the concatenated bytes, the same value `sha256Hex` returns for the same
// bytes in one buffer: `test/stream-digest.test.ts` checks the Bun path and
// `worker-test/r2-terminal.test.ts` the Workers path against `sha256Hex`.
import { bytesHex } from "../../evidence-contract/src/digest";

/** The part of Cloudflare's `crypto.DigestStream` this module uses. */
interface DigestStreamLike extends WritableStream<ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;
}

type DigestStreamConstructor = new (algorithm: "SHA-256") => DigestStreamLike;

/** The part of Bun's `Bun.CryptoHasher` this module uses. */
interface CryptoHasherLike {
  update(chunk: Uint8Array): unknown;
  digest(encoding: "hex"): string;
}

type CryptoHasherConstructor = new (algorithm: "sha256") => CryptoHasherLike;

interface IncrementalSha256 {
  update(chunk: Uint8Array): Promise<void>;
  hex(): Promise<string>;
}

function incrementalSha256(): IncrementalSha256 {
  const digestStream = (globalThis.crypto as unknown as { DigestStream?: DigestStreamConstructor })
    .DigestStream;
  if (digestStream !== undefined) {
    const sink = new digestStream("SHA-256");
    const writer = sink.getWriter();
    return {
      update: (chunk) => writer.write(chunk),
      hex: async () => {
        await writer.close();
        return bytesHex(new Uint8Array(await sink.digest));
      },
    };
  }
  const hasher = (globalThis as { Bun?: { CryptoHasher?: CryptoHasherConstructor } }).Bun
    ?.CryptoHasher;
  if (hasher !== undefined) {
    const state = new hasher("sha256");
    return {
      update: async (chunk) => {
        state.update(chunk);
      },
      hex: async () => state.digest("hex"),
    };
  }
  throw new Error("sha256_stream_unavailable");
}

/**
 * Lower-case hex SHA-256 of every byte the stream yields, read through
 * `getReader()` one chunk at a time. Equal to `sha256Hex` of the same bytes
 * concatenated; no more than the chunk being hashed is held at once.
 */
export async function sha256HexOfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = incrementalSha256();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.hex();
}
