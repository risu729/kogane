// The `lane` audit records of the scheduled lanes (ADR 0064, plan slice S7).
//
// A lane that writes rule decisions, economic commits or proposals gets one
// audit record per tick that wrote any of them, naming what it wrote by range
// and nothing else. A lane writes in many batches, so the record cannot be
// the last statement of one of them; instead `runScheduled` reads a high-water
// mark of each table before the lane runs (`laneAuditMark`) and, after it,
// the lane's own rows above that mark (`laneWrites`): rows under the lane's
// own actor, principal or method, so an operator's decision or an agent's
// proposal written while the lane ran is not counted as the lane's. The
// record is then appended on its own (`recordLaneAudit`).
//
// What a reference names is defined here (`resolveLaneRef`): the rows of one
// table between two positions, inclusive, that pass the lane's own predicate.
// The positions are the commit sequence of `economic_commit_log`, the integer
// key of `maintenance_survey_proposals`, and the rowid of the TEXT-keyed
// `decision_revisions`, `reconciliation_proposals` and
// `card_settlement_candidates`, which the repository already orders by (for
// example `entity_relations` in the card-ownership read). These tables are
// append-only, so a position is never reused while the table is not rebuilt
// (a rebuild that drops the rowid renumbers it; docs/audit-log.md, limits).
//
// Recording never changes what the lane did: a mark or a record that cannot
// be read or written is logged as `lane_audit_record_failed` with a safe code,
// and the tick goes on.
import { CARD_PURCHASE_ACTOR } from "../../../packages/domain/src/card-purchase.ts";
import {
  auditInsertWrite,
  auditInstant,
  d1CommandStore,
  type LaneProposalKind,
  type LaneRange,
  laneTickRecord,
  type LaneWrites,
} from "../../../packages/application/src/index.ts";
import type { LaneTickResult } from "./lane-ticks.ts";

/** The actor of the reconciliation sweep's automatic acceptances (`reconciliation-job.ts`). */
export const RECONCILIATION_RULE_ACTOR = "rule:reconciliation-v1";

/**
 * Every statement this module prepares. Each is a range on its table's key,
 * also without table statistics (D1 never runs `ANALYZE`), which
 * `test/lane-audit-plans.test.ts` asserts for every one of them.
 *
 * `reconciliation_proposals` has an index on `(kind,stage)`: grouping or
 * filtering on a bare `kind` lets the planner walk that index for the grouping
 * order or seek every proposal of one kind, so its reads write `+kind`, which
 * keeps the value and its collation but is not an index term, and the plan is
 * the rowid range (docs/audit-log.md, Cost).
 */
export const LANE_AUDIT_SQL = {
  mark: `SELECT e.core_epoch AS epoch,
  (SELECT coalesce(max(rowid),0) FROM decision_revisions) AS decisions,
  (SELECT coalesce(max(commit_seq),0) FROM economic_commit_log WHERE core_epoch=e.core_epoch) AS commits,
  (SELECT coalesce(max(rowid),0) FROM reconciliation_proposals) AS reconciliation,
  (SELECT coalesce(max(rowid),0) FROM card_settlement_candidates) AS settlement,
  (SELECT coalesce(max(id),0) FROM maintenance_survey_proposals) AS survey
  FROM core_source_revision e WHERE e.id=1`,
  decisions: `SELECT count(*) AS n,min(rowid) AS lo,max(rowid) AS hi FROM decision_revisions
                WHERE rowid>?1 AND actor_id=?2 AND method='rule'`,
  commits: `SELECT count(*) AS n,min(commit_seq) AS lo,max(commit_seq) AS hi FROM economic_commit_log
                WHERE core_epoch=?1 AND commit_seq>?2 AND principal=?3`,
  reconciliationProposals: `SELECT kind,count(*) AS n,min(rowid) AS lo,max(rowid) AS hi FROM reconciliation_proposals
      WHERE rowid>?1 AND method='rule' GROUP BY +kind ORDER BY +kind`,
  settlementCandidates: `SELECT 'candidate' AS kind,count(*) AS n,min(rowid) AS lo,max(rowid) AS hi
      FROM card_settlement_candidates WHERE rowid>?1 HAVING count(*)>0`,
  surveyProposals: `SELECT kind,count(*) AS n,min(id) AS lo,max(id) AS hi FROM maintenance_survey_proposals
      WHERE id>?1 GROUP BY kind`,
  decisionsRef: `SELECT id FROM decision_revisions WHERE rowid>=?1 AND rowid<=?2 AND actor_id=?3 AND method='rule' ORDER BY rowid`,
  commitsRef: `SELECT commit_seq FROM economic_commit_log WHERE core_epoch=?1 AND commit_seq>=?2 AND commit_seq<=?3 AND principal=?4 ORDER BY commit_seq`,
  reconciliationRef: `SELECT id FROM reconciliation_proposals WHERE rowid>=?1 AND rowid<=?2 AND method='rule' AND +kind=?3 ORDER BY rowid`,
  settlementRef:
    "SELECT id FROM card_settlement_candidates WHERE rowid>=?1 AND rowid<=?2 ORDER BY rowid",
  surveyRef:
    "SELECT id FROM maintenance_survey_proposals WHERE id>=?1 AND id<=?2 AND kind=?3 ORDER BY id",
} as const;

