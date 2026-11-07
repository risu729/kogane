// The evidence browser's catalogue reads: a source's sealed runs, a run's
// inventoried artifacts and one artifact's row. Moved here from
// `services/app/src/read.ts` (ADR 0081 point 2), so `GET /api/evidence/v1/*`
// and `kogane.evidence.read` run the same SQL and no MCP adapter holds any.
// A missing run or artifact is `null`; the route turns it into its 404.
import type {
  EvidenceRun,
  EvidenceArtifact,
  EvidenceArtifactDetail,
} from "../../../observation-shared/src/evidence-contract";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

export interface EvidenceRunRow {
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
export interface EvidenceArtifactRow {
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
function runDto(row: EvidenceRunRow): EvidenceRun {
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
export function artifactDto(row: EvidenceArtifactRow): EvidenceArtifact {
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
export function detailDto(row: EvidenceArtifactRow): EvidenceArtifactDetail["artifact"] {
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
/** One page of a source's sealed runs below `before`, newest first. */
export async function listEvidenceRuns(sql: SqlExecutor, source: string, before: number) {
  const results = await sql.all<EvidenceRunRow>(
    `${RUN_SELECT} WHERE r.source_id = ? AND r.id < ? ORDER BY r.id DESC LIMIT 51`,
    [source, before],
  );
  return {
    items: results.slice(0, 50).map(runDto),
    nextCursor: results.length > 50 ? `c_${results[49]!.id}` : null,
  };
}

/** One sealed run of the source, or null when it has none by that id. */
export async function evidenceRun(
  sql: SqlExecutor,
  source: string,
  id: number,
): Promise<EvidenceRun | null> {
  const row = await sql.first<EvidenceRunRow>(`${RUN_SELECT} WHERE r.source_id = ? AND r.id = ?`, [
    source,
    id,
  ]);
  return row ? runDto(row) : null;
}

/** One page of a run's inventoried artifacts below `before`, newest first. */
export async function listEvidenceArtifacts(
  sql: SqlExecutor,
  source: string,
  run: number,
  before: number,
) {
  const results = await sql.all<EvidenceArtifactRow>(
    `${ARTIFACT_SELECT} AND a.id < ? ORDER BY a.id DESC LIMIT 51`,
    [source, run, before],
  );
  return {
    items: results.slice(0, 50).map(artifactDto),
    nextCursor: results.length > 50 ? `c_${results[49]!.id}` : null,
  };
}

/** One artifact of the run's sealed inventory, or null when it is not in it. */
export function evidenceArtifact(
  sql: SqlExecutor,
  source: string,
  run: number,
  id: number,
): Promise<EvidenceArtifactRow | null> {
  return sql.first<EvidenceArtifactRow>(`${ARTIFACT_SELECT} AND a.id = ?`, [source, run, id]);
}
