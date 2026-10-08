// What the schedule page reads of the survey, and the operator's decision on
// one proposal (ADR 0050). Accepting is the only way a survey reading reaches
// the maintenance rules, and it goes through the maintenance writer with the
// writer's own version check: this module never writes a rule itself.
import { z } from "zod";
import {
  PROPOSAL_REASONS,
  SURVEY_FAILURE_CODES,
  type MaintenanceSurveyProposalView,
  type MaintenanceSurveyView,
  type ProposalKind,
  type ProposalReason,
  type SurveyFailureCode,
} from "../../../../packages/collection/src/maintenance-survey-model.ts";
import type {
  MaintenancePattern,
  MaintenanceRule,
} from "../../../../packages/collection/src/schedule-model.ts";
import {
  fetchable,
  loadSurveyConfig,
  maintenanceSurveyEnabled,
  type SurveyConfig,
} from "./config.ts";

/**
 * The slice of a maintenance revision write an accepted proposal makes. It is
 * the narrowest form of `MaintenanceWrite` (#560, ADR 0046): an operator, a
 * named rule (new rules get an id derived from the proposal), the proposal's
 * page and fetch time as provenance, and the proposal as the decision
 * reference. `writeMaintenanceRevision(env, MaintenanceWrite)` accepts it as
 * it is, and answers a `MaintenanceWriteResult`, which `RevisionResult`
 * covers.
 */
export interface RevisionWrite {
  source: string;
  ruleId: string;
  expectedRevision: number;
  change: {
    timezone: string;
    pattern: MaintenancePattern;
    enabled: boolean;
    scope: MaintenanceRule["scope"];
  };
  provenance: { referenceUrl: string; verifiedAt: string; decisionRef: string };
  actor: { kind: "operator"; id: string };
  reason: string;
}
export type RevisionResult =
  | { ok: true; ruleId: string; revision: number; reconciled: boolean }
  | { ok: false; code: string; status: number };
/** The version-checked maintenance writer; the only path from a proposal to a rule. */
export type MaintenanceRevisionWriter = (env: Env, write: RevisionWrite) => Promise<RevisionResult>;

/** The reason an accepted proposal's revision carries: a closed code, never page text. */
export const ACCEPTED_REASON = "maintenance-survey-proposal-accepted";
/** The decision reference of the revision a proposal's acceptance writes. */
export function proposalRef(id: number): string {
  return `maintenance-survey:proposal:${id}`;
}
/** The id a `new` proposal's rule is created under (the survey view repeats it in SQL). */
export function proposedRuleId(source: string, id: number): string {
  return `${source}-survey-${id}`;
}

const decisionSchema = z.strictObject({ decision: z.enum(["accept", "reject"]) });

interface ProposalRow {
  id: number;
  target_id: string;
  source: string;
  kind: ProposalKind;
  rule_id: string | null;
  base_revision: number;
  timezone: string;
  pattern_json: string;
  enabled: number;
  scope: MaintenanceRule["scope"];
  status: "proposed" | "review_pending";
  reasons_json: string;
  created_at: string;
  url: string;
  fetched_at: string;
  sha256: string;
}

function refuse(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

/**
 * Accept or reject one undecided proposal, as `actor` (an operator the App
 * resolved). Rejecting records the decision and changes nothing else.
 * Accepting asks the writer for the revision the proposal describes, against
 * the rule revision the proposal was read against; a rule that moved since
 * answers the writer's `revision_conflict`, and the proposal stays undecided.
 * Only after the writer saved the revision is the acceptance recorded, with
 * the revision it produced.
 */
export async function decideSurveyProposal(
  env: Env,
  id: number,
  value: unknown,
  actor: string,
  writer: MaintenanceRevisionWriter,
): Promise<Response> {
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) return refuse("invalid_request", 400);
  const row = await env.DB.prepare(
    `SELECT p.*,f.url,f.fetched_at,f.sha256,d.decision FROM maintenance_survey_proposals p
     JOIN maintenance_survey_fetches f ON f.id=p.fetch_id
     LEFT JOIN maintenance_survey_decisions d ON d.proposal_id=p.id WHERE p.id=?`,
  )
    .bind(id)
    .first<ProposalRow & { decision: string | null }>();
  if (!row) return refuse("proposal_not_found", 404);
  if (row.decision !== null) return refuse("proposal_already_decided", 409);
  const decidedAt = new Date().toISOString();
  if (parsed.data.decision === "reject") {
    const rejected = await env.DB.prepare(
      `INSERT INTO maintenance_survey_decisions(proposal_id,decision,actor,decided_at)
       SELECT ?,'rejected',?,? WHERE NOT EXISTS(SELECT 1 FROM maintenance_survey_decisions WHERE proposal_id=?)`,
    )
      .bind(id, actor, decidedAt, id)
      .run();
    return rejected.meta.changes === 1
      ? Response.json({ decided: "rejected" })
      : refuse("proposal_already_decided", 409);
  }
  const saved = await writer(env, {
    source: row.source,
    ruleId: row.rule_id ?? proposedRuleId(row.source, row.id),
    expectedRevision: row.base_revision,
    change: {
      timezone: row.timezone,
      pattern: JSON.parse(row.pattern_json) as MaintenancePattern,
      enabled: row.enabled === 1,
      scope: row.scope,
    },
    provenance: {
      referenceUrl: row.url,
      verifiedAt: row.fetched_at,
      decisionRef: proposalRef(row.id),
    },
    actor: { kind: "operator", id: actor },
    reason: ACCEPTED_REASON,
  });
  if (!saved.ok) return refuse(saved.code, saved.status);
  let recorded: D1Result;
  try {
    recorded = await env.DB.prepare(
      `INSERT INTO maintenance_survey_decisions(proposal_id,decision,actor,decided_at,rule_id,rule_revision)
       SELECT ?,'accepted',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM maintenance_survey_decisions WHERE proposal_id=?)`,
    )
      .bind(id, actor, decidedAt, saved.ruleId, saved.revision, id)
      .run();
  } catch {
    // The revision stands; the proposal now reads as outdated and can be rejected.
    return refuse("decision_record_failed", 503);
  }
  if (recorded.meta.changes !== 1) return refuse("proposal_already_decided", 409);
  return Response.json({
    decided: "accepted",
    ruleId: saved.ruleId,
    revision: saved.revision,
    reservation: saved.reconciled ? "armed" : "pending",
  });
}

