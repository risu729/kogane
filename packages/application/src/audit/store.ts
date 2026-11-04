// The audit store: the App adapter's answer records under the daily caps, the
// Processor's daily overflow aggregate, and the operator's page (ADR 0064).
//
// Effect records (`applied`, `accepted`) are never written here: each writer
// appends its own as the last statement of its own batch (`call.ts`). What is
// written here is everything else — a read, a replay, a refusal, a failure —
// once, after the answer, and an audit write never changes the answer: the
// caller swallows a failure and the request log carries `audit_write_failed`.
import type { ScopeSet } from "../grants.ts";
import type { CommandStore } from "../command/contract.ts";
import type { SqlWrite } from "../../../storage-d1/src/core/operations.ts";
import { canonicalDigest } from "../../../domain/src/context.ts";
import {
  AUDIT_COLUMNS,
  type AuditRow,
  auditInsertWrite,
  auditInstant,
  buildAuditRecord,
} from "./record.ts";
import {
  AUDIT_DAILY_CAPS,
  AUDIT_ID,
  AUDIT_INSTANT,
  AUDIT_OPERATION,
  AUDIT_PATHS,
  AUDIT_PRINCIPAL_KINDS,
  AUDIT_RESULTS,
  type AuditPath,
  type AuditPrincipalKind,
  type AuditResult,
  type OverflowResult,
  type SubjectPath,
  type SubjectPrincipalKind,
} from "./vocabulary.ts";

/** The UTC day of a canonical instant, and the half-open range of instants it covers. */
export function utcDay(instant: string): { day: string; from: string; to: string } {
  const day = instant.slice(0, 10);
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { day, from: `${day}T00:00:00.000Z`, to: next.toISOString() };
}

/** How many records of `result` this principal has on the record's UTC day. */
const DAY_COUNT = `(SELECT count(*) FROM audit_records
  WHERE principal=? AND result=? AND recorded_at>=? AND recorded_at<?)`;

export type AnswerAppend = "recorded" | "overflow" | "cap_reached";

/**
 * Appends one answer record (`read`, `replayed`, `refused`, `failed`).
 *
 * `read` and `refused` are capped per principal and UTC day: below the cap
 * the record is inserted; at or past it, only the principal's counter for
 * that day, path and result is incremented (`overflow`). Both statements
 * read the day's count inside one batch, the counter first, so exactly one
 * of them writes. A `prepared` record past its cap is not written at all
 * (`cap_reached`) and the caller refuses the prepare. `replayed` and
 * `failed` are not capped (ADR 0064 caps prepared, read and refused).
 */
export async function appendAnswerRecord(
  store: CommandStore,
  row: AuditRow,
): Promise<AnswerAppend> {
  if (row.result === "applied" || row.result === "accepted" || row.result === "overflow")
    throw new Error("an effect or overflow record is written by its writer, not here");
  if (row.result === "replayed" || row.result === "failed") {
    await store.batch([auditInsertWrite(row)]);
    return "recorded";
  }
  const cap = AUDIT_DAILY_CAPS[row.result];
  const { day, from, to } = utcDay(row.recorded_at);
  const countBinds = [row.principal, row.result, from, to];
  const insert = auditInsertWrite(row);
  const capped: SqlWrite = {
    sql: `INSERT INTO audit_records(${AUDIT_COLUMNS.join(",")}) SELECT ${AUDIT_COLUMNS.map(() => "?").join(",")}
      WHERE ${DAY_COUNT}<?`,
    binds: [...insert.binds, ...countBinds, cap],
  };
  if (row.result === "prepared") {
    const [written] = await store.batch([capped]);
    return written?.changes === 1 ? "recorded" : "cap_reached";
  }
  // A capped record has a subject and a subject-path principal (ui, agent-http, mcp).
  if (row.subject === null || row.principal_kind === "automatic")
    throw new Error("only subject paths are capped");
  const counter: SqlWrite = {
    sql: `INSERT INTO audit_overflow_counters(day,principal,path,result,subject,principal_kind,count)
      SELECT ?,?,?,?,?,?,1 WHERE ${DAY_COUNT}>=?
      ON CONFLICT(day,principal,path,result) DO UPDATE SET count=count+1`,
    binds: [
      day,
      row.principal,
      row.path,
      row.result,
      row.subject,
      // The aggregate spans delegation revisions and asserts no execution grant.
      row.principal_kind === "delegated" ? "agent" : row.principal_kind,
      ...countBinds,
      cap,
    ],
  };
  const [counted, written] = await store.batch([counter, capped]);
  if (written?.changes === 1) return "recorded";
  if (counted?.changes === 1) return "overflow";
  throw new Error("audit answer record was neither recorded nor counted");
}

