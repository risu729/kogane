// Cataloguing an artifact: the row that says "this run fetched these bytes,
// from this origin, through these transforms, in this relation to that other
// artifact".
//
// Three things make this safe to retry and impossible to forge:
//
//   * the descriptor digest is recomputed here from the server's own validated
//     parse; a client-supplied hash is never stored;
//   * the artifact row and every child row are one D1 batch whose children
//     select the parent by (run, artifact_key), so a failed parent leaves no
//     orphan child;
//   * a second call with the same artifact key is compared column by column
//     against what is stored, children included, and a difference is a
//     conflict rather than an overwrite.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05.
import { canonicalJsonV1 } from "../../../evidence-contract/src/json.ts";
import type { JsonValue } from "../../../evidence-contract/src/json.ts";
import {
  descriptorContractV1,
  type CanonicalDescriptorV1,
} from "../../../evidence-contract/src/descriptor.ts";
import {
  artifactStatement,
  rangeStatements,
  readArtifact,
  readArtifactForeignActors,
  readArtifactOriginCount,
  readArtifactRanges,
  readArtifactRelations,
  readArtifactSource,
  readArtifactTransformSteps,
  relationStatements,
  transformStatements,
} from "../../../storage-d1/src/core/artifacts.ts";
import { originStatements } from "../../../storage-d1/src/core/origins.ts";
import { readRawObjectSize } from "../../../storage-d1/src/core/raw-objects.ts";
import type { D1StatementLike } from "../../../storage-d1/src/d1.ts";
import { runBatch } from "../../../storage-d1/src/d1.ts";
import { loadRun } from "./access.ts";
import {
  assertSame,
  IngestError,
  type IngestEnv,
  type RecordValue,
} from "./contract.ts";
import { validateOriginScope } from "./origins.ts";

/** Validated, normalized artifact descriptor: the shape whose canonical bytes
 * are hashed into fetch_artifacts.descriptor_sha256 (descriptor-v1). */
type ArtifactInput = CanonicalDescriptorV1;

export interface CataloguedArtifact {
  artifactId: number;
  descriptorSha256: string;
}

export async function addArtifact(
  env: IngestEnv,
  clientId: string,
  runId: number,
  body: RecordValue,
): Promise<CataloguedArtifact> {
  const run = await loadRun(env, clientId, runId);
  // The shared contract validates the body (unknown keys rejected) and
  // normalizes it exactly as the ingest client does.
  const input = descriptorContractV1.normalize(
    descriptorContractV1.parseRequest(body, { runId }),
  );
  const objectRow = await readRawObjectSize(env.DB, input.sha256);
  if (!objectRow) throw new IngestError(409, "raw_object_missing");
  if (objectRow.byte_size !== input.byteSize)
    throw new IngestError(409, "raw_object_size_conflict");
  await validateOriginScope(env, run.source_id, input.origins);
  for (const relation of input.relations) {
    const parent = await readArtifactSource(
      env.DB,
      relation.parentRunId,
      relation.parentArtifactKey,
    );
    if (!parent) throw new IngestError(409, "parent_artifact_missing");
    if (parent.source_id !== run.source_id)
      throw new IngestError(409, "parent_artifact_source_mismatch");
  }

  // Never trust a client-supplied descriptor hash. The digest is always
  // recomputed here from the server's own validated parse; inventory items
  // and seals that carry a different value are rejected as conflicts.
  const descriptorSha256 = await descriptorContractV1.digest(descriptorContractV1.encode(input));
  const existing = await readArtifact(env.DB, runId, input.artifactKey);
  const expectedArtifact = artifactExpected(input, run, clientId, descriptorSha256);
  if (existing) {
    assertSame(existing, expectedArtifact, "fetch_artifact_conflict");
    await assertArtifactChildren(env, runId, input, clientId);
    return { artifactId: existing.id as number, descriptorSha256 };
  }

  const now = Date.now();
  const statements: D1StatementLike[] = [
    artifactStatement(env.DB, {
      runId,
      producerId: run.producer_id,
      sourceId: run.source_id,
      clientId,
      fetchUnitId: input.fetchUnitId,
      pageGroupId: input.pageGroupId,
      artifactKey: input.artifactKey,
      artifactRole: input.artifactRole,
      payloadFidelity: input.payloadFidelity,
      containerKind: input.containerKind,
      lineageDisposition: input.lineageDisposition,
      dataset: input.dataset,
      formatId: input.formatId,
      formatVersion: input.formatVersion,
      declaredMediaType: input.declaredMediaType,
      mediaTypeBasis: input.mediaTypeBasis,
      fetchedAtMs: input.fetchedAtMs,
      fetchedAtBasis: input.fetchedAtBasis,
      pageIndex: input.pageIndex,
      sequence: input.sequence,
      sha256: input.sha256,
      byteSize: input.byteSize,
      descriptorSha256,
      now,
    }),
  ];
  statements.push(...originStatements(env.DB, runId, input.artifactKey, input.origins));
  statements.push(
    ...rangeStatements(env.DB, runId, input.artifactKey, clientId, now, input.ranges),
  );
  statements.push(
    ...transformStatements(env.DB, runId, input.artifactKey, clientId, now, input.transformSteps),
  );
  statements.push(
    ...relationStatements(env.DB, runId, input.artifactKey, clientId, now, input.relations),
  );
  try {
    await runBatch(env.DB, statements);
  } catch (originalError) {
    let raced: RecordValue | null;
    try {
      raced = await readArtifact(env.DB, runId, input.artifactKey);
      if (!raced) throw originalError;
      assertSame(raced, expectedArtifact, "fetch_artifact_conflict");
      await assertArtifactChildren(env, runId, input, clientId);
      return { artifactId: raced.id as number, descriptorSha256 };
    } catch (reconciliationError) {
      if (reconciliationError instanceof IngestError && reconciliationError.status === 409) {
        throw reconciliationError;
      }
      throw originalError;
    }
  }

  const artifact = await readArtifact(env.DB, runId, input.artifactKey);
  assertSame(artifact, expectedArtifact, "fetch_artifact_conflict");
  await assertArtifactChildren(env, runId, input, clientId);
  return { artifactId: artifact!.id as number, descriptorSha256 };
}

