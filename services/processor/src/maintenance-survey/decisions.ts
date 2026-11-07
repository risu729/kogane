// What the schedule page reads of the survey, and the operator's decision on
// one proposal (ADR 0050). Accepting is the only way a survey reading reaches
// the maintenance rules, and it goes through the maintenance writer with the
// writer's own version check: this module never writes a rule itself.
import { z } from "zod";
import {
  OPERATOR_ONLY_PROPOSAL_REASONS,
  PROPOSAL_REASONS,
  SURVEY_FAILURE_CODES,
  type MaintenanceSurveyProposalView,
  type MaintenanceSurveyView,
  type ProposalKind,
  type ProposalReason,
  type SurveyFailureCode,
} from "../../../../packages/collection/src/maintenance-survey-model.ts";
import type {
  MaintenanceChangeReason,
  MaintenancePattern,
  MaintenanceRule,
} from "../../../../packages/collection/src/schedule-model.ts";
import {
  fetchable,
  loadSurveyConfig,
  maintenanceSurveyEnabled,
  type SurveyConfig,
} from "./config.ts";
import {
  OPERATOR_ONLY_HEADER,
  type OperationCall,
  type RevisionField,
} from "../../../../packages/application/src/index.ts";
import { operatorOnlyAcceptance } from "./diff.ts";
import type { SqlWrite } from "../../../../packages/storage-d1/src/core/operations.ts";

/**
 * The slice of a maintenance revision write an accepted proposal makes. It is
 * the narrowest form of `MaintenanceWrite` (#560, ADR 0046): an operator, a
 * named rule (new rules get an id derived from the proposal), the proposal's
 * page and fetch time as provenance, the proposal as the decision reference
 * and the closed acceptance reason, which CORE 0078 stores. The proposal
 * route passes `writeMaintenanceRevision(env, MaintenanceWrite, append)`
 * itself: it accepts this write as it is, and answers a
 * `MaintenanceWriteResult`, which `RevisionResult` covers.
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
  /** The operator, or a principal the owner delegated (`mcp-client:<sub>`). */
  actor: { kind: "operator" | "delegated"; id: string };
  reason: typeof ACCEPTED_REASON;
}
/** The proposal an acceptance writes, as the trusted writer options name it. */
interface AcceptedProposal {
  id: number;
  ruleId: string;
}
export type RevisionResult =
  | { ok: true; ruleId: string; revision: number; reconciled: boolean }
  | { ok: false; code: string; status: number };
/** The revision a writer is about to send, as the decision that asked for it sees it. */
export interface SavedRevision {
  ruleId: string;
  revision: number;
  /** The revision the change was made against. */
  previous: number;
  /** The names of the rule's fields this revision changes; never their values. */
  fields: RevisionField[];
  /** The canonical digest of the revision as validated; never the values themselves. */
  payloadDigest: string;
  /** The revision's closed reason code. */
  reason: MaintenanceChangeReason;
  /** A boolean SQL guard that holds exactly when the batch wrote this revision. */
  guard: SqlWrite;
}
/** Statements a decision appends to the revision's own batch, and what to do with their results. */
export interface RevisionAppend {
  statements: D1PreparedStatement[];
  settle(results: readonly D1Result[]): void;
}
/**
 * The version-checked maintenance writer; the only path from a proposal to a
 * rule. `append` adds the decision's own statements to the revision's batch,
 * so the revision and the decision are one write (ADR 0064).
 */
export type MaintenanceRevisionWriter<O = never> = (
  env: Env,
  write: RevisionWrite,
  append: (saved: SavedRevision) => RevisionAppend,
  options?: O,
) => Promise<RevisionResult>;
/** What a delegated acceptance's prepare learns from the writer's validation chain. */
type RevisionPrepareResult =
  | {
      ok: true;
      currentRevision: number;
      deferralClass: "within-7d" | "within-31d" | "beyond-31d";
      budgetRemaining: number | null;
    }
  | { ok: false; code: string; status: number };
