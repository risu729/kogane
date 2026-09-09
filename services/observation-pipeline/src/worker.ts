import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry.ts";
import { resolveIdentity } from "../../../poc/observation-pipeline/src/identity/index.ts";
import {
  snapshotPolicyComparisonSql,
  type SnapshotPolicyComparisonRow,
} from "../../../poc/observation-pipeline/src/snapshot-query.ts";
import {
  coverageClaimViolations,
  validCoverageClaim,
  validParseIssue,
} from "../../../packages/domain/src/coverage.ts";
import { SNAPSHOT_RELATIONS, unitParseable } from "../../../packages/read-model/src/concepts";
import { IDENTITY_POLICY_VERSION, identitySweep } from "./identity-store.ts";
import { executeIdentityCommand } from "./identity-commands.ts";
import { changeCommandRoute } from "./change-commands.ts";
import { dispatchDecisionOutbox } from "./decision-outbox.ts";
import { reconciliationEnabled, reconciliationSweep } from "./reconciliation-job.ts";
import {
  publicationConsistency,
  publicationStatements,
  REPAIR_LIMIT_DEFAULT,
  repairPublication,
} from "./publication-gate.ts";
import {
  extractMetadata,
  isMetadataExtractorRelease,
  LEGACY_METADATA_RELEASE,
  MetadataError,
  persistProjection,
  type MetadataExtractorRelease,
} from "./metadata-extractors/index.ts";
import {
  activeRelease,
  inputFingerprint,
  lookupRelease,
  registerDeployedReleases,
  releaseIdentity,
  releaseInsert,
} from "./releases.ts";
import {
  activateRelease,
  candidateBatch,
  candidatesEnabled,
  compareReleases,
  ReleaseCommandError,
  releaseStatus,
  rollbackRelease,
  type AdoptionRequest,
} from "./release-adoption.ts";
import type {
  ArtifactMeta,
  CoverageClaim,
  Observation,
  Parser,
  ParseIssue,
  ParseResult,
} from "../../../poc/observation-pipeline/src/types.ts";

const SCAN_PAGE = 200;
const JOBS_PER_SWEEP = 12;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60 * 1000;
// Contract v2 budgets: bounded like observation rows so one artifact cannot
// flood D1 with diagnostics. A parser exceeding them is a parser bug.
const MAX_ISSUES = 10_000;
const ISSUE_CHUNK = 500;
const MAX_COVERAGE_CLAIMS = 100;
class PipelineError extends Error {}
interface ArtifactRow {
  id: number;
  fetch_run_id: number;
  source_id: string;
  dataset: string | null;
  artifact_key: string;
  fetch_unit_key: string | null;
  mime: string;
  fetched_at: string;
  sha256: string;
  blob_key: string;
  byte_size: number;
  window_start: string | null;
  window_end: string | null;
  run_status: "success" | "partial" | "failed";
  run_failure_count: number;
  /** The artifact's own fetch-unit terminal outcome (0037); NULL when it has no unit. */
  unit_outcome: string | null;
  /** 'success' when that unit is provably complete, else 'failed'; NULL when it has no unit. */
  unit_status: "success" | "failed" | null;
}
interface Job {
  fetch_artifact_id: number;
  parser_name: string;
  parser_version: string;
  attempts: number;
  /** Release a replay plan aims this job at (0035); NULL for ordinary jobs. */
  target_release?: string | null;
}
// Parse eligibility is the D13 `unitParseable` predicate, driven by the
// dataset's `dataset_snapshot_policies.unit_scope` row: `run` (the default and
// the only seeded value) requires the whole parent run to have succeeded;
// `unit` also admits an artifact whose own fetch unit succeeded on a sealed
// partial run. Every lane creates jobs through this same statement, so a
// partial run can only ever produce jobs for its eligible units. The run
// outcome and the unit outcome are selected so every coverage claim records
// which of the two allowed the parse.
const artifactSql = `SELECT a.*,o.blob_key,o.byte_size,r.status AS run_status,r.failure_count AS run_failure_count,
 (SELECT au.unit_outcome FROM observation_fetch_artifact_units au WHERE au.fetch_artifact_id=a.id) AS unit_outcome,
 (SELECT au.unit_status FROM observation_fetch_artifact_units au WHERE au.fetch_artifact_id=a.id) AS unit_status,
 coalesce((SELECT start_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_start) AS window_start,
 coalesce((SELECT end_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_end) AS window_end
 FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
 JOIN raw_objects o ON o.sha256=a.sha256 WHERE ${unitParseable.policyPredicate("r", "a")}`;

export function artifactMeta(row: ArtifactRow): ArtifactMeta {
  return {
    id: row.id,
    sourceId: row.source_id,
    runStatus: row.run_status,
    runFailureCount: row.run_failure_count,
    // `artifactSql` already applied the policy: a row whose parent run is not
    // a clean success can only have been admitted by `unit-independent-v1`,
    // and the parser's own precondition may rely on the unit instead (D13).
    unitScopeEligibility:
      row.run_status === "success" && row.run_failure_count === 0 ? null : "unit-independent-v1",
    ...(row.window_start && row.window_end
      ? { runWindow: { from: row.window_start, to: row.window_end } }
      : {}),
    dataset: row.dataset,
    artifactKey: row.artifact_key,
    fetchUnitKey: row.fetch_unit_key,
    statementState: null,
    period: null,
    url: null,
    mime: row.mime,
    fetchedAt: row.fetched_at,
    sha256: row.sha256,
  };
}

async function verifiedBytes(
  env: Env,
  row: { blob_key: string; byte_size: number; sha256: string },
): Promise<Uint8Array> {
  if (row.byte_size > MAX_BYTES) throw new PipelineError("artifact_too_large");
  const object = await env.EVIDENCE.get(row.blob_key);
  if (!object) throw new PipelineError("raw_object_missing");
  if (object.size !== row.byte_size || object.size > MAX_BYTES)
    throw new PipelineError("raw_size_mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== row.sha256)
    throw new PipelineError("raw_checksum_mismatch");
  return bytes;
}

/**
 * Metadata for one artifact, produced by a versioned extractor and recorded
 * as a `metadata_projections` row (D02, docs/release-adoption.md). The
 * default release `legacy-metadata-v1` applies exactly the rules this
 * function applied before A04, including its reuse of an existing
 * `observation_artifact_metadata` row, so nothing a reader sees changes; the
 * projection is the append-only record of which extraction the parse read.
 */
async function hydrateMeta(
  env: Env,
  row: ArtifactRow,
  release: MetadataExtractorRelease,
): Promise<{ meta: ArtifactMeta; projectionId: number }> {
  const meta = artifactMeta(row);
  const extraction = await extractMetadata(
    { db: env.DB, read: (manifest) => verifiedBytes(env, manifest) },
    row,
    release,
  );
  meta.statementState = extraction.output.statementState;
  meta.period = extraction.output.period;
  // A manifest-stated media type replaces the declared one; the extractor
  // makes no claim when it returns null and Layer A's value stands.
  if (extraction.output.mime !== null) meta.mime = extraction.output.mime;
  const projectionId = await persistProjection(
    env.DB,
    row,
    release,
    extraction,
    new Date().toISOString(),
  );
  return { meta, projectionId };
}

function extractorRelease(value: string | null | undefined): MetadataExtractorRelease {
  if (value === null || value === undefined) return LEGACY_METADATA_RELEASE;
  if (!isMetadataExtractorRelease(value)) throw new PipelineError("metadata_release_unknown");
  return value;
}

const fields = {
  transaction: [
    "sourceAccount",
    "externalId",
    "status",
    "amountMinor",
    "amountText",
    "amountScale",
    "currency",
    "description",
    "counterparty",
    "asOf",
    "observedAt",
    "rawLocator",
    "extra",
  ],
  balance: [
    "sourceAccount",
    "metric",
    "amountMinor",
    "amountText",
    "amountScale",
    "instrument",
    "asOf",
    "observedAt",
    "rawLocator",
    "extra",
  ],
  position: [
    "sourceAccount",
    "securityCode",
    "securityName",
    "market",
    "quantityText",
    "quantityScale",
    "currency",
    "asOf",
    "observedAt",
    "rawLocator",
    "extra",
  ],
  valuation: [
    "sourceAccount",
    "subject",
    "metric",
    "amountMinor",
    "amountText",
    "amountScale",
    "currency",
    "asOf",
    "observedAt",
    "rawLocator",
    "extra",
  ],
} as const;
const snake = (field: string) =>
  field === "extra" ? "extra_json" : field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function observationInsert(
  db: D1Database,
  id: number,
  kind: Observation["kind"],
  rows: Observation[],
): D1PreparedStatement {
  const names = fields[kind];
  return db
    .prepare(
      `INSERT INTO ${kind}_observations(parse_run_id,${names.map(snake).join(",")}) SELECT ?,${names.map((n) => `json_extract(value,'$.${n}')`).join(",")} FROM json_each(?)`,
    )
    .bind(id, JSON.stringify(rows));
}

/**
 * Contract v2 output, validated against the domain contract before anything
 * is written. A legacy parser (no issues, no coverage) yields empty lists and
 * nothing is persisted for it; no claim is ever synthesized.
 */
export function contractRows(result: ParseResult): {
  issues: ParseIssue[];
  coverage: CoverageClaim[];
} {
  const issues = result.issues ?? [];
  const coverage = result.coverage ?? [];
  if (issues.length > MAX_ISSUES || coverage.length > MAX_COVERAGE_CLAIMS)
    throw new PipelineError("parse_contract_invalid");
  for (const issue of issues)
    if (!validParseIssue(issue)) throw new PipelineError("parse_contract_invalid");
  for (const claim of coverage) {
    if (!validCoverageClaim(claim) || coverageClaimViolations(claim).length > 0)
      throw new PipelineError("parse_contract_invalid");
  }
  if (new Set(coverage.map((claim) => claim.claimId)).size !== coverage.length)
    throw new PipelineError("parse_contract_invalid");
  return { issues, coverage };
}

function issueInsert(db: D1Database, id: number, rows: ParseIssue[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO parse_issues(parse_run_id,code,locator,severity,impact,message) SELECT ?,json_extract(value,'$.code'),json_extract(value,'$.locator'),json_extract(value,'$.severity'),json_extract(value,'$.impact'),json_extract(value,'$.message') FROM json_each(?)`,
    )
    .bind(id, JSON.stringify(rows));
}

/**
 * The eligibility scope this parse was admitted under. `artifactSql` already
 * refused every ineligible artifact, so an artifact whose parent run is not a
 * clean success can only have arrived through `unit-independent-v1`.
 */
export function claimUnitScope(
  parent: Pick<ArtifactRow, "run_status" | "run_failure_count">,
): "run" | "unit" {
  return parent.run_status === "success" && parent.run_failure_count === 0 ? "run" : "unit";
}

function coverageInsert(
  db: D1Database,
  id: number,
  rows: CoverageClaim[],
  parent: Pick<ArtifactRow, "run_status" | "run_failure_count" | "unit_outcome">,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO parse_coverage_claims(parse_run_id,claim_id,scope_key,mode,completeness,membership_complete,observed_count,expected_count,evidence_refs_json,policy_version,failure_cause,absence_meaning,parent_run_status,parent_run_failure_count,unit_scope,unit_report_outcome)
       SELECT ?1,json_extract(value,'$.claimId'),json_extract(value,'$.scopeKey'),json_extract(value,'$.mode'),json_extract(value,'$.completeness'),
         CASE WHEN json_extract(value,'$.membershipComplete') THEN 1 ELSE 0 END,
         json_extract(value,'$.observedCount'),json_extract(value,'$.expectedCount'),json_extract(value,'$.evidenceRefs'),
         json_extract(value,'$.policyVersion'),json_extract(value,'$.failureCause'),json_extract(value,'$.absenceMeaning'),?3,?4,?5,?6
       FROM json_each(?2)`,
    )
    .bind(
      id,
      JSON.stringify(rows),
      parent.run_status,
      parent.run_failure_count,
      claimUnitScope(parent),
      parent.unit_outcome,
    );
}

function numericVersion(value: string): number[] {
  const parts = value.split(".").map(Number);
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value) ||
    parts.some((part) => !Number.isSafeInteger(part))
  )
    throw new PipelineError("parser_version_invalid");
  return parts;
}

