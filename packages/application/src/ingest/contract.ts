// What the registration use cases need from their host, and how they report a
// refusal. Nothing here is an HTTP type: the legacy ingest Worker turns an
// `IngestError` into a status code, and the Processor will turn the same error
// into a job outcome, but neither meaning belongs in the use case.
import type { D1Like } from "../../../storage-d1/src/d1.ts";

export type RecordValue = Record<string, unknown>;

/**
 * A refused registration. `status` is the HTTP status the legacy ingest API
 * has always returned for this `code`; it is carried here so the adapter stays
 * a translation and the protocol cannot drift when a second caller appears.
 */
export class IngestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const SHA256 = /^[0-9a-f]{64}$/;

/** The object store, narrowed to the two operations registration performs. A
 * real `R2Bucket` satisfies it; so does an in-memory fake in a test. */
export interface StoredObjectLike {
  readonly size: number;
  readonly checksums: { readonly sha256?: ArrayBuffer | undefined };
  readonly customMetadata?: Record<string, string> | undefined;
  readonly httpMetadata?: { contentType?: string | undefined } | undefined;
}

export interface PutObjectOptions {
  onlyIf?: { etagDoesNotMatch?: string };
  sha256?: ArrayBuffer | ArrayBufferView | string;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}

export interface EvidenceBucketLike {
  head(key: string): Promise<StoredObjectLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: PutObjectOptions,
  ): Promise<StoredObjectLike | null>;
}

/** CORE plus the object store: everything a registration touches. */
export interface IngestEnv {
  DB: D1Like;
  EVIDENCE: EvidenceBucketLike;
  MAX_OBJECT_BYTES?: string | undefined;
}

/**
 * The read-back check every registration write ends with. A conditional insert
 * that matched nothing leaves the earlier row in place; comparing it with what
 * this request meant to write is what turns a retry into a no-op and a genuine
 * disagreement into a conflict. A missing row means the write is not visible,
 * which is a server fault, not a client conflict.
 */
export function assertSame(
  row: RecordValue | null,
  expected: RecordValue,
  code: string,
): void {
  if (!row) throw new IngestError(500, "write_not_visible");
  for (const [key, value] of Object.entries(expected)) {
    if (row[key] !== value) throw new IngestError(409, code);
  }
}
