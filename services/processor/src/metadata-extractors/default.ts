// Sources with no metadata sidecar. The extraction still runs and still
// produces a projection: "this artifact carries no statement state" is a
// result of the extractor, recorded with its release, and is different from
// "no extraction has been attempted".
import {
  EMPTY_METADATA_OUTPUT,
  type ExtractorContext,
  type MetadataArtifact,
  type MetadataExtraction,
} from "./types.ts";

export async function extractDefault(
  _context: ExtractorContext,
  _row: MetadataArtifact,
): Promise<MetadataExtraction> {
  return {
    status: "absent",
    output: EMPTY_METADATA_OUTPUT,
    // No sidecar evidence: the subject artifact is the projection's own key.
    inputs: [],
    inputDigest: "",
    manifestArtifactId: null,
  };
}
