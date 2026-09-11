// Sony Bank wallet-history media type. Layer A records the declared media
// type of the artifact; for this dataset the collector manifest is the
// authority, and the parser is selected on the corrected value. The rule is
// the one `hydrateMeta` applied before A04, unchanged.
import {
  collectorManifest,
  MetadataError,
  record,
  type ExtractorContext,
  type MetadataArtifact,
  type MetadataExtraction,
} from "./types.ts";

const WALLET_HISTORY = /^wallet-history-\d{6}$/u;
const WALLET_HISTORY_MEDIA_TYPE = "text/html; charset=UTF-8";

export function acceptsSonyBank(row: MetadataArtifact): boolean {
  return row.source_id === "sony-bank" && WALLET_HISTORY.test(row.dataset ?? "");
}

export async function extractSonyBank(
  context: ExtractorContext,
  row: MetadataArtifact,
): Promise<MetadataExtraction> {
  const { manifest, root } = await collectorManifest(context, row);
  // The manifest entry is identified by the raw digest and size, never by a
  // name, so a renamed or re-encoded artifact cannot borrow another entry.
  const byteSize = await context.db
    .prepare("SELECT byte_size FROM raw_objects WHERE sha256=?")
    .bind(row.sha256)
    .first<number>("byte_size");
  const matches = (root.artifacts as unknown[])
    .map(record)
    .filter(
      (entry) =>
        entry.dataset === row.dataset && entry.sha256 === row.sha256 && entry.bytes === byteSize,
    );
  if (matches.length !== 1 || matches[0]!.mediaType !== WALLET_HISTORY_MEDIA_TYPE)
    throw new MetadataError("manifest_media_type_mismatch");
  return {
    status: "ok",
    output: { mime: WALLET_HISTORY_MEDIA_TYPE, period: null, statementState: null },
    inputs: [{ artifactId: manifest.id, role: "collector_manifest", rawSha256: manifest.sha256 }],
    inputDigest: "",
    manifestArtifactId: manifest.id,
  };
}
