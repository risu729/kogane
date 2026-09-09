import type {
  EvidenceRun,
  EvidenceArtifact,
  EvidenceArtifactDetail,
} from "../../../packages/observation-shared/src/evidence-contract";
import { HttpError } from "./http";

export async function catalogue<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "catalogue_read_failed");
  }
}

interface RunRow {
  id: number;
  source_id: string;
  producer_id: string;
  first_recorded_at_ms: number;
  sealed_at_ms: number;
  normalized_outcome: EvidenceRun["outcome"];
  started_at_ms: number | null;
  completed_at_ms: number | null;
  started_at_basis: EvidenceRun["startedAtBasis"];
  completed_at_basis: EvidenceRun["completedAtBasis"];
  expected_artifact_count: number;
}
export interface ArtifactRow {
  id: number;
  fetch_run_id: number;
  artifact_key: string;
  artifact_role: EvidenceArtifact["role"];
  payload_fidelity: EvidenceArtifact["payloadFidelity"];
  dataset: string | null;
  sha256: string;
  byte_size: number;
  recorded_at_ms: number;
  descriptor_sha256: string;
  container_kind: EvidenceArtifactDetail["artifact"]["containerKind"];
  lineage_disposition: EvidenceArtifactDetail["artifact"]["lineageDisposition"];
  format_id: string | null;
  format_version: string | null;
  declared_media_type: string | null;
  blob_key: string;
}

// financial_fetch_runs (raw-evidence migration 0004) excludes synthetic sources
// and runs annotated exclude_from_financial_views for both queries below.
const RUN_SELECT = `SELECT r.id, r.source_id, r.producer_id, r.first_recorded_at_ms,
 s.sealed_at_ms, p.normalized_outcome, p.started_at_ms, p.completed_at_ms,
 p.started_at_basis, p.completed_at_basis, i.expected_artifact_count
 FROM financial_fetch_runs r
 JOIN fetch_run_seals s ON s.fetch_run_id = r.id
 JOIN run_inventories i ON i.id = s.inventory_id AND i.fetch_run_id = r.id
 JOIN fetch_run_reports p ON p.fetch_run_id = r.id AND p.report_kind = 'terminal'`;

// Repeat visibility and inventory membership for artifact reads: a previous run lookup
// never grants access to an artifact outside that run's sealed inventory.
const ARTIFACT_SELECT = `SELECT a.id, a.fetch_run_id, a.artifact_key, a.artifact_role,
 a.payload_fidelity, a.dataset, a.sha256, a.byte_size, a.recorded_at_ms,
 a.descriptor_sha256, a.container_kind, a.lineage_disposition, a.format_id,
 a.format_version, a.declared_media_type, o.blob_key
 FROM fetch_artifacts a
 JOIN financial_fetch_runs r ON r.id = a.fetch_run_id
 JOIN fetch_run_seals s ON s.fetch_run_id = r.id
 JOIN run_inventory_items item ON item.inventory_id = s.inventory_id
   AND item.fetch_run_id = r.id AND item.artifact_key = a.artifact_key
   AND item.sha256 = a.sha256 AND item.descriptor_sha256 = a.descriptor_sha256
 JOIN raw_objects o ON o.sha256 = a.sha256 AND o.byte_size = a.byte_size
 WHERE r.source_id = ? AND a.source_id = r.source_id AND r.id = ?`;

const date = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();
function runDto(row: RunRow): EvidenceRun {
  return {
    id: `r_${row.id}`,
    sourceId: row.source_id,
    producerId: row.producer_id,
    recordedAt: date(row.first_recorded_at_ms)!,
    sealedAt: date(row.sealed_at_ms)!,
    outcome: row.normalized_outcome,
    startedAt: date(row.started_at_ms),
    startedAtBasis: row.started_at_basis,
    completedAt: date(row.completed_at_ms),
    completedAtBasis: row.completed_at_basis,
    artifactCount: row.expected_artifact_count,
  };
}
export function artifactDto(row: ArtifactRow): EvidenceArtifact {
  return {
    id: `a_${row.id}`,
    runId: `r_${row.fetch_run_id}`,
    artifactKey: row.artifact_key,
    role: row.artifact_role,
    payloadFidelity: row.payload_fidelity,
    dataset: row.dataset,
    sha256: row.sha256,
    byteSize: row.byte_size,
    recordedAt: date(row.recorded_at_ms)!,
  };
}
export function detailDto(row: ArtifactRow): EvidenceArtifactDetail["artifact"] {
  return {
    ...artifactDto(row),
    descriptorSha256: row.descriptor_sha256,
    containerKind: row.container_kind,
    lineageDisposition: row.lineage_disposition,
    formatId: row.format_id,
    formatVersion: row.format_version,
    declaredMediaType: row.declared_media_type,
  };
}
export async function listRuns(db: D1Database, source: string, before: number) {
  const { results } = await db
    .prepare(`${RUN_SELECT} WHERE r.source_id = ? AND r.id < ? ORDER BY r.id DESC LIMIT 51`)
    .bind(source, before)
    .all<RunRow>();
  return {
    items: results.slice(0, 50).map(runDto),
    nextCursor: results.length > 50 ? `c_${results[49].id}` : null,
  };
}
export async function getRun(db: D1Database, source: string, id: number): Promise<EvidenceRun> {
  const row = await db
    .prepare(`${RUN_SELECT} WHERE r.source_id = ? AND r.id = ?`)
    .bind(source, id)
    .first<RunRow>();
  if (!row) throw new HttpError(404, "not_found");
  return runDto(row);
}
export async function listArtifacts(db: D1Database, source: string, run: number, before: number) {
  const { results } = await db
    .prepare(`${ARTIFACT_SELECT} AND a.id < ? ORDER BY a.id DESC LIMIT 51`)
    .bind(source, run, before)
    .all<ArtifactRow>();
  return {
    items: results.slice(0, 50).map(artifactDto),
    nextCursor: results.length > 50 ? `c_${results[49].id}` : null,
  };
}
export async function getArtifact(
  db: D1Database,
  source: string,
  run: number,
  id: number,
): Promise<ArtifactRow> {
  const row = await db
    .prepare(`${ARTIFACT_SELECT} AND a.id = ?`)
    .bind(source, run, id)
    .first<ArtifactRow>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

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