/** Retire only pending/failed or expired-lease jobs after a strictly newer
 * deployed version has a terminal job and parse result. Done jobs and live
 * leases remain unchanged; all parse evidence remains immutable. */
export async function retireReplacedJobs(
  db: D1Database,
  parsers: readonly Pick<Parser, "name" | "version">[] = PARSERS,
  artifactId?: number,
): Promise<void> {
  const registry = parsers.map((parser) => ({
    name: parser.name,
    version: parser.version,
    parts: numericVersion(parser.version),
  }));
  await db
    .prepare(`WITH registry AS (
      SELECT json_extract(value,'$.name') AS name, json_extract(value,'$.version') AS version,
        json_extract(value,'$.parts[0]') AS major, json_extract(value,'$.parts[1]') AS minor,
        json_extract(value,'$.parts[2]') AS patch FROM json_each(?1)
    ), candidates AS (
      SELECT j.fetch_artifact_id, j.parser_name, j.parser_version,
        CASE WHEN json_valid('['||replace(j.parser_version,'.',',')||']')
          THEN '['||replace(j.parser_version,'.',',')||']' ELSE '[]' END AS parts
      FROM observation_parse_jobs j
      WHERE (j.status IN ('pending','failed') OR (j.status='running' AND j.lease_until_ms<=?3))
        AND (?2 IS NULL OR j.fetch_artifact_id=?2)
        AND j.parser_name IN (SELECT name FROM registry)
        AND coalesce(j.last_error_code,'') <> 'parser_version_retired'
    ), older AS (
      SELECT * FROM candidates WHERE json_array_length(parts)=3
        AND json_type(parts,'$[0]')='integer' AND json_type(parts,'$[1]')='integer'
        AND json_type(parts,'$[2]')='integer'
        AND printf('%d.%d.%d',json_extract(parts,'$[0]'),json_extract(parts,'$[1]'),json_extract(parts,'$[2]'))=parser_version
        AND json_extract(parts,'$[0]') BETWEEN 0 AND 9007199254740991
        AND json_extract(parts,'$[1]') BETWEEN 0 AND 9007199254740991
        AND json_extract(parts,'$[2]') BETWEEN 0 AND 9007199254740991
    ) UPDATE observation_parse_jobs SET status='failed',last_error_code='parser_version_retired',
      lease_token=NULL,lease_until_ms=0
    WHERE (fetch_artifact_id,parser_name,parser_version) IN (
      SELECT old.fetch_artifact_id,old.parser_name,old.parser_version FROM older old
      JOIN registry r ON r.name=old.parser_name
      JOIN observation_parse_jobs replacement ON replacement.fetch_artifact_id=old.fetch_artifact_id
        AND replacement.parser_name=r.name AND replacement.parser_version=r.version
      WHERE replacement.status IN ('done','failed')
        AND coalesce(replacement.last_error_code,'') <> 'parser_version_retired'
        AND (json_extract(old.parts,'$[0]'),json_extract(old.parts,'$[1]'),json_extract(old.parts,'$[2]'))
          < (r.major,r.minor,r.patch)
        AND EXISTS (SELECT 1 FROM parse_runs p WHERE p.fetch_artifact_id=replacement.fetch_artifact_id
          AND p.parser_name=replacement.parser_name AND p.parser_version=replacement.parser_version
          AND p.status IN ('ok','error'))
    )`)
    .bind(JSON.stringify(registry), artifactId ?? null, Date.now())
    .run();
}

export async function parseJob(
  env: Env,
  job: Job,
  parser: Parser,
): Promise<"parsed" | "error" | "skipped"> {
  const result = await executeParseJob(env, job, parser);
  try {
    numericVersion(parser.version);
  } catch {
    return result;
  }
  // Keep maintenance errors outside the parser's catch: a published success
  // must never gain a fabricated parser-error attempt if retirement fails.
  await retireReplacedJobs(env.DB, [parser], job.fetch_artifact_id);
  return result;
}

export interface PublishInput {
  parseId: number;
  /** The lease this attempt holds; nothing publishes once it has expired. */
  token: string;
  version: number[];
  artifactId: number;
  parserName: string;
  publishedAt: string;
  now: number;
}

/**
 * The publish transaction of a successful *adopted* parse, in order: mark the
 * run ok (born superseded when a numerically newer success is already current),
 * supersede older successes if this run is current, move the publication
 * projection and record its event (0026, same decision), then close the job.
 * Every statement that writes is fenced on the live lease, not only the
 * first: an expired lease changes nothing, and replaying the whole batch for
 * a run that is already published changes nothing either, because the effect
 * the later statements would otherwise key on is already committed.
 * Candidate results (`parse_run_candidates`, migration 0028) are excluded from
 * supersession in both directions: a candidate must not be turned into
 * replaced history by a later normal publish, and a candidate at a higher
 * version must not supersede the run readers actually use. With the release
 * flag off that table is empty and this batch behaves exactly as before.
 * Exported for the publication-gate tests only.
 */
