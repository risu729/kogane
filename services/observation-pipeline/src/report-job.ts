// The report job (architecture addendum A12; findings AR03, AR12, AR18).
//
// It does three separable things and keeps them separable:
//
//   1. fixes the input set it used as a manifest and derives the context id
//      from that manifest, so the same inputs always give the same context and
//      a corrected price gives a different one (AR12, UC36/AT36);
//   2. writes a calculation run with typed unvalued reasons, never a zero for
//      a missing price (addendum 09 section 3);
//   3. stores the report body once, content-addressed under `reports/`, and
//      records a `generated` event. The body is fixed from then on: a later
//      rule, price or classification change produces a new report, never an
//      edit of this one (AR03, UC60/AT60).
//
// The job is behind the `REPORTS_ENABLED` flag and writes nothing when it is
// off. It never fetches a price from outside; prices are observations with a
// source claim. Report bodies carry references and derived values only, never
// raw provider bytes.
import {
  canonicalDigest,
  canonicalJson,
  DEFAULT_INSTRUMENT_VALUATION_POLICY,
  replayabilityFor,
  reportStorageRef,
  summarizeValuation,
  valueHolding,
  type EvidenceUseRestriction,
  type PriceObservation,
  type ReportBody,
  type ReportRow,
  type ValuationCell,
} from "../../../packages/domain/src/index.ts";
import { quantityFromNormalizedDecimal } from "../../../packages/domain/src/values.ts";
import { validNormalizedDecimal } from "../../../poc/observation-pipeline/shared/normalized-decimal.ts";
import type { NormalizedDecimal } from "../../../poc/observation-pipeline/shared/normalized-decimal.ts";
import { createD1ObservationReader } from "../../../packages/read-model/src/d1";
import type { PositionWithValuations } from "../../../poc/observation-pipeline/shared/api-contract.ts";

/** The report body version this job writes; it is the schema of the stored bytes. */
export const REPORT_JOB_RELEASE = "report-job-v1";
const INPUT_MANIFEST_VERSION = "report-inputs-v1";
const DEFAULT_MAX_ROWS = 500;
const DECIMAL_LOOKUP_CHUNK = 80;

/** Feature flag. Off unless the deployment explicitly sets the string "true". */
export function reportsEnabled(flag: string | undefined): boolean {
  return flag === "true";
}

export interface ReportJobEnv {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  REPORTS_ENABLED?: string;
}

export interface ReportJobOptions {
  /** Server-verified actor; never taken from a request body. */
  actor: string;
  /** Instant the run started. It is recorded on the run, not folded into the context. */
  now: string;
  /** Base unit the holdings view is expressed in. Nothing is converted 1:1 into it. */
  unitRef: string;
  perimeterRef: string;
  /** Evidence recorded after this instant is not part of the context (UC63/AT63). */
  knowledgeCutoff: string;
  decimalPolicyRelease: string;
  maxRows?: number;
}

export interface ReportJobResult {
  generated: number;
  reused: number;
  skipped: string | null;
  reportId: string | null;
  contextId: string | null;
  contentDigest: string | null;
  runId: string | null;
  partition: string | null;
  unvaluedReasons: string[];
  truncated: boolean;
}

interface PriceRow {
  id: string;
  base_instrument_ref: string;
  base_quantity_coefficient: string;
  base_quantity_scale: number;
  quote_unit_ref: string;
  quote_amount_coefficient: string;
  quote_amount_scale: number;
  price_kind: PriceObservation["priceKind"];
  effective_time: string;
  source_claim_ref: string;
  market_ref: string | null;
  adjustment_policy_ref: string | null;
}

/**
 * Provider-scoped instrument reference. Instrument identity resolution is the
 * decision layer's job; this key only keeps the same code in two markets or
 * two sources apart, and a price must be quoted for exactly this reference.
 */