/** The proposal tables a lane may write, each with the closed kinds it maps to. */
const PROPOSAL_TABLES = {
  // Stage A pairs of the reconciliation sweep and pending-to-posted
  // candidates of purchase recognition: rule proposals only (an agent's or an
  // operator's proposal has another method).
  reconciliation: {
    sql: LANE_AUDIT_SQL.reconciliationProposals,
    kind: (raw: string) => `reconciliation-${raw.replaceAll("_", "-")}`,
  },
  // Written by the settlement sweep only.
  "card-settlement": {
    sql: LANE_AUDIT_SQL.settlementCandidates,
    kind: () => "card-settlement-candidate",
  },
  // Written by the maintenance re-survey only.
  "maintenance-survey": {
    sql: LANE_AUDIT_SQL.surveyProposals,
    kind: (raw: string) => `maintenance-survey-${raw}`,
  },
} as const;
type ProposalTable = keyof typeof PROPOSAL_TABLES;

export interface LaneAuditSpec {
  /** The `decision_revisions.actor_id` of the lane's rule decisions. */
  decisionActor?: string;
  /** The `economic_commit_log.principal` of the lane's commits. */
  commitPrincipal?: string;
  /** The proposal tables the lane writes. */
  proposals: readonly ProposalTable[];
}

/**
 * The lanes that write decisions, proposals or settings, and how their own
 * rows are told apart. No lane writes a setting (a schedule or a maintenance
 * rule) today: the re-survey only proposes, and the operator's acceptance is
 * a `ui` record. A lane not listed here records nothing.
 */
export const LANE_AUDIT: Readonly<Record<string, LaneAuditSpec>> = {
  // Stage A proposals, and the automatic acceptance of a provider-linked pair.
  reconciliation_sweep: { decisionActor: RECONCILIATION_RULE_ACTOR, proposals: ["reconciliation"] },
  // Settlement candidates; acceptance is the operator's command.
  card_settlement_sweep: { proposals: ["card-settlement"] },
  // Rule decisions, each with its commit row (ADR 0054), and the
  // pending-to-posted candidates; a provider-linked pair is merged by rule.
  purchase_recognition: {
    decisionActor: CARD_PURCHASE_ACTOR,
    commitPrincipal: CARD_PURCHASE_ACTOR,
    proposals: ["reconciliation"],
  },
  // Proposals only; never a rule, a schedule or an alarm (ADR 0050).
  maintenance_survey: { proposals: ["maintenance-survey"] },
};

/** The positions every audited table had before a lane ran. */
export interface LaneAuditMark {
  epoch: string;
  decisions: number;
  commits: number;
  reconciliation: number;
  "card-settlement": number;
  "maintenance-survey": number;
}

/** The high-water mark before a lane runs: one statement, each part a seek on its key. */
async function laneAuditMark(db: D1Database): Promise<LaneAuditMark> {
  const row = await db.prepare(LANE_AUDIT_SQL.mark).first<{
    epoch: string;
    decisions: number;
    commits: number;
    reconciliation: number;
    settlement: number;
    survey: number;
  }>();
  if (!row) throw new Error("lane_audit_mark_unavailable");
  return {
    epoch: row.epoch,
    decisions: row.decisions,
    commits: row.commits,
    reconciliation: row.reconciliation,
    "card-settlement": row.settlement,
    "maintenance-survey": row.survey,
  };
}

interface RangeRow {
  n: number;
  lo: number | null;
  hi: number | null;
}

const range = (row: RangeRow | null | undefined): LaneRange | null =>
  row && row.n > 0 && row.lo !== null && row.hi !== null
    ? { count: row.n, from: row.lo, to: row.hi }
    : null;

/**
 * The lane's own rows above `mark`: its decisions, its commits in the mark's
 * epoch, and its proposals per kind, in kind order. Every read is a range
 * on the table's key, so a tick reads only what was written since its mark.
 */
async function laneWrites(
  db: D1Database,
  spec: LaneAuditSpec,
  mark: LaneAuditMark,
): Promise<LaneWrites> {
  const decisions =
    spec.decisionActor === undefined
      ? null
      : range(
          await db
            .prepare(LANE_AUDIT_SQL.decisions)
            .bind(mark.decisions, spec.decisionActor)
            .first<RangeRow>(),
        );
  const commitRange =
    spec.commitPrincipal === undefined
      ? null
      : range(
          await db
            .prepare(LANE_AUDIT_SQL.commits)
            .bind(mark.epoch, mark.commits, spec.commitPrincipal)
            .first<RangeRow>(),
        );
  const proposals: (LaneRange & { kind: LaneProposalKind })[] = [];
  for (const table of spec.proposals) {
    const { sql, kind } = PROPOSAL_TABLES[table];
    const rows = await db.prepare(sql).bind(mark[table]).all<RangeRow & { kind: string }>();
    for (const row of rows.results) {
      const found = range(row);
      if (found) proposals.push({ ...found, kind: kind(row.kind) as LaneProposalKind });
    }
  }
  return {
    decisions,
    commits: commitRange === null ? null : { ...commitRange, epoch: mark.epoch },
    proposals,
  };
}

