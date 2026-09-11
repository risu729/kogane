// One place that decides whether the object R2 holds is the object the
// manifest claims. Both the writer (post-put) and the reader (re-check) use
// it, so "verified" means the same thing on both sides.
import { nativeSha256Hex, type R2ObjectLike } from "./bucket";

export const OBJECT_CONTENT_TYPE = "application/octet-stream";
export const TERMINAL_CONTENT_TYPE = "application/json";

export interface ExpectedObject {
  readonly sha256: string;
  readonly byteSize: number;
}

export type ObjectProblemCode =
  | "object_missing"
  | "object_size_mismatch"
  | "object_hash_mismatch"
  | "object_digest_unverifiable";

/**
 * Returns null when the stored object matches, otherwise the reason code.
 *
 * R2 stores a native SHA-256 only for single-part puts that declared one, so
 * `customMetadata.sha256` is written alongside and is the fallback for
 * multipart objects. When neither is present the object is *unverifiable from
 * metadata*: the caller must stream and hash it rather than assume it is fine.
 */
export function verifyStoredObject(
  object: R2ObjectLike | null,
  expected: ExpectedObject,
): ObjectProblemCode | null {
  if (!object) return "object_missing";
  if (object.size !== expected.byteSize) return "object_size_mismatch";
  const native = nativeSha256Hex(object);
  const declared = object.customMetadata?.sha256;
  if (native === null && declared === undefined) return "object_digest_unverifiable";
  if (native !== null && native !== expected.sha256) return "object_hash_mismatch";
  if (declared !== undefined && declared !== expected.sha256) return "object_hash_mismatch";
  if (object.customMetadata?.byteSize !== undefined) {
    if (object.customMetadata.byteSize !== String(expected.byteSize)) {
      return "object_size_mismatch";
    }
  }
  return null;
}

/** Metadata every content-addressed object carries, so a reader never needs the manifest. */
export function objectMetadata(expected: ExpectedObject): Record<string, string> {
  return { sha256: expected.sha256, byteSize: String(expected.byteSize) };
}
