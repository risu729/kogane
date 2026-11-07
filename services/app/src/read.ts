import type { EvidenceArtifactRow } from "../../../packages/application/src/query/evidence-catalogue.ts";
import { HttpError } from "./http";

export async function catalogue<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "catalogue_read_failed");
  }
}

/** The catalogue row of an artifact whose raw bytes a route streams. */
export type ArtifactRow = EvidenceArtifactRow;

type DownloadArtifact = Pick<ArtifactRow, "artifact_key" | "declared_media_type" | "sha256">;

const mediaExtensions: Record<string, string> = {
  "application/json": ".json",
  "application/ld+json": ".json",
  "application/pdf": ".pdf",
  "application/xml": ".xml",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "text/html": ".html",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "text/xml": ".xml",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

export function downloadDisposition(row: DownloadArtifact): string {
  // Artifact keys are collector paths, not trusted filenames. Never interpret
  // percent escapes as path syntax or allow header/control characters through.
  let name = (row.artifact_key.split(/[\\/]/).at(-1) ?? "")
    .toWellFormed()
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "");
  if (!name) name = `artifact-${row.sha256.slice(0, 16)}`;
  if (!/\.[^.]+$/.test(name)) {
    const mediaType = row.declared_media_type?.split(";", 1)[0].trim().toLowerCase() ?? "";
    name += Object.hasOwn(mediaExtensions, mediaType)
      ? mediaExtensions[mediaType]
      : mediaType.endsWith("+json")
        ? ".json"
        : "";
  }
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  // Bound the header while retaining the original extension, including Unicode.
  const characters = Array.from(name);
  if (characters.length > 120) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 20 ? name.slice(dot) : "";
    name = characters.slice(0, 120 - Array.from(extension).length).join("") + extension;
  }
  const fallback = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

type RawRow = Pick<
  ArtifactRow,
  "blob_key" | "sha256" | "byte_size" | "artifact_key" | "declared_media_type"
>;

export async function raw(bucket: R2Bucket, row: RawRow, head: boolean): Promise<Response> {
  const body = await verifiedObject(bucket, row, head);
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(row.byte_size),
      "content-disposition": downloadDisposition(row),
      "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
    },
  });
}

/** The largest raw object an agent read returns (ADR 0081, 2026-11-07). */
export const RAW_READ_MAX_BYTES = 1024 * 1024;

/**
 * One raw object's bytes for an agent read: the same object and the same
 * integrity checks as the download, refused before any read past
 * `RAW_READ_MAX_BYTES` (`413 raw_too_large`), and the bytes' own SHA-256
 * compared with the catalogue's as well.
 */
export async function rawBytes(bucket: R2Bucket, row: RawRow): Promise<Uint8Array> {
  if (row.byte_size > RAW_READ_MAX_BYTES) throw new HttpError(413, "raw_too_large");
  const body = await verifiedObject(bucket, row, false);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await new Response(body).arrayBuffer());
  } catch {
    throw new HttpError(503, "raw_read_failed");
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (bytes.length !== row.byte_size || digest !== row.sha256)
    throw new HttpError(409, "raw_integrity_failed");
  return bytes;
}

/** The object's body (none for `head`), refused unless R2 still holds exactly the catalogued bytes. */
async function verifiedObject(
  bucket: R2Bucket,
  row: RawRow,
  head: boolean,
): Promise<ReadableStream | null> {
  let object: R2Object | R2ObjectBody | null;
  try {
    object = head ? await bucket.head(row.blob_key) : await bucket.get(row.blob_key);
  } catch {
    throw new HttpError(503, "raw_read_failed");
  }
  if (!object) throw new HttpError(404, "raw_unavailable");
  const body = head ? null : (object as R2ObjectBody).body;
  const checksum = object.checksums.sha256;
  const hex =
    checksum &&
    Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (
    object.size !== row.byte_size ||
    hex !== row.sha256 ||
    object.customMetadata?.sha256 !== row.sha256 ||
    object.customMetadata?.byteSize !== String(row.byte_size)
  ) {
    if (body) {
      try {
        await body.cancel();
      } catch {
        /* Preserve integrity failure. */
      }
    }
    throw new HttpError(409, "raw_integrity_failed");
  }
  return body;
}