function artifactExpected(
  input: ArtifactInput,
  run: { producer_id: string; source_id: string },
  clientId: string,
  descriptorSha256: string,
): RecordValue {
  return {
    producer_id: run.producer_id,
    source_id: run.source_id,
    first_ingested_by_client_id: clientId,
    fetch_unit_id: input.fetchUnitId,
    page_group_id: input.pageGroupId,
    artifact_role: input.artifactRole,
    payload_fidelity: input.payloadFidelity,
    container_kind: input.containerKind,
    lineage_disposition: input.lineageDisposition,
    dataset: input.dataset,
    format_id: input.formatId,
    format_version: input.formatVersion,
    declared_media_type: input.declaredMediaType,
    media_type_basis: input.mediaTypeBasis,
    fetched_at_ms: input.fetchedAtMs,
    fetched_at_basis: input.fetchedAtBasis,
    page_index: input.pageIndex,
    sequence: input.sequence,
    sha256: input.sha256,
    byte_size: input.byteSize,
    descriptor_version: "v1",
    descriptor_sha256: descriptorSha256,
  };
}

/**
 * The children of an already-catalogued artifact must equal the ones this
 * request declares — compared as canonical JSON, so order and shape count —
 * and must have been recorded by the same client.
 */
async function assertArtifactChildren(
  env: IngestEnv,
  runId: number,
  input: ArtifactInput,
  clientId: string,
): Promise<void> {
  const ranges = await readArtifactRanges(env.DB, runId, input.artifactKey);
  const steps = await readArtifactTransformSteps(env.DB, runId, input.artifactKey);
  const relations = await readArtifactRelations(env.DB, runId, input.artifactKey);
  if (
    canonicalJsonV1(ranges as unknown as JsonValue) !==
      canonicalJsonV1(input.ranges as unknown as JsonValue) ||
    canonicalJsonV1(steps as unknown as JsonValue) !==
      canonicalJsonV1(input.transformSteps as unknown as JsonValue) ||
    canonicalJsonV1(relations as unknown as JsonValue) !==
      canonicalJsonV1(input.relations as unknown as JsonValue)
  ) {
    throw new IngestError(409, "artifact_children_conflict");
  }
  const originCount = Object.values(input.origins).filter((value) => value !== null).length;
  const counts = await readArtifactOriginCount(env.DB, runId, input.artifactKey);
  if (counts?.origin_count !== originCount) throw new IngestError(409, "artifact_origin_conflict");
  const actorRows = await readArtifactForeignActors(env.DB, runId, input.artifactKey, clientId);
  if ((actorRows?.bad ?? 0) !== 0) throw new IngestError(409, "artifact_actor_conflict");
}
