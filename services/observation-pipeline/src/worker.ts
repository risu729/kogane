import { PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry.ts";
import { resolveIdentity } from "../../../poc/observation-pipeline/src/identity/index.ts";
import { identitySweep, reviseIdentity } from "./identity-store.ts";
import type {
  ArtifactMeta,
  Observation,
  Parser,
} from "../../../poc/observation-pipeline/src/types.ts";

const SCAN_PAGE = 200;
const JOBS_PER_SWEEP = 12;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60 * 1000;
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
}
interface Job {
  fetch_artifact_id: number;
  parser_name: string;
  parser_version: string;
  attempts: number;
}
const artifactSql = `SELECT a.*,o.blob_key,o.byte_size,
 coalesce((SELECT start_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_start) AS window_start,
 coalesce((SELECT end_value FROM artifact_ranges q WHERE q.fetch_artifact_id=a.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1),r.window_end) AS window_end
 FROM observation_fetch_artifacts a JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
 JOIN raw_objects o ON o.sha256=a.sha256 WHERE r.status='success' AND r.failure_count=0`;

export function artifactMeta(row: ArtifactRow): ArtifactMeta {
  return {
    id: row.id,
    sourceId: row.source_id,
    runStatus: "success",
    runFailureCount: 0,
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

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PipelineError("manifest_shape_invalid");
  return value as Record<string, unknown>;
}

// Statement state is an artifact-specific manifest claim. Never infer it from
// dates or from row output. This also supplies metadata to the read-side view.
async function hydrateMeta(env: Env, row: ArtifactRow): Promise<ArtifactMeta> {
  const meta = artifactMeta(row);
  const previous = await env.DB.prepare(
    "SELECT statement_state,period FROM observation_artifact_metadata WHERE fetch_artifact_id=?",
  )
    .bind(row.id)
    .first<{ statement_state: string | null; period: string | null }>();
  if (previous) {
    meta.statementState = previous.statement_state;
    meta.period = previous.period;
  }
  let manifestId: number | null = null;
  if (row.source_id === "myjcb" && !previous) {
    const manifest = await env.DB.prepare(
      `SELECT a.id,o.blob_key,o.byte_size,o.sha256 FROM fetch_artifacts a JOIN raw_objects o ON o.sha256=a.sha256 WHERE a.fetch_run_id=? AND a.artifact_role='collector_manifest' AND a.artifact_key='manifest.json'`,
    )
      .bind(row.fetch_run_id)
      .first<{ id: number; blob_key: string; byte_size: number; sha256: string }>();
    if (!manifest) throw new PipelineError("metadata_manifest_missing");
    const root = record(JSON.parse(new TextDecoder().decode(await verifiedBytes(env, manifest))));
    if (!Array.isArray(root.artifacts)) throw new PipelineError("manifest_shape_invalid");
    const matching = root.artifacts
      .map(record)
      .filter((a) => `${String(a.connectionId)}/${String(a.filename)}` === row.artifact_key);
    if (matching.length !== 1) throw new PipelineError("manifest_artifact_mismatch");
    const match = matching[0]!;
    if (match.dataset !== row.dataset) throw new PipelineError("manifest_dataset_mismatch");
    if (match.statementState !== undefined && typeof match.statementState !== "string")
      throw new PipelineError("manifest_state_invalid");
    if (match.period !== undefined && typeof match.period !== "string")
      throw new PipelineError("manifest_period_invalid");
    meta.statementState = typeof match.statementState === "string" ? match.statementState : null;
    meta.period = typeof match.period === "string" ? match.period : null;
    manifestId = manifest.id;
  }
  if (row.source_id === "sony-bank" && /^wallet-history-\d{6}$/.test(row.dataset ?? "")) {
    const manifest = await env.DB.prepare(
      "SELECT a.id,o.blob_key,o.byte_size,o.sha256 FROM fetch_artifacts a JOIN raw_objects o ON o.sha256=a.sha256 WHERE a.fetch_run_id=? AND a.artifact_role='collector_manifest' AND a.artifact_key='manifest.json'",
    )
      .bind(row.fetch_run_id)
      .first<{ id: number; blob_key: string; byte_size: number; sha256: string }>();
    if (!manifest) throw new PipelineError("metadata_manifest_missing");
    const root = record(JSON.parse(new TextDecoder().decode(await verifiedBytes(env, manifest))));
    if (!Array.isArray(root.artifacts)) throw new PipelineError("manifest_shape_invalid");
    const matches = root.artifacts
      .map(record)
      .filter(
        (a) => a.dataset === row.dataset && a.sha256 === row.sha256 && a.bytes === row.byte_size,
      );
    if (matches.length !== 1 || matches[0]!.mediaType !== "text/html; charset=UTF-8")
      throw new PipelineError("manifest_media_type_mismatch");
    meta.mime = matches[0]!.mediaType;
    manifestId = manifest.id;
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO observation_artifact_metadata(fetch_artifact_id,statement_state,period,metadata_manifest_artifact_id) VALUES(?,?,?,?)`,
  )
    .bind(row.id, meta.statementState ?? null, meta.period ?? null, manifestId)
    .run();
  return meta;
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
    const meta = await hydrateMeta(env, row);
    if (!parser.accepts(meta)) throw new PipelineError("parser_no_longer_accepts");
    const bytes = await verifiedBytes(env, row);
    failureStage = "parser_rejected";
    const result = parser.parse(bytes, meta);
    if (result.observations.length > 100_000) throw new PipelineError("observation_limit_exceeded");
    // Bound D1 statement count per invocation as well as in-memory raw bytes.
    if (new TextEncoder().encode(JSON.stringify(result.observations)).length > 2 * 1024 * 1024)
      throw new PipelineError("observation_payload_too_large");
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
    // A lost lease cannot publish rows. All visibility and supersession changes
    // occur in one D1 transaction; empty successful parses are published too.
    const publish = await env.DB.batch([
      env.DB.prepare(
        `UPDATE parse_runs SET status='ok',superseded_by_parse_run_id=(
          SELECT newer.id FROM parse_runs newer
          WHERE newer.fetch_artifact_id=parse_runs.fetch_artifact_id
            AND newer.parser_name=parse_runs.parser_name AND newer.status='ok'
            AND newer.superseded_by_parse_run_id IS NULL
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
      ).bind(version[0]!, version[1]!, version[2]!, parseId, token, Date.now()),
      env.DB.prepare(
        `UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE fetch_artifact_id=? AND parser_name=? AND id<>? AND status='ok' AND superseded_by_parse_run_id IS NULL AND EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=? AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL)`,
      ).bind(parseId, row.id, parser.name, parseId, parseId),
      env.DB.prepare(
        `UPDATE observation_parse_jobs SET status='done',last_error_code=NULL WHERE lease_token=? AND EXISTS(SELECT 1 FROM parse_runs WHERE id=? AND status='ok')`,
      ).bind(token, parseId),
    ]);
    if (!publish[0]?.meta.changes) throw new PipelineError("parse_lease_expired");
    return "parsed";
  } catch (error) {
    // Parser exception strings may contain provider values; retain a safe code
    // and full provenance, never financial rows or secret-bearing error text.
    const code = error instanceof PipelineError ? error.message : failureStage;
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
    await env.DB.prepare(
      `UPDATE observation_parse_jobs SET status=CASE WHEN attempts>=? OR ?='parser_rejected' THEN 'failed' ELSE 'pending' END,available_at_ms=?,last_error_code=? WHERE lease_token=? AND status='running'`,
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

export async function sweep(env: Env, maxJobs = JOBS_PER_SWEEP) {
  maxJobs = Math.max(1, Math.min(40, Math.trunc(maxJobs) || JOBS_PER_SWEEP));
  const state = await env.DB.prepare("SELECT cursor FROM observation_scan_state WHERE id=1").first<{
    cursor: number;
  }>();
  const candidates = await env.DB.prepare(
    "SELECT id FROM fetch_artifacts WHERE id>? ORDER BY id LIMIT ?",
  )
    .bind(state?.cursor ?? 0, SCAN_PAGE)
    .all<{ id: number }>();
  if (candidates.results.length) {
    const last = candidates.results.at(-1)!.id;
    const eligible = await env.DB.prepare(artifactSql + " AND a.id>? AND a.id<=? ORDER BY a.id")
      .bind(state?.cursor ?? 0, last)
      .all<ArtifactRow>();
    const known = await env.DB.prepare(
      "SELECT fetch_artifact_id,parser_name,parser_version FROM observation_parse_jobs WHERE fetch_artifact_id>? AND fetch_artifact_id<=?",
    )
      .bind(state?.cursor ?? 0, last)
      .all<Job>();
    const knownKeys = new Set(
      known.results.map(
        (job) => `${job.fetch_artifact_id}/${job.parser_name}/${job.parser_version}`,
      ),
    );
    const inserts: D1PreparedStatement[] = [];
    for (const row of eligible.results)
      for (const parser of PARSERS) {
        if (
          parser.accepts(artifactMeta(row)) &&
          !knownKeys.has(`${row.id}/${parser.name}/${parser.version}`) &&
          inserts.length < SCAN_PAGE
        )
          inserts.push(
            env.DB.prepare(
              "INSERT OR IGNORE INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
            ).bind(row.id, parser.name, parser.version),
          );
      }
    for (let offset = 0; offset < inserts.length; offset += 50)
      await env.DB.batch(inserts.slice(offset, offset + 50));
    await env.DB.prepare("UPDATE observation_scan_state SET cursor=? WHERE id=1 AND cursor=?")
      .bind(last, state?.cursor ?? 0)
      .run();
  } else {
    await env.DB.prepare("UPDATE observation_scan_state SET cursor=0 WHERE id=1 AND cursor=?")
      .bind(state?.cursor ?? 0)
      .run();
  }
  // An invocation terminated on its final attempt remains inspectable and does
  // not pin the work queue forever after its lease expires.
  await env.DB.prepare(
    "UPDATE observation_parse_jobs SET status='failed',last_error_code='lease_exhausted' WHERE status='running' AND attempts>=? AND lease_until_ms<=?",
  )
    .bind(MAX_ATTEMPTS, Date.now())
    .run();
  await env.DB.prepare(
    "UPDATE parse_runs SET status='error',error='parse_interrupted' WHERE status='pending' AND EXISTS(SELECT 1 FROM observation_parse_jobs j WHERE j.fetch_artifact_id=parse_runs.fetch_artifact_id AND j.parser_name=parse_runs.parser_name AND j.parser_version=parse_runs.parser_version AND j.status='failed' AND j.last_error_code='lease_exhausted')",
  ).run();
  // Also repairs an interrupted post-publication retirement on the next sweep.
  await retireReplacedJobs(env.DB);
  const ready = await env.DB.prepare(
    `SELECT * FROM observation_parse_jobs j WHERE attempts<? AND ((status='pending' AND available_at_ms<=?) OR (status='running' AND lease_until_ms<=?))
      AND EXISTS(SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.name')=j.parser_name AND json_extract(r.value,'$.version')=j.parser_version)
      ORDER BY available_at_ms,fetch_artifact_id LIMIT ?`,
  )
    .bind(
      MAX_ATTEMPTS,
      Date.now(),
      Date.now(),
      JSON.stringify(PARSERS.map(({ name, version }) => ({ name, version }))),
      maxJobs,
    )
    .all<Job>();
  const summary = { scanned: candidates.results.length, parsed: 0, error: 0, skipped: 0 };
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
  return summary;
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

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    console.log(JSON.stringify({ event: "observation_sweep", ...(await sweep(env)) }));
    console.log(
      JSON.stringify({
        event: "identity_sweep",
        ...(await identitySweep(env.DB, resolveIdentity)),
      }),
    );
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/identity-sweep") {
      const url = new URL(request.url);
      const source = url.searchParams.get("source") ?? undefined;
      if (source && !/^[a-z0-9-]{1,100}$/.test(source))
        return new Response("Invalid source", { status: 400 });
      const maxRuns = Number(url.searchParams.get("maxRuns") ?? "8");
      if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 40)
        return new Response("Invalid batch", { status: 400 });
      return Response.json(await identitySweep(env.DB, resolveIdentity, maxRuns, source));
    }
    if (request.method === "POST" && path === "/identity-revise") {
      // Internal service-binding endpoint; no public route. Bound request bytes.
      const body = await bounded(request, 4096);
      if (body === null) return new Response("Invalid request", { status: 400 });
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        return new Response("Invalid request", { status: 400 });
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        return new Response("Invalid request", { status: 400 });
      const v = value as Record<string, unknown>;
      if (
        (v.kind !== "account" && v.kind !== "instrument") ||
        typeof v.referenceId !== "string" ||
        typeof v.targetId !== "string" ||
        typeof v.expectedRevision !== "number" ||
        typeof v.reason !== "string"
      )
        return new Response("Invalid request", { status: 400 });
      try {
        await reviseIdentity(env.DB, {
          kind: v.kind,
          referenceId: v.referenceId,
          targetId: v.targetId,
          expectedRevision: v.expectedRevision,
          reason: v.reason,
        });
      } catch {
        return new Response("Revision conflict or invalid identity", { status: 409 });
      }
      return Response.json({ revised: true });
    }
    if (request.method === "POST" && path === "/sweep")
      return Response.json(
        await sweep(
          env,
          Number(new URL(request.url).searchParams.get("maxJobs")) || JOBS_PER_SWEEP,
        ),
      );
    if (request.method === "GET" && path === "/status") {
      const jobs = await env.DB.prepare(
        "SELECT status,count(*) AS count FROM observation_parse_jobs GROUP BY status",
      ).all();
      return Response.json({
        parsers: PARSERS.map((p) => ({ name: p.name, version: p.version })),
        jobs: jobs.results,
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
