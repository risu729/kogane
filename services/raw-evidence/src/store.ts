import {
  descriptorContractV1,
  type ArtifactRange,
  type CanonicalDescriptorV1,
  type RelationClaim,
  type TransformStep,
} from "../../../packages/evidence-contract/src/descriptor";
import {
  parseAddInventoryItemsRequest,
  parseBeginInventoryRequest,
  parseCreateRunRequest,
  parseAddRunReportRequest,
  parseRecordAttemptRequest,
  parseSealRunRequest,
  parseSealStagedInventoryRequest,
  type InventoryItem,
} from "../../../packages/evidence-contract/src/requests";
import { canonicalJson, hexBytes, type JsonValue, sha256Hex } from "./canonical";
import {
  ApiError,
  SHA256,
  assertSame,
  loadRun,
  readJson,
  requireRoute,
  type RecordValue,
  type WorkerEnv,
} from "./http";
import { originStatements, validateOriginScope } from "./origins";

const DEFAULT_MAX_OBJECT_BYTES = 50 * 1024 * 1024;

export async function putObject(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
  sha256: string,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  if (!SHA256.test(sha256)) throw new ApiError(400, "invalid_sha256");
  const sizeHeader = request.headers.get("x-kogane-byte-size");
  const contentLength = request.headers.get("content-length");
  if (!sizeHeader || !contentLength || !/^\d+$/.test(sizeHeader) || !/^\d+$/.test(contentLength)) {
    throw new ApiError(411, "byte_size_required");
  }
  const byteSize = Number(sizeHeader);
  const maxObjectBytes = Number(env.MAX_OBJECT_BYTES ?? DEFAULT_MAX_OBJECT_BYTES);
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) {
    throw new ApiError(503, "object_limit_configuration_invalid");
  }
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maxObjectBytes) {
    throw new ApiError(413, "object_too_large");
  }
  if (Number(contentLength) !== byteSize) {
    throw new ApiError(400, "byte_size_mismatch");
  }

  const blobKey = `objects/${sha256.slice(0, 2)}/${sha256}`;
  let reused = false;
  const existing = await env.EVIDENCE.head(blobKey);
  if (existing) {
    verifyR2Object(existing, sha256, byteSize);
    reused = true;
  } else {
    let stored: R2Object | null;
    try {
      stored = await env.EVIDENCE.put(blobKey, request.body ?? new Uint8Array(), {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: hexBytes(sha256),
        customMetadata: { sha256, byteSize: String(byteSize) },
        httpMetadata: { contentType: "application/octet-stream" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/sha.?256|checksum|digest/i.test(message)) {
        throw new ApiError(422, "object_checksum_mismatch");
      }
      throw error;
    }
    if (!stored) {
      const winner = await env.EVIDENCE.head(blobKey);
      if (!winner) throw new ApiError(409, "r2_object_race_conflict");
      verifyR2Object(winner, sha256, byteSize);
      reused = true;
    } else {
      verifyR2Object(stored, sha256, byteSize, 422, "object_checksum_mismatch");
    }
  }

  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO raw_objects (sha256, byte_size, blob_key, first_stored_at_ms)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM raw_objects WHERE sha256 = ?
    )
  `)
    .bind(sha256, byteSize, blobKey, now, sha256)
    .run();
  const row = await env.DB.prepare(`
    SELECT sha256, byte_size, blob_key FROM raw_objects WHERE sha256 = ?
  `)
    .bind(sha256)
    .first<RecordValue>();
  assertSame(row, { sha256, byte_size: byteSize, blob_key: blobKey }, "raw_object_conflict");
  return { sha256, byteSize, reused, recordedBy: clientId, authorizedByRunId: runId };
}

function verifyR2Object(
  object: R2Object,
  sha256: string,
  byteSize: number,
  status = 409,
  code = "r2_object_conflict",
): void {
  const nativeSha256 = object.checksums.sha256;
  const nativeHex = nativeSha256
    ? [...new Uint8Array(nativeSha256)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    : null;
  if (
    object.size !== byteSize ||
    object.customMetadata?.sha256 !== sha256 ||
    object.customMetadata?.byteSize !== String(byteSize) ||
    nativeHex !== sha256 ||
    object.httpMetadata?.contentType !== "application/octet-stream"
  ) {
    throw new ApiError(status, code);
  }
}

export async function verifyObject(
  env: WorkerEnv,
  clientId: string,
  runId: number,
  sha256: string,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  if (!SHA256.test(sha256)) throw new ApiError(400, "invalid_sha256");
  const authorized = await env.DB.prepare(`
    SELECT 1 AS ok FROM fetch_artifacts WHERE fetch_run_id = ? AND sha256 = ? LIMIT 1
  `)
    .bind(runId, sha256)
    .first<{ ok: number }>();
  if (!authorized) throw new ApiError(404, "raw_object_not_found");
  const row = await env.DB.prepare(`
    SELECT byte_size, blob_key FROM raw_objects WHERE sha256 = ?
  `)
    .bind(sha256)
    .first<{ byte_size: number; blob_key: string }>();
  if (!row) throw new ApiError(404, "raw_object_not_found");
  const recent = await env.DB.prepare(`
    SELECT id, result FROM raw_object_verification_events
    WHERE sha256 = ? AND checked_by_client_id = ? AND checked_at_ms >= ?
    ORDER BY checked_at_ms DESC, id DESC LIMIT 1
  `)
    .bind(sha256, clientId, Date.now() - 300_000)
    .first<{ id: number; result: string }>();
  if (recent) {
    return { verificationEventId: recent.id, sha256, result: recent.result, reused: true };
  }
  let result: "ok" | "missing" | "size_mismatch" | "hash_mismatch" | "read_error";
  let observedSize: number | null = null;
  let observedSha256: string | null = null;
  let detailCode: string | null = null;
  try {
    const stored = await env.EVIDENCE.head(row.blob_key);
    if (!stored) {
      result = "missing";
    } else {
      observedSize = stored.size;
      const native = stored.checksums.sha256;
      observedSha256 = native
        ? [...new Uint8Array(native)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
        : null;
      if (observedSize !== row.byte_size) result = "size_mismatch";
      else if (observedSha256 === null) {
        result = "read_error";
        detailCode = "native_checksum_unavailable";
      } else if (observedSha256 !== sha256) result = "hash_mismatch";
      else if (
        stored.customMetadata?.sha256 !== sha256 ||
        stored.customMetadata?.byteSize !== String(row.byte_size) ||
        stored.httpMetadata?.contentType !== "application/octet-stream"
      ) {
        result = "read_error";
        detailCode = "metadata_mismatch";
      } else result = "ok";
    }
  } catch {
    result = "read_error";
    detailCode = "r2_head_failed";
  }
  const now = Date.now();
  const inserted = await env.DB.prepare(`
    INSERT INTO raw_object_verification_events (
      sha256, checked_at_ms, result, observed_size, observed_sha256,
      detail_code, checked_by_client_id, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `)
    .bind(sha256, now, result, observedSize, observedSha256, detailCode, clientId, now)
    .first<{ id: number }>();
  return { verificationEventId: inserted!.id, sha256, result, reused: false };
}

export async function createRun(
  request: Request,
  env: WorkerEnv,
  clientId: string,
): Promise<Record<string, JsonValue>> {
  const {
    producerId,
    sourceId,
    externalIdNamespace: namespace,
    externalSessionId,
    sourceRunKey,
  } = parseCreateRunRequest(await readJson(request));
  await requireRoute(env, clientId, producerId, sourceId);
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO acquisition_sessions (
      producer_id, first_recorded_by_client_id, external_id_namespace,
      external_session_id, first_recorded_at_ms
    ) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM acquisition_sessions
      WHERE producer_id = ? AND external_id_namespace = ? AND external_session_id = ?
    )
  `)
    .bind(
      producerId,
      clientId,
      namespace,
      externalSessionId,
      now,
      producerId,
      namespace,
      externalSessionId,
    )
    .run();
  const session = await env.DB.prepare(`
    SELECT id, producer_id, first_recorded_by_client_id,
           external_id_namespace, external_session_id
    FROM acquisition_sessions
    WHERE producer_id = ? AND external_id_namespace = ? AND external_session_id = ?
  `)
    .bind(producerId, namespace, externalSessionId)
    .first<RecordValue>();
  assertSame(
    session,
    {
      producer_id: producerId,
      first_recorded_by_client_id: clientId,
      external_id_namespace: namespace,
      external_session_id: externalSessionId,
    },
    "acquisition_session_conflict",
  );

  const sessionId = session!.id as number;
  await env.DB.prepare(`
    INSERT INTO fetch_runs (
      acquisition_session_id, producer_id, source_id,
      first_recorded_by_client_id, source_run_key, first_recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM fetch_runs
      WHERE acquisition_session_id = ? AND source_id = ? AND source_run_key = ?
    )
  `)
    .bind(
      sessionId,
      producerId,
      sourceId,
      clientId,
      sourceRunKey,
      now,
      sessionId,
      sourceId,
      sourceRunKey,
    )
    .run();
  const run = await env.DB.prepare(`
    SELECT id, acquisition_session_id, producer_id, source_id,
           first_recorded_by_client_id, source_run_key
    FROM fetch_runs
    WHERE acquisition_session_id = ? AND source_id = ? AND source_run_key = ?
  `)
    .bind(sessionId, sourceId, sourceRunKey)
    .first<RecordValue>();
  assertSame(
    run,
    {
      acquisition_session_id: sessionId,
      producer_id: producerId,
      source_id: sourceId,
      first_recorded_by_client_id: clientId,
      source_run_key: sourceRunKey,
    },
    "fetch_run_conflict",
  );
  return { sessionId, runId: run!.id as number };
}