export function publishBatch(env: Env, input: PublishInput): D1PreparedStatement[] {
  const { parseId, token, version, artifactId, parserName, publishedAt, now } = input;
  return [
    env.DB.prepare(
      `UPDATE parse_runs SET status='ok',superseded_by_parse_run_id=(
          SELECT newer.id FROM parse_runs newer
          WHERE newer.fetch_artifact_id=parse_runs.fetch_artifact_id
            AND newer.parser_name=parse_runs.parser_name AND newer.status='ok'
            AND newer.superseded_by_parse_run_id IS NULL -- gate:writer
            AND NOT EXISTS(SELECT 1 FROM parse_run_candidates c WHERE c.parse_run_id=newer.id)
            AND (
              json_extract('['||replace(newer.parser_version,'.',',')||']','$[0]'),
              json_extract('['||replace(newer.parser_version,'.',',')||']','$[1]'),
              json_extract('['||replace(newer.parser_version,'.',',')||']','$[2]')
            ) > (?,?,?)
          ORDER BY
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[0]') DESC,
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[1]') DESC,
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[2]') DESC LIMIT 1
        ) WHERE id=? AND EXISTS(SELECT 1 FROM observation_parse_jobs WHERE lease_token=? AND status='running' AND lease_until_ms>?)`,
    ).bind(version[0]!, version[1]!, version[2]!, parseId, token, now),
    env.DB.prepare(
      `UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE fetch_artifact_id=? AND parser_name=? AND id<>? AND status='ok' AND superseded_by_parse_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM parse_run_candidates c WHERE c.parse_run_id=parse_runs.id) AND EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=? AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL)`, // gate:writer
    ).bind(parseId, artifactId, parserName, parseId, parseId),
    ...publicationStatements(env.DB, parseId, publishedAt, token, now),
    // Fenced on the live lease like the first statement: a replayed batch
    // must not touch a job another attempt has already closed.
    env.DB.prepare(
      `UPDATE observation_parse_jobs SET status='done',last_error_code=NULL WHERE lease_token=? AND status='running' AND EXISTS(SELECT 1 FROM parse_runs WHERE id=? AND status='ok')`,
    ).bind(token, parseId),
  ];
}

async function executeParseJob(
  env: Env,
  job: Job,
  parser: Parser,
): Promise<"parsed" | "error" | "skipped"> {
  const now = Date.now();
  const token = crypto.randomUUID();
  const claim =
    await env.DB.prepare(`UPDATE observation_parse_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until_ms=?
    WHERE fetch_artifact_id=? AND parser_name=? AND parser_version=? AND attempts<? AND
    ((status='pending' AND available_at_ms<=?) OR (status='running' AND lease_until_ms<=?))`)
      .bind(
        token,
        now + LEASE_MS,
        job.fetch_artifact_id,
        parser.name,
        parser.version,
        MAX_ATTEMPTS,
        now,
        now,
      )
      .run();
  if (!claim.meta.changes) return "skipped";
  await env.DB.prepare(
    "UPDATE parse_runs SET status='error',error='parse_interrupted' WHERE fetch_artifact_id=? AND parser_name=? AND parser_version=? AND status='pending'",
  )
    .bind(job.fetch_artifact_id, parser.name, parser.version)
    .run();
  let parseId: number | undefined;
  let failureStage = "metadata_or_raw_read_failed";
  try {
    const version = numericVersion(parser.version);
    const row = await env.DB.prepare(artifactSql + " AND a.id=?")
      .bind(job.fetch_artifact_id)
      .first<ArtifactRow>();
    if (!row) throw new PipelineError("artifact_not_eligible");
    const already = await env.DB.prepare(
      "SELECT id FROM parse_runs WHERE fetch_artifact_id=? AND parser_name=? AND parser_version=? AND status='ok'",
    )
      .bind(row.id, parser.name, parser.version)
      .first();
    if (already) {
      await env.DB.prepare("UPDATE observation_parse_jobs SET status='done' WHERE lease_token=?")
        .bind(token)
        .run();
      return "skipped";
    }
    // Which transformation is this run? A job aimed at a registered release
    // that is not the dataset's active one is a candidate; anything else is a
    // normal run of the deployed code. With the flag off `target_release` is
    // ignored entirely and this is the pre-A04 path.
    const active = await activeRelease(env.DB, {
      sourceId: row.source_id,
      dataset: row.dataset,
      parserName: parser.name,
    });
    const target =
      candidatesEnabled(env) && job.target_release
        ? await lookupRelease(env.DB, job.target_release)
        : null;
    const candidate =
      target !== null &&
      target.parser_name === parser.name &&
      target.semantic_version === parser.version &&
      target.release_id !== (active?.release_id ?? null);
    const release = extractorRelease(
      candidate ? target!.metadata_extractor_release : active?.metadata_extractor_release,
    );
    const identity = await releaseIdentity(parser, release);
    if (candidate && identity.releaseId !== target!.release_id)
      throw new PipelineError("release_manifest_mismatch");
    // Registering here is what refuses a deployment that changed a parser
    // without changing its version: migration 0028's trigger aborts, and the
    // attempt fails loudly instead of writing an unidentifiable result.
    try {
      await releaseInsert(
        env.DB,
        { parser, metadataExtractorRelease: release, ...identity },
        new Date().toISOString(),
      ).run();
    } catch {
      throw new PipelineError("parser_release_conflict");
    }
    const { meta, projectionId } = await hydrateMeta(env, row, release);
    if (!parser.accepts(meta)) throw new PipelineError("parser_no_longer_accepts");
    const bytes = await verifiedBytes(env, row);
    failureStage = "parser_rejected";
    const result = parser.parse(bytes, meta);
    if (result.observations.length > 100_000) throw new PipelineError("observation_limit_exceeded");
    // Bound D1 statement count per invocation as well as in-memory raw bytes.
    if (new TextEncoder().encode(JSON.stringify(result.observations)).length > 2 * 1024 * 1024)
      throw new PipelineError("observation_payload_too_large");
    const contract = contractRows(result);
    failureStage = "persistence_failed";
    const inserted = await env.DB.prepare(
      `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'pending',?) RETURNING id`,
    )
      .bind(
        row.id,
        parser.name,
        parser.version,
        new Date().toISOString(),
        JSON.stringify(result.warnings),
      )
      .first<{ id: number }>();
    if (!inserted) throw new PipelineError("parse_run_insert_failed");
    parseId = inserted.id;
    // The input identity of this attempt, recorded whatever the outcome:
    // H(raw digest, parser-visible metadata, transform manifest digest).
    await env.DB.prepare(
      "INSERT OR IGNORE INTO parse_input_references(parse_run_id,metadata_projection_id,parser_release_id,input_fingerprint) VALUES(?,?,?,?)",
    )
      .bind(
        parseId,
        projectionId,
        identity.releaseId,
        await inputFingerprint({
          rawSha256: row.sha256,
          meta,
          manifestDigest: identity.manifestDigest,
        }),
      )
      .run();
    for (const kind of Object.keys(fields) as Observation["kind"][]) {
      let chunk: Observation[] = [];
      let bytes = 0;
      for (const observation of result.observations) {
        if (observation.kind !== kind) continue;
        const size = new TextEncoder().encode(JSON.stringify(observation)).length;
        if (size > 500_000) throw new PipelineError("observation_row_too_large");
        if (bytes + size > 500_000 && chunk.length) {
          await observationInsert(env.DB, parseId, kind, chunk).run();
          chunk = [];
          bytes = 0;
        }
        chunk.push(observation);
        bytes += size;
      }
      if (chunk.length) await observationInsert(env.DB, parseId, kind, chunk).run();
    }
    // Contract v2 rows belong to the same pending parse run as the
    // observations: invisible until the publish batch below sets status='ok',
    // and left attached to an error run if publication fails.
    for (let offset = 0; offset < contract.issues.length; offset += ISSUE_CHUNK)
      await issueInsert(env.DB, parseId, contract.issues.slice(offset, offset + ISSUE_CHUNK)).run();
    if (contract.coverage.length)
      await coverageInsert(env.DB, parseId, contract.coverage, row).run();
    // A lost lease cannot publish rows. All visibility and supersession changes
    // occur in one D1 transaction; empty successful parses are published too.
    // A candidate takes the other batch: it is marked ok and recorded as a
    // candidate of its release, and never reaches the publication pointer.
    const publish = await env.DB.batch(
      candidate
        ? candidateBatch(env.DB, {
            parseId,
            token,
            releaseId: identity.releaseId,
            fingerprint: await inputFingerprint({
              rawSha256: row.sha256,
              meta,
              manifestDigest: identity.manifestDigest,
            }),
            createdAt: new Date().toISOString(),
            now: Date.now(),
          })
        : publishBatch(env, {
            parseId,
            token,
            version,
            artifactId: row.id,
            parserName: parser.name,
            publishedAt: new Date().toISOString(),
            now: Date.now(),
          }),
    );
    if (!publish[0]?.meta.changes) throw new PipelineError("parse_lease_expired");
    return "parsed";
  } catch (error) {
    // Parser exception strings may contain provider values; retain a safe code
    // and full provenance, never financial rows or secret-bearing error text.
    const code =
      error instanceof PipelineError || error instanceof MetadataError
        ? error.message
        : failureStage;
    if (parseId !== undefined) {
      await env.DB.prepare(
        "UPDATE parse_runs SET status='error',error=? WHERE id=? AND status='pending'",
      )
        .bind(code, parseId)
        .run();
    } else {
      await env.DB.prepare(
        "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,error,warnings_json) VALUES(?,?,?,?,'error',?,'[]')",
      )
        .bind(job.fetch_artifact_id, parser.name, parser.version, new Date().toISOString(), code)
        .run();
    }
    // A parser that rejects its input or violates the output contract is
    // deterministic: retrying at the same version cannot succeed.
    await env.DB.prepare(
      `UPDATE observation_parse_jobs SET status=CASE WHEN attempts>=? OR ? IN ('parser_rejected','parse_contract_invalid') THEN 'failed' ELSE 'pending' END,available_at_ms=?,last_error_code=? WHERE lease_token=? AND status='running'`,
    )
      .bind(
        MAX_ATTEMPTS,
        code,
        Date.now() + Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** (job.attempts + 1)),
        code,
        token,
      )
      .run();
    return "error";
  }
}