export function instrumentRef(row: {
  source_id: string;
  market: string | null;
  security_code: string;
}): string {
  return `instrument:${row.source_id}:${row.market ?? "-"}:${row.security_code}`;
}

function priceObservation(row: PriceRow): PriceObservation | null {
  let effectiveTime: unknown;
  try {
    effectiveTime = JSON.parse(row.effective_time);
  } catch {
    return null;
  }
  return {
    id: row.id,
    baseInstrumentRef: row.base_instrument_ref,
    baseQuantity: { coefficient: row.base_quantity_coefficient, scale: row.base_quantity_scale },
    quoteUnitRef: row.quote_unit_ref,
    quoteAmount: { coefficient: row.quote_amount_coefficient, scale: row.quote_amount_scale },
    priceKind: row.price_kind,
    effectiveTime: effectiveTime as PriceObservation["effectiveTime"],
    sourceClaimRef: row.source_claim_ref,
    marketRef: row.market_ref,
    adjustmentPolicyRef: row.adjustment_policy_ref,
  };
}

/**
 * Position observations whose evidence was recorded after the knowledge
 * cutoff. A file fetched long ago but imported yesterday is knowledge Kogane
 * gained yesterday, so `recorded_at_ms` decides, not `fetched_at_ms`
 * (addendum 06 section 2; UC63/AT63).
 */
async function recordedAfterCutoff(
  db: D1Database,
  ids: readonly number[],
  cutoffMs: number,
): Promise<Set<number>> {
  const late = new Set<number>();
  for (let offset = 0; offset < ids.length; offset += DECIMAL_LOOKUP_CHUNK) {
    const page = ids.slice(offset, offset + DECIMAL_LOOKUP_CHUNK);
    if (page.length === 0) break;
    const rows = await db
      .prepare(
        `SELECT po.id AS id FROM position_observations po
         JOIN parse_runs p ON p.id=po.parse_run_id
         JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
         WHERE po.id IN (${page.map(() => "?").join(",")})
           AND coalesce(a.recorded_at_ms, a.fetched_at_ms) > ?`,
      )
      .bind(...page, cutoffMs)
      .all<{ id: number }>();
    for (const row of rows.results) late.add(row.id);
  }
  return late;
}

/**
 * The newest moment Kogane learned any of the included evidence. The manifest
 * records this rather than the requested cutoff instant: a sweep five minutes
 * later with no new evidence must produce the same context, not a new one
 * every time the clock moves (AR12/INV09).
 */
async function knowledgeBoundary(db: D1Database, ids: readonly number[]): Promise<string> {
  let newest: number | null = null;
  for (let offset = 0; offset < ids.length; offset += DECIMAL_LOOKUP_CHUNK) {
    const page = ids.slice(offset, offset + DECIMAL_LOOKUP_CHUNK);
    if (page.length === 0) break;
    const row = await db
      .prepare(
        `SELECT max(coalesce(a.recorded_at_ms,a.fetched_at_ms)) AS newest
         FROM position_observations po
         JOIN parse_runs p ON p.id=po.parse_run_id
         JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
         WHERE po.id IN (${page.map(() => "?").join(",")})`,
      )
      .bind(...page)
      .first<{ newest: number | null }>();
    if (row?.newest != null && (newest === null || row.newest > newest)) newest = row.newest;
  }
  return newest === null ? "none" : new Date(newest).toISOString();
}

/** Persisted decimal projection for a bounded set of observation ids. */
async function decimals(
  db: D1Database,
  kind: "position" | "valuation",
  ids: readonly number[],
  policyVersion: string,
): Promise<Map<number, NormalizedDecimal>> {
  const found = new Map<number, NormalizedDecimal>();
  for (let offset = 0; offset < ids.length; offset += DECIMAL_LOOKUP_CHUNK) {
    const page = ids.slice(offset, offset + DECIMAL_LOOKUP_CHUNK);
    if (page.length === 0) break;
    const rows = await db
      .prepare(
        `SELECT observation_id,policy_version AS policyVersion,status,coefficient,scale,basis
         FROM observation_decimal_values
         WHERE kind=? AND policy_version=? AND observation_id IN (${page.map(() => "?").join(",")})`,
      )
      .bind(kind, policyVersion, ...page)
      .all<NormalizedDecimal & { observation_id: number }>();
    for (const row of rows.results) {
      const { observation_id, ...value } = row;
      if (validNormalizedDecimal(value)) found.set(observation_id, value);
    }
  }
  return found;
}

