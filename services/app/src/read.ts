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

export async function raw(
  bucket: R2Bucket,
  row: Pick<
    ArtifactRow,
    "blob_key" | "sha256" | "byte_size" | "artifact_key" | "declared_media_type"
  >,
  head: boolean,
): Promise<Response> {
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
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(row.byte_size),
      "content-disposition": downloadDisposition(row),
      "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
    },
  });
}