const LANES = ["incremental", "repair", "replay"] as const;
export type Lane = (typeof LANES)[number];
/** Jobs executed per sweep and lane. Incremental keeps the historical
 * per-sweep budget; repair and replay are smaller so a large replay backlog
 * or a slow history scan never delays freshly sealed evidence. */
const LANE_BUDGETS: Record<Lane, number> = { incremental: JOBS_PER_SWEEP, repair: 4, replay: 8 };
const MAX_LANE_JOBS = 40;
const WORK_ITEMS_PER_SWEEP = 50;
const WORK_ITEM_PAGE = 100;
const WORK_ITEM_PAGES_PER_SWEEP = 5;
const REPAIR_SCAN_PAGE = 100;
const REPLAY_STEP = 200;
const REPLAY_PLANS_PER_SWEEP = 2;
const PLAN_STATUSES = ["planned", "running", "paused", "completed", "cancelled"] as const;
type PlanStatus = (typeof PLAN_STATUSES)[number];
interface PlanRow {
  id: number;
  created_at_ms: number;
  updated_at_ms: number;
  source_id: string;
  dataset: string | null;
  parser_name: string;
  parser_version: string;
  target_release: string | null;
  artifact_id_from: number;
  artifact_id_high_water: number;
  fetched_from: string | null;
  fetched_to: string | null;
  status: PlanStatus;
  estimated_artifacts: number;
  already_parsed: number;
  jobs_created: number;
  creation_cursor: number;
  creation_complete: number;
  reason: string;
}
export interface LaneSummary {
  created: number;
  parsed: number;
  error: number;
  skipped: number;
  scanned: number;
  workItems: number;
  plans: number;
}
export interface SweepOptions {
  maxJobs?: number;
  lane?: Lane;
}

function jobInsert(
  env: Env,
  artifactId: number,
  parser: Pick<Parser, "name" | "version">,
  lane: Lane,
  now: number,
  plan?: Pick<PlanRow, "id" | "target_release">,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lane,created_at_ms,replay_plan_id,target_release) VALUES(?,?,?,'pending',?,?,?,?)",
  ).bind(
    artifactId,
    parser.name,
    parser.version,
    lane,
    now,
    plan?.id ?? null,
    plan?.target_release ?? null,
  );
}

/**
 * The release each dataset publishes from, as a lookup for job creation:
 * `${source}/${dataset}/${parser}` -> semantic version. Empty until an
 * operator activates a release, which is why job creation is unchanged for
 * every deployment that never uses the candidate lane.
 */
async function activeParserVersions(env: Env): Promise<Map<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT ar.source_id,ar.dataset,ar.parser_name,r.semantic_version
      FROM active_releases ar JOIN parser_releases r ON r.release_id=ar.release_id`,
  ).all<{ source_id: string; dataset: string; parser_name: string; semantic_version: string }>();
  return new Map(
    rows.results.map((row) => [
      `${row.source_id}/${row.dataset}/${row.parser_name}`,
      row.semantic_version,
    ]),
  );
}

/**
 * Parsers whose jobs the normal lanes create for one artifact: the deployed
 * registry, narrowed to the active release's version where the dataset has a
 * pointer and that version is deployed. A pointer naming a version this build
 * does not carry falls back to the registry, so a rolled-back release never
 * strands the incremental lane on a version nothing can execute.
 */
function laneParsers(
  row: ArtifactRow,
  active: Map<string, string>,
  deployed: readonly Parser[] = PARSERS,
): readonly Parser[] {
  const meta = artifactMeta(row);
  return deployed.filter((parser) => {
    if (!parser.accepts(meta)) return false;
    const pinned =
      row.dataset === null
        ? undefined
        : active.get(`${row.source_id}/${row.dataset}/${parser.name}`);
    if (pinned === undefined) return true;
    if (!deployed.some((other) => other.name === parser.name && other.version === pinned))
      return true;
    return parser.version === pinned;
  });
}

async function insertJobs(env: Env, inserts: D1PreparedStatement[]): Promise<number> {
  let created = 0;
  for (let offset = 0; offset < inserts.length; offset += 50)
    for (const result of await env.DB.batch(inserts.slice(offset, offset + 50)))
      created += result.meta.changes;
  return created;
}

/** Incremental lane: sealed-run notifications appended by the D1 trigger.
 * Each item is examined in bounded artifact pages with a durable cursor, so a
 * staged run of thousands of artifacts progresses across sweeps without
 * blocking other items or repeating work after an interruption. */
async function consumeWorkItems(env: Env, limit: number) {
  const summary = { processed: 0, created: 0, examined: 0, cursor: 0 };
  const active = await activeParserVersions(env);
  const items = await env.DB.prepare(
    "SELECT id,fetch_run_id,cursor_artifact_id,jobs_created FROM observation_work_items WHERE processed_at_ms IS NULL ORDER BY id LIMIT ?",
  )
    .bind(limit)
    .all<{ id: number; fetch_run_id: number; cursor_artifact_id: number; jobs_created: number }>();
  let pages = 0;
  for (const item of items.results) {
    let cursor = item.cursor_artifact_id;
    let created = 0;
    let complete = false;
    while (pages < WORK_ITEM_PAGES_PER_SWEEP) {
      pages++;
      const page = await env.DB.prepare(
        artifactSql + " AND a.fetch_run_id=? AND a.id>? ORDER BY a.id LIMIT ?",
      )
        .bind(item.fetch_run_id, cursor, WORK_ITEM_PAGE)
        .all<ArtifactRow>();
      summary.examined += page.results.length;
      const now = Date.now();
      const inserts: D1PreparedStatement[] = [];
      for (const row of page.results)
        for (const parser of laneParsers(row, active))
          inserts.push(jobInsert(env, row.id, parser, "incremental", now));
      created += await insertJobs(env, inserts);
      const last = page.results.at(-1);
      if (last) cursor = last.id;
      if (page.results.length < WORK_ITEM_PAGE) {
        complete = true;
        break;
      }
    }
    const total = item.jobs_created + created;
    const outcome = total > 0 ? "jobs_created" : cursor > 0 ? "no_new_jobs" : "not_eligible";
    await env.DB.prepare(
      "UPDATE observation_work_items SET cursor_artifact_id=?,jobs_created=?,processed_at_ms=CASE WHEN ? THEN ? ELSE NULL END,outcome=CASE WHEN ? THEN ? ELSE NULL END WHERE id=? AND processed_at_ms IS NULL",
    )
      .bind(cursor, total, complete ? 1 : 0, Date.now(), complete ? 1 : 0, outcome, item.id)
      .run();
    summary.created += created;
    if (complete) {
      summary.processed++;
      summary.cursor = item.id;
    }
    if (pages >= WORK_ITEM_PAGES_PER_SWEEP) break;
  }
  return summary;
}

/** Repair lane: the historical cyclic artifact cursor in observation_scan_state
 * row 1. It recovers lost notifications and discovers work for newly deployed
 * parser versions, one bounded page per sweep. */
async function repairScan(env: Env) {
  const state = await env.DB.prepare("SELECT cursor FROM observation_scan_state WHERE id=1").first<{
    cursor: number;
  }>();
  const from = state?.cursor ?? 0;
  const candidates = await env.DB.prepare(
    "SELECT id FROM fetch_artifacts WHERE id>? ORDER BY id LIMIT ?",
  )
    .bind(from, REPAIR_SCAN_PAGE)
    .all<{ id: number }>();
  const summary = { scanned: candidates.results.length, created: 0, cursor: 0 };
  if (!candidates.results.length) {
    await env.DB.prepare("UPDATE observation_scan_state SET cursor=0 WHERE id=1 AND cursor=?")
      .bind(from)
      .run();
    return summary;
  }
  const last = candidates.results.at(-1)!.id;
  const eligible = await env.DB.prepare(artifactSql + " AND a.id>? AND a.id<=? ORDER BY a.id")
    .bind(from, last)
    .all<ArtifactRow>();
  const known = await env.DB.prepare(
    "SELECT fetch_artifact_id,parser_name,parser_version FROM observation_parse_jobs WHERE fetch_artifact_id>? AND fetch_artifact_id<=?",
  )
    .bind(from, last)
    .all<Job>();
  const knownKeys = new Set(
    known.results.map((job) => `${job.fetch_artifact_id}/${job.parser_name}/${job.parser_version}`),
  );
  const now = Date.now();
  const active = await activeParserVersions(env);
  const inserts: D1PreparedStatement[] = [];
  for (const row of eligible.results)
    for (const parser of laneParsers(row, active)) {
      if (
        !knownKeys.has(`${row.id}/${parser.name}/${parser.version}`) &&
        inserts.length < SCAN_PAGE
      )
        inserts.push(jobInsert(env, row.id, parser, "repair", now));
    }
  summary.created = await insertJobs(env, inserts);
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=? WHERE id=1 AND cursor=?")
    .bind(last, from)
    .run();
  summary.cursor = last;
  return summary;
}

// Range filters shared by plan estimation and bounded job creation. The
// artifact id high-water is fixed at plan time; ?3 is the creation cursor.
const replayFilterSql = ` AND a.source_id=?1 AND (?2 IS NULL OR a.dataset=?2) AND a.id>?3 AND a.id<=?4
 AND substr(a.fetched_at,1,10)>=coalesce(?5,'0000-00-00') AND substr(a.fetched_at,1,10)<=coalesce(?6,'9999-12-31')`;

/** One bounded creation step for a running plan. Jobs that already exist at
 * this artifact/parser/version keep their lane; a job for a version with a
 * published success is skipped by executeParseJob exactly like any other. */
async function replayStep(env: Env, plan: PlanRow) {
  const parser = PARSERS.find(
    (p) => p.name === plan.parser_name && p.version === plan.parser_version,
  );
  if (!parser || plan.status !== "running" || plan.creation_complete)
    return { created: 0, examined: 0, complete: plan.creation_complete === 1 };
  const rows = await env.DB.prepare(artifactSql + replayFilterSql + " ORDER BY a.id LIMIT ?7")
    .bind(
      plan.source_id,
      plan.dataset,
      Math.max(plan.creation_cursor, plan.artifact_id_from),
      plan.artifact_id_high_water,
      plan.fetched_from,
      plan.fetched_to,
      REPLAY_STEP,
    )
    .all<ArtifactRow>();
  const now = Date.now();
  const inserts = rows.results
    .filter((row) => parser.accepts(artifactMeta(row)))
    .map((row) => jobInsert(env, row.id, parser, "replay", now, plan));
  const created = await insertJobs(env, inserts);
  const complete = rows.results.length < REPLAY_STEP;
  const cursor = complete ? plan.artifact_id_high_water : rows.results.at(-1)!.id;
  await env.DB.prepare(
    "UPDATE observation_replay_plans SET creation_cursor=?,creation_complete=?,jobs_created=jobs_created+?,updated_at_ms=? WHERE id=? AND status='running'",
  )
    .bind(cursor, complete ? 1 : 0, created, now, plan.id)
    .run();
  return { created, examined: rows.results.length, complete };
}

async function replayCreation(env: Env) {
  const summary = { created: 0, examined: 0, plans: 0, cursor: 0 };
  const plans = await env.DB.prepare(
    "SELECT * FROM observation_replay_plans WHERE status='running' AND creation_complete=0 ORDER BY id LIMIT ?",
  )
    .bind(REPLAY_PLANS_PER_SWEEP)
    .all<PlanRow>();
  for (const plan of plans.results) {
    const step = await replayStep(env, plan);
    summary.created += step.created;
    summary.examined += step.examined;
    summary.plans++;
    summary.cursor = plan.id;
  }
  return summary;
}

async function completeReplayPlans(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE observation_replay_plans SET status='completed',updated_at_ms=? WHERE status='running' AND creation_complete=1
      AND NOT EXISTS(SELECT 1 FROM observation_parse_jobs j WHERE j.replay_plan_id=observation_replay_plans.id AND j.status IN ('pending','running'))`,
  )
    .bind(Date.now())
    .run();
  return result.meta.changes;
}