/**
 * Appends the record of one tick of `lane`, if the lane is audited and wrote
 * anything since `mark`. Never throws: a failure is logged with a safe code.
 */
export async function recordLaneAudit(
  db: D1Database,
  lane: string,
  mark: LaneAuditMark | null,
  tick: LaneTickResult,
  correlationId: string,
  log: (line: string) => void,
): Promise<void> {
  const spec = LANE_AUDIT[lane];
  if (!spec || mark === null || tick.outcome === "skipped-by-flag") return;
  try {
    const writes = await laneWrites(db, spec, mark);
    const row = laneTickRecord(
      lane,
      writes,
      tick.outcome === "failed" ? { result: "failed", code: tick.code } : { result: "applied" },
      auditInstant(new Date()),
      correlationId,
    );
    if (row !== null) await d1CommandStore(db).batch([auditInsertWrite(row)]);
  } catch (error) {
    logFailure(log, lane, error);
  }
}

/** The mark before an audited lane runs, or null (logged) when it cannot be read. */
export async function markLaneAudit(
  db: D1Database,
  lane: string,
  log: (line: string) => void,
): Promise<LaneAuditMark | null> {
  if (!Object.hasOwn(LANE_AUDIT, lane)) return null;
  try {
    return await laneAuditMark(db);
  } catch (error) {
    logFailure(log, lane, error);
    return null;
  }
}

/** A closed code of this module or the audit builder (`audit_record_invalid`, …). */
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

function logFailure(log: (line: string) => void, lane: string, error: unknown): void {
  // Only a lower-case code is kept from an error's `code`; any other value
  // (a driver's own text) falls back to the error's class name.
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
  log(
    JSON.stringify({
      event: "lane_audit_record_failed",
      lane,
      code:
        code !== null && SAFE_CODE.test(code)
          ? code
          : error instanceof Error
            ? error.constructor.name
            : "unknown",
    }),
  );
}

// ── reading a lane record's references back ─────────────────────────────

const REF =
  /^(?:decision-revisions:(?<d>\d+)-(?<dt>\d+)|commit-seq:(?<epoch>[a-z0-9.-]+):(?<c>\d+)-(?<ct>\d+)|proposals:(?<kind>[a-z-]+):(?<p>\d+)-(?<pt>\d+))$/u;

/**
 * The rows a reference of a `lane:` record names: the lane's own rows of the
 * reference's table between its two positions, inclusive — decision revision
 * ids, `<epoch>:<commit seq>` or proposal ids. Null for a reference this lane
 * does not write. For tests and for an operator reading a record back.
 */
export async function resolveLaneRef(
  db: D1Database,
  lane: string,
  ref: string,
): Promise<string[] | null> {
  const spec = LANE_AUDIT[lane];
  const match = REF.exec(ref)?.groups;
  if (!spec || !match) return null;
  if (match.d !== undefined) {
    if (spec.decisionActor === undefined) return null;
    const rows = await db
      .prepare(LANE_AUDIT_SQL.decisionsRef)
      .bind(Number(match.d), Number(match.dt), spec.decisionActor)
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }
  if (match.c !== undefined) {
    if (spec.commitPrincipal === undefined) return null;
    const rows = await db
      .prepare(LANE_AUDIT_SQL.commitsRef)
      .bind(match.epoch, Number(match.c), Number(match.ct), spec.commitPrincipal)
      .all<{ commit_seq: number }>();
    return rows.results.map((row) => `${match.epoch}:${row.commit_seq}`);
  }
  const kind = match.kind!;
  const from = Number(match.p),
    to = Number(match.pt);
  if (kind.startsWith("reconciliation-") && spec.proposals.includes("reconciliation")) {
    const rows = await db
      .prepare(LANE_AUDIT_SQL.reconciliationRef)
      .bind(from, to, kind.slice("reconciliation-".length).replaceAll("-", "_"))
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }
  if (kind === "card-settlement-candidate" && spec.proposals.includes("card-settlement")) {
    const rows = await db
      .prepare(LANE_AUDIT_SQL.settlementRef)
      .bind(from, to)
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }
  if (kind.startsWith("maintenance-survey-") && spec.proposals.includes("maintenance-survey")) {
    const rows = await db
      .prepare(LANE_AUDIT_SQL.surveyRef)
      .bind(from, to, kind.slice("maintenance-survey-".length))
      .all<{ id: number }>();
    return rows.results.map((row) => String(row.id));
  }
  return null;
}