/**
 * Every version this run used, as the set itself rather than as a latest id or
 * a timestamp (AR12). The digest of this object is the context id, so adding a
 * corrected price or a later observation produces a new context instead of
 * silently changing an existing one.
 */
export interface ReportInputManifest {
  schemaVersion: typeof INPUT_MANIFEST_VERSION;
  perimeterRef: string;
  unitRef: string;
  /** Newest moment any included evidence was recorded, or "none"; see knowledgeBoundary. */
  knowledgeCutoffEffective: string;
  decimalPolicyRelease: string;
  instrumentValuationPolicyId: string;
  positionObservationIds: number[];
  valuationObservationIds: number[];
  priceObservationIds: string[];
}

async function restrictionsFor(
  db: D1Database,
  refs: readonly string[],
): Promise<EvidenceUseRestriction[]> {
  if (refs.length === 0) return [];
  const rows = await db
    .prepare(
      `SELECT evidence_ref,restriction,since,affected_manifests_json,actor,reason
       FROM evidence_use_restrictions WHERE evidence_ref IN (${refs.map(() => "?").join(",")})`,
    )
    .bind(...refs)
    .all<{
      evidence_ref: string;
      restriction: EvidenceUseRestriction["restriction"];
      since: string;
      affected_manifests_json: string;
      actor: string;
      reason: string;
    }>();
  return rows.results.map((row) => ({
    evidenceRef: row.evidence_ref,
    restriction: row.restriction,
    since: row.since,
    affectedManifests: JSON.parse(row.affected_manifests_json) as string[],
    actor: row.actor,
    reason: row.reason,
  }));
}

/**
 * Build (or reuse) the holdings report at the context implied by the current
 * inputs. Re-running with unchanged inputs reuses the stored artifact; it does
 * not rewrite it.
 */
