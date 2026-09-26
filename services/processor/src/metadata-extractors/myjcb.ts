// MyJCB statement state and period, read from the run's sanitized collector
// manifest. The importer-shape rules are the ones `hydrateMeta` applied before
// A04, moved here unchanged so the compatibility release and the versioned
// release share one implementation and differ only in when they are allowed
// to run.
//
// Two manifest shapes exist (ADR 0025):
//
//   importer  The retired importer's central manifest (runs before U09). Each
//             artifact entry carries `connectionId` and `filename` and is
//             found by the artifact key they form. This branch is frozen:
//             every input it completed before completes identically.
//   shared    The collector's own manifest in the shared bucket
//             (`myJcbRunPlan`, U09). An entry carries no connection and no
//             file name, only the content-addressed object it names, so it is
//             found by that object - the artifact's own digest and size -
//             and never by position or by a name the entry does not state.
//             It is read only when no entry carries `connectionId` or
//             `filename`, which is only for manifests the importer branch
//             always refused with `manifest_artifact_mismatch`.
import { objectKey } from "../../../../packages/collection/src/keys.ts";
import {
  collectorManifest,
  MetadataError,
  record,
  type ExtractorContext,
  type ManifestArtifactRow,
  type MetadataArtifact,
  type MetadataExtraction,
} from "./types.ts";

export function acceptsMyJcb(row: MetadataArtifact): boolean {
  return row.source_id === "myjcb";
}

/** `<connectionId>/<filename>`: the artifact key both manifest eras use. */
const ARTIFACT_KEY = /^([^/]+)\/[^/]+$/u;

interface StatementMetadata {
  period: string | null;
  statementState: string | null;
}

export async function extractMyJcb(
  context: ExtractorContext,
  row: MetadataArtifact,
): Promise<MetadataExtraction> {
  const { manifest, root } = await collectorManifest(context, row);
  const entries = (root.artifacts as unknown[]).map(record);
  const matching = entries.filter(
    (entry) => `${String(entry.connectionId)}/${String(entry.filename)}` === row.artifact_key,
  );
  if (matching.length !== 1) {
    if (
      matching.length === 0 &&
      entries.length > 0 &&
      entries.every((entry) => entry.connectionId === undefined && entry.filename === undefined)
    )
      return extractShared(context, row, manifest, root, entries);
    throw new MetadataError("manifest_artifact_mismatch");
  }
  const match = matching[0]!;
  if (match.dataset !== row.dataset) throw new MetadataError("manifest_dataset_mismatch");
  return extraction(manifest, statementMetadata(match));
}

/**
 * The shared-bucket manifest. The artifact's connection is the one its key
 * names (the terminal unit the collector wrote), and it must be a connection
 * the manifest lists. Its entry is the one naming this artifact's object: the
 * same digest, the same size and the content-addressed key of that digest.
 * The same bytes written twice in one run (two connections with an identical
 * empty ledger, say) are several entries; their metadata is used only when
 * every one of them states the same values, and otherwise the extraction
 * refuses (`manifest_artifact_ambiguous`) rather than choose one.
 */
async function extractShared(
  context: ExtractorContext,
  row: MetadataArtifact,
  manifest: ManifestArtifactRow,
  root: Record<string, unknown>,
  entries: readonly Record<string, unknown>[],
): Promise<MetadataExtraction> {
  const connection = ARTIFACT_KEY.exec(row.artifact_key)?.[1];
  const connections = Array.isArray(root.connections) ? root.connections.map(record) : [];
  if (connection === undefined || !connections.some((c) => c.connectionId === connection))
    throw new MetadataError("manifest_artifact_mismatch");
  const byteSize = await context.db
    .prepare("SELECT byte_size FROM raw_objects WHERE sha256=?")
    .bind(row.sha256)
    .first<number>("byte_size");
  const key = objectKey(row.sha256);
  const named = entries.filter(
    (entry) => entry.sha256 === row.sha256 && entry.bytes === byteSize && entry.key === key,
  );
  if (named.length === 0) throw new MetadataError("manifest_artifact_mismatch");
  const sameDataset = named.filter((entry) => entry.dataset === row.dataset);
  if (sameDataset.length === 0) throw new MetadataError("manifest_dataset_mismatch");
  const stated = sameDataset.map(statementMetadata);
  const first = stated[0]!;
  if (
    stated.some(
      (value) => value.period !== first.period || value.statementState !== first.statementState,
    )
  )
    throw new MetadataError("manifest_artifact_ambiguous");
  return extraction(manifest, first);
}

/** The statement state and period one manifest entry states, each or null. */
function statementMetadata(entry: Record<string, unknown>): StatementMetadata {
  if (entry.statementState !== undefined && typeof entry.statementState !== "string")
    throw new MetadataError("manifest_state_invalid");
  if (entry.period !== undefined && typeof entry.period !== "string")
    throw new MetadataError("manifest_period_invalid");
  return {
    period: typeof entry.period === "string" ? entry.period : null,
    statementState: typeof entry.statementState === "string" ? entry.statementState : null,
  };
}

function extraction(manifest: ManifestArtifactRow, stated: StatementMetadata): MetadataExtraction {
  const output = { mime: null, period: stated.period, statementState: stated.statementState };
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
