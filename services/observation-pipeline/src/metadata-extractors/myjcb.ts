// MyJCB statement state and period, read from the run's sanitized collector
// manifest. The rules are the ones `hydrateMeta` applied before A04, moved
// here unchanged so the compatibility release and the versioned release share
// one implementation and differ only in when they are allowed to run.
import {
  collectorManifest,
  MetadataError,
  record,
  type ExtractorContext,
  type MetadataArtifact,
  type MetadataExtraction,
} from "./types.ts";

export function acceptsMyJcb(row: MetadataArtifact): boolean {
  return row.source_id === "myjcb";
}

export async function extractMyJcb(
  context: ExtractorContext,
  row: MetadataArtifact,
): Promise<MetadataExtraction> {
  const { manifest, root } = await collectorManifest(context, row);
  const matching = (root.artifacts as unknown[])
    .map(record)
    .filter((entry) => `${String(entry.connectionId)}/${String(entry.filename)}` === row.artifact_key);
  if (matching.length !== 1) throw new MetadataError("manifest_artifact_mismatch");
  const match = matching[0]!;
  if (match.dataset !== row.dataset) throw new MetadataError("manifest_dataset_mismatch");
  if (match.statementState !== undefined && typeof match.statementState !== "string")
    throw new MetadataError("manifest_state_invalid");
  if (match.period !== undefined && typeof match.period !== "string")
    throw new MetadataError("manifest_period_invalid");
  const output = {
    mime: null,
    period: typeof match.period === "string" ? match.period : null,
    statementState: typeof match.statementState === "string" ? match.statementState : null,
  };
  return {
    // "The manifest says there is no statement state" is a completed
    // extraction, not a missing one: the row records that it ran.
    status: output.period === null && output.statementState === null ? "absent" : "ok",
    output,
    inputs: [{ artifactId: manifest.id, role: "collector_manifest", rawSha256: manifest.sha256 }],
    inputDigest: "",
    manifestArtifactId: manifest.id,
  };
}