export async function runReportJob(
  env: ReportJobEnv,
  options: ReportJobOptions,
): Promise<ReportJobResult> {
  const empty: ReportJobResult = {
    generated: 0,
    reused: 0,
    skipped: null,
    reportId: null,
    contextId: null,
    contentDigest: null,
    runId: null,
    partition: null,
    unvaluedReasons: [],
    truncated: false,
  };
  if (!reportsEnabled(env.REPORTS_ENABLED)) return { ...empty, skipped: "flag_off" };
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const reader = createD1ObservationReader(env.DB);
  const visible = await reader.listPositions({ offset: 0 });
  const cutoffMs = Date.parse(options.knowledgeCutoff);
  if (!Number.isFinite(cutoffMs)) return { ...empty, skipped: "invalid_knowledge_cutoff" };
  const late = await recordedAfterCutoff(
    env.DB,
    visible.map((entry) => entry.position.id),
    cutoffMs,
  );
  const all = visible.filter((entry) => !late.has(entry.position.id));
  const truncated = all.length > maxRows;
  const positions = all.slice(0, maxRows);

  const positionIds = positions.map((entry) => entry.position.id);
  const valuationIds = positions.flatMap((entry) =>
    entry.valuations.filter((row) => row.currency === options.unitRef).map((row) => row.id),
  );
  const positionDecimals = await decimals(
    env.DB,
    "position",
    positionIds,
    options.decimalPolicyRelease,
  );
  const valuationDecimals = await decimals(
    env.DB,
    "valuation",
    valuationIds,
    options.decimalPolicyRelease,
  );

  // One price per instrument: the most recently recorded observation quoted in
  // the report's base unit. The chosen id goes into the manifest, so a later
  // correction changes the context rather than the stored report (UC36/AT36).
  const prices = new Map<string, PriceObservation>();
  for (const entry of positions) {
    const ref = instrumentRef(entry.position);
    if (prices.has(ref)) continue;
    const row = await env.DB.prepare(
      `SELECT id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,
        quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,
        market_ref,adjustment_policy_ref
       FROM price_observations WHERE base_instrument_ref=? AND quote_unit_ref=?
       ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    )
      .bind(ref, options.unitRef)
      .first<PriceRow>();
    const price = row ? priceObservation(row) : null;
    if (price) prices.set(ref, price);
  }

  const manifest: ReportInputManifest = {
    schemaVersion: INPUT_MANIFEST_VERSION,
    perimeterRef: options.perimeterRef,
    unitRef: options.unitRef,
    knowledgeCutoffEffective: await knowledgeBoundary(env.DB, positionIds),
    decimalPolicyRelease: options.decimalPolicyRelease,
    instrumentValuationPolicyId: DEFAULT_INSTRUMENT_VALUATION_POLICY.policyId,
    positionObservationIds: [...positionIds].sort((a, b) => a - b),
    valuationObservationIds: [...valuationIds].sort((a, b) => a - b),
    priceObservationIds: [...prices.values()].map((price) => price.id).sort(),
  };
  const manifestDigest = await canonicalDigest(manifest);
  const contextId = `ctx-${manifestDigest}`;
  const runId = `run-${manifestDigest}`;
  const reportId = `rpt-${manifestDigest}`;

  const existing = await env.DB.prepare(
    "SELECT report_id,content_digest FROM report_artifacts WHERE report_id=?",
  )
    .bind(reportId)
    .first<{ report_id: string; content_digest: string }>();
  if (existing)
    return {
      ...empty,
      reused: 1,
      reportId: existing.report_id,
      contextId,
      contentDigest: existing.content_digest,
      runId,
      truncated,
    };

  const cells: ValuationCell[] = [];
  const rows: ReportRow[] = [];
  const providerRows: {
    subjectRef: string;
    scopeRef: string;
    metric: string;
    unitRef: string;
    normalized: NormalizedDecimal | undefined;
  }[] = [];
  for (const entry of positions) {
    const ref = instrumentRef(entry.position);
    const scopeRef = `scope:${entry.position.source_id}:${entry.position.source_account}`;
    const normalized = positionDecimals.get(entry.position.id);
    const quantity = normalized
      ? quantityFromNormalizedDecimal(ref, normalized)
      : { unitRef: ref, value: { status: "missing" as const, reasonCode: "decimal_row_missing" } };
    const outcome = valueHolding(quantity, prices.get(ref) ?? null, {
      instrumentClass: "listed-equity",
    });
    cells.push({
      subjectRef: ref,
      scopeRef,
      metric: "holdings.valuation",
      unitRef: options.unitRef,
      outcome,
    });
    rows.push(
      outcome.valued && outcome.value.value.status === "exact"
        ? {
            subjectRef: ref,
            scopeRef,
            metric: "holdings.valuation",
            unitRef: options.unitRef,
            valued: true,
            value: outcome.value.value.value,
          }
        : {
            subjectRef: ref,
            scopeRef,
            metric: "holdings.valuation",
            unitRef: options.unitRef,
            valued: false,
            unvaluedReason: outcome.valued ? "missing-quantity" : outcome.reason,
          },
    );
    // Provider-reported values and costs are kept beside the own calculation,
    // never promoted to the single truth (UC30/AT30).
    for (const valuation of entry.valuations) {
      if (valuation.currency !== options.unitRef) continue;
      const metric = `provider.${valuation.metric}`.slice(0, 128);
      if (providerRows.some((row) => row.subjectRef === ref && row.metric === metric)) continue;
      providerRows.push({
        subjectRef: ref,
        scopeRef,
        metric,
        unitRef: options.unitRef,
        normalized: valuationDecimals.get(valuation.id),
      });
    }
  }
  const summary = summarizeValuation(options.unitRef, cells);

  const restrictions = await restrictionsFor(env.DB, [
    contextId,
    ...manifest.priceObservationIds,
    ...[...prices.values()].map((price) => price.sourceClaimRef),
  ]);
  const replayability = replayabilityFor({
    inputsPresent: true,
    artifactPresent: true,
    restrictions,
  });

  const body: ReportBody = {
    schemaVersion: "report-holdings-v1",
    purpose: "holdings-view",
    contextId,
    calculationRunId: runId,
    policyRefs: [DEFAULT_INSTRUMENT_VALUATION_POLICY.policyId, options.decimalPolicyRelease].sort(),
    unitRef: options.unitRef,
    partition: summary.partition,
    subtotal:
      summary.subtotal && summary.subtotal.value.status === "exact"
        ? summary.subtotal.value.value
        : null,
    rows,
    coverage: {
      scopeRef: options.perimeterRef,
      coveredRef: `positions:${manifest.positionObservationIds.length}`,
      truncated,
    },
  };
  const contentDigest = await canonicalDigest(body);
  const storageRef = reportStorageRef(contentDigest);

  await env.DB.prepare(
    `INSERT INTO calculation_runs(run_id,context_id,policy_refs_json,input_manifest_digest,status,replayability,started_at)
     VALUES(?,?,?,?,'building',?,?) ON CONFLICT(run_id) DO NOTHING`,
  )
    .bind(
      runId,
      contextId,
      JSON.stringify(body.policyRefs),
      manifestDigest,
      replayability,
      options.now,
    )
    .run();
  const inserts = [
    ...cells.map((cell, index) => {
      const row = rows[index]!;
      return env.DB.prepare(
        `INSERT INTO calculation_results(run_id,subject_ref,scope_ref,metric,unit_ref,coefficient,scale,value_status,unvalued_reason,rounding_inputs_json)
         VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      ).bind(
        runId,
        cell.subjectRef,
        cell.scopeRef,
        cell.metric,
        options.unitRef,
        row.valued ? row.value.coefficient : null,
        row.valued ? row.value.scale : null,
        row.valued ? "exact" : "unvalued",
        row.valued ? null : row.unvaluedReason,
        JSON.stringify({
          priceRef: cell.outcome.valued ? cell.outcome.priceRef : null,
          rounding: cell.outcome.valued ? cell.outcome.roundingInputs : null,
        }),
      );
    }),
    ...providerRows.map((row) => {
      const exact =
        row.normalized?.status === "exact" &&
        row.normalized.coefficient !== null &&
        row.normalized.scale !== null;
      return env.DB.prepare(
        `INSERT INTO calculation_results(run_id,subject_ref,scope_ref,metric,unit_ref,coefficient,scale,value_status,unvalued_reason,rounding_inputs_json)
         VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      ).bind(
        runId,
        row.subjectRef,
        row.scopeRef,
        row.metric,
        row.unitRef,
        exact ? row.normalized!.coefficient : null,
        exact ? row.normalized!.scale : null,
        exact ? "exact" : "unvalued",
        exact ? null : "missing-quantity",
        JSON.stringify({ providerReported: true, policy: options.decimalPolicyRelease }),
      );
    }),
  ];
  if (inserts.length > 0) await env.DB.batch(inserts);
  await env.DB.prepare(
    "UPDATE calculation_runs SET status='complete',completed_at=?,replayability=? WHERE run_id=? AND status='building'",
  )
    .bind(options.now, replayability, runId)
    .run();

  // The stored bytes are the canonical form the digest was taken over, so a
  // reader can verify sha256(bytes) == content_digest without re-serializing.
  const encoder = new TextEncoder();
  await env.EVIDENCE.put(storageRef, encoder.encode(canonicalJson(body)));
  // A cached explanation node: references only, no amounts and no raw locator.
  // It is a cache (retention class `cache`), so a use restriction purges it
  // while the report body itself survives (UC66/AT66).
  await env.EVIDENCE.put(
    `${storageRef}.explanation`,
    encoder.encode(
      canonicalJson({
        schemaVersion: "report-explanation-v1",
        contextId,
        calculationRunId: runId,
        inputManifest: manifest,
        policyRefs: body.policyRefs,
        prices: [...prices.values()]
          .map((price) => ({
            id: price.id,
            baseInstrumentRef: price.baseInstrumentRef,
            quoteUnitRef: price.quoteUnitRef,
            priceKind: price.priceKind,
            sourceClaimRef: price.sourceClaimRef,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }),
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO report_artifacts(report_id,context_id,purpose,schema_version,content_digest,storage_ref,created_by,created_at)
       VALUES(?,?,'holdings-view',?,?,?,?,?) ON CONFLICT(report_id) DO NOTHING`,
    ).bind(
      reportId,
      contextId,
      body.schemaVersion,
      contentDigest,
      storageRef,
      options.actor,
      options.now,
    ),
    env.DB.prepare(
      "INSERT INTO report_events(report_id,kind,actor,related_report_id,occurred_at) VALUES(?,'generated',?,NULL,?)",
    ).bind(reportId, options.actor, options.now),
  ]);

  return {
    generated: 1,
    reused: 0,
    skipped: null,
    reportId,
    contextId,
    contentDigest,
    runId,
    partition: summary.partition,
    unvaluedReasons: summary.reasons,
    truncated,
  };
}

