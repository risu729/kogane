// The `maintenance_survey` lane (ADR 0050): re-read the allowlisted official
// maintenance-notice pages on their cadence, keep what was fetched, and
// propose what changed. It never writes a maintenance rule, never touches a
// schedule or an alarm, and never calls the maintenance writer: proposals wait
// for an operator's decision (INV07). Its log line and tick record carry
// counts and closed codes only, never page text.
import { canonicalDigest } from "../../../../packages/domain/src/context.ts";
import { sha256Hex } from "../../../../packages/evidence-contract/src/digest.ts";
import type {
  SurveyFailureCode,
  SurveyOutcome,
} from "../../../../packages/collection/src/maintenance-survey-model.ts";
import { maintenanceRules } from "../schedule-store.ts";
import { fetchable, loadSurveyConfig, type SurveyConfig, type SurveyTarget } from "./config.ts";
import { diffWindows } from "./diff.ts";
import { EXTRACTOR_VERSION, MAX_WINDOWS, extractWindows, type Extraction } from "./extract.ts";
import { decodePage, fetchPage, pageLines, type SurveyTransport } from "./page.ts";

/** R2 prefix of stored page bodies, content-addressed like `objects/<2 hex>/<sha256>`. */
const SURVEY_OBJECT_PREFIX = "maintenance-survey/objects";
/** How long a claimed page stays claimed if the tick dies mid-way. */
const CLAIM_MS = 30 * 60_000;
const HOUR = 3_600_000;

export interface MaintenanceSurveyResult {
  /** Allowlisted pages the configuration lets the lane fetch. */
  targets: number;
  /** Pages due and claimed this tick. */
  due: number;
  /** Pages whose windows were read. */
  extracted: number;
  /** Pages that failed, by closed code in `failures`. */
  failed: number;
  /** Current windows read. */
  windows: number;
  /** Windows equal to an enabled rule. */
  unchanged: number;
  /** New proposals without a review reason. */
  proposed: number;
  /** New proposals with one. */
  reviewPending: number;
  /** Drafts that were already proposed (the same reading again). */
  known: number;
  failures: Partial<Record<SurveyFailureCode, number>>;
}

export interface SurveyLaneOptions {
  /** The page transport; production passes the platform `fetch`. */
  transport: SurveyTransport;
  now?: () => number;
  /** Defaults to the committed, validated configuration. */
  config?: SurveyConfig;
}

interface CursorRow {
  target_id: string;
  next_due_at: string;
  consecutive_failures: number;
  last_sha256: string | null;
}

/** After `failures` consecutive failures: 1h, 2h, 4h … never later than the cadence. */
export function retryDelay(failures: number, cadenceHours: number): number {
  return Math.min(HOUR * 2 ** Math.max(0, failures - 1), cadenceHours * HOUR);
}

function empty(targets: number): MaintenanceSurveyResult {
  return {
    targets,
    due: 0,
    extracted: 0,
    failed: 0,
    windows: 0,
    unchanged: 0,
    proposed: 0,
    reviewPending: 0,
    known: 0,
    failures: {},
  };
}

/**
 * One tick: claim at most `targetsPerTick` due pages and survey each. The
 * caller runs it only while `MAINTENANCE_SURVEY_ENABLED` is on.
 */
export async function maintenanceSurveyLane(
  env: Env,
  options: SurveyLaneOptions,
): Promise<MaintenanceSurveyResult> {
  const config = options.config ?? loadSurveyConfig();
  const now = options.now ?? Date.now;
  const targets = config.targets.filter(fetchable);
  const result = empty(targets.length);
  if (targets.length === 0) return result;
  const started = now();
  const startedIso = new Date(started).toISOString();
  // A page newly allowlisted is due at once.
  await env.DB.batch(
    targets.map((t) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO maintenance_survey_cursors(target_id,next_due_at) VALUES(?,?)",
      ).bind(t.id, startedIso),
    ),
  );
  const due = await env.DB.prepare(
    `SELECT target_id,next_due_at,consecutive_failures,last_sha256 FROM maintenance_survey_cursors
     WHERE target_id IN (SELECT value FROM json_each(?)) AND next_due_at<=?
     ORDER BY next_due_at,target_id LIMIT ?`,
  )
    .bind(JSON.stringify(targets.map((t) => t.id)), startedIso, config.targetsPerTick)
    .all<CursorRow>();
  for (const cursor of due.results) {
    const target = targets.find((t) => t.id === cursor.target_id)!;
    // Claim it, so an overlapping tick cannot fetch the same page again.
    const claimed = await env.DB.prepare(
      "UPDATE maintenance_survey_cursors SET next_due_at=?,last_attempt_at=? WHERE target_id=? AND next_due_at=?",
    )
      .bind(new Date(started + CLAIM_MS).toISOString(), startedIso, target.id, cursor.next_due_at)
      .run();
    if (claimed.meta.changes !== 1) continue;
    result.due++;
    await surveyTarget(env, target, cursor, options.transport, now(), result);
  }
  return result;
}

interface Stored {
  sha256: string;
  objectKey: string;
  byteSize: number;
}