async function maintenance(env: Env): Promise<void> {
  // An invocation terminated on its final attempt remains inspectable and does
  // not pin the work queue forever after its lease expires.
  await env.DB.prepare(
    "UPDATE observation_parse_jobs SET status='failed',last_error_code='lease_exhausted' WHERE status='running' AND attempts>=? AND lease_until_ms<=?",
  )
    .bind(MAX_ATTEMPTS, Date.now())
    .run();
  await env.DB.prepare(
    "UPDATE parse_runs SET status='error',error='parse_interrupted' WHERE status='pending' AND EXISTS(SELECT 1 FROM observation_parse_jobs j WHERE j.fetch_artifact_id=parse_runs.fetch_artifact_id AND j.parser_name=parse_runs.parser_name AND j.parser_version=parse_runs.parser_version AND j.status='failed' AND j.last_error_code IN ('lease_exhausted','replay_cancelled'))",
  ).run();
  // Also repairs an interrupted post-publication retirement on the next sweep.
  await retireReplacedJobs(env.DB);
  // Registers the deployed transformation identities. Idempotent, and the
  // 0028 trigger aborts here when a parser changed without a version change,
  // which fails the sweep loudly instead of writing unidentifiable results.
  await registerDeployedReleases(env.DB);
}

async function runLane(env: Env, lane: Lane, budget: number): Promise<LaneSummary> {
  const summary: LaneSummary = {
    created: 0,
    parsed: 0,
    error: 0,
    skipped: 0,
    scanned: 0,
    workItems: 0,
    plans: 0,
  };
  let cursor = 0;
  if (lane === "incremental") {
    const items = await consumeWorkItems(env, WORK_ITEMS_PER_SWEEP);
    summary.created = items.created;
    summary.workItems = items.processed;
    summary.scanned = items.examined;
    cursor = items.cursor;
  } else if (lane === "repair") {
    const scan = await repairScan(env);
    summary.created = scan.created;
    summary.scanned = scan.scanned;
    cursor = scan.cursor;
  } else {
    const creation = await replayCreation(env);
    summary.created = creation.created;
    summary.scanned = creation.examined;
    summary.plans = creation.plans;
    cursor = creation.cursor;
  }
  // Paused or cancelled plans stop unclaimed replay jobs only; a claimed lease
  // finishes through the same fenced publish path as every other job.
  const ready = await env.DB.prepare(
    `SELECT * FROM observation_parse_jobs j WHERE j.lane=?1 AND attempts<?2 AND ((status='pending' AND available_at_ms<=?3) OR (status='running' AND lease_until_ms<=?3))
      AND EXISTS(SELECT 1 FROM json_each(?4) r WHERE json_extract(r.value,'$.name')=j.parser_name AND json_extract(r.value,'$.version')=j.parser_version)
      AND (j.replay_plan_id IS NULL OR EXISTS(SELECT 1 FROM observation_replay_plans p WHERE p.id=j.replay_plan_id AND p.status='running'))
      ORDER BY priority DESC,available_at_ms,fetch_artifact_id LIMIT ?5`,
  )
    .bind(
      lane,
      MAX_ATTEMPTS,
      Date.now(),
      JSON.stringify(PARSERS.map(({ name, version }) => ({ name, version }))),
      budget,
    )
    .all<Job>();
  for (const job of ready.results) {
    const parser = PARSERS.find(
      (p) => p.name === job.parser_name && p.version === job.parser_version,
    );
    if (!parser) {
      summary.skipped++;
      continue;
    }
    summary[await parseJob(env, job, parser)]++;
  }
  if (lane === "replay") summary.plans += await completeReplayPlans(env);
  await env.DB.prepare(
    "UPDATE observation_lane_state SET cursor=?,last_sweep_at_ms=?,last_created=?,last_executed=? WHERE lane=?",
  )
    .bind(cursor, Date.now(), summary.created, summary.parsed + summary.error, lane)
    .run();
  return summary;
}

function clampJobs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_LANE_JOBS, Math.trunc(value) || fallback));
}

/** Lanes consume independent budgets in order incremental → repair → replay.
 * `maxJobs` without a lane overrides the incremental budget only (the
 * historical meaning of the sweep budget); with `lane`, only that lane runs. */
export async function sweep(env: Env, options: SweepOptions = {}) {
  const budgets = { ...LANE_BUDGETS };
  const only = options.lane;
  budgets[only ?? "incremental"] = clampJobs(options.maxJobs, budgets[only ?? "incremental"]);
  await maintenance(env);
  const lanes: Partial<Record<Lane, LaneSummary>> = {};
  const totals = { scanned: 0, parsed: 0, error: 0, skipped: 0 };
  for (const lane of LANES) {
    if (only && lane !== only) continue;
    const summary = await runLane(env, lane, budgets[lane]);
    lanes[lane] = summary;
    totals.scanned += summary.scanned;
    totals.parsed += summary.parsed;
    totals.error += summary.error;
    totals.skipped += summary.skipped;
  }
  return { ...totals, lanes };
}