interface CursorRow {
  target_id: string;
  next_due_at: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_code: string | null;
  consecutive_failures: number;
  last_changed_at: string | null;
}
/** Undecided proposals shown at most; `attention` still counts all of them. */
const PROPOSALS_SHOWN = 200;

function closedReasons(json: string): ProposalReason[] {
  const values = JSON.parse(json) as unknown[];
  return PROPOSAL_REASONS.filter((r) => values.includes(r));
}

/** Read-only: each allowlisted page's freshness and the undecided proposals. */
export async function maintenanceSurveyView(
  env: Env,
  now: number,
  config: SurveyConfig = loadSurveyConfig(),
): Promise<MaintenanceSurveyView> {
  const db = env.DB;
  const laneEnabled = maintenanceSurveyEnabled(env);
  const [cursorRows, proposalRows, countRows] = await db.batch<unknown>([
    db.prepare("SELECT * FROM maintenance_survey_cursors"),
    db
      .prepare(
        `SELECT p.*,f.url,f.fetched_at,f.sha256,
          (SELECT MAX(r.revision) FROM provider_maintenance_rules r
            WHERE r.id=COALESCE(p.rule_id,p.source||'-survey-'||p.id)) AS current_revision
         FROM maintenance_survey_proposals p JOIN maintenance_survey_fetches f ON f.id=p.fetch_id
         WHERE NOT EXISTS(SELECT 1 FROM maintenance_survey_decisions d WHERE d.proposal_id=p.id)
         ORDER BY p.id LIMIT ?`,
      )
      .bind(PROPOSALS_SHOWN),
    db.prepare(
      `SELECT count(*) AS n FROM maintenance_survey_proposals p
       WHERE NOT EXISTS(SELECT 1 FROM maintenance_survey_decisions d WHERE d.proposal_id=p.id)`,
    ),
  ]);
  const cursors = (cursorRows?.results ?? []) as CursorRow[];
  const proposals = (proposalRows?.results ?? []) as (ProposalRow & {
    current_revision: number | null;
  })[];
  const attention = ((countRows?.results ?? []) as { n: number }[])[0]?.n ?? 0;
  return {
    enabled: laneEnabled,
    targets: config.targets.map((t) => {
      const c = cursors.find((row) => row.target_id === t.id);
      const enabled = laneEnabled && fetchable(t);
      const success = c?.last_success_at ? Date.parse(c.last_success_at) : null;
      const failure = (SURVEY_FAILURE_CODES as readonly string[]).includes(
        c?.last_failure_code ?? "",
      )
        ? (c!.last_failure_code as SurveyFailureCode)
        : null;
      return {
        id: t.id,
        source: t.source,
        url: t.url,
        scope: t.scope,
        cadenceHours: t.cadenceHours,
        fetch: t.fetch,
        terms: t.terms,
        freshness: !enabled
          ? "disabled"
          : success === null
            ? "never"
            : now - success > 2 * t.cadenceHours * 3_600_000
              ? "stale"
              : "fresh",
        nextDueAt: enabled ? (c?.next_due_at ?? null) : null,
        lastAttemptAt: c?.last_attempt_at ?? null,
        lastSuccessAt: c?.last_success_at ?? null,
        lastFailureAt: c?.last_failure_at ?? null,
        lastFailureCode: failure,
        consecutiveFailures: c?.consecutive_failures ?? 0,
        lastChangedAt: c?.last_changed_at ?? null,
      };
    }),
    proposals: proposals.map((p): MaintenanceSurveyProposalView => ({
      id: p.id,
      targetId: p.target_id,
      source: p.source,
      kind: p.kind,
      ruleId: p.rule_id,
      baseRevision: p.base_revision,
      // A new proposal is current while its rule (`proposedRuleId`, the
      // COALESCE above) does not exist; once the writer created it, even if
      // the acceptance row then failed, it is not.
      current: (p.current_revision ?? 0) === p.base_revision,
      timezone: p.timezone,
      pattern: JSON.parse(p.pattern_json) as MaintenancePattern,
      enabled: p.enabled === 1,
      scope: p.scope,
      status: p.status,
      reasons: closedReasons(p.reasons_json),
      referenceUrl: p.url,
      fetchedAt: p.fetched_at,
      sha256: p.sha256,
      createdAt: p.created_at,
    })),
    attention,
  };
}