interface CounterRow {
  day: string;
  principal: string;
  path: SubjectPath;
  result: OverflowResult;
  subject: string;
  principal_kind: SubjectPrincipalKind;
  count: number;
}

/** Counter rows aggregated per tick at most; the rest wait for the next tick. */
export const OVERFLOW_ROWS_PER_TICK = 100;

/**
 * The first Processor tick after a UTC day ends: one `overflow` record per
 * counter row of an ended day — the counter's principal, subject and path,
 * operation `audit.overflow`, `{of, count, cap}` — and the counter row
 * deleted in the same batch. Both statements are guarded on the count read,
 * so a counter that moved in between is left for the next tick rather than
 * recorded with a stale count; a second tick finds nothing.
 */
export async function aggregateAuditOverflow(
  store: CommandStore,
  now: Date,
  limit: number = OVERFLOW_ROWS_PER_TICK,
): Promise<{ counters: number; written: number }> {
  const today = auditInstant(now).slice(0, 10);
  const rows = await store.all<CounterRow>(
    `SELECT day,principal,path,result,subject,principal_kind,count FROM audit_overflow_counters
      WHERE day<?1 ORDER BY day,principal,path,result LIMIT ?2`,
    [today, limit],
  );
  let written = 0;
  for (const counter of rows) {
    const row = buildAuditRecord(
      {
        path: counter.path,
        subject: counter.subject,
        principal: counter.principal,
        principalKind: counter.principal_kind,
        correlationId: crypto.randomUUID(),
      },
      {
        operation: "audit.overflow",
        riskClass: "R0",
        result: "overflow",
        diff: {
          kind: "overflow",
          of: counter.result,
          count: counter.count,
          cap: AUDIT_DAILY_CAPS[counter.result],
        },
      },
      auditInstant(now),
    );
    const key = [counter.day, counter.principal, counter.path, counter.result, counter.count];
    const insert = auditInsertWrite(row);
    const [inserted] = await store.batch([
      {
        sql: `INSERT INTO audit_records(${AUDIT_COLUMNS.join(",")}) SELECT ${AUDIT_COLUMNS.map(() => "?").join(",")}
          WHERE EXISTS(SELECT 1 FROM audit_overflow_counters
            WHERE day=? AND principal=? AND path=? AND result=? AND count=?)`,
        binds: [...insert.binds, ...key],
      },
      {
        sql: `DELETE FROM audit_overflow_counters
          WHERE day=? AND principal=? AND path=? AND result=? AND count=?`,
        binds: key,
      },
    ]);
    if (inserted?.changes === 1) written += 1;
  }
  return { counters: rows.length, written };
}

// ── the operator's page ──────────────────────────────────────────────────

/** Records per page of `GET /api/v2/audit`. */
export const AUDIT_PAGE_SIZE = 50;

export interface AuditPageFilters {
  operation?: string;
  path?: AuditPath;
  principalKind?: AuditPrincipalKind;
  result?: AuditResult;
  /** First UTC day included, `YYYY-MM-DD`. */
  from?: string;
  /** Last UTC day included, `YYYY-MM-DD`. */
  to?: string;
}

/** One record as the reader returns it. Every value is the stored closed value. */
export interface AuditRecordView {
  auditId: string;
  recordedAt: string;
  path: AuditPath;
  subject: string | null;
  principal: string;
  principalKind: string;
  delegationRef: string | null;
  operation: string;
  riskClass: string;
  step: string;
  scope: { namespace: string; source: string } | null;
  targetRef: string | null;
  result: AuditResult;
  resultCode: string | null;
  reasonCode: string | null;
  correlationId: string;
  idempotencyKey: string | null;
  payloadDigest: string | null;
  confirmationDigest: string | null;
  confirmExpiresAt: string | null;
  confirmsAuditId: string | null;
  revertsAuditId: string | null;
  refs: string[];
  diff: Record<string, unknown>;
}