async function surveyTarget(
  env: Env,
  target: SurveyTarget,
  cursor: CursorRow,
  transport: SurveyTransport,
  fetchedAt: number,
  result: MaintenanceSurveyResult,
): Promise<void> {
  const fetchedIso = new Date(fetchedAt).toISOString();
  const page = await fetchPage(target.url, transport);
  let outcome: SurveyOutcome;
  let stored: Stored | null = null;
  let extraction: Extraction | null = null;
  if (!page.ok) outcome = page.code;
  else {
    stored = await store(env, page.bytes, page.mediaType);
    const text = stored ? decodePage(page.bytes, page.charset) : null;
    if (!stored) outcome = "store_failed";
    else if (text === null) outcome = "decode_failed";
    else {
      extraction = extractWindows(pageLines(text, page.mediaType), {
        timezone: target.timezone,
        fetchedAt,
      });
      outcome =
        extraction.windows.length > MAX_WINDOWS
          ? "too_many_windows"
          : extraction.windows.length + extraction.past === 0
            ? "no_window_recognized"
            : "extracted";
    }
  }
  const fetchRow = await env.DB.prepare(
    `INSERT INTO maintenance_survey_fetches(target_id,source,url,fetched_at,outcome,http_status,media_type,
      byte_size,sha256,object_key,extractor_version,windows,past,rejected)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  )
    .bind(
      target.id,
      target.source,
      target.url,
      fetchedIso,
      outcome,
      page.status,
      page.mediaType,
      stored?.byteSize ?? null,
      stored?.sha256 ?? null,
      stored?.objectKey ?? null,
      EXTRACTOR_VERSION,
      outcome === "extracted" ? extraction!.windows.length : 0,
      extraction?.past ?? 0,
      extraction?.rejected ?? 0,
    )
    .first<{ id: number }>();
  const fetchId = fetchRow!.id;
  const writes: D1PreparedStatement[] = [];
  if (outcome === "extracted") {
    result.extracted++;
    result.windows += extraction!.windows.length;
    const diff = diffWindows(
      extraction!,
      await maintenanceRules(env.DB, target.source),
      target,
      fetchedAt,
    );
    result.unchanged += diff.unchanged;
    for (const draft of diff.drafts) {
      const key = await canonicalDigest({
        targetId: target.id,
        kind: draft.kind,
        ruleId: draft.ruleId,
        baseRevision: draft.baseRevision,
        timezone: draft.timezone,
        pattern: draft.pattern,
        enabled: draft.enabled,
        scope: draft.scope,
      });
      writes.push(
        env.DB.prepare(
          // The same reading again is the same proposal; any other violation still fails.
          `INSERT INTO maintenance_survey_proposals(fetch_id,target_id,source,kind,rule_id,base_revision,
            timezone,pattern_json,enabled,scope,status,reasons_json,proposal_key,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(proposal_key) DO NOTHING`,
        ).bind(
          fetchId,
          target.id,
          target.source,
          draft.kind,
          draft.ruleId,
          draft.baseRevision,
          draft.timezone,
          JSON.stringify(draft.pattern),
          Number(draft.enabled),
          draft.scope,
          draft.reasons.length ? "review_pending" : "proposed",
          JSON.stringify(draft.reasons),
          key,
          fetchedIso,
        ),
      );
    }
    writes.push(
      env.DB.prepare(
        `UPDATE maintenance_survey_cursors SET next_due_at=?,last_success_at=?,consecutive_failures=0,
          last_fetch_id=?,last_changed_at=CASE WHEN last_sha256 IS ? THEN last_changed_at ELSE ? END,last_sha256=?
         WHERE target_id=?`,
      ).bind(
        new Date(fetchedAt + target.cadenceHours * HOUR).toISOString(),
        fetchedIso,
        fetchId,
        stored!.sha256,
        fetchedIso,
        stored!.sha256,
        target.id,
      ),
    );
    const results = await env.DB.batch(writes);
    diff.drafts.forEach((draft, i) => {
      if (results[i]?.meta.changes !== 1) result.known++;
      else if (draft.reasons.length) result.reviewPending++;
      else result.proposed++;
    });
    return;
  }
  const code = outcome as SurveyFailureCode;
  result.failed++;
  result.failures[code] = (result.failures[code] ?? 0) + 1;
  const failures = cursor.consecutive_failures + 1;
  await env.DB.prepare(
    `UPDATE maintenance_survey_cursors SET next_due_at=?,last_failure_at=?,last_failure_code=?,
      consecutive_failures=?,last_fetch_id=? WHERE target_id=?`,
  )
    .bind(
      new Date(fetchedAt + retryDelay(failures, target.cadenceHours)).toISOString(),
      fetchedIso,
      code,
      failures,
      fetchId,
      target.id,
    )
    .run();
}

/**
 * The body, content-addressed in the EVIDENCE bucket and written once: the
 * same bytes fetched again are the object already there. R2 verifies the
 * SHA-256 on the put. A body that cannot be stored is not read, because a
 * proposal must point at bytes someone can look at.
 */
async function store(env: Env, bytes: Uint8Array, mediaType: string): Promise<Stored | null> {
  try {
    const sha256 = await sha256Hex(bytes);
    const objectKey = `${SURVEY_OBJECT_PREFIX}/${sha256.slice(0, 2)}/${sha256}`;
    if (!(await env.EVIDENCE.head(objectKey)))
      await env.EVIDENCE.put(objectKey, bytes, {
        sha256,
        httpMetadata: { contentType: mediaType },
      });
    return { sha256, objectKey, byteSize: bytes.byteLength };
  } catch {
    return null;
  }
}
