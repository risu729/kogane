// Metadata extraction as a versioned transform (design review D02, A04).
//
// The values a parser sees beyond the raw bytes - a statement state, a
// statement period, a manifest-corrected media type - are interpretation
// results, not a cache. Each extraction therefore names the release that
// produced it and the evidence it read, and is stored as an append-only
// `metadata_projections` row (migration 0027). Reading the same evidence with
// a new extractor adds a row; the parse runs that used the old one keep
// pointing at it.

/** Releases known to this build. `legacy-metadata-v1` is the compatibility
 * extractor: exactly the rules `hydrateMeta` applied before A04, including
 * its reuse of an existing `observation_artifact_metadata` row. Its input
 * digest is always `unknown`, because the code that produced the historical
 * values is not recorded anywhere and is never reconstructed from today's. */
export const LEGACY_METADATA_RELEASE = "legacy-metadata-v1";
/** Re-reads the collector manifest every time and records the exact input
 * evidence, so a correction to the extraction rules can be applied and
 * compared without touching what an old parse read. */
export const MANIFEST_METADATA_RELEASE = "manifest-metadata-v2";
export const METADATA_EXTRACTOR_RELEASES = [
  LEGACY_METADATA_RELEASE,
  MANIFEST_METADATA_RELEASE,
] as const;
export type MetadataExtractorRelease = (typeof METADATA_EXTRACTOR_RELEASES)[number];
export function isMetadataExtractorRelease(value: string): value is MetadataExtractorRelease {
  return (METADATA_EXTRACTOR_RELEASES as readonly string[]).includes(value);
}

/** Safe failure codes only; never provider text, values or URLs. */
export class MetadataError extends Error {}

/** The parser-visible metadata one extraction produced. `mime` is null when
 * the extractor makes no claim and Layer A's declared media type stands. */
export interface MetadataOutput {
  mime: string | null;
  period: string | null;
  statementState: string | null;
}
export const EMPTY_METADATA_OUTPUT: MetadataOutput = {
  mime: null,
  period: null,
  statementState: null,
};

export interface MetadataInput {
  artifactId: number;
  role: string;
  rawSha256: string;
}

export interface MetadataExtraction {
  /** 'ok' produced a value, 'absent' read the inputs and there is none,
   * 'error' could not complete. The row exists in all three cases, which is
   * what distinguishes "no value" from "never extracted". */
  status: "ok" | "absent" | "error";
  output: MetadataOutput;
  inputs: MetadataInput[];
  /** Digest of the evidence read, or 'unknown' for the compatibility path. */
  inputDigest: string;
  /** Manifest artifact recorded by `observation_artifact_metadata`, if any. */
  manifestArtifactId: number | null;
  errorCode?: string;
}

/** The artifact fields every extractor may read. */
export interface MetadataArtifact {
  id: number;
  fetch_run_id: number;
  source_id: string;
  dataset: string | null;
  artifact_key: string;
  mime: string;
  sha256: string;
}

export interface ManifestArtifactRow {
  id: number;
  blob_key: string;
  byte_size: number;
  sha256: string;
}

/** Everything an extractor needs from the runtime, so extractors stay free of
 * the Worker's `Env` and can be exercised directly by tests. */
export interface ExtractorContext {
  db: D1Database;
  /** Raw bytes of an artifact, checksum-verified by the caller. */
  read(row: ManifestArtifactRow): Promise<Uint8Array>;
}

export interface MetadataExtractor {
  release: MetadataExtractorRelease;
  extract(context: ExtractorContext, row: MetadataArtifact): Promise<MetadataExtraction>;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MetadataError("manifest_shape_invalid");
  return value as Record<string, unknown>;
}

/** The run's collector manifest, with the columns needed to verify its bytes. */
export async function collectorManifest(
  context: ExtractorContext,
  row: MetadataArtifact,
): Promise<{ manifest: ManifestArtifactRow; root: Record<string, unknown> }> {
  const manifest = await context.db
    .prepare(
      "SELECT a.id,o.blob_key,o.byte_size,o.sha256 FROM fetch_artifacts a JOIN raw_objects o ON o.sha256=a.sha256 WHERE a.fetch_run_id=? AND a.artifact_role='collector_manifest' AND a.artifact_key='manifest.json'",
    )
    .bind(row.fetch_run_id)
    .first<ManifestArtifactRow>();
  if (!manifest) throw new MetadataError("metadata_manifest_missing");
  const root = record(JSON.parse(new TextDecoder().decode(await context.read(manifest))));
  if (!Array.isArray(root.artifacts)) throw new MetadataError("manifest_shape_invalid");
  return { manifest, root };
}