export type AuditPageOutcome =
  | { ok: true; records: AuditRecordView[]; cursor: string | null }
  | { ok: false; code: "invalid_query" | "stale_context" };

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function validDay(value: string): boolean {
  return DAY.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}

/** The filters, checked against the closed vocabulary; null when any is outside it. */
export function auditPageFilters(input: Record<string, string>): AuditPageFilters | null {
  const filters: AuditPageFilters = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "operation" && AUDIT_OPERATION.test(value)) filters.operation = value;
    else if (key === "path" && (AUDIT_PATHS as readonly string[]).includes(value))
      filters.path = value as AuditPath;
    else if (
      key === "principalKind" &&
      [...AUDIT_PRINCIPAL_KINDS, "delegated"].includes(value as AuditPrincipalKind)
    )
      filters.principalKind = value as AuditPrincipalKind;
    else if (key === "result" && (AUDIT_RESULTS as readonly string[]).includes(value))
      filters.result = value as AuditResult;
    else if ((key === "from" || key === "to") && validDay(value)) filters[key] = value;
    else return null;
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to)
    return null;
  return filters;
}

/**
 * Newest first, filtered in the SQL `WHERE` before the `LIMIT`, 50 records a
 * page; no total is computed. The cursor names the last record shown and
 * binds the filters it was issued under: a cursor presented with other
 * filters is `stale_context`, never a page of a different query.
 *
 * The day range and the cursor are one range on `audit_records_by_time`
 * (`recorded_at` from the first day up to the earlier of the cursor and the
 * end of the last day), so a later page or an older day seeks to its place in
 * the index instead of walking it from the newest record. An absent bound is
 * `''` or `'~'`, which sort before and after every canonical instant. The
 * exclusive end of the last day and the cursor's tie on `audit_id` are
 * residual checks (`+recorded_at` keeps them off the index), so the planner
 * never has two upper bounds to choose between.
 */
export const AUDIT_PAGE_SQL = `SELECT ${AUDIT_COLUMNS.join(",")} FROM audit_records
  WHERE (?1 IS NULL OR operation=?1) AND (?2 IS NULL OR path=?2)
    AND (?3 IS NULL OR principal_kind=?3) AND (?4 IS NULL OR result=?4)
    AND recorded_at>=coalesce(?5,'')
    AND recorded_at<=min(coalesce(?6,'~'),coalesce(?7,'~'))
    AND +recorded_at<coalesce(?6,'~')
    AND (?7 IS NULL OR +recorded_at<?7 OR audit_id<?8)
  ORDER BY recorded_at DESC, audit_id DESC LIMIT ?9`;

async function filtersDigest(
  filters: AuditPageFilters,
  perimeter: AuditReadPerimeter | "*" = "*",
): Promise<string> {
  return (await canonicalDigest({ v: "kogane-audit-cursor-v1", perimeter, filters })).slice(0, 32);
}

function encodeCursor(value: { at: string; id: string; f: string }): string {
  return btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decodeCursor(text: string): { at: string; id: string; f: string } | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/u.test(text)) return null;
  try {
    const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
    const value: unknown = JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const { at, id, f } = value as Record<string, unknown>;
    if (
      typeof at !== "string" ||
      !AUDIT_INSTANT.test(at) ||
      typeof id !== "string" ||
      !AUDIT_ID.test(id) ||
      typeof f !== "string" ||
      !/^[0-9a-f]{32}$/u.test(f) ||
      Object.keys(value).length !== 3
    )
      return null;
    return { at, id, f };
  } catch {
    return null;
  }
}