/** The writer's validation chain without the write (`prepareMaintenanceRevision`). */
type MaintenanceRevisionPreparer<O> = (
  env: Env,
  write: RevisionWrite,
  options?: O,
) => Promise<RevisionPrepareResult>;

/**
 * A decision by a delegated principal, as the private route
 * (`delegated-survey.ts`) has verified it: the attenuated source, the step,
 * and for an acceptance the expected base revision and the audit record the
 * revision cites. The decision row and the revision name `actor`.
 */
export interface DelegatedSurveyDecision<O> {
  /** The schedule source the delegation was attenuated to; another source's proposal is not found. */
  source: string;
  /** `apply` rejects (R1); `prepare` and `confirm` accept (R2). */
  step: "apply" | "prepare" | "confirm";
  /** Accept only: the proposal's base revision the caller decided on. */
  baseRevision?: number;
  /** Accept only: `delegated-audit:aud_<uuid>`, the prepare record a confirm cites. */
  decisionRef?: string;
  /**
   * Accept: the writer's trusted options for this proposal, which only the
   * private route constructs (`MaintenanceWriteOptions`); this module never
   * names a bound.
   */
  writerOptions?: (proposal: AcceptedProposal) => O;
  /** Accept prepare: the writer's chain without the write. */
  prepare?: MaintenanceRevisionPreparer<O>;
  /** A batch that raised: the delegation's closed refusal it stands for, if any. */
  batchFailure?: () => Promise<Response | null>;
  /** Accept: the source's current rules (latest revision of each), read at each step. */
  rules?: (source: string) => Promise<readonly MaintenanceRule[]>;
}

/**
 * The reason an accepted proposal's revision carries: a closed code of
 * `MAINTENANCE_CHANGE_REASONS`, never page text.
 */
export const ACCEPTED_REASON =
  "maintenance-survey-proposal-accepted" satisfies MaintenanceChangeReason;
/** The reason code of a rejection's audit record. */
export const REJECTED_REASON = "maintenance-survey-proposal-rejected";
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
/** An acceptance the owner kept with the operator (R3), marked so the App records it so. */
function operatorOnly(): Response {
  return Response.json(
    { error: "operation_not_delegable" },
    { status: 403, headers: { [OPERATOR_ONLY_HEADER]: "1" } },
  );
}

/**
 * Accept or reject one undecided proposal, as `actor` (an operator the App
 * resolved). Rejecting records the decision and changes nothing else.
 * Accepting asks the writer for the revision the proposal describes, against
 * the rule revision the proposal was read against; a rule that moved since
 * answers the writer's `revision_conflict`, and the proposal stays undecided.
 * The acceptance row, with the revision it produced, and the audit record
 * are sent in the revision's own batch: the revision, the decision and the
 * record exist together or not at all (ADR 0064), and a proposal decided by
 * someone else in between rolls the revision back with them.
 */
