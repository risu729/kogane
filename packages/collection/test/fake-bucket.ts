// In-memory R2 stand-in for the contract tests. It models the parts of R2 the
// collection contract depends on and nothing else:
//
//   * strongly consistent read-after-write and list-after-write;
//   * `onlyIf: { etagDoesNotMatch: "*" }` as create-only — an existing key
//     makes `put` return null instead of replacing the object;
//   * the `sha256` put option rejecting a body that does not match;
//   * native `checksums.sha256` for single-part puts only, so the multipart
//     path exercises the customMetadata fallback the way real R2 does;
//   * ordered, cursor-paged `list`.
//
// Faults are injected explicitly (`failPut`, `failMultipartComplete`) so a
// test can stop a run exactly where an acceptance row says it stops.
import type {
  R2BucketLike,
  R2ListOptionsLike,
  R2MultipartOptionsLike,
  R2MultipartUploadLike,
  R2ObjectBodyLike,
  R2ObjectLike,
  R2ObjectsLike,
  R2PutOptionsLike,
  R2PutValueLike,
  R2UploadedPartLike,
} from "../src/bucket";

interface StoredEntry {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  contentType: string | undefined;
  customMetadata: Record<string, string> | undefined;
  nativeSha256: string | null;
}

function toBytes(value: R2PutValueLike): Uint8Array {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexOf(value: string | ArrayBuffer): string {
  if (typeof value === "string") return value.toLowerCase();
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class FakeObject implements R2ObjectBodyLike {
  constructor(
    readonly key: string,
    private readonly entry: StoredEntry,
  ) {}
  get size(): number {
    return this.entry.bytes.byteLength;
  }
  get etag(): string {
    return this.entry.etag;
  }
  get uploaded(): Date {
    return this.entry.uploaded;
  }
  get httpMetadata(): { contentType?: string | undefined } {
    return { contentType: this.entry.contentType };
  }
  get customMetadata(): Record<string, string> | undefined {
    return this.entry.customMetadata;
  }
  get checksums(): { sha256?: ArrayBuffer | undefined } {
    if (this.entry.nativeSha256 === null) return {};
    const hex = this.entry.nativeSha256;
    const bytes = Uint8Array.from(hex.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
    return { sha256: bytes.buffer as ArrayBuffer };
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new Uint8Array(this.entry.bytes.byteLength);
    copy.set(this.entry.bytes);
    return copy.buffer;
  }
}

export interface FakeBucketFaults {
  /** Keys whose single-part put throws. */
  readonly failPut?: ReadonlySet<string>;
  /** Keys whose multipart `complete` throws, leaving the upload unfinished. */
  readonly failMultipartComplete?: ReadonlySet<string>;
}

export class FakeR2Bucket implements R2BucketLike {
  readonly entries = new Map<string, StoredEntry>();
  readonly putKeys: string[] = [];
  private version = 0;
  faults: FakeBucketFaults = {};

  constructor(faults: FakeBucketFaults = {}) {
    this.faults = faults;
  }

  /** Write bytes as if a previous, lost attempt had stored them. */
  async seed(
    key: string,
    bytes: Uint8Array,
    options: { contentType?: string; customMetadata?: Record<string, string> } = {},
  ): Promise<void> {
    this.entries.set(key, {
      bytes,
      etag: `etag-${(this.version += 1)}`,
      uploaded: new Date(1_700_000_000_000 + this.version),
      contentType: options.contentType ?? "application/octet-stream",
      customMetadata: options.customMetadata,
      nativeSha256: await sha256Hex(bytes),
    });
  }

  async head(key: string): Promise<R2ObjectLike | null> {
    const entry = this.entries.get(key);
    return entry ? new FakeObject(key, entry) : null;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const entry = this.entries.get(key);
    return entry ? new FakeObject(key, entry) : null;
  }

  async put(
    key: string,
    value: R2PutValueLike,
    options: R2PutOptionsLike = {},
  ): Promise<R2ObjectLike | null> {
    if (this.faults.failPut?.has(key)) throw new Error("simulated R2 put failure");
    const bytes = toBytes(value);
    const digest = await sha256Hex(bytes);
    if (options.sha256 !== undefined && hexOf(options.sha256) !== digest) {
      throw new Error("put failed: sha256 checksum does not match");
    }
    const exists = this.entries.has(key);
    if (options.onlyIf?.etagDoesNotMatch === "*" && exists) return null;
    if (options.onlyIf?.etagMatches !== undefined) {
      const current = this.entries.get(key);
      if (!current || current.etag !== options.onlyIf.etagMatches) return null;
    }
    const entry: StoredEntry = {
      bytes,
      etag: `etag-${(this.version += 1)}`,
      uploaded: new Date(1_700_000_000_000 + this.version),
      contentType: options.httpMetadata?.contentType,
      customMetadata: options.customMetadata,
      // Real R2 only records a native checksum when the caller declared one.
      nativeSha256: options.sha256 === undefined ? null : digest,
    };
    this.entries.set(key, entry);
    this.putKeys.push(key);
    return new FakeObject(key, entry);
  }

  async list(options: R2ListOptionsLike = {}): Promise<R2ObjectsLike> {
    const prefix = options.prefix ?? "";
    const limit = options.limit ?? 1000;
    const keys = [...this.entries.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const after = options.cursor === undefined ? -1 : keys.indexOf(options.cursor);
    const page = keys.slice(after + 1, after + 1 + limit);
    const truncated = after + 1 + limit < keys.length;
    const last = page.at(-1);
    return {
      objects: page.map((key) => new FakeObject(key, this.entries.get(key)!)),
      truncated,
      ...(truncated && last !== undefined ? { cursor: last } : {}),
    };
  }

  async createMultipartUpload(
    key: string,
    options: R2MultipartOptionsLike = {},
  ): Promise<R2MultipartUploadLike> {
    const parts = new Map<number, Uint8Array>();
    return {
      key,
      uploadId: `upload-${(this.version += 1)}`,
      uploadPart: async (
        partNumber: number,
        value: R2PutValueLike,
      ): Promise<R2UploadedPartLike> => {
        parts.set(partNumber, toBytes(value));
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async (uploaded: R2UploadedPartLike[]): Promise<R2ObjectLike> => {
        if (this.faults.failMultipartComplete?.has(key)) {
          throw new Error("simulated multipart completion failure");
        }
        const ordered = [...uploaded].sort((left, right) => left.partNumber - right.partNumber);
        const chunks = ordered.map((part) => parts.get(part.partNumber) ?? new Uint8Array());
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const entry: StoredEntry = {
          bytes,
          etag: `etag-${(this.version += 1)}`,
          uploaded: new Date(1_700_000_000_000 + this.version),
          contentType: options.httpMetadata?.contentType,
          customMetadata: options.customMetadata,
          // R2 does not compute a native SHA-256 for a multipart object.
          nativeSha256: null,
        };
        this.entries.set(key, entry);
        this.putKeys.push(key);
        return new FakeObject(key, entry);
      },
      abort: async (): Promise<void> => {
        parts.clear();
      },
    };
  }
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export { sha256Hex as fakeSha256Hex };
