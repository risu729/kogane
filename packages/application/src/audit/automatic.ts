// The records of the Processor's own paths (ADR 0064, plan slice S7): `alarm`
// and `lane`. No subject stands behind them; the principal is the Processor's
// own (`alarm:<job id>`, `lane:<lane>`, kind `automatic`). They are built by
// the same builder as every other record (`record.ts`) and carry references
// and counts only.
//
//   * `alarm.occurrence.claim` — one `accepted` record per occurrence of a
//     `collection`-kind job that `ScheduleAlarm` claims, appended as the last
//     statement of the claim's own batch, joined to the occurrence row that
//     batch wrote. The outcome of the dispatch stays in the occurrence row.
//   * `lane.tick` — one record per tick of a lane that wrote rule decisions,
//     economic commits or proposals, naming the ranges it wrote; `applied`
//     when the stage returned, `failed` with the tick's code when it threw
//     after writing. A tick that wrote nothing records nothing.
import type { SqlWrite } from "../../../storage-d1/src/core/operations.ts";
import { type AuditRow, auditEffectWrite, AuditRecordError, buildAuditRecord } from "./record.ts";
import { AUDIT_RESULT_CODE, type LaneProposalKind } from "./vocabulary.ts";

/** The reference of an alarm occurrence (`collection_schedule_occurrences.id`). */
export function occurrenceRef(occurrenceId: string): string {
  return `occurrence:${occurrenceId}`;
}

export interface AlarmClaim {
  /** The alarm job (`config/alarm-jobs.json`), a `collection`-kind one. */
  jobId: string;
  /** The job's schedule source, or null for a job without one. */
  source: string | null;
  /** `scheduled:<job id>:<nominal ms>`, as the claim batch inserts it. */
  occurrenceId: string;
  /** The schedule revision the occurrence was claimed under. */
  scheduleRevision: number;
  /** The claim's `started_at`, canonical UTC milliseconds. */
  claimedAt: string;
}

/**
 * The `accepted` record of one claimed collection occurrence, as the last
 * statement of the claim batch: a plain `INSERT … SELECT … WHERE` joined to
 * the occurrence row this claim inserted (its id, its `started_at` and status
 * `started`), so a claim that inserted nothing (an occurrence already claimed)
 * writes no record, and at most one record names one occurrence.
 */
export function alarmClaimWrite(claim: AlarmClaim, correlationId: string): SqlWrite {
  const ref = occurrenceRef(claim.occurrenceId);
  const row = buildAuditRecord(
    {
      path: "alarm",
      subject: null,
      principal: `alarm:${claim.jobId}`,
      principalKind: "automatic",
      correlationId,
    },
    {
      operation: "alarm.occurrence.claim",
      riskClass: "R2",
      result: "accepted",
      targetRef: `schedule:${claim.jobId}`,
      scope: claim.source === null ? null : { namespace: "schedule-source", source: claim.source },
      refs: [ref, `schedule:${claim.jobId}@${claim.scheduleRevision}`],
      diff: { kind: "none" },
    },
    claim.claimedAt,
  );
  // An occurrence id the reference pattern does not admit would leave the
  // record without it, and the once-check without a key: refuse instead.
  if (!(JSON.parse(row.refs_json) as string[]).includes(ref))
    throw new AuditRecordError("refs_json");
  return auditEffectWrite(
    row,
    {
      sql: "EXISTS(SELECT 1 FROM collection_schedule_occurrences WHERE id=? AND started_at=? AND status='started')",
      binds: [claim.occurrenceId, claim.claimedAt],
    },
    { kind: "target-ref", ref },
  );
}

/** One inclusive range of rows a lane wrote, and how many of them are its own. */
export interface LaneRange {
  count: number;
  from: number;
  to: number;
}

/** What one lane tick wrote, as ranges over the tables it writes. */
export interface LaneWrites {
  /** `decision_revisions` rows (by rowid) under the lane's own actor. */
  decisions: LaneRange | null;
  /** `economic_commit_log` rows (by commit sequence) under the lane's own principal. */
  commits: (LaneRange & { epoch: string }) | null;
  /** Proposal rows, per closed proposal kind. */
  proposals: readonly (LaneRange & { kind: LaneProposalKind })[];
}

/** Whether the tick wrote anything a lane record names. */
export function laneWroteAny(writes: LaneWrites): boolean {
  return (
    (writes.decisions?.count ?? 0) > 0 ||
    (writes.commits?.count ?? 0) > 0 ||
    writes.proposals.some((range) => range.count > 0)
  );
}

/** The principal of a lane: `lane:` and its name with hyphens for underscores. */
export function lanePrincipal(lane: string): string {
  return `lane:${lane.replaceAll("_", "-")}`;
}

/** A failed tick's code as a record admits it; any other shape is `lane_failed`. */
function laneFailureCode(code: string): string {
  return AUDIT_RESULT_CODE.test(code) ? code : "lane_failed";
}

/**
 * The record of one lane tick, or null when it wrote nothing. Its references
 * are the ranges in `writes` (`decision-revisions:<from>-<to>`,
 * `commit-seq:<epoch>:<from>-<to>`, `proposals:<kind>:<from>-<to>`); its diff
 * the number of the lane's own rows in each. No target, no scope (a tick
 * spans sources), and nothing of the tick's own counts.
 */
export function laneTickRecord(
  lane: string,
  writes: LaneWrites,
  outcome: { result: "applied" } | { result: "failed"; code: string },
  recordedAt: string,
  correlationId: string,
): AuditRow | null {
  if (!laneWroteAny(writes)) return null;
  const proposals = writes.proposals.filter((range) => range.count > 0);
  const refs: string[] = [];
  if (writes.decisions && writes.decisions.count > 0)
    refs.push(`decision-revisions:${writes.decisions.from}-${writes.decisions.to}`);
  if (writes.commits && writes.commits.count > 0)
    refs.push(`commit-seq:${writes.commits.epoch}:${writes.commits.from}-${writes.commits.to}`);
  for (const range of proposals) refs.push(`proposals:${range.kind}:${range.from}-${range.to}`);
  const adopted = (writes.decisions?.count ?? 0) > 0 || (writes.commits?.count ?? 0) > 0;
  const row = buildAuditRecord(
    {
      path: "lane",
      subject: null,
      principal: lanePrincipal(lane),
      principalKind: "automatic",
      correlationId,
    },
    {
      operation: "lane.tick",
      riskClass: adopted ? "R2" : "R1",
      result: outcome.result,
      resultCode: outcome.result === "failed" ? laneFailureCode(outcome.code) : null,
      refs,
      diff: {
        kind: "lane",
        decisionRevisions: writes.decisions?.count ?? 0,
        commits: writes.commits?.count ?? 0,
        proposals: proposals.map((range) => ({ kind: range.kind, count: range.count })),
      },
    },
    recordedAt,
  );
  // The builder drops a reference outside the closed patterns (an epoch or a
  // position of another shape); a lane record that lost one would count rows
  // it no longer names, so it is refused instead.
  if ((JSON.parse(row.refs_json) as string[]).length !== refs.length)
    throw new AuditRecordError("refs_json");
  return row;
}