export function auditRecordView(row: AuditRow): AuditRecordView {
  return {
    auditId: row.audit_id,
    recordedAt: row.recorded_at,
    path: row.path,
    subject: row.subject,
    principal: row.principal,
    principalKind: row.principal_kind,
    delegationRef: row.delegation_ref,
    operation: row.operation,
    riskClass: row.risk_class,
    step: row.step,
    scope:
      row.scope_namespace === null || row.scope_source === null
        ? null
        : { namespace: row.scope_namespace, source: row.scope_source },
    targetRef: row.target_ref,
    result: row.result,
    resultCode: row.result_code,
    reasonCode: row.reason_code,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    payloadDigest: row.payload_digest,
    confirmationDigest: row.confirmation_digest,
    confirmExpiresAt: row.confirm_expires_at,
    confirmsAuditId: row.confirms_audit_id,
    revertsAuditId: row.reverts_audit_id,
    refs: JSON.parse(row.refs_json) as string[],
    diff: JSON.parse(row.diff_json) as Record<string, unknown>,
  };
}

/** One page of the whole store, for the operator (ADR 0064, "Reading"). */
export async function readAuditPage(
  store: CommandStore,
  filters: AuditPageFilters,
  cursor: string | null,
  pageSize: number = AUDIT_PAGE_SIZE,
  perimeter?: AuditReadPerimeter,
): Promise<AuditPageOutcome> {
  const digest = await filtersDigest(filters, perimeter);
  let after: { at: string; id: string } | null = null;
  if (cursor !== null) {
    const decoded = decodeCursor(cursor);
    if (decoded === null) return { ok: false, code: "invalid_query" };
    if (decoded.f !== digest) return { ok: false, code: "stale_context" };
    after = decoded;
  }
  const { sql, scopeBinds } = perimeter
    ? scopedAuditPageSql(perimeter)
    : { sql: AUDIT_PAGE_SQL, scopeBinds: [] };
  const rows = await store.all<AuditRow>(sql, [
    filters.operation ?? null,
    filters.path ?? null,
    filters.principalKind ?? null,
    filters.result ?? null,
    filters.from === undefined ? null : `${filters.from}T00:00:00.000Z`,
    filters.to === undefined ? null : utcDay(`${filters.to}T00:00:00.000Z`).to,
    after?.at ?? null,
    after?.id ?? null,
    pageSize + 1,
    ...scopeBinds,
  ]);
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return {
    ok: true,
    records: page.map(auditRecordView),
    cursor:
      rows.length > pageSize && last
        ? encodeCursor({ at: last.recorded_at, id: last.audit_id, f: digest })
        : null,
  };
}

export interface AuditReadPerimeter {
  sources: ScopeSet;
  scheduleSources: ScopeSet;
  unscoped: boolean;
}
/** Scope is placed in each indexed branch before the common page window. */
export function scopedAuditPageSql(perimeter: AuditReadPerimeter): {
  sql: string;
  scopeBinds: unknown[];
} {
  const base = AUDIT_PAGE_SQL.slice(0, AUDIT_PAGE_SQL.indexOf("  ORDER BY")).replace(
    "FROM audit_records",
    "FROM audit_records INDEXED BY audit_records_by_scope",
  );
  const scopeBinds: unknown[] = [];
  const branches: string[] = [];
  for (const [namespace, sources] of [
    ["core-source", perimeter.sources],
    ["schedule-source", perimeter.scheduleSources],
  ] as const) {
    if (sources === "*") {
      const i = 10 + scopeBinds.length;
      scopeBinds.push(namespace);
      branches.push(base.replace("WHERE ", `WHERE scope_namespace=?${i} AND `));
    } else if (sources.length) {
      const i = 10 + scopeBinds.length;
      scopeBinds.push(namespace, JSON.stringify([...sources].sort()));
      branches.push(
        base.replace(
          "WHERE ",
          `WHERE scope_namespace=?${i} AND scope_source IN (SELECT atom FROM json_each(?${i + 1})) AND `,
        ),
      );
    }
  }
  if (perimeter.unscoped)
    branches.push(base.replace("WHERE ", "WHERE scope_namespace IS NULL AND "));
  if (!branches.length) branches.push(base.replace("WHERE ", "WHERE 0 AND "));
  return {
    sql: `${branches.join(" UNION ALL ")} ORDER BY recorded_at DESC,audit_id DESC LIMIT ?9`,
    scopeBinds,
  };
}
