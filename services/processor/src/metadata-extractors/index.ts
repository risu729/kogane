// Selection and persistence of metadata projections (D02, A04).
//
// Two releases exist in this build.
//
//   legacy-metadata-v1  The compatibility extractor: the rules `hydrateMeta`
//                       applied before A04 (plus the MyJCB shared-manifest
//                       lookup for inputs they refused, ADR 0025), including
//                       reusing an existing `observation_artifact_metadata`
//                       row for MyJCB and re-reading the Sony Bank media type every
//                       time. It keeps writing that table, so the
//                       `observation_fetch_artifacts` view and every reader
//                       are unchanged. Its `input_digest` is `unknown`: the
//                       inputs of the historical extraction are not recorded,
//                       and today's code digest is never substituted for them.
//
//   manifest-metadata-v2  Re-reads the collector manifest every time and
//                       records the exact input evidence and its digest. It
//                       never writes `observation_artifact_metadata`, so
//                       running it changes nothing a reader sees until a
//                       parse of a release that names it is adopted.
//
// An explicit re-extraction never skips because a value already exists; that
// is the acceptance condition of D02.
import {
  canonicalDigest,
  canonicalJson,
  sha256Hex,
} from "../../../../packages/domain/src/context.ts";
import { extractDefault } from "./default.ts";
import { acceptsMyJcb, extractMyJcb } from "./myjcb.ts";
import { acceptsSonyBank, extractSonyBank } from "./sony-bank.ts";
import {
  EMPTY_METADATA_OUTPUT,
  LEGACY_METADATA_RELEASE,
  MetadataError,
  type ExtractorContext,
  type MetadataArtifact,
  type MetadataExtraction,
  type MetadataExtractorRelease,
  type MetadataOutput,
} from "./types.ts";

export * from "./types.ts";

/** Digest of the evidence an extraction read: the subject artifact's identity
 * plus every input in a canonical order. Two extractions with the same digest
 * and the same release are the same extraction, which is what makes the
 * `metadata_projections` unique key meaningful. */
async function metadataInputDigest(
  row: MetadataArtifact,
  extraction: MetadataExtraction,
): Promise<string> {
  return canonicalDigest({
    artifact: {
      artifactKey: row.artifact_key,
      dataset: row.dataset,
      sha256: row.sha256,
      sourceId: row.source_id,
    },
    inputs: [...extraction.inputs]
      .map((input) => ({ ...input }))
      .sort((a, b) =>
        a.artifactId === b.artifactId ? (a.role < b.role ? -1 : 1) : a.artifactId - b.artifactId,
      ),
    scheme: "metadata-input-v1",
  });
}

/** The versioned extractor for one artifact: manifest rules per source, and
 * an explicit "this source carries no metadata" result otherwise. */
async function extractVersioned(
  context: ExtractorContext,
  row: MetadataArtifact,
): Promise<MetadataExtraction> {
  if (acceptsMyJcb(row)) return extractMyJcb(context, row);
  if (acceptsSonyBank(row)) return extractSonyBank(context, row);
  return extractDefault(context, row);
}

/**
 * The compatibility extractor. Behaviour is byte-for-byte the pre-A04
 * `hydrateMeta`: a stored MyJCB value wins over the manifest, the Sony Bank
 * media type is verified on every run, and `observation_artifact_metadata`
 * receives the same row, kept only the first time: a later run skips the
 * existing artifact key (`ON CONFLICT(fetch_artifact_id) DO NOTHING`). The
 * table has no CHECK or NOT NULL, so that is the pre-A04 `INSERT OR IGNORE`'s
 * behaviour for every row the table accepts; a constraint added later raises.
 */
async function extractLegacy(
  context: ExtractorContext,
  row: MetadataArtifact,
): Promise<MetadataExtraction> {
  const previous = await context.db
    .prepare(
      "SELECT statement_state,period FROM observation_artifact_metadata WHERE fetch_artifact_id=?",
    )
    .bind(row.id)
    .first<{ statement_state: string | null; period: string | null }>();
  const output: MetadataOutput = {
    ...EMPTY_METADATA_OUTPUT,
    period: previous?.period ?? null,
    statementState: previous?.statement_state ?? null,
  };
  const inputs: MetadataExtraction["inputs"] = [];
  let manifestArtifactId: number | null = null;
  if (acceptsMyJcb(row) && !previous) {
    const extracted = await extractMyJcb(context, row);
    output.period = extracted.output.period;
    output.statementState = extracted.output.statementState;
    manifestArtifactId = extracted.manifestArtifactId;
    inputs.push(...extracted.inputs);
  }
  if (acceptsSonyBank(row)) {
    const extracted = await extractSonyBank(context, row);
    output.mime = extracted.output.mime;
    manifestArtifactId = extracted.manifestArtifactId;
    inputs.push(...extracted.inputs);
  }
  await context.db
    .prepare(
      "INSERT INTO observation_artifact_metadata(fetch_artifact_id,statement_state,period,metadata_manifest_artifact_id) VALUES(?,?,?,?) ON CONFLICT(fetch_artifact_id) DO NOTHING",
    )
    .bind(row.id, output.statementState, output.period, manifestArtifactId)
    .run();
  return {
    // Mirrors the legacy table: the media type correction is applied to the
    // parser's metadata but is not part of what `legacy-metadata-v1` records,
    // so a Worker-written projection and a 0027-backfilled one are identical.
    status: output.period === null && output.statementState === null ? "absent" : "ok",
    output,
    inputs,
    // Never a digest of today's code standing in as evidence of a past run.
    inputDigest: "unknown",
    manifestArtifactId,
  };
}

