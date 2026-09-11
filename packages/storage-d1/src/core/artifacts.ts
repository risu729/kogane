// The catalogue: `fetch_artifacts` and its children — ranges, transform steps
// and relations (migration 0001). One artifact is one row plus its children,
// written as a single D1 batch whose children all select the parent by
// (run, artifact_key), so nothing is recorded unless the artifact row was.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05; SQL unchanged.
import type {
  ArtifactRange,
  RelationClaim,
  TransformStep,
} from "../../../evidence-contract/src/descriptor.ts";
import type { D1Like, D1StatementLike, Row } from "../d1.ts";

/** Every column the read-back comparison checks, in one select. */
const ARTIFACT_COLUMNS = `id, producer_id, source_id, first_ingested_by_client_id, fetch_unit_id,
           page_group_id, artifact_role, payload_fidelity, container_kind,
           lineage_disposition, dataset, format_id, format_version, declared_media_type,
           media_type_basis, fetched_at_ms, fetched_at_basis, page_index, sequence,
           sha256, byte_size, descriptor_version, descriptor_sha256`;

export async function readArtifact(
  db: D1Like,
  runId: number,
  artifactKey: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
    SELECT ${ARTIFACT_COLUMNS}
    FROM fetch_artifacts WHERE fetch_run_id = ? AND artifact_key = ?
  `,
    )
    .bind(runId, artifactKey)
    .first<Row>();
}

/** The source a parent artifact belongs to; a relation may not cross sources. */
export async function readArtifactSource(
  db: D1Like,
  runId: number,
  artifactKey: string,
): Promise<{ source_id: string } | null> {
  return await db
    .prepare(
      `
      SELECT source_id FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `,
    )
    .bind(runId, artifactKey)
    .first<{ source_id: string }>();
}

export interface ArtifactInsert {
  runId: number;
  producerId: string;
  sourceId: string;
  clientId: string;
  fetchUnitId: number | null;
  pageGroupId: number | null;
  artifactKey: string;
  artifactRole: string;
  payloadFidelity: string;
  containerKind: string;
  lineageDisposition: string | null;
  dataset: string | null;
  formatId: string | null;
  formatVersion: string | null;
  declaredMediaType: string | null;
  mediaTypeBasis: string | null;
  fetchedAtMs: number | null;
  fetchedAtBasis: string | null;
  pageIndex: number | null;
  sequence: number | null;
  sha256: string;
  byteSize: number;
  descriptorSha256: string;
  now: number;
}

/** Statement 1 of the catalogue batch: the artifact row itself. */
export function artifactStatement(db: D1Like, input: ArtifactInsert): D1StatementLike {
  return db
    .prepare(
      `
    INSERT INTO fetch_artifacts (
      fetch_run_id, producer_id, source_id, first_ingested_by_client_id,
      fetch_unit_id, page_group_id, artifact_key, artifact_role, payload_fidelity,
      container_kind, lineage_disposition, dataset, format_id, format_version,
      declared_media_type, media_type_basis, fetched_at_ms, fetched_at_basis,
      page_index, sequence, sha256, byte_size, descriptor_version, descriptor_sha256,
      recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1', ?, ?)
  `,
    )
    .bind(
      input.runId,
      input.producerId,
      input.sourceId,
      input.clientId,
      input.fetchUnitId,
      input.pageGroupId,
      input.artifactKey,
      input.artifactRole,
      input.payloadFidelity,
      input.containerKind,
      input.lineageDisposition,
      input.dataset,
      input.formatId,
      input.formatVersion,
      input.declaredMediaType,
      input.mediaTypeBasis,
      input.fetchedAtMs,
      input.fetchedAtBasis,
      input.pageIndex,
      input.sequence,
      input.sha256,
      input.byteSize,
      input.descriptorSha256,
      input.now,
    );
}

export function rangeStatements(
  db: D1Like,
  runId: number,
  artifactKey: string,
  clientId: string,
  now: number,
  values: readonly ArtifactRange[],
): D1StatementLike[] {
  return values.map((value) =>
    db
      .prepare(
        `
      INSERT INTO artifact_ranges (
        fetch_artifact_id, range_key, range_kind, precision, start_value, end_value,
        start_inclusive, end_inclusive, basis, recorded_by_client_id, recorded_at_ms
      ) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `,
      )
      .bind(
        value.rangeKey,
        value.rangeKind,
        value.precision,
        value.startValue,
        value.endValue,
        value.startInclusive,
        value.endInclusive,
        value.basis,
        clientId,
        now,
        runId,
        artifactKey,
      ),
  );
}

export function transformStatements(
  db: D1Like,
  runId: number,
  artifactKey: string,
  clientId: string,
  now: number,
  values: readonly TransformStep[],
): D1StatementLike[] {
  return values.map((value) =>
    db
      .prepare(
        `
      INSERT INTO artifact_transform_steps (
        fetch_artifact_id, step_index, step_kind, transformer_id,
        transformer_version, recorded_by_client_id, recorded_at_ms
      ) SELECT id, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `,
      )
      .bind(
        value.stepIndex,
        value.stepKind,
        value.transformerId,
        value.transformerVersion,
        clientId,
        now,
        runId,
        artifactKey,
      ),
  );
}

export function relationStatements(
  db: D1Like,
  runId: number,
  artifactKey: string,
  clientId: string,
  now: number,
  values: readonly RelationClaim[],
): D1StatementLike[] {
  return values.map((value) =>
    db
      .prepare(
        `
      INSERT INTO artifact_relations (
        child_artifact_id, parent_artifact_id, relation, transformer_id,
        transformer_version, recorded_by_client_id, recorded_at_ms
      ) SELECT child.id, parent.id, ?, ?, ?, ?, ?
        FROM fetch_artifacts AS child, fetch_artifacts AS parent
       WHERE child.fetch_run_id = ? AND child.artifact_key = ?
         AND parent.fetch_run_id = ? AND parent.artifact_key = ?
    `,
      )
      .bind(
        value.relation,
        value.transformerId,
        value.transformerVersion,
        clientId,
        now,
        runId,
        artifactKey,
        value.parentRunId,
        value.parentArtifactKey,
      ),
  );
}

/** The recorded ranges of one artifact, in the descriptor's own order. */
export async function readArtifactRanges(
  db: D1Like,
  runId: number,
  artifactKey: string,
): Promise<ArtifactRange[]> {
  const result = await db
    .prepare(
      `
    SELECT r.range_key AS rangeKey, r.range_kind AS rangeKind, r.precision,
           r.start_value AS startValue, r.end_value AS endValue,
           r.start_inclusive AS startInclusive, r.end_inclusive AS endInclusive, r.basis
    FROM artifact_ranges AS r JOIN fetch_artifacts AS a ON a.id = r.fetch_artifact_id
    WHERE a.fetch_run_id = ? AND a.artifact_key = ? ORDER BY r.range_key COLLATE BINARY
  `,
    )
    .bind(runId, artifactKey)
    .all<ArtifactRange>();
  return result.results;
}

export async function readArtifactTransformSteps(
  db: D1Like,
  runId: number,
  artifactKey: string,
): Promise<TransformStep[]> {
  const result = await db
    .prepare(
      `
    SELECT t.step_index AS stepIndex, t.step_kind AS stepKind,
           t.transformer_id AS transformerId, t.transformer_version AS transformerVersion
    FROM artifact_transform_steps AS t JOIN fetch_artifacts AS a ON a.id = t.fetch_artifact_id
    WHERE a.fetch_run_id = ? AND a.artifact_key = ? ORDER BY t.step_index
  `,
    )
    .bind(runId, artifactKey)
    .all<TransformStep>();
  return result.results;
}

export async function readArtifactRelations(
  db: D1Like,
  runId: number,
  artifactKey: string,
): Promise<RelationClaim[]> {
  const result = await db
    .prepare(
      `
    SELECT parent.fetch_run_id AS parentRunId, parent.artifact_key AS parentArtifactKey,
           relation.relation, relation.transformer_id AS transformerId,
           relation.transformer_version AS transformerVersion
    FROM artifact_relations AS relation
    JOIN fetch_artifacts AS child ON child.id = relation.child_artifact_id
    JOIN fetch_artifacts AS parent ON parent.id = relation.parent_artifact_id
    WHERE child.fetch_run_id = ? AND child.artifact_key = ?
    ORDER BY parent.fetch_run_id, parent.artifact_key COLLATE BINARY, relation.relation COLLATE BINARY
  `,
    )
    .bind(runId, artifactKey)
    .all<RelationClaim>();
  return result.results;
}

/** How many origin rows of any kind the artifact has; the descriptor declares
 * exactly one per kind it names, so the count must match. */
export async function readArtifactOriginCount(
  db: D1Like,
  runId: number,
  artifactKey: string,
): Promise<{ origin_count: number } | null> {
  return await db
    .prepare(
      `
    SELECT
      (SELECT count(*) FROM artifact_http_metadata h WHERE h.fetch_artifact_id = a.id) +
      (SELECT count(*) FROM artifact_storage_metadata s WHERE s.fetch_artifact_id = a.id) +
      (SELECT count(*) FROM artifact_file_metadata f WHERE f.fetch_artifact_id = a.id) +
      (SELECT count(*) FROM artifact_email_metadata e WHERE e.fetch_artifact_id = a.id) AS origin_count
    FROM fetch_artifacts a WHERE a.fetch_run_id = ? AND a.artifact_key = ?
  `,
    )
    .bind(runId, artifactKey)
    .first<{ origin_count: number }>();
}

/** Children recorded by somebody other than this client: a catalogue conflict. */
export async function readArtifactForeignActors(
  db: D1Like,
  runId: number,
  artifactKey: string,
  clientId: string,
): Promise<{ bad: number } | null> {
  return await db
    .prepare(
      `
    SELECT count(*) AS bad FROM (
      SELECT recorded_by_client_id FROM artifact_ranges r JOIN fetch_artifacts a ON a.id=r.fetch_artifact_id WHERE a.fetch_run_id=? AND a.artifact_key=?
      UNION ALL SELECT recorded_by_client_id FROM artifact_transform_steps t JOIN fetch_artifacts a ON a.id=t.fetch_artifact_id WHERE a.fetch_run_id=? AND a.artifact_key=?
      UNION ALL SELECT recorded_by_client_id FROM artifact_relations r JOIN fetch_artifacts a ON a.id=r.child_artifact_id WHERE a.fetch_run_id=? AND a.artifact_key=?
    ) WHERE recorded_by_client_id <> ?
  `,
    )
    .bind(runId, artifactKey, runId, artifactKey, runId, artifactKey, clientId)
    .first<{ bad: number }>();
}

/** The run's whole catalogue, in the order a seal inventory must declare it. */
export async function readRunCatalogue(
  db: D1Like,
  runId: number,
): Promise<{ artifact_key: string; sha256: string; descriptor_sha256: string }[]> {
  const result = await db
    .prepare(
      `
    SELECT artifact_key, sha256, descriptor_sha256
    FROM fetch_artifacts WHERE fetch_run_id = ? ORDER BY artifact_key COLLATE BINARY
  `,
    )
    .bind(runId)
    .all<{ artifact_key: string; sha256: string; descriptor_sha256: string }>();
  return result.results;
}

/** The hashes one catalogued artifact carries, for an inventory item check. */
export async function readArtifactDigests(
  db: D1Like,
  runId: number,
  artifactKey: string,
): Promise<Row | null> {
  return await db
    .prepare(
      `
      SELECT sha256, descriptor_sha256 FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `,
    )
    .bind(runId, artifactKey)
    .first<Row>();
}