export async function decideSurveyProposal<O = never>(
  env: Env,
  id: number,
  value: unknown,
  actor: string,
  writer: MaintenanceRevisionWriter<O>,
  audit: OperationCall,
  delegated?: DelegatedSurveyDecision<O>,
): Promise<Response> {
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) return refuse("invalid_request", 400);
  // Reject is the direct step and accept the two-step one, never the other way.
  if (delegated && (parsed.data.decision === "reject") !== (delegated.step === "apply"))
    return refuse("invalid_request", 400);
  const row = await env.DB.prepare(
    `SELECT p.*,f.url,f.fetched_at,f.sha256,d.decision FROM maintenance_survey_proposals p
     JOIN maintenance_survey_fetches f ON f.id=p.fetch_id
     LEFT JOIN maintenance_survey_decisions d ON d.proposal_id=p.id WHERE p.id=?`,
  )
    .bind(id)
    .first<ProposalRow & { decision: string | null }>();
  // A proposal of a source outside the delegation answers exactly like one that
  // does not exist, before anything else about it is said.
  if (!row || (delegated && row.source !== delegated.source))
    return refuse("proposal_not_found", 404);
  if (row.decision !== null) return refuse("proposal_already_decided", 409);
  const decidedAt = new Date().toISOString();
  const target = `maintenance-survey-proposal:${id}`;
  if (parsed.data.decision === "reject") {
    // A rejection changes no rule: R1 (plan section 5, W5).
    audit.setRisk("R1");
    const record = audit.effect(
      {
        targetRef: target,
        scope: { namespace: "schedule-source", source: row.source },
        reasonCode: REJECTED_REASON,
        diff: { kind: "none" },
      },
      {
        sql: "EXISTS(SELECT 1 FROM maintenance_survey_decisions WHERE proposal_id=? AND decision='rejected' AND actor=? AND decided_at=?)",
        binds: [id, actor, decidedAt],
      },
      { kind: "target" },
    );
    let rejected: D1Result | undefined, recorded: D1Result | undefined;
    try {
      [rejected, recorded] = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO maintenance_survey_decisions(proposal_id,decision,actor,decided_at)
       SELECT ?,'rejected',?,? WHERE NOT EXISTS(SELECT 1 FROM maintenance_survey_decisions WHERE proposal_id=?)`,
        ).bind(id, actor, decidedAt, id),
        env.DB.prepare(record.sql).bind(...record.binds),
      ]);
    } catch (error) {
      // A delegated record's guard (budget, expiry) raised: nothing was written.
      const refusal = delegated?.batchFailure ? await delegated.batchFailure() : null;
      if (refusal) return refusal;
      throw error;
    }
    audit.settle(recorded?.meta.changes);
    return rejected?.meta.changes === 1
      ? Response.json({ decided: "rejected" })
      : refuse("proposal_already_decided", 409);
  }
  if (delegated) {
    if (row.base_revision !== delegated.baseRevision) return refuse("revision_conflict", 409);
    // The owner kept these acceptances with the operator (R3): refused at
    // prepare and at confirm, whatever else holds.
    const reasons = closedReasons(row.reasons_json);
    if (reasons.some((r) => (OPERATOR_ONLY_PROPOSAL_REASONS as readonly string[]).includes(r)))
      return operatorOnly();
  }
  const ruleId = row.rule_id ?? proposedRuleId(row.source, row.id);
  const write: RevisionWrite = {
    source: row.source,
    ruleId,
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
      decisionRef: delegated?.decisionRef ?? proposalRef(row.id),
    },
    actor: { kind: delegated ? "delegated" : "operator", id: actor },
    reason: ACCEPTED_REASON,
  };
  const options = delegated?.writerOptions?.({ id: row.id, ruleId });
  if (delegated && (options === undefined || !delegated.rules))
    return refuse("scheduling_unavailable", 503);
  // The same reservation against the rules as they stand now: a disable, a
  // re-enable, or a rule beside another one it overlaps, whatever the reasons
  // recorded when the page was read.
  if (
    delegated?.rules &&
    operatorOnlyAcceptance(write.change, ruleId, await delegated.rules(row.source))
  )
    return operatorOnly();
  if (delegated?.step === "prepare") {
    if (!delegated.prepare) return refuse("scheduling_unavailable", 503);
    const checked = await delegated.prepare(env, write, options);
    if (!checked.ok) return refuse(checked.code, checked.status);
    return Response.json({
      ok: true,
      proposalId: row.id,
      source: row.source,
      kind: row.kind,
      status: row.status,
      reasons: closedReasons(row.reasons_json),
      ruleId,
      baseRevision: row.base_revision,
      currentRevision: checked.currentRevision,
      change: write.change,
      deferralClass: checked.deferralClass,
      budgetRemaining: checked.budgetRemaining,
    });
  }
  const append = (revision: SavedRevision): RevisionAppend => {
    const ref = `maintenance-rule:${revision.ruleId}@${revision.revision}`;
    const record = audit.effect(
      {
        targetRef: target,
        refs: [ref],
        scope: { namespace: "schedule-source", source: row.source },
        reasonCode: ACCEPTED_REASON,
        diff: {
          kind: "revision",
          from: revision.previous,
          to: revision.revision,
          fields: revision.fields,
        },
      },
      {
        sql: `EXISTS(SELECT 1 FROM maintenance_survey_decisions WHERE proposal_id=? AND decision='accepted'
          AND actor=? AND decided_at=? AND rule_id=? AND rule_revision=?)`,
        binds: [id, actor, decidedAt, revision.ruleId, revision.revision],
      },
      { kind: "target" },
    );
    return {
      statements: [
        // A plain INSERT: a proposal another decision reached first raises on
        // the primary key and rolls the revision back with it.
        env.DB.prepare(
          `INSERT INTO maintenance_survey_decisions(proposal_id,decision,actor,decided_at,rule_id,rule_revision)
           SELECT ?,'accepted',?,?,?,? WHERE ${revision.guard.sql}`,
        ).bind(id, actor, decidedAt, revision.ruleId, revision.revision, ...revision.guard.binds),
        env.DB.prepare(record.sql).bind(...record.binds),
      ],
      settle: (results) => audit.settle(results[1]?.meta.changes),
    };
  };
  let saved: RevisionResult;
  try {
    saved = await writer(env, write, append, options);
  } catch {
    // A delegated record's guard (budget, expiry, a used confirmation) raised.
    const refusal = delegated?.batchFailure ? await delegated.batchFailure() : null;
    if (refusal) return refusal;
    // The batch raised and wrote nothing: the revision, the decision and the
    // record were rolled back together. A decision that now exists is the
    // reason; otherwise the store failed.
    const decided = await env.DB.prepare(
      "SELECT 1 AS decided FROM maintenance_survey_decisions WHERE proposal_id=?",
    )
      .bind(id)
      .first<{ decided: number }>()
      .catch(() => null);
    return decided
      ? refuse("proposal_already_decided", 409)
      : refuse("decision_record_failed", 503);
  }
  if (!saved.ok) return refuse(saved.code, saved.status);
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

/**
 * Read-only: each allowlisted page's freshness and the undecided proposals.
 * `sources` narrows the proposals and their count to those sources before the
 * bound on shown proposals applies (the agent read); omitted, every source.
 */
export async function maintenanceSurveyView(
  env: Env,
  now: number,
  config: SurveyConfig = loadSurveyConfig(),
  sources?: readonly string[],
): Promise<MaintenanceSurveyView> {
  const db = env.DB;
  const only = sources ? ` AND p.source IN (SELECT value FROM json_each(?))` : "";
  const onlyBinds = sources ? [JSON.stringify(sources)] : [];
  const laneEnabled = maintenanceSurveyEnabled(env);
  const [cursorRows, proposalRows, countRows] = await db.batch<unknown>([
    db.prepare("SELECT * FROM maintenance_survey_cursors"),
    db
      .prepare(
        `SELECT p.*,f.url,f.fetched_at,f.sha256,
          (SELECT MAX(r.revision) FROM provider_maintenance_rules r
            WHERE r.id=COALESCE(p.rule_id,p.source||'-survey-'||p.id)) AS current_revision
         FROM maintenance_survey_proposals p JOIN maintenance_survey_fetches f ON f.id=p.fetch_id
         WHERE NOT EXISTS(SELECT 1 FROM maintenance_survey_decisions d WHERE d.proposal_id=p.id)${only}
         ORDER BY p.id LIMIT ?`,
      )
      .bind(...onlyBinds, PROPOSALS_SHOWN),
    db
      .prepare(
        `SELECT count(*) AS n FROM maintenance_survey_proposals p
       WHERE NOT EXISTS(SELECT 1 FROM maintenance_survey_decisions d WHERE d.proposal_id=p.id)${only}`,
      )
      .bind(...onlyBinds),
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