async function bounded(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function command(request: Request): Promise<Record<string, unknown> | null> {
  const body = await bounded(request, 4096);
  if (body === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const invalid = (code: string) => Response.json({ error: code }, { status: 400 });
const conflict = (code: string) => Response.json({ error: code }, { status: 409 });

function optionalText(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

async function inspectPlan(env: Env, id: number): Promise<Response> {
  const plan = await env.DB.prepare("SELECT * FROM observation_replay_plans WHERE id=?")
    .bind(id)
    .first<PlanRow>();
  if (!plan) return Response.json({ error: "plan_not_found" }, { status: 404 });
  const counts = await env.DB.prepare(
    "SELECT status,count(*) AS count FROM observation_parse_jobs WHERE replay_plan_id=? GROUP BY status",
  )
    .bind(id)
    .all<{ status: string; count: number }>();
  const jobs = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of counts.results)
    if (row.status in jobs) jobs[row.status as keyof typeof jobs] = row.count;
  return Response.json({
    plan,
    jobs,
    parserDeployed: PARSERS.some(
      (p) => p.name === plan.parser_name && p.version === plan.parser_version,
    ),
  });
}

async function planReplay(env: Env, v: Record<string, unknown>): Promise<Response> {
  const source = optionalText(v.source, /^[a-z0-9-]{1,100}$/);
  const dataset = optionalText(v.dataset, /^[A-Za-z0-9._-]{1,200}$/);
  const targetRelease = optionalText(v.targetRelease, /^[A-Za-z0-9._-]{1,100}$/);
  const fetchedFrom = optionalText(v.fetchedFrom, /^\d{4}-\d{2}-\d{2}$/);
  const fetchedTo = optionalText(v.fetchedTo, /^\d{4}-\d{2}-\d{2}$/);
  const reason = optionalText(v.reason, /^[^\p{Cc}]{1,500}$/u);
  const from = v.artifactIdFrom ?? 0;
  if (!source) return invalid("source_invalid");
  if (dataset === undefined) return invalid("dataset_invalid");
  if (targetRelease === undefined) return invalid("target_release_invalid");
  if (fetchedFrom === undefined || fetchedTo === undefined) return invalid("window_invalid");
  if (!reason) return invalid("reason_required");
  if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0)
    return invalid("artifact_id_from_invalid");
  // Only a deployed parser version can execute; the registry filter in the
  // ready query would leave any other version pending forever.
  const parser = PARSERS.find((p) => p.name === v.parser && p.version === v.version);
  if (!parser) return invalid("parser_not_deployed");
  const highWater =
    (await env.DB.prepare("SELECT coalesce(max(id),0) AS id FROM fetch_artifacts").first<number>(
      "id",
    )) ?? 0;
  // Parser acceptance is applied at job creation, so this is an upper bound
  // of eligible artifacts in range, never a financial value. "Already parsed"
  // means published (0026): a successful run the projection does not name is
  // not a result an operator should count as done, so replaying it is right.
  const estimate = await env.DB.prepare(
    `SELECT count(*) AS n,coalesce(sum(EXISTS(SELECT 1 FROM published_parse_runs pub WHERE pub.fetch_artifact_id=a.id AND pub.parser_name=?7 AND pub.parser_version=?8)),0) AS parsed
      FROM (${artifactSql}${replayFilterSql}) a`,
  )
    .bind(source, dataset, from, highWater, fetchedFrom, fetchedTo, parser.name, parser.version)
    .first<{ n: number; parsed: number }>();
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT INTO observation_replay_plans(created_at_ms,updated_at_ms,source_id,dataset,parser_name,parser_version,target_release,artifact_id_from,artifact_id_high_water,fetched_from,fetched_to,status,estimated_artifacts,already_parsed,creation_cursor,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'planned',?,?,?,?) RETURNING id`,
  )
    .bind(
      now,
      now,
      source,
      dataset,
      parser.name,
      parser.version,
      targetRelease,
      from,
      highWater,
      fetchedFrom,
      fetchedTo,
      estimate?.n ?? 0,
      estimate?.parsed ?? 0,
      from,
      reason,
    )
    .first<{ id: number }>();
  if (!inserted) return conflict("plan_insert_failed");
  return inspectPlan(env, inserted.id);
}

/** Idempotent status transition: reaching `to` from any of `from` or being
 * there already succeeds; any other current status is a conflict. */
async function transition(
  env: Env,
  id: number,
  from: readonly PlanStatus[],
  to: PlanStatus,
): Promise<Response | null> {
  const result = await env.DB.prepare(
    "UPDATE observation_replay_plans SET status=?,updated_at_ms=? WHERE id=? AND status IN (SELECT value FROM json_each(?))",
  )
    .bind(to, Date.now(), id, JSON.stringify(from))
    .run();
  if (result.meta.changes) return null;
  const current = await env.DB.prepare("SELECT status FROM observation_replay_plans WHERE id=?")
    .bind(id)
    .first<PlanStatus>("status");
  if (!current) return Response.json({ error: "plan_not_found" }, { status: 404 });
  return current === to ? null : conflict(`plan_${current}`);
}

async function replayCommand(env: Env, action: string, request: Request): Promise<Response> {
  const v = await command(request);
  if (!v) return invalid("request_invalid");
  if (action === "plan") return planReplay(env, v);
  const id = v.planId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    return invalid("plan_id_invalid");
  let refused: Response | null = null;
  switch (action) {
    case "start": {
      refused = await transition(env, id, ["planned"], "running");
      if (refused) return refused;
      const plan = await env.DB.prepare("SELECT * FROM observation_replay_plans WHERE id=?")
        .bind(id)
        .first<PlanRow>();
      if (plan) await replayStep(env, plan);
      break;
    }
    case "pause":
      refused = await transition(env, id, ["planned", "running"], "paused");
      break;
    case "resume":
      refused = await transition(env, id, ["paused"], "running");
      break;
    case "cancel": {
      refused = await transition(env, id, ["planned", "running", "paused"], "cancelled");
      if (refused) return refused;
      // Unclaimed work only. Live leases finish; raw and Layer B stay intact.
      await env.DB.prepare(
        "UPDATE observation_parse_jobs SET status='failed',last_error_code='replay_cancelled',lease_token=NULL,lease_until_ms=0 WHERE replay_plan_id=? AND (status='pending' OR (status='running' AND lease_until_ms<=?))",
      )
        .bind(id, Date.now())
        .run();
      break;
    }
    case "inspect":
      break;
    default:
      return new Response("Not found", { status: 404 });
  }
  return refused ?? inspectPlan(env, id);
}

async function status(env: Env): Promise<Response> {
  const now = Date.now();
  const jobs = await env.DB.prepare(
    "SELECT status,count(*) AS count FROM observation_parse_jobs GROUP BY status",
  ).all();
  const laneRows = await env.DB.prepare(
    "SELECT lane,status,count(*) AS count,min(CASE WHEN status='pending' AND created_at_ms>0 THEN created_at_ms END) AS oldest FROM observation_parse_jobs GROUP BY lane,status",
  ).all<{ lane: Lane; status: string; count: number; oldest: number | null }>();
  const lanes: Record<
    Lane,
    Record<"pending" | "running" | "done" | "failed", number> & {
      oldestPendingAgeMs: number | null;
    }
  > = {
    incremental: { pending: 0, running: 0, done: 0, failed: 0, oldestPendingAgeMs: null },
    repair: { pending: 0, running: 0, done: 0, failed: 0, oldestPendingAgeMs: null },
    replay: { pending: 0, running: 0, done: 0, failed: 0, oldestPendingAgeMs: null },
  };
  for (const row of laneRows.results) {
    const lane = lanes[row.lane];
    if (!lane) continue;
    if (
      row.status === "pending" ||
      row.status === "running" ||
      row.status === "done" ||
      row.status === "failed"
    )
      lane[row.status] = row.count;
    if (row.oldest !== null) lane.oldestPendingAgeMs = now - row.oldest;
  }
  const workItems = await env.DB.prepare(
    "SELECT count(*) AS unprocessed,min(enqueued_at_ms) AS oldest FROM observation_work_items WHERE processed_at_ms IS NULL",
  ).first<{ unprocessed: number; oldest: number | null }>();
  const freshness = await env.DB.prepare(
    `SELECT (SELECT max(sealed_at_ms) FROM fetch_run_seals) AS latest_sealed_at_ms,
      (SELECT max(coalesce(a.fetched_at_ms,a.recorded_at_ms)) FROM fetch_artifacts a JOIN fetch_run_seals s ON s.fetch_run_id=a.fetch_run_id) AS latest_sealed_artifact_fetched_at_ms,
      (SELECT max(parsed_at) FROM published_observation_parses) AS latest_parsed_at`,
  ).first<{
    latest_sealed_at_ms: number | null;
    latest_sealed_artifact_fetched_at_ms: number | null;
    latest_parsed_at: string | null;
  }>();
  const laneState = await env.DB.prepare(
    "SELECT lane,cursor,last_sweep_at_ms,last_created,last_executed FROM observation_lane_state ORDER BY lane",
  ).all();
  const plans = await env.DB.prepare(
    `SELECT id,status,source_id,dataset,parser_name,parser_version,target_release,artifact_id_from,artifact_id_high_water,estimated_artifacts,already_parsed,jobs_created,creation_complete,updated_at_ms
      FROM observation_replay_plans WHERE status IN ('planned','running','paused') OR updated_at_ms>? ORDER BY id DESC LIMIT 50`,
  )
    .bind(now - 7 * 24 * 60 * 60 * 1000)
    .all();
  return Response.json({
    parsers: PARSERS.map((p) => ({ name: p.name, version: p.version })),
    jobs: jobs.results,
    lanes,
    workItems: {
      unprocessed: workItems?.unprocessed ?? 0,
      oldestUnprocessedAgeMs: workItems?.oldest == null ? null : now - workItems.oldest,
    },
    freshness: {
      latestSealedAtMs: freshness?.latest_sealed_at_ms ?? null,
      latestSealedArtifactFetchedAtMs: freshness?.latest_sealed_artifact_fetched_at_ms ?? null,
      latestParsedAt: freshness?.latest_parsed_at ?? null,
    },
    laneState: laneState.results,
    replayPlans: plans.results,
  });
}

interface PolicyComparison {
  sourceId: string;
  parserName: string;
  dataset: string;
  legacy: { count: number };
  coverageV1: { count: number };
  /** Partitions whose current snapshot artifact differs between the two policies. */
  differences: {
    fetchUnitKey: string | null;
    legacyArtifactId: number | null;
    coverageArtifactId: number | null;
  }[];
}

/**
 * A03 shadow comparison: the current snapshot of every container dataset
 * under legacy-warning-compat-v1 and under coverage-v1, with the active row
 * of each dataset. Counts and artifact ids only; never observations,
 * warnings or raw bodies. A dataset is switched to coverage-v1 only after
 * every difference listed here is explained as an intended correction.
 */
export async function snapshotPolicyComparison(env: Env): Promise<Response> {
  const policies = await env.DB.prepare(
    "SELECT source_id,dataset,parser_name,policy_id,policy_version,required_parser_version,replaces_previous_on_complete_empty,unit_scope,snapshot_selection,updated_at_ms FROM dataset_snapshot_policies ORDER BY parser_name,dataset",
  ).all();
  const rows = await env.DB.prepare(
    snapshotPolicyComparisonSql(SNAPSHOT_RELATIONS),
  ).all<SnapshotPolicyComparisonRow>();
  const datasets = new Map<string, PolicyComparison>();
  for (const row of rows.results) {
    // NUL cannot occur in a source id, parser name or dataset, so it is a
    // safe composite-key separator; written as an escape so the file stays
    // text for grep, diff and review tooling.
    const key = `${row.source_id}\u0000${row.parser_name}\u0000${row.dataset}`;
    let entry = datasets.get(key);
    if (!entry) {
      entry = {
        sourceId: row.source_id,
        parserName: row.parser_name,
        dataset: row.dataset,
        legacy: { count: 0 },
        coverageV1: { count: 0 },
        differences: [],
      };
      datasets.set(key, entry);
    }
    if (row.legacy_artifact_id !== null) entry.legacy.count++;
    if (row.coverage_artifact_id !== null) entry.coverageV1.count++;
    if (row.legacy_artifact_id !== row.coverage_artifact_id)
      entry.differences.push({
        fetchUnitKey: row.fetch_unit_key,
        legacyArtifactId: row.legacy_artifact_id,
        coverageArtifactId: row.coverage_artifact_id,
      });
  }
  const comparison = [...datasets.values()];
  return Response.json({
    policies: policies.results,
    datasets: comparison,
    differingDatasets: comparison.filter((entry) => entry.differences.length > 0).length,
  });
}

// ── release adoption routes (A04) ─────────────────────────────────────────
//
// Internal service-binding routes at the same trust level as /sweep. Every
// write route is reachable only when RELEASE_CANDIDATES_ENABLED is "true";
// with the flag absent the pipeline has no adoption surface at all. Responses
// carry identifiers, counts and raw locators, never financial values.

const REEXTRACT_LIMIT_DEFAULT = 100;
const REEXTRACT_LIMIT_MAX = 500;
const DIFFERENCES_LIMIT_MAX = 500;

async function releaseRegister(env: Env, v: Record<string, unknown>): Promise<Response> {
  const parser = PARSERS.find((p) => p.name === v.parser && p.version === v.version);
  if (!parser) return invalid("parser_not_deployed");
  const release = v.metadataExtractorRelease ?? LEGACY_METADATA_RELEASE;
  if (typeof release !== "string" || !isMetadataExtractorRelease(release))
    return invalid("metadata_release_unknown");
  const identity = await releaseIdentity(parser, release);
  try {
    await releaseInsert(
      env.DB,
      { parser, metadataExtractorRelease: release, ...identity },
      new Date().toISOString(),
    ).run();
  } catch {
    // The 0028 guard: this name and version already exist with other code.
    return conflict("parser_release_conflict");
  }
  return Response.json({
    releaseId: identity.releaseId,
    manifestDigest: identity.manifestDigest,
    manifest: identity.manifest,
  });
}

function adoptionRequest(v: Record<string, unknown>): AdoptionRequest | null {
  const expected = v.expectedActiveReleaseId;
  if (
    typeof v.source !== "string" ||
    typeof v.dataset !== "string" ||
    typeof v.parser !== "string" ||
    typeof v.releaseId !== "string" ||
    typeof v.actor !== "string" ||
    typeof v.reason !== "string" ||
    (expected !== null && expected !== undefined && typeof expected !== "string")
  )
    return null;
  return {
    source: v.source,
    dataset: v.dataset,
    parser: v.parser,
    releaseId: v.releaseId,
    expectedActiveReleaseId: typeof expected === "string" ? expected : null,
    actor: v.actor,
    reason: v.reason,
  };
}

async function releaseCommand(env: Env, action: string, request: Request): Promise<Response> {
  const v = await command(request);
  if (!v) return invalid("request_invalid");
  try {
    if (action === "register") return await releaseRegister(env, v);
    if (action === "compare") {
      if (
        typeof v.source !== "string" ||
        typeof v.dataset !== "string" ||
        typeof v.parser !== "string" ||
        typeof v.releaseId !== "string"
      )
        return invalid("request_invalid");
      return Response.json(
        await compareReleases(env.DB, {
          source: v.source,
          dataset: v.dataset,
          parser: v.parser,
          releaseId: v.releaseId,
        }),
      );
    }
    const adoption = adoptionRequest(v);
    if (!adoption) return invalid("request_invalid");
    return Response.json(
      action === "activate"
        ? await activateRelease(env.DB, adoption)
        : await rollbackRelease(env.DB, adoption),
    );
  } catch (error) {
    if (!(error instanceof ReleaseCommandError)) throw error;
    return error.message === "release_activation_conflict"
      ? conflict(error.message)
      : invalid(error.message);
  }
}

/**
 * Bounded, explicit re-extraction. It never skips because a value already
 * exists - that is the D02 acceptance condition - and never writes
 * `observation_artifact_metadata`, so old projections and old parses keep
 * exactly the inputs they had.
 */
async function metadataReextract(env: Env, v: Record<string, unknown>): Promise<Response> {
  const source = optionalText(v.source, /^[a-z0-9-]{1,100}$/u);
  const dataset = optionalText(v.dataset, /^[A-Za-z0-9._-]{1,200}$/u);
  const release = v.extractorRelease;
  const from = v.artifactIdFrom ?? 0;
  const limit = v.limit ?? REEXTRACT_LIMIT_DEFAULT;
  if (!source) return invalid("source_invalid");
  if (dataset === undefined) return invalid("dataset_invalid");
  if (typeof release !== "string" || !isMetadataExtractorRelease(release))
    return invalid("metadata_release_unknown");
  if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0)
    return invalid("artifact_id_from_invalid");
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > REEXTRACT_LIMIT_MAX
  )
    return invalid("metadata_limit_invalid");
  const rows = await env.DB.prepare(
    `${artifactSql} AND a.source_id=?1 AND (?2 IS NULL OR a.dataset=?2) AND a.id>?3 ORDER BY a.id LIMIT ?4`,
  )
    .bind(source, dataset, from, limit)
    .all<ArtifactRow>();
  const summary = { examined: 0, ok: 0, absent: 0, errors: 0, cursor: from };
  const now = new Date().toISOString();
  for (const row of rows.results) {
    const extraction = await extractMetadata(
      { db: env.DB, read: (manifest) => verifiedBytes(env, manifest) },
      row,
      release,
      true,
    );
    await persistProjection(env.DB, row, release, extraction, now);
    summary.examined++;
    if (extraction.status === "ok") summary.ok++;
    else if (extraction.status === "absent") summary.absent++;
    else summary.errors++;
    summary.cursor = row.id;
  }
  return Response.json({
    release,
    ...summary,
    complete: rows.results.length < limit,
  });
}

/**
 * Artifacts whose newest projection under `release` disagrees with the legacy
 * one. Ids and changed field names only: no statement state, period or any
 * other provider value leaves this route.
 */
async function metadataDifferences(env: Env, url: URL): Promise<Response> {
  const release = url.searchParams.get("release") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "100");
  if (!isMetadataExtractorRelease(release) || release === LEGACY_METADATA_RELEASE)
    return invalid("metadata_release_unknown");
  if (!Number.isInteger(limit) || limit < 1 || limit > DIFFERENCES_LIMIT_MAX)
    return invalid("metadata_limit_invalid");
  const rows = await env.DB.prepare(
    `SELECT n.fetch_artifact_id AS artifact_id,n.status AS next_status,n.output_json AS next_json,
      l.status AS legacy_status,l.output_json AS legacy_json
      FROM metadata_projections n
      JOIN legacy_metadata_projections l ON l.fetch_artifact_id=n.fetch_artifact_id
      WHERE n.extractor_release=?1 AND n.id=(SELECT max(q.id) FROM metadata_projections q
        WHERE q.fetch_artifact_id=n.fetch_artifact_id AND q.extractor_release=?1)
      ORDER BY n.fetch_artifact_id LIMIT ?2`,
  )
    .bind(release, limit)
    .all<{
      artifact_id: number;
      next_status: string;
      next_json: string;
      legacy_status: string;
      legacy_json: string;
    }>();
  const differences: { artifactId: number; changed: string[] }[] = [];
  for (const row of rows.results) {
    const legacy = JSON.parse(row.legacy_json) as Record<string, unknown>;
    const next = JSON.parse(row.next_json) as Record<string, unknown>;
    const changed = Object.keys(legacy).filter(
      (field) => JSON.stringify(legacy[field] ?? null) !== JSON.stringify(next[field] ?? null),
    );
    if (row.legacy_status !== row.next_status) changed.push("status");
    if (changed.length) differences.push({ artifactId: row.artifact_id, changed: changed.sort() });
  }
  return Response.json({
    release,
    compared: rows.results.length,
    differing: differences.length,
    differences,
  });
}

export interface ScheduledStages {
  parse: (env: Env) => Promise<object>;
  identity: (env: Env) => Promise<object>;
  /** A10 reconciliation. Absent stage, or the flag off, means the lane never runs. */
  reconcile?: (env: Env) => Promise<object>;
  /**
   * A09: accepted decisions reach the read models here, not at commit time.
   * Optional like `reconcile`, so a test may run a subset of the lanes; the
   * default stages always wire it, which is what the deployed cron runs.
   */
  decisions?: (env: Env) => Promise<object>;
}
const defaultStages: ScheduledStages = {
  parse: (env) => sweep(env),
  identity: (env) => identitySweep(env.DB, resolveIdentity),
  reconcile: (env) => reconciliationSweep(env.DB),
  decisions: (env) => dispatchDecisionOutbox(env.DB),
};

/** Each stage is isolated: a parse-sweep failure is logged as its own event
 * and never stops the identity projection. Log lines carry counts and safe
 * codes only, never provider values or exception text. */
export async function runScheduled(
  env: Env,
  stages: ScheduledStages = defaultStages,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const lanes: [string, ((env: Env) => Promise<object>) | undefined][] = [
    ["observation_sweep", stages.parse],
    ["identity_sweep", stages.identity],
    // Off unless RECONCILIATION_ENABLED is set, so a normal deploy logs and
    // writes nothing new (docs/economic-events.md).
    [
      "reconciliation_sweep",
      reconciliationEnabled(env.RECONCILIATION_ENABLED) ? stages.reconcile : undefined,
    ],
    // A09: the decision outbox runs last, after the projections a decision may
    // have invalidated (docs/change-lifecycle.md).
    ["decision_outbox", stages.decisions],
  ];
  for (const [event, stage] of lanes) {
    if (!stage) continue;
    try {
      log(JSON.stringify({ event, ...(await stage(env)) }));
    } catch (error) {
      const code =
        error instanceof PipelineError
          ? error.message
          : error instanceof Error
            ? error.constructor.name
            : "unknown";
      log(JSON.stringify({ event: `${event}_failed`, code }));
    }
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await runScheduled(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "POST" && path === "/identity-sweep") {
      const source = url.searchParams.get("source") ?? undefined;
      if (source && !/^[a-z0-9-]{1,100}$/.test(source))
        return new Response("Invalid source", { status: 400 });
      const maxRuns = Number(url.searchParams.get("maxRuns") ?? "8");
      if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 40)
        return new Response("Invalid batch", { status: 400 });
      return Response.json(await identitySweep(env.DB, resolveIdentity, maxRuns, source));
    }
    // A09 change lifecycle. Private service-binding routes with the same trust
    // level as /sweep: the evidence browser authenticates the human and
    // forwards the verified actor here, and this Worker stays the only writer
    // of the decision, approval, receipt and outbox tables.
    const changeResponse = await changeCommandRoute(env, request, path);
    if (changeResponse) return changeResponse;
    if (request.method === "POST" && path === "/identity-revise") {
      // Internal service-binding endpoint; no public route. Bound request bytes.
      // The body may carry an operation id and an action; the actor never
      // comes from the body. Without the trusted-caller header the actor is
      // the unverified legacy CLI. A09 replaces this with the authenticated
      // command path.
      const v = await command(request);
      if (!v) return new Response("Invalid request", { status: 400 });
      const action = v.action === undefined ? "assign" : v.action;
      if (
        (v.kind !== "account" && v.kind !== "instrument") ||
        typeof v.referenceId !== "string" ||
        (action === "assign" ? typeof v.targetId !== "string" : v.targetId !== null) ||
        typeof v.expectedRevision !== "number" ||
        typeof v.reason !== "string" ||
        (action !== "assign" && action !== "release-override") ||
        (v.operationId !== undefined && typeof v.operationId !== "string")
      )
        return new Response("Invalid request", { status: 400 });
      const verifiedActor = request.headers.get("x-kogane-verified-actor");
      if (verifiedActor !== null && !/^[a-z0-9][a-z0-9._:@/-]{0,127}$/u.test(verifiedActor))
        return new Response("Invalid request", { status: 400 });
      const result = await executeIdentityCommand(
        env.DB,
        {
          operationId: v.operationId ?? crypto.randomUUID(),
          actorId: verifiedActor ?? "legacy-cli",
          actorVerification: verifiedActor === null ? "legacy-unknown" : "server",
          action,
          kind: v.kind,
          referenceId: v.referenceId,
          expectedRevision: v.expectedRevision,
          targetId: action === "assign" ? (v.targetId as string) : null,
          reason: v.reason,
        },
        IDENTITY_POLICY_VERSION,
      );
      if (!result.ok)
        return new Response("Revision conflict or invalid identity", {
          status: 409,
          headers: { "x-kogane-error": result.error },
        });
      return Response.json({ revised: true, replayed: result.replayed, receipt: result.receipt });
    }
    if (request.method === "POST" && path === "/sweep") {
      const options: SweepOptions = {};
      const lane = url.searchParams.get("lane");
      if (lane !== null) {
        if (!LANES.includes(lane as Lane)) return invalid("lane_invalid");
        options.lane = lane as Lane;
      }
      const maxJobs = url.searchParams.get("maxJobs");
      if (maxJobs !== null) options.maxJobs = Number(maxJobs);
      return Response.json(await sweep(env, options));
    }
    // Replay commands share the private service-binding trust level of /sweep.
    const replay = /^\/replay\/(plan|start|pause|resume|cancel|inspect)$/.exec(path);
    if (request.method === "POST" && replay) return replayCommand(env, replay[1]!, request);
    if (request.method === "GET" && path === "/status") return status(env);
    // Release adoption (docs/release-adoption.md). The audit view is always
    // readable; every command needs the flag.
    if (request.method === "GET" && path === "/release/status")
      return Response.json(await releaseStatus(env.DB));
    if (request.method === "GET" && path === "/metadata/differences")
      return metadataDifferences(env, url);
    if (request.method === "POST" && candidatesEnabled(env)) {
      const release = /^\/release\/(register|compare|activate|rollback)$/.exec(path);
      if (release) return releaseCommand(env, release[1]!, request);
      if (path === "/metadata/reextract") {
        const v = await command(request);
        return v ? metadataReextract(env, v) : invalid("request_invalid");
      }
    }
    // Internal service-binding route, like /status: identifiers and counts only.
    if (request.method === "GET" && path === "/snapshot-policy/compare")
      return snapshotPolicyComparison(env);
    // Publication gate operations (docs/publication-gate.md): the consistency
    // check is read-only; repair is bounded, idempotent and records its actor.
    if (request.method === "GET" && path === "/publication/consistency")
      return Response.json(await publicationConsistency(env.DB));
    if (request.method === "POST" && path === "/publication/repair") {
      const v = await command(request);
      if (!v || typeof v.actor !== "string" || typeof v.reason !== "string")
        return invalid("publication_request_invalid");
      const limit = v.limit === undefined ? REPAIR_LIMIT_DEFAULT : v.limit;
      if (typeof limit !== "number") return invalid("publication_limit_invalid");
      try {
        return Response.json(
          await repairPublication(env.DB, { actor: v.actor, reason: v.reason, limit }),
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code.startsWith("publication_")) return invalid(code);
        throw error;
      }
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