export async function addRunReport(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const { reportKey, reportKind, ...report } = parseAddRunReportRequest(await readJson(request));
  // Key order matches the INSERT column list below.
  const fields = {
    producer_version: report.producerVersion,
    producer_revision: report.producerRevision,
    manifest_schema_version: report.manifestSchemaVersion,
    producer_status: report.producerStatus,
    normalized_outcome: report.normalizedOutcome,
    started_at_ms: report.startedAtMs,
    started_at_basis: report.startedAtBasis,
    completed_at_ms: report.completedAtMs,
    completed_at_basis: report.completedAtBasis,
    declared_artifact_count: report.declaredArtifactCount,
    artifact_count_scope: report.artifactCountScope,
  };
  const now = Date.now();
  const values = [runId, reportKey, reportKind, clientId, ...Object.values(fields), now];
  await env.DB.prepare(`
    INSERT INTO fetch_run_reports (
      fetch_run_id, report_key, report_kind, recorded_by_client_id,
      producer_version, producer_revision, manifest_schema_version, producer_status,
      normalized_outcome, started_at_ms, started_at_basis, completed_at_ms,
      completed_at_basis, declared_artifact_count, artifact_count_scope, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM fetch_run_reports WHERE fetch_run_id = ? AND report_key = ?
    )
  `)
    .bind(...values, runId, reportKey)
    .run();
  const row = await env.DB.prepare(`
    SELECT id, report_kind, recorded_by_client_id, producer_version, producer_revision,
           manifest_schema_version, producer_status, normalized_outcome, started_at_ms,
           started_at_basis, completed_at_ms, completed_at_basis,
           declared_artifact_count, artifact_count_scope
    FROM fetch_run_reports WHERE fetch_run_id = ? AND report_key = ?
  `)
    .bind(runId, reportKey)
    .first<RecordValue>();
  assertSame(
    row,
    { report_kind: reportKind, recorded_by_client_id: clientId, ...fields },
    "fetch_run_report_conflict",
  );
  return { reportId: row!.id as number };
}

/**
 * Validated, normalized artifact descriptor: the shape whose canonical bytes
 * are hashed into fetch_artifacts.descriptor_sha256 (descriptor-v1).
 */
type ArtifactInput = CanonicalDescriptorV1;

