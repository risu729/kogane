// The smallest R2 surface the collection contract needs. Collectors (Workers
// with a `DATA` binding), the Processor and the tests all pass their own
// object through it, so nothing in this package depends on `@cloudflare/workers-types`.
//
// The shapes are structurally compatible with the Workers `R2Bucket`: a real
// binding is assignable to `R2BucketLike` without a cast, including from a
// package compiled with `exactOptionalPropertyTypes`. That is why the option
// types below write `field?: T` and never `field?: T | undefined`: under that
// flag an explicit `| undefined` on an option this interface hands *to* R2
// makes the real `put`, `list` and `createMultipartUpload` signatures
// unassignable. The result shapes R2 hands *back* keep `| undefined`, where it
// costs nothing. Every collector's `worker-test/` suite passes its real `DATA`
// binding straight into this interface, which is what checks it.

export interface R2ChecksumsLike {
  readonly sha256?: ArrayBuffer | undefined;
}

/** What R2 reports back: a stored object may carry no content type at all. */
export interface R2HttpMetadataLike {
  readonly contentType?: string | undefined;
}

/** What a writer declares on a put; see the note on optionality above. */
export interface R2HttpMetadataInit {
  readonly contentType?: string;
}

export interface R2ObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly checksums: R2ChecksumsLike;
  readonly uploaded?: Date | undefined;
  readonly httpMetadata?: R2HttpMetadataLike | undefined;
  readonly customMetadata?: Record<string, string> | undefined;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Bytes a caller may hand to `put`; a subset of the R2 value union. */
export type R2PutValueLike = ArrayBuffer | ArrayBufferView | string | null;

/**
 * Bytes a caller may hand to `uploadPart`. Deliberately narrower than
 * {@link R2PutValueLike}: the Workers `R2MultipartUpload.uploadPart` has no
 * null form, so keeping null here would make a real `R2Bucket` unassignable to
 * `R2BucketLike` — the one thing this interface exists to allow.
 */
export type R2PartValueLike = ArrayBuffer | ArrayBufferView | string;

export interface R2ConditionalLike {
  readonly etagMatches?: string;
  readonly etagDoesNotMatch?: string;
}

export interface R2PutOptionsLike {
  readonly onlyIf?: R2ConditionalLike;
  /** Hex string or raw bytes; R2 rejects the write when the body does not match. */
  readonly sha256?: string | ArrayBuffer;
  readonly httpMetadata?: R2HttpMetadataInit;
  readonly customMetadata?: Record<string, string>;
}

export interface R2ListOptionsLike {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly delimiter?: string;
}

export interface R2ObjectsLike {
  readonly objects: R2ObjectLike[];
  readonly truncated: boolean;
  /** Present only while `truncated` is true, exactly as the Workers API defines it. */
  readonly cursor?: string | undefined;
  readonly delimitedPrefixes?: string[] | undefined;
}

export interface R2UploadedPartLike {
  readonly partNumber: number;
  readonly etag: string;
}

export interface R2MultipartUploadLike {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: R2PartValueLike): Promise<R2UploadedPartLike>;
  complete(uploadedParts: R2UploadedPartLike[]): Promise<R2ObjectLike>;
  abort(): Promise<void>;
}

export interface R2MultipartOptionsLike {
  readonly httpMetadata?: R2HttpMetadataInit;
  readonly customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: R2PutValueLike, options?: R2PutOptionsLike): Promise<R2ObjectLike | null>;
  list(options?: R2ListOptionsLike): Promise<R2ObjectsLike>;
  createMultipartUpload(
    key: string,
    options?: R2MultipartOptionsLike,
  ): Promise<R2MultipartUploadLike>;
}

/** Lower-case hex of an R2 native checksum, or null when R2 stored none. */
export function nativeSha256Hex(object: R2ObjectLike): string | null {
  const digest = object.checksums.sha256;
  if (!digest) return null;
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hex string to bytes, for the `sha256` put option. */
export function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}