/** Positions the job would read, exposed so a test can assert what the manifest covers. */
export type ReportJobPositions = PositionWithValuations[];

export interface PurgeResult {
  downgradedRuns: number;
  purgedExplanations: number;
  restrictedReports: string[];
}

/**
 * Apply evidence-use restrictions to what was already computed (AR17, UC66).
 *
 * Report bodies are never deleted here: a fixed deliverable stays fixed and
 * its retention class is `report`. What changes is the honest claim about it —
 * the calculation run is downgraded to `restricted`, and the cached
 * explanation node, whose retention class is `cache`, is removed so no reader
 * can serve a derivative of the restricted evidence. Deleting the stored bytes
 * themselves is a privileged operation outside this job.
 */
export async function purgeRestrictedExplanations(env: ReportJobEnv): Promise<PurgeResult> {
  const restricted = await env.DB.prepare(
    `SELECT DISTINCT a.report_id, a.storage_ref, a.context_id
     FROM report_artifacts a
     JOIN evidence_use_restrictions r
       ON r.evidence_ref = a.context_id
       OR EXISTS(SELECT 1 FROM json_each(r.affected_manifests_json) m WHERE m.value = a.context_id)
     ORDER BY a.report_id LIMIT 500`,
  ).all<{ report_id: string; storage_ref: string; context_id: string }>();
  let purged = 0;
  const contexts = new Set<string>();
  for (const row of restricted.results) {
    contexts.add(row.context_id);
    const key = `${row.storage_ref}.explanation`;
    if (await env.EVIDENCE.head(key)) {
      await env.EVIDENCE.delete(key);
      purged += 1;
    }
  }
  let downgraded = 0;
  for (const contextId of contexts) {
    const result = await env.DB.prepare(
      "UPDATE calculation_runs SET replayability='restricted' WHERE context_id=? AND replayability<>'restricted'",
    )
      .bind(contextId)
      .run();
    downgraded += result.meta.changes ?? 0;
  }
  return {
    downgradedRuns: downgraded,
    purgedExplanations: purged,
    restrictedReports: restricted.results.map((row) => row.report_id),
  };
}