export async function addArtifact(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  const run = await loadRun(env, clientId, runId);
  // The shared contract validates the body (unknown keys rejected) and
  // normalizes it exactly as the ingest client does.
  const input = descriptorContractV1.normalize(
    descriptorContractV1.parseRequest(await readJson(request), { runId }),
  );
  const objectRow = await env.DB.prepare("SELECT byte_size FROM raw_objects WHERE sha256 = ?")
    .bind(input.sha256)
    .first<{ byte_size: number }>();
  if (!objectRow) throw new ApiError(409, "raw_object_missing");
  if (objectRow.byte_size !== input.byteSize) throw new ApiError(409, "raw_object_size_conflict");
  await validateOriginScope(env, run.source_id, input.origins);
  for (const relation of input.relations) {
    const parent = await env.DB.prepare(`
      SELECT source_id FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `)
      .bind(relation.parentRunId, relation.parentArtifactKey)
      .first<{ source_id: string }>();
    if (!parent) throw new ApiError(409, "parent_artifact_missing");
    if (parent.source_id !== run.source_id)
      throw new ApiError(409, "parent_artifact_source_mismatch");
  }

  // Never trust a client-supplied descriptor hash. The digest is always
  // recomputed here from the server's own validated parse; inventory items
  // and seals that carry a different value are rejected as conflicts.
  const descriptorSha256 = await descriptorContractV1.digest(descriptorContractV1.encode(input));
  const existing = await env.DB.prepare(`
    SELECT id, producer_id, source_id, first_ingested_by_client_id, fetch_unit_id,
           page_group_id, artifact_role, payload_fidelity, container_kind,
           lineage_disposition, dataset, format_id, format_version, declared_media_type,
           media_type_basis, fetched_at_ms, fetched_at_basis, page_index, sequence,
           sha256, byte_size, descriptor_version, descriptor_sha256
    FROM fetch_artifacts WHERE fetch_run_id = ? AND artifact_key = ?
  `)
    .bind(runId, input.artifactKey)
    .first<RecordValue>();
  const expectedArtifact = artifactExpected(input, run, clientId, descriptorSha256);
  if (existing) {
    assertSame(existing, expectedArtifact, "fetch_artifact_conflict");
    await assertArtifactChildren(env, runId, input, clientId);
    return { artifactId: existing.id as number, descriptorSha256 };
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
    INSERT INTO fetch_artifacts (
      fetch_run_id, producer_id, source_id, first_ingested_by_client_id,
      fetch_unit_id, page_group_id, artifact_key, artifact_role, payload_fidelity,
      container_kind, lineage_disposition, dataset, format_id, format_version,
      declared_media_type, media_type_basis, fetched_at_ms, fetched_at_basis,
      page_index, sequence, sha256, byte_size, descriptor_version, descriptor_sha256,
      recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1', ?, ?)
  `).bind(
      runId,
      run.producer_id,
      run.source_id,
      clientId,
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
      descriptorSha256,
      now,
    ),
  ];
  statements.push(...originStatements(env, runId, input.artifactKey, input.origins));
  statements.push(...rangeStatements(env, runId, input.artifactKey, clientId, now, input.ranges));
  statements.push(
    ...transformStatements(env, runId, input.artifactKey, clientId, now, input.transformSteps),
  );
  statements.push(
    ...relationStatements(env, runId, input.artifactKey, clientId, now, input.relations),
  );
  try {
    await env.DB.batch(statements);
  } catch (originalError) {
    let raced: RecordValue | null;
    try {
      raced = await env.DB.prepare(`
        SELECT id, producer_id, source_id, first_ingested_by_client_id, fetch_unit_id,
               page_group_id, artifact_role, payload_fidelity, container_kind,
               lineage_disposition, dataset, format_id, format_version, declared_media_type,
               media_type_basis, fetched_at_ms, fetched_at_basis, page_index, sequence,
               sha256, byte_size, descriptor_version, descriptor_sha256
        FROM fetch_artifacts WHERE fetch_run_id = ? AND artifact_key = ?
      `)
        .bind(runId, input.artifactKey)
        .first<RecordValue>();
      if (!raced) throw originalError;
      assertSame(raced, expectedArtifact, "fetch_artifact_conflict");
      await assertArtifactChildren(env, runId, input, clientId);
      return { artifactId: raced!.id as number, descriptorSha256 };
    } catch (reconciliationError) {
      if (reconciliationError instanceof ApiError && reconciliationError.status === 409) {
        throw reconciliationError;
      }
      throw originalError;
    }
  }

  const artifact = await env.DB.prepare(`
    SELECT id, producer_id, source_id, first_ingested_by_client_id, fetch_unit_id,
           page_group_id, artifact_role, payload_fidelity, container_kind,
           lineage_disposition, dataset, format_id, format_version, declared_media_type,
           media_type_basis, fetched_at_ms, fetched_at_basis, page_index, sequence,
           sha256, byte_size, descriptor_version, descriptor_sha256
    FROM fetch_artifacts WHERE fetch_run_id = ? AND artifact_key = ?
  `)
    .bind(runId, input.artifactKey)
    .first<RecordValue>();
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

function rangeStatements(
  env: WorkerEnv,
  runId: number,
  artifactKey: string,
  clientId: string,
  now: number,
  values: ArtifactRange[],
): D1PreparedStatement[] {
  return values.map((value) =>
    env.DB.prepare(`
      INSERT INTO artifact_ranges (
        fetch_artifact_id, range_key, range_kind, precision, start_value, end_value,
        start_inclusive, end_inclusive, basis, recorded_by_client_id, recorded_at_ms
      ) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `).bind(
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

function transformStatements(
  env: WorkerEnv,
  runId: number,
  artifactKey: string,
  clientId: string,
  now: number,
  values: TransformStep[],
): D1PreparedStatement[] {
  return values.map((value) =>
    env.DB.prepare(`
      INSERT INTO artifact_transform_steps (
        fetch_artifact_id, step_index, step_kind, transformer_id,
        transformer_version, recorded_by_client_id, recorded_at_ms
      ) SELECT id, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `).bind(
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

function relationStatements(
  env: WorkerEnv,
  runId: number,
  artifactKey: string,
  clientId: string,
  now: number,
  values: RelationClaim[],
): D1PreparedStatement[] {
  return values.map((value) =>
    env.DB.prepare(`
      INSERT INTO artifact_relations (
        child_artifact_id, parent_artifact_id, relation, transformer_id,
        transformer_version, recorded_by_client_id, recorded_at_ms
      ) SELECT child.id, parent.id, ?, ?, ?, ?, ?
        FROM fetch_artifacts AS child, fetch_artifacts AS parent
       WHERE child.fetch_run_id = ? AND child.artifact_key = ?
         AND parent.fetch_run_id = ? AND parent.artifact_key = ?
    `).bind(
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

async function assertArtifactChildren(
  env: WorkerEnv,
  runId: number,
  input: ArtifactInput,
  clientId: string,
): Promise<void> {
  const ranges = await env.DB.prepare(`
    SELECT r.range_key AS rangeKey, r.range_kind AS rangeKind, r.precision,
           r.start_value AS startValue, r.end_value AS endValue,
           r.start_inclusive AS startInclusive, r.end_inclusive AS endInclusive, r.basis
    FROM artifact_ranges AS r JOIN fetch_artifacts AS a ON a.id = r.fetch_artifact_id
    WHERE a.fetch_run_id = ? AND a.artifact_key = ? ORDER BY r.range_key COLLATE BINARY
  `)
    .bind(runId, input.artifactKey)
    .all<ArtifactRange>();
  const steps = await env.DB.prepare(`
    SELECT t.step_index AS stepIndex, t.step_kind AS stepKind,
           t.transformer_id AS transformerId, t.transformer_version AS transformerVersion
    FROM artifact_transform_steps AS t JOIN fetch_artifacts AS a ON a.id = t.fetch_artifact_id
    WHERE a.fetch_run_id = ? AND a.artifact_key = ? ORDER BY t.step_index
  `)
    .bind(runId, input.artifactKey)
    .all<TransformStep>();
  const relations = await env.DB.prepare(`
    SELECT parent.fetch_run_id AS parentRunId, parent.artifact_key AS parentArtifactKey,
           relation.relation, relation.transformer_id AS transformerId,
           relation.transformer_version AS transformerVersion
    FROM artifact_relations AS relation
    JOIN fetch_artifacts AS child ON child.id = relation.child_artifact_id
    JOIN fetch_artifacts AS parent ON parent.id = relation.parent_artifact_id
    WHERE child.fetch_run_id = ? AND child.artifact_key = ?
    ORDER BY parent.fetch_run_id, parent.artifact_key COLLATE BINARY, relation.relation COLLATE BINARY
  `)
    .bind(runId, input.artifactKey)
    .all<RelationClaim>();
  if (
    canonicalJson(ranges.results as unknown as JsonValue) !==
      canonicalJson(input.ranges as unknown as JsonValue) ||
    canonicalJson(steps.results as unknown as JsonValue) !==
      canonicalJson(input.transformSteps as unknown as JsonValue) ||
    canonicalJson(relations.results as unknown as JsonValue) !==
      canonicalJson(input.relations as unknown as JsonValue)
  ) {
    throw new ApiError(409, "artifact_children_conflict");
  }
  const originCount = Object.values(input.origins).filter((value) => value !== null).length;
  const counts = await env.DB.prepare(`
    SELECT
      (SELECT count(*) FROM artifact_http_metadata h WHERE h.fetch_artifact_id = a.id) +
      (SELECT count(*) FROM artifact_storage_metadata s WHERE s.fetch_artifact_id = a.id) +
      (SELECT count(*) FROM artifact_file_metadata f WHERE f.fetch_artifact_id = a.id) +
      (SELECT count(*) FROM artifact_email_metadata e WHERE e.fetch_artifact_id = a.id) AS origin_count
    FROM fetch_artifacts a WHERE a.fetch_run_id = ? AND a.artifact_key = ?
  `)
    .bind(runId, input.artifactKey)
    .first<{ origin_count: number }>();
  if (counts?.origin_count !== originCount) throw new ApiError(409, "artifact_origin_conflict");
  const actorRows = await env.DB.prepare(`
    SELECT count(*) AS bad FROM (
      SELECT recorded_by_client_id FROM artifact_ranges r JOIN fetch_artifacts a ON a.id=r.fetch_artifact_id WHERE a.fetch_run_id=? AND a.artifact_key=?
      UNION ALL SELECT recorded_by_client_id FROM artifact_transform_steps t JOIN fetch_artifacts a ON a.id=t.fetch_artifact_id WHERE a.fetch_run_id=? AND a.artifact_key=?
      UNION ALL SELECT recorded_by_client_id FROM artifact_relations r JOIN fetch_artifacts a ON a.id=r.child_artifact_id WHERE a.fetch_run_id=? AND a.artifact_key=?
    ) WHERE recorded_by_client_id <> ?
  `)
    .bind(runId, input.artifactKey, runId, input.artifactKey, runId, input.artifactKey, clientId)
    .first<{ bad: number }>();
  if ((actorRows?.bad ?? 0) !== 0) throw new ApiError(409, "artifact_actor_conflict");
}

export async function sealRun(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  const run = await loadRun(env, clientId, runId);
  const {
    artifacts: submitted,
    declarationBasis,
    externalAttemptId,
    startedAtMs,
  } = parseSealRunRequest(await readJson(request));
  // Client-declared descriptor hashes are compared against the catalogue's
  // own recomputed values; any difference is an inventory_mismatch conflict.
  const actual = await env.DB.prepare(`
    SELECT artifact_key, sha256, descriptor_sha256
    FROM fetch_artifacts WHERE fetch_run_id = ? ORDER BY artifact_key COLLATE BINARY
  `)
    .bind(runId)
    .all<{ artifact_key: string; sha256: string; descriptor_sha256: string }>();
  if (
    actual.results.length !== submitted.length ||
    actual.results.some(
      (row, index) =>
        row.artifact_key !== submitted[index].artifactKey ||
        row.sha256 !== submitted[index].sha256 ||
        row.descriptor_sha256 !== submitted[index].descriptorSha256,
    )
  ) {
    throw new ApiError(409, "inventory_mismatch");
  }
  const inventorySha256 = await sha256Hex(canonicalJson(submitted as unknown as JsonValue));
  const now = Date.now();

  const expectedInventory = {
    expected_artifact_count: submitted.length,
    inventory_digest_version: "v1",
    declaration_basis: declarationBasis,
    created_by_client_id: clientId,
  };
  const priorInventory = await env.DB.prepare(`
    SELECT id, expected_artifact_count, inventory_digest_version,
           declaration_basis, created_by_client_id
    FROM run_inventories WHERE fetch_run_id = ? AND inventory_sha256 = ?
  `)
    .bind(runId, inventorySha256)
    .first<RecordValue>();
  if (priorInventory) assertSame(priorInventory, expectedInventory, "inventory_conflict");
  const priorSeal = await env.DB.prepare(
    "SELECT inventory_id, sealed_by_client_id FROM fetch_run_seals WHERE fetch_run_id = ?",
  )
    .bind(runId)
    .first<RecordValue>();
  if (priorSeal && priorInventory && priorSeal.inventory_id !== priorInventory.id) {
    throw new ApiError(409, "seal_conflict");
  }
  const expectedAttempt = {
    producer_id: run.producer_id,
    source_id: run.source_id,
    started_at_ms: startedAtMs,
    expected_artifact_count: submitted.length,
    observed_artifact_count: submitted.length,
    rejected_artifact_count: 0,
    outcome: "complete",
    error_code: null,
  };
  const priorAttempt = await env.DB.prepare(`
    SELECT id, producer_id, source_id, started_at_ms, expected_artifact_count,
           observed_artifact_count, accepted_artifact_count, reused_artifact_count,
           rejected_artifact_count, sealed_inventory_id, outcome, error_code
    FROM ingestion_attempts
    WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
  `)
    .bind(runId, clientId, externalAttemptId)
    .first<RecordValue>();
  if (priorAttempt) {
    if (!priorInventory) throw new ApiError(409, "inventory_conflict");
    await assertCompleteAttempt(
      env,
      runId,
      priorAttempt,
      {
        ...expectedAttempt,
        sealed_inventory_id: priorInventory.id,
      },
      submitted.length,
    );
    if (
      !priorSeal ||
      priorSeal.inventory_id !== priorInventory.id ||
      priorSeal.sealed_by_client_id !== clientId
    ) {
      throw new ApiError(409, "seal_conflict");
    }
    return {
      runId,
      inventoryId: priorInventory.id as number,
      inventorySha256,
      sealed: true,
    };
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
    INSERT INTO run_inventories (
      fetch_run_id, inventory_sha256, expected_artifact_count,
      inventory_digest_version, declaration_basis, created_at_ms, created_by_client_id
    ) SELECT ?, ?, ?, 'v1', ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM run_inventories WHERE fetch_run_id = ? AND inventory_sha256 = ?
    )
  `).bind(
      runId,
      inventorySha256,
      submitted.length,
      declarationBasis,
      now,
      clientId,
      runId,
      inventorySha256,
    ),
  ];
  // D1's runtime SQLite build accepts at most five terms in a compound SELECT.
  // Keep the VALUES-shaped UNION below that limit for direct inventories.
  for (let offset = 0; offset < submitted.length; offset += 5) {
    const chunk = submitted.slice(offset, offset + 5);
    const rows = chunk
      .map(() => "SELECT ? AS artifact_key, ? AS sha256, ? AS descriptor_sha256")
      .join(" UNION ALL ");
    statements.push(
      env.DB.prepare(`
      INSERT INTO run_inventory_items (
        inventory_id, fetch_run_id, artifact_key, sha256, descriptor_sha256
      )
      SELECT inventory.id, inventory.fetch_run_id,
             item.artifact_key, item.sha256, item.descriptor_sha256
      FROM run_inventories AS inventory
      JOIN (${rows}) AS item
      WHERE inventory.fetch_run_id = ? AND inventory.inventory_sha256 = ?
        AND inventory.expected_artifact_count = ?
        AND inventory.inventory_digest_version = 'v1'
        AND inventory.declaration_basis = ?
        AND inventory.created_by_client_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM run_inventory_items AS existing
          WHERE existing.inventory_id = inventory.id
            AND existing.artifact_key = item.artifact_key
        )
    `).bind(
        ...chunk.flatMap((item) => [item.artifactKey, item.sha256, item.descriptorSha256]),
        runId,
        inventorySha256,
        submitted.length,
        declarationBasis,
        clientId,
      ),
    );
  }
  statements.push(
    env.DB.prepare(`
    INSERT INTO fetch_run_seals (
      inventory_id, fetch_run_id, sealed_at_ms, sealed_by_client_id
    ) SELECT inventory.id, inventory.fetch_run_id, ?, ?
      FROM run_inventories AS inventory
     WHERE inventory.fetch_run_id = ? AND inventory.inventory_sha256 = ?
       AND inventory.expected_artifact_count = ?
       AND inventory.inventory_digest_version = 'v1'
       AND inventory.declaration_basis = ?
       AND inventory.created_by_client_id = ?
       AND NOT EXISTS (SELECT 1 FROM fetch_run_seals WHERE fetch_run_id = ?)
  `).bind(
      now,
      clientId,
      runId,
      inventorySha256,
      submitted.length,
      declarationBasis,
      clientId,
      runId,
    ),
  );
  statements.push(
    env.DB.prepare(`
    INSERT INTO ingestion_attempts (
      fetch_run_id, producer_id, source_id, ingest_client_id, external_attempt_id,
      started_at_ms, completed_at_ms, expected_artifact_count, observed_artifact_count,
      accepted_artifact_count, reused_artifact_count, rejected_artifact_count,
      sealed_inventory_id, outcome, error_code, recorded_at_ms
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
           CASE WHEN EXISTS (
             SELECT 1 FROM ingestion_attempts
             WHERE fetch_run_id = ? AND outcome = 'complete'
           ) THEN 0 ELSE ? END,
           CASE WHEN EXISTS (
             SELECT 1 FROM ingestion_attempts
             WHERE fetch_run_id = ? AND outcome = 'complete'
           ) THEN ? ELSE 0 END,
           0, inventory.id, 'complete', NULL, ?
      FROM run_inventories AS inventory
     WHERE inventory.fetch_run_id = ? AND inventory.inventory_sha256 = ?
       AND inventory.expected_artifact_count = ?
       AND inventory.inventory_digest_version = 'v1'
       AND inventory.declaration_basis = ?
       AND inventory.created_by_client_id = ?
  `).bind(
      runId,
      run.producer_id,
      run.source_id,
      clientId,
      externalAttemptId,
      startedAtMs,
      now,
      submitted.length,
      submitted.length,
      runId,
      submitted.length,
      runId,
      submitted.length,
      now,
      runId,
      inventorySha256,
      submitted.length,
      declarationBasis,
      clientId,
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch (originalError) {
    try {
      const racedInventory = await env.DB.prepare(`
        SELECT id, expected_artifact_count, inventory_digest_version,
               declaration_basis, created_by_client_id
        FROM run_inventories WHERE fetch_run_id = ? AND inventory_sha256 = ?
      `)
        .bind(runId, inventorySha256)
        .first<RecordValue>();
      const racedSeal = await env.DB.prepare(
        "SELECT inventory_id, sealed_by_client_id FROM fetch_run_seals WHERE fetch_run_id = ?",
      )
        .bind(runId)
        .first<RecordValue>();
      const racedAttempt = await env.DB.prepare(`
        SELECT id, producer_id, source_id, started_at_ms, expected_artifact_count,
               observed_artifact_count, accepted_artifact_count, reused_artifact_count,
               rejected_artifact_count, sealed_inventory_id, outcome, error_code
        FROM ingestion_attempts
        WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
      `)
        .bind(runId, clientId, externalAttemptId)
        .first<RecordValue>();
      if (!racedInventory || !racedSeal || !racedAttempt) throw originalError;
      assertSame(racedInventory, expectedInventory, "inventory_conflict");
      assertSame(
        racedSeal,
        {
          inventory_id: racedInventory!.id,
          sealed_by_client_id: clientId,
        },
        "seal_conflict",
      );
      await assertCompleteAttempt(
        env,
        runId,
        racedAttempt,
        {
          ...expectedAttempt,
          sealed_inventory_id: racedInventory!.id,
        },
        submitted.length,
      );
      return {
        runId,
        inventoryId: racedInventory!.id as number,
        inventorySha256,
        sealed: true,
      };
    } catch (reconciliationError) {
      if (reconciliationError instanceof ApiError && reconciliationError.status === 409) {
        throw reconciliationError;
      }
      throw originalError;
    }
  }

  const inventory = await env.DB.prepare(`
    SELECT id, expected_artifact_count, inventory_digest_version,
           declaration_basis, created_by_client_id
    FROM run_inventories WHERE fetch_run_id = ? AND inventory_sha256 = ?
  `)
    .bind(runId, inventorySha256)
    .first<RecordValue>();
  assertSame(inventory, expectedInventory, "inventory_conflict");
  const inventoryId = inventory!.id as number;
  const seal = await env.DB.prepare(`
    SELECT inventory_id, sealed_by_client_id FROM fetch_run_seals WHERE fetch_run_id = ?
  `)
    .bind(runId)
    .first<RecordValue>();
  assertSame(seal, { inventory_id: inventoryId, sealed_by_client_id: clientId }, "seal_conflict");
  const attempt = await env.DB.prepare(`
    SELECT id, producer_id, source_id, started_at_ms, expected_artifact_count,
           observed_artifact_count, accepted_artifact_count, reused_artifact_count,
           rejected_artifact_count, sealed_inventory_id, outcome, error_code
    FROM ingestion_attempts
    WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
  `)
    .bind(runId, clientId, externalAttemptId)
    .first<RecordValue>();
  await assertCompleteAttempt(
    env,
    runId,
    attempt,
    {
      ...expectedAttempt,
      sealed_inventory_id: inventoryId,
    },
    submitted.length,
  );
  return { runId, inventoryId, inventorySha256, sealed: true };
}

async function assertCompleteAttempt(
  env: WorkerEnv,
  runId: number,
  attempt: RecordValue | null,
  expected: RecordValue,
  artifactCount: number,
): Promise<void> {
  assertSame(attempt, expected, "ingestion_attempt_conflict");
  const earlier = await env.DB.prepare(`
    SELECT count(*) AS count FROM ingestion_attempts
    WHERE fetch_run_id = ? AND outcome = 'complete' AND id < ?
  `)
    .bind(runId, attempt!.id)
    .first<{ count: number }>();
  const reused = (earlier?.count ?? 0) > 0;
  assertSame(
    attempt,
    {
      accepted_artifact_count: reused ? 0 : artifactCount,
      reused_artifact_count: reused ? artifactCount : 0,
    },
    "ingestion_attempt_conflict",
  );
}

export async function beginInventory(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const { inventorySha256, expectedArtifactCount, declarationBasis } = parseBeginInventoryRequest(
    await readJson(request),
  );
  const expected = {
    expected_artifact_count: expectedArtifactCount,
    inventory_digest_version: "v1",
    declaration_basis: declarationBasis,
    created_by_client_id: clientId,
  };
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO run_inventories (
      fetch_run_id, inventory_sha256, expected_artifact_count,
      inventory_digest_version, declaration_basis, created_at_ms, created_by_client_id
    ) SELECT ?, ?, ?, 'v1', ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM run_inventories WHERE fetch_run_id = ? AND inventory_sha256 = ?
    )
  `)
    .bind(
      runId,
      inventorySha256,
      expectedArtifactCount,
      declarationBasis,
      now,
      clientId,
      runId,
      inventorySha256,
    )
    .run();
  const inventory = await env.DB.prepare(`
    SELECT id, expected_artifact_count, inventory_digest_version,
           declaration_basis, created_by_client_id
    FROM run_inventories WHERE fetch_run_id = ? AND inventory_sha256 = ?
  `)
    .bind(runId, inventorySha256)
    .first<RecordValue>();
  assertSame(inventory, expected, "inventory_conflict");
  return { inventoryId: inventory!.id as number, inventorySha256, expectedArtifactCount };
}

export async function addInventoryItems(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
  inventoryId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  const { items } = parseAddInventoryItemsRequest(await readJson(request));
  const inventory = await env.DB.prepare(`
    SELECT 1 AS ok FROM run_inventories WHERE id = ? AND fetch_run_id = ?
  `)
    .bind(inventoryId, runId)
    .first<{ ok: number }>();
  if (!inventory) throw new ApiError(404, "inventory_not_found");
  const newItems: InventoryItem[] = [];
  for (const item of items) {
    // The client-declared descriptorSha256 must equal the value this server
    // computed when the artifact was catalogued; it is never taken on trust.
    const artifact = await env.DB.prepare(`
      SELECT sha256, descriptor_sha256 FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `)
      .bind(runId, item.artifactKey)
      .first<RecordValue>();
    assertSame(
      artifact,
      {
        sha256: item.sha256,
        descriptor_sha256: item.descriptorSha256,
      },
      "inventory_artifact_conflict",
    );
    const existing = await env.DB.prepare(`
      SELECT sha256, descriptor_sha256 FROM run_inventory_items
      WHERE inventory_id = ? AND artifact_key = ?
    `)
      .bind(inventoryId, item.artifactKey)
      .first<RecordValue>();
    if (existing) {
      assertSame(
        existing,
        {
          sha256: item.sha256,
          descriptor_sha256: item.descriptorSha256,
        },
        "inventory_item_conflict",
      );
    } else {
      newItems.push(item);
    }
  }
  const sealed = await env.DB.prepare("SELECT 1 AS ok FROM fetch_run_seals WHERE fetch_run_id = ?")
    .bind(runId)
    .first<{ ok: number }>();
  if (sealed && newItems.length > 0) throw new ApiError(409, "run_already_sealed");
  const capacity = await env.DB.prepare(`
    SELECT inventory.expected_artifact_count AS expected,
           count(item.artifact_key) AS received
    FROM run_inventories AS inventory
    LEFT JOIN run_inventory_items AS item ON item.inventory_id = inventory.id
    WHERE inventory.id = ? GROUP BY inventory.id
  `)
    .bind(inventoryId)
    .first<{ expected: number; received: number }>();
  if (!capacity || capacity.received + newItems.length > capacity.expected) {
    throw new ApiError(409, "inventory_overflow");
  }
  const statements = newItems.map((item) =>
    env.DB.prepare(`
    INSERT INTO run_inventory_items (
      inventory_id, fetch_run_id, artifact_key, sha256, descriptor_sha256
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(inventoryId, runId, item.artifactKey, item.sha256, item.descriptorSha256),
  );
  let accepted = newItems.length;
  if (statements.length > 0) {
    try {
      await env.DB.batch(statements);
    } catch (originalError) {
      accepted = 0;
      try {
        for (const item of items) {
          const existing = await env.DB.prepare(`
            SELECT sha256, descriptor_sha256 FROM run_inventory_items
            WHERE inventory_id = ? AND artifact_key = ?
          `)
            .bind(inventoryId, item.artifactKey)
            .first<RecordValue>();
          if (!existing) throw originalError;
          if (
            existing.sha256 !== item.sha256 ||
            existing.descriptor_sha256 !== item.descriptorSha256
          ) {
            throw new ApiError(409, "inventory_item_conflict");
          }
        }
      } catch (reconciliationError) {
        if (reconciliationError instanceof ApiError && reconciliationError.status === 409) {
          throw reconciliationError;
        }
        throw originalError;
      }
    }
  }
  const status = await inventoryStatus(env, runId, inventoryId);
  return { inventoryId, accepted, ...status };
}

export async function getInventoryStatus(
  env: WorkerEnv,
  clientId: string,
  runId: number,
  inventoryId: number,
): Promise<Record<string, JsonValue>> {
  await loadRun(env, clientId, runId);
  return { inventoryId, ...(await inventoryStatus(env, runId, inventoryId)) };
}

async function inventoryStatus(
  env: WorkerEnv,
  runId: number,
  inventoryId: number,
): Promise<Record<string, JsonValue>> {
  const row = await env.DB.prepare(`
    SELECT inventory.expected_artifact_count AS expected_artifact_count,
           count(item.artifact_key) AS received_artifact_count,
           CASE WHEN seal.inventory_id IS NULL THEN 0 ELSE 1 END AS sealed
    FROM run_inventories AS inventory
    LEFT JOIN run_inventory_items AS item ON item.inventory_id = inventory.id
    LEFT JOIN fetch_run_seals AS seal ON seal.inventory_id = inventory.id
    WHERE inventory.id = ? AND inventory.fetch_run_id = ?
    GROUP BY inventory.id, seal.inventory_id
  `)
    .bind(inventoryId, runId)
    .first<{
      expected_artifact_count: number;
      received_artifact_count: number;
      sealed: number;
    }>();
  if (!row) throw new ApiError(404, "inventory_not_found");
  return {
    expectedArtifactCount: row.expected_artifact_count,
    receivedArtifactCount: row.received_artifact_count,
    sealed: row.sealed === 1,
  };
}

export async function sealStagedInventory(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
  inventoryId: number,
): Promise<Record<string, JsonValue>> {
  const run = await loadRun(env, clientId, runId);
  const { externalAttemptId, startedAtMs } = parseSealStagedInventoryRequest(
    await readJson(request),
  );
  const inventory = await env.DB.prepare(`
    SELECT inventory_sha256, expected_artifact_count FROM run_inventories
    WHERE id = ? AND fetch_run_id = ?
  `)
    .bind(inventoryId, runId)
    .first<{
      inventory_sha256: string;
      expected_artifact_count: number;
    }>();
  if (!inventory) throw new ApiError(404, "inventory_not_found");
  const items = await env.DB.prepare(`
    SELECT artifact_key, sha256, descriptor_sha256 FROM run_inventory_items
    WHERE inventory_id = ? ORDER BY artifact_key COLLATE BINARY
  `)
    .bind(inventoryId)
    .all<{
      artifact_key: string;
      sha256: string;
      descriptor_sha256: string;
    }>();
  if (items.results.length !== inventory.expected_artifact_count) {
    throw new ApiError(409, "inventory_incomplete");
  }
  const canonicalItems = items.results.map((item) => ({
    artifactKey: item.artifact_key,
    sha256: item.sha256,
    descriptorSha256: item.descriptor_sha256,
  }));
  if (
    (await sha256Hex(canonicalJson(canonicalItems as unknown as JsonValue))) !==
    inventory.inventory_sha256
  ) {
    throw new ApiError(409, "inventory_digest_mismatch");
  }
  const expectedAttempt = {
    producer_id: run.producer_id,
    source_id: run.source_id,
    started_at_ms: startedAtMs,
    expected_artifact_count: inventory.expected_artifact_count,
    observed_artifact_count: inventory.expected_artifact_count,
    rejected_artifact_count: 0,
    sealed_inventory_id: inventoryId,
    outcome: "complete",
    error_code: null,
  };
  const priorAttempt = await env.DB.prepare(`
    SELECT id, producer_id, source_id, started_at_ms, expected_artifact_count,
           observed_artifact_count, accepted_artifact_count, reused_artifact_count,
           rejected_artifact_count, sealed_inventory_id, outcome, error_code
    FROM ingestion_attempts
    WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
  `)
    .bind(runId, clientId, externalAttemptId)
    .first<RecordValue>();
  if (priorAttempt) {
    await assertCompleteAttempt(
      env,
      runId,
      priorAttempt,
      expectedAttempt,
      inventory.expected_artifact_count,
    );
    return { runId, inventoryId, inventorySha256: inventory.inventory_sha256, sealed: true };
  }
  const now = Date.now();
  const statements = [
    env.DB.prepare(`
      INSERT INTO fetch_run_seals (
        inventory_id, fetch_run_id, sealed_at_ms, sealed_by_client_id
      ) SELECT ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM fetch_run_seals WHERE fetch_run_id = ?
      )
    `).bind(inventoryId, runId, now, clientId, runId),
    env.DB.prepare(`
      INSERT INTO ingestion_attempts (
        fetch_run_id, producer_id, source_id, ingest_client_id, external_attempt_id,
        started_at_ms, completed_at_ms, expected_artifact_count, observed_artifact_count,
        accepted_artifact_count, reused_artifact_count, rejected_artifact_count,
        sealed_inventory_id, outcome, error_code, recorded_at_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN EXISTS (
          SELECT 1 FROM ingestion_attempts WHERE fetch_run_id = ? AND outcome = 'complete'
        ) THEN 0 ELSE ? END,
        CASE WHEN EXISTS (
          SELECT 1 FROM ingestion_attempts WHERE fetch_run_id = ? AND outcome = 'complete'
        ) THEN ? ELSE 0 END,
        0, ?, 'complete', NULL, ?
      )
    `).bind(
      runId,
      run.producer_id,
      run.source_id,
      clientId,
      externalAttemptId,
      startedAtMs,
      now,
      inventory.expected_artifact_count,
      inventory.expected_artifact_count,
      runId,
      inventory.expected_artifact_count,
      runId,
      inventory.expected_artifact_count,
      inventoryId,
      now,
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch (originalError) {
    try {
      const finalSeal = await env.DB.prepare(
        "SELECT inventory_id FROM fetch_run_seals WHERE fetch_run_id = ?",
      )
        .bind(runId)
        .first<{ inventory_id: number }>();
      const finalAttempt = await env.DB.prepare(`
        SELECT id, producer_id, source_id, started_at_ms, expected_artifact_count,
               observed_artifact_count, accepted_artifact_count, reused_artifact_count,
               rejected_artifact_count, sealed_inventory_id, outcome, error_code
        FROM ingestion_attempts
        WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
      `)
        .bind(runId, clientId, externalAttemptId)
        .first<RecordValue>();
      if (!finalSeal || !finalAttempt) throw originalError;
      if (finalSeal.inventory_id !== inventoryId) throw new ApiError(409, "seal_conflict");
      await assertCompleteAttempt(
        env,
        runId,
        finalAttempt,
        expectedAttempt,
        inventory.expected_artifact_count,
      );
    } catch (reconciliationError) {
      if (reconciliationError instanceof ApiError && reconciliationError.status === 409) {
        throw reconciliationError;
      }
      throw originalError;
    }
  }
  return { runId, inventoryId, inventorySha256: inventory.inventory_sha256, sealed: true };
}

export async function addFailedAttempt(
  request: Request,
  env: WorkerEnv,
  clientId: string,
  runId: number,
): Promise<Record<string, JsonValue>> {
  const run = await loadRun(env, clientId, runId);
  const attemptRequest = parseRecordAttemptRequest(await readJson(request));
  const fields = {
    ingest_client_version: attemptRequest.ingestClientVersion,
    external_attempt_id: attemptRequest.externalAttemptId,
    started_at_ms: attemptRequest.startedAtMs,
    completed_at_ms: attemptRequest.completedAtMs,
    expected_artifact_count: attemptRequest.expectedArtifactCount,
    observed_artifact_count: attemptRequest.observedArtifactCount,
    accepted_artifact_count: attemptRequest.acceptedArtifactCount,
    reused_artifact_count: attemptRequest.reusedArtifactCount,
    rejected_artifact_count: attemptRequest.rejectedArtifactCount,
    outcome: attemptRequest.outcome,
    error_code: attemptRequest.errorCode,
  };
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO ingestion_attempts (
      fetch_run_id, producer_id, source_id, ingest_client_id, ingest_client_version,
      external_attempt_id, started_at_ms, completed_at_ms, expected_artifact_count,
      observed_artifact_count, accepted_artifact_count, reused_artifact_count,
      rejected_artifact_count, sealed_inventory_id, outcome, error_code, recorded_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM ingestion_attempts
      WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
    )
  `)
    .bind(
      runId,
      run.producer_id,
      run.source_id,
      clientId,
      fields.ingest_client_version,
      fields.external_attempt_id,
      fields.started_at_ms,
      fields.completed_at_ms,
      fields.expected_artifact_count,
      fields.observed_artifact_count,
      fields.accepted_artifact_count,
      fields.reused_artifact_count,
      fields.rejected_artifact_count,
      fields.outcome,
      fields.error_code,
      now,
      runId,
      clientId,
      fields.external_attempt_id,
    )
    .run();
  const attempt = await env.DB.prepare(`
    SELECT id, ingest_client_version, external_attempt_id, started_at_ms, completed_at_ms,
           expected_artifact_count, observed_artifact_count, accepted_artifact_count,
           reused_artifact_count, rejected_artifact_count, outcome, error_code
    FROM ingestion_attempts
    WHERE fetch_run_id = ? AND ingest_client_id = ? AND external_attempt_id = ?
  `)
    .bind(runId, clientId, fields.external_attempt_id)
    .first<RecordValue>();
  assertSame(attempt, fields, "ingestion_attempt_conflict");
  return { attemptId: attempt!.id as number, outcome: fields.outcome };
}