/** Runs `release` over one artifact. Errors are returned, not thrown, when
 * `captureErrors` is set, so a bounded re-extraction can record which
 * artifacts fail without aborting the batch. */
export async function extractMetadata(
  context: ExtractorContext,
  row: MetadataArtifact,
  release: MetadataExtractorRelease,
  captureErrors = false,
): Promise<MetadataExtraction> {
  try {
    const extraction =
      release === LEGACY_METADATA_RELEASE
        ? await extractLegacy(context, row)
        : await extractVersioned(context, row);
    return {
      ...extraction,
      inputDigest:
        extraction.inputDigest === "unknown"
          ? "unknown"
          : await metadataInputDigest(row, extraction),
    };
  } catch (error) {
    const code = error instanceof MetadataError ? error.message : "metadata_extraction_failed";
    if (!captureErrors) throw error;
    return {
      status: "error",
      output: EMPTY_METADATA_OUTPUT,
      inputs: [{ artifactId: row.id, role: "subject", rawSha256: row.sha256 }],
      inputDigest: `error:${code}`,
      manifestArtifactId: null,
      errorCode: code,
    };
  }
}

/** `legacy-metadata-v1` records exactly the two fields
 * `observation_artifact_metadata` holds, which is what migration 0027
 * backfills; later releases record the whole output. */
function outputJson(release: MetadataExtractorRelease, extraction: MetadataExtraction): string {
  if (extraction.errorCode !== undefined)
    return canonicalJson({ errorCode: extraction.errorCode, ...extraction.output });
  if (release === LEGACY_METADATA_RELEASE)
    return canonicalJson({
      period: extraction.output.period,
      statementState: extraction.output.statementState,
    });
  return canonicalJson(extraction.output);
}

/** One input of the projection the same batch wrote or skipped, found by its
 * unique key. The `WHERE` also keeps SQLite from reading `ON CONFLICT` as a
 * join constraint of the `SELECT`. */
const PROJECTION_INPUT_INSERT_SQL = `INSERT INTO metadata_projection_inputs
    (projection_id,input_artifact_id,role,raw_sha256)
  SELECT id,?4,?5,?6 FROM metadata_projections
  WHERE fetch_artifact_id=?1 AND extractor_release=?2 AND input_digest=?3
  ON CONFLICT(projection_id,input_artifact_id,role) DO NOTHING`;

/**
 * Appends the projection and its inputs, and returns its id. Idempotent: the
 * unique key (artifact, release, input digest) means the same evidence read
 * by the same extractor is one row, however often it is recomputed, and an
 * input is one row per (projection, artifact, role). Only those keys are
 * skipped (`ON CONFLICT(<key>) DO NOTHING`; the projection's `id` is never
 * supplied): a projection or an input the schema refuses (a CHECK or NOT NULL
 * failure) raises. `OR IGNORE` skipped a refused input without an error, so
 * the projection was kept without that input and read as complete.
 *
 * The projection and its inputs are one D1 batch, and each input finds its
 * projection by that unique key inside the batch, so a refused input rolls
 * back the projection it belongs to: no projection is written without its
 * inputs. A projection an earlier call already wrote is the key the batch
 * skips, so a refused input then adds nothing to it either.
 */
export async function persistProjection(
  db: D1Database,
  row: MetadataArtifact,
  release: MetadataExtractorRelease,
  extraction: MetadataExtraction,
  now: string,
): Promise<number> {
  const json = outputJson(release, extraction);
  const outputDigest = await sha256Hex(json);
  await db.batch([
    db
      .prepare(
        `INSERT INTO metadata_projections
          (fetch_artifact_id,extractor_release,input_digest,output_json,output_digest,status,created_at)
          VALUES(?1,?2,?3,?4,?5,?6,?7)
          ON CONFLICT(fetch_artifact_id,extractor_release,input_digest) DO NOTHING`,
      )
      .bind(row.id, release, extraction.inputDigest, json, outputDigest, extraction.status, now),
    ...extraction.inputs.map((input) =>
      db
        .prepare(PROJECTION_INPUT_INSERT_SQL)
        .bind(
          row.id,
          release,
          extraction.inputDigest,
          input.artifactId,
          input.role,
          input.rawSha256,
        ),
    ),
  ]);
  const id = await db
    .prepare(
      "SELECT id FROM metadata_projections WHERE fetch_artifact_id=? AND extractor_release=? AND input_digest=?",
    )
    .bind(row.id, release, extraction.inputDigest)
    .first<number>("id");
  if (id === null || id === undefined) throw new MetadataError("metadata_projection_missing");
  return id;
}
