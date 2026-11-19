// What waits for the owner's decision (issue #1414, gap G9 of
// docs/plans/2026-11-mcp-everyday-questions.md, ADR 0126): one compact line
// per kind of open proposal, each with how many there are, the first few ids,
// the oldest proposal time where one is recorded, and the page and tool that
// handle it. The ホーム page (`GET /api/v2/decisions/pending`) and an agent
// (`kogane.decisions.pending`) both call `readPendingDecisions` and nothing
// else, so a page and an agent read one answer (ADR 0081 point 2).
//
// It reads, and nothing else. It decides nothing, proposes nothing and
// changes no state (INV07): every line points at the read that shows the
// items and at the path that decides them.
//
// - The grant decides. `records.read` over the whole store, as the candidate
//   reads it counts: a narrowed grant is refused before anything is read.
//   The survey line also needs `schedules.read` and counts only the grant's
//   `scheduleSources`, as the survey read does.
// - Each line counts its own list's items. The account and instrument lines
//   run their reviews' own bounded reads and view filters
//   (`accountCandidateView`, `instrumentCandidateView`); the others are the
//   SQL below, each reaching rows by key or by one bounded index range, and
//   the card settlement lines one pass over the candidates, as the カード照合
//   list's statement page makes (docs/card-settlements.md, Cost).
// - Bounded. A line whose own read is refused past its bounds says so
//   (`unavailable`, `budget_exceeded`); the other lines still answer. The
//   index-range lines count at most `PENDING_DECISIONS_COUNT_BOUND` rows and
//   say when more exist (`complete: false`). At most
//   `PENDING_DECISIONS_IDS_SHOWN` ids and `PENDING_DECISIONS_ID_BYTES` bytes
//   of ids per line, so the answer stays under `PENDING_DECISIONS_MAX_BYTES`.
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import {
  PENDING_DECISION_HANDLERS,
  PENDING_DECISIONS_COUNT_BOUND,
  PENDING_DECISIONS_ID_BYTES,
  PENDING_DECISIONS_IDS_SHOWN,
  PENDING_DECISIONS_MAX_BYTES,
  PENDING_DECISIONS_NOT_COVERED,
  type PendingDecisionKind,
  type PendingDecisionLine,
  type PendingDecisions,
  type PendingDecisionUnavailable,
} from "../../../domain/src/pending-decisions.ts";
import { AccountCandidateLimitError } from "../../../domain/src/account-candidates.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type Grant, grantAllows } from "../grants.ts";
import { accountCandidateView, queryAccountCandidates } from "./account-candidates.ts";
import {
  boundedInstrumentResolution,
  instrumentCandidateView,
} from "./instrument-candidates-review.ts";

export {
  PENDING_DECISION_HANDLERS,
  PENDING_DECISIONS_COUNT_BOUND,
  PENDING_DECISIONS_ID_BYTES,
  PENDING_DECISIONS_IDS_SHOWN,
  PENDING_DECISIONS_MAX_BYTES,
  PENDING_DECISIONS_NOT_COVERED,
  type PendingDecisionKind,
  type PendingDecisionLine,
  type PendingDecisions,
};

const REQUEST_ID = "decisions.pending";

/** How long a plan may live (plan.ts `PLAN_TTL_SECONDS_MAX`): older plans are expired. */
const PLAN_LIFETIME_MAX_MS = 24 * 60 * 60 * 1000;

export type PendingDecisionsOutcome =
  | { ok: true; answer: PendingDecisions }
  | { ok: false; error: FinancialError };

/** What this deployment serves: a line whose page and tool are absent is `not_served`. */
export interface PendingDecisionsServed {
  /** The カード照合 views (`cardSettlementsAvailable`). */
  cardSettlements: boolean;
  /** Card purchase recognition (`cardPurchasesAvailable`). */
  cardPurchases: boolean;
  /** The schedule settings routes (`SCHEDULES_ENABLED`). */
  schedules: boolean;
  /** The change lifecycle routes (`COMMANDS_ENABLED`). */
  commands: boolean;
}

/** One waiting row of a SQL line: an id, its time and the line's count and oldest time. */
interface WaitingRow {
  id: string;
  total: number;
  oldest: string | null;
}

/**
 * The candidates no decision names (migration 0044 allows no other way to be
 * proposed), each with its statement; the statements among them with no live
 * acceptance (their newest decision `accepted`, by the decision key). One
 * pass over the candidates, each decision by `(proposal_id, revision)`, and
 * each statement's candidates by `card_settlement_candidates_statement`.
 */
const WAITING_STATEMENTS_CTES = `undecided AS MATERIALIZED (
 SELECT c.id,c.statement_key,c.created_at FROM card_settlement_candidates c
 WHERE NOT EXISTS(SELECT 1 FROM card_settlement_decisions d WHERE d.proposal_id=c.id)
), undecided_statements AS MATERIALIZED (
 SELECT statement_key,min(created_at) AS oldest FROM undecided GROUP BY statement_key
), waiting_statements AS MATERIALIZED (
 SELECT s.statement_key,s.oldest FROM undecided_statements s
 WHERE NOT EXISTS(SELECT 1 FROM card_settlement_candidates a WHERE a.statement_key=s.statement_key
  AND (SELECT d.status FROM card_settlement_decisions d WHERE d.proposal_id=a.id
   ORDER BY d.revision DESC LIMIT 1)='accepted')
)`;

/**
 * `card-settlement.statement`: each statement with an undecided candidate
 * and no live acceptance, newest undecided candidate first; its id is that
 * candidate. `?1` the ids shown.
 */
export const PENDING_CARD_SETTLEMENTS_SQL = `WITH ${WAITING_STATEMENTS_CTES}, leads AS MATERIALIZED (
 SELECT id,created_at FROM (
  SELECT u.id,u.created_at,row_number() OVER (PARTITION BY u.statement_key ORDER BY u.created_at DESC,u.id DESC) AS position
  FROM undecided u JOIN waiting_statements w ON w.statement_key=u.statement_key
 ) WHERE position=1
)
SELECT id,(SELECT count(*) FROM waiting_statements) AS total,
 (SELECT min(oldest) FROM waiting_statements) AS oldest
FROM leads ORDER BY created_at DESC,id DESC LIMIT ?1`;

/**
 * `card-ownership.account`: each account an undecided candidate of a
 * waiting statement resolved (the card's for `liable_party`, the bank's for
 * `beneficial_owner`; an account id the facts state as text, as a valid
 * candidate's facts do) that holds no current accepted ownership claim in that
 * role: an accepted relation whose decision is live and that no later
 * decision of the same owner, through either alias of the account, replaced
 * (as the ownership review reads claims, card-ownership.ts). Claims are found
 * by `entity_relations_from (kind, from_ref)`. Its id is the newest undecided
 * candidate naming it, whose ownership review shows the account; ids repeat
 * no candidate. `?1` the ids shown.
 */
export const PENDING_CARD_OWNERSHIP_SQL = `WITH ${WAITING_STATEMENTS_CTES}, sides AS MATERIALIZED (
 SELECT 'liable_party' AS role,json_extract(c.facts_json,'$.statement.accountId') AS account_id,u.id,u.created_at
 FROM undecided u JOIN waiting_statements w ON w.statement_key=u.statement_key JOIN card_settlement_candidates c ON c.id=u.id
 UNION ALL
 SELECT 'beneficial_owner',json_extract(c.facts_json,'$.bankDebit.accountId'),u.id,u.created_at
 FROM undecided u JOIN waiting_statements w ON w.statement_key=u.statement_key JOIN card_settlement_candidates c ON c.id=u.id
), owned AS MATERIALIZED (
 SELECT DISTINCT a.role,a.account_id FROM (SELECT DISTINCT role,account_id FROM sides WHERE typeof(account_id)='text') a
 WHERE EXISTS(SELECT 1 FROM entity_relations r JOIN decision_revisions d ON d.id=r.decision_revision_id AND d.superseded_by IS NULL
  WHERE r.kind=a.role AND r.from_ref IN(a.account_id,'account:'||a.account_id) AND r.status='accepted'
  AND NOT EXISTS(SELECT 1 FROM entity_relations n WHERE n.kind=r.kind AND n.from_ref IN(a.account_id,'account:'||a.account_id)
   AND n.to_ref=r.to_ref AND n.rowid>r.rowid AND n.status<>'proposed'))
), waiting AS MATERIALIZED (
 SELECT s.role,s.account_id,min(s.created_at) AS oldest FROM sides s
 WHERE typeof(s.account_id)='text' AND NOT EXISTS(SELECT 1 FROM owned o WHERE o.role=s.role AND o.account_id=s.account_id)
 GROUP BY s.role,s.account_id
), ranked AS MATERIALIZED (
 SELECT s.id,s.created_at,row_number() OVER (PARTITION BY s.role,s.account_id ORDER BY s.created_at DESC,s.id DESC) AS position
 FROM sides s JOIN waiting w ON w.role=s.role AND w.account_id=s.account_id
), leads AS MATERIALIZED (
 SELECT id,max(created_at) AS newest FROM ranked WHERE position=1 GROUP BY id
)
SELECT id,(SELECT count(*) FROM waiting) AS total,(SELECT min(oldest) FROM waiting) AS oldest
FROM leads ORDER BY newest DESC,id DESC LIMIT ?1`;

/**
 * `pending-posted.link`: stage-B `pending_to_posted` proposals not yet
 * decided (a decision resolves the row, migration 0032), oldest first by
 * insertion, through `reconciliation_proposals_status (status, kind, stage)`.
 * `?1` the count bound plus one, `?2` the ids shown.
 */
export const PENDING_POSTED_LINKS_SQL = `WITH waiting AS MATERIALIZED (
 SELECT id,created_at,rowid AS position FROM reconciliation_proposals
 WHERE status='proposed' AND kind='pending_to_posted' AND stage='B' ORDER BY rowid LIMIT ?1
)
SELECT id,(SELECT count(*) FROM waiting) AS total,(SELECT min(created_at) FROM waiting) AS oldest
FROM waiting ORDER BY position LIMIT ?2`;

/**
 * `maintenance-survey.proposal`: survey proposals no decision names, of the
 * sources in `?3` (a JSON array, or NULL for every source), in id order as the
 * survey read lists them (services/processor maintenance-survey/decisions.ts);
 * each decision by its key. `?1` the count bound plus one, `?2` the ids shown.
 */
export const PENDING_SURVEY_PROPOSALS_SQL = `WITH waiting AS MATERIALIZED (
 SELECT p.id,p.created_at FROM maintenance_survey_proposals p
 WHERE NOT EXISTS(SELECT 1 FROM maintenance_survey_decisions d WHERE d.proposal_id=p.id)
  AND (?3 IS NULL OR p.source IN (SELECT value FROM json_each(?3)))
 ORDER BY p.id LIMIT ?1
)
SELECT CAST(id AS TEXT) AS id,(SELECT count(*) FROM waiting) AS total,
 (SELECT min(created_at) FROM waiting) AS oldest
FROM waiting ORDER BY waiting.id LIMIT ?2`;

/**
 * `change-plan.open`: plans `planned` or `approved` that have not expired at
 * `?4`, oldest first, through `change_plans_status (status, created_at)`
 * from `?3` (a plan lives at most 24 hours, so an older one has expired).
 * `?1` the count bound plus one, `?2` the ids shown.
 */
export const PENDING_CHANGE_PLANS_SQL = `WITH waiting AS MATERIALIZED (
 SELECT plan_id AS id,created_at FROM change_plans
 WHERE status IN ('planned','approved') AND created_at>=?3 AND expires_at>?4
 ORDER BY created_at,plan_id LIMIT ?1
)
SELECT id,(SELECT count(*) FROM waiting) AS total,(SELECT min(created_at) FROM waiting) AS oldest
FROM waiting ORDER BY created_at,id LIMIT ?2`;

/** The ids a line lists: at most `PENDING_DECISIONS_IDS_SHOWN`, within `PENDING_DECISIONS_ID_BYTES`. */
export function shownIds(ids: readonly string[]): string[] {
  const shown: string[] = [];
  let bytes = 0;
  for (const id of ids.slice(0, PENDING_DECISIONS_IDS_SHOWN)) {
    bytes += new TextEncoder().encode(id).length;
    if (bytes > PENDING_DECISIONS_ID_BYTES) break;
    shown.push(id);
  }
  return shown;
}

function counted(
  kind: PendingDecisionKind,
  count: number,
  complete: boolean,
  ids: readonly string[],
  oldestAt: string | null,
  timed: boolean,
): PendingDecisionLine {
  return {
    kind,
    state: "counted",
    reason: null,
    count,
    complete,
    ids: shownIds(ids),
    oldestAt: count === 0 ? null : oldestAt,
    timeBasis: timed ? "created" : "not_recorded",
    handler: PENDING_DECISION_HANDLERS[kind],
  };
}

function unavailable(
  kind: PendingDecisionKind,
  reason: PendingDecisionUnavailable,
  timed: boolean,
): PendingDecisionLine {
  return {
    kind,
    state: "unavailable",
    reason,
    count: null,
    complete: false,
    ids: [],
    oldestAt: null,
    timeBasis: timed ? "created" : "not_recorded",
    handler: PENDING_DECISION_HANDLERS[kind],
  };
}

/** A line read by one of the SQL texts above: rows of ids, each with the line's total. */
async function sqlLine(
  sql: SqlExecutor,
  kind: PendingDecisionKind,
  text: string,
  binds: readonly unknown[],
  bounded: boolean,
): Promise<PendingDecisionLine> {
  const rows = await sql.all<WaitingRow>(text, binds);
  const total = rows[0]?.total ?? 0;
  const over = bounded && total > PENDING_DECISIONS_COUNT_BOUND;
  return counted(
    kind,
    over ? PENDING_DECISIONS_COUNT_BOUND : total,
    !over,
    rows.map((row) => row.id),
    rows[0]?.oldest ?? null,
    true,
  );
}

/** The two account candidate lines, from one read of the candidate set. */
async function accountLines(sql: SqlExecutor): Promise<PendingDecisionLine[]> {
  const kinds = ["account-candidate.open", "account-candidate.held"] as const;
  try {
    const set = await queryAccountCandidates(sql);
    return kinds.map((kind) => {
      const items = accountCandidateView(set, kind === "account-candidate.open" ? "open" : "held");
      return counted(
        kind,
        items.length,
        true,
        items.map((item) => ("candidateId" in item ? item.candidateId : "")),
        null,
        false,
      );
    });
  } catch (error) {
    if (error instanceof AccountCandidateLimitError)
      return kinds.map((kind) => unavailable(kind, "budget_exceeded", false));
    throw error;
  }
}

/** The two instrument candidate lines, from one read of the resolution. */
async function instrumentLines(sql: SqlExecutor): Promise<PendingDecisionLine[]> {
  const kinds = ["instrument-candidate.open", "instrument-candidate.held"] as const;
  const read = await boundedInstrumentResolution(sql);
  if (!read.ok) return kinds.map((kind) => unavailable(kind, "budget_exceeded", false));
  return kinds.map((kind) => {
    const items = instrumentCandidateView(
      read.resolution,
      kind === "instrument-candidate.open" ? "open" : "held",
    );
    return counted(
      kind,
      items.length,
      true,
      items.map((item) => ("candidateId" in item ? item.candidateId : "")),
      null,
      false,
    );
  });
}

/**
 * The summary for one grant, or the typed refusal. The capability and
 * perimeter refusals are decided before the store is read.
 */
export async function readPendingDecisions(input: {
  grant: Grant;
  sql: SqlExecutor;
  served: PendingDecisionsServed;
  /** An ISO instant; the plans line counts plans unexpired at it. */
  now: string;
}): Promise<PendingDecisionsOutcome> {
  const { grant, sql, served, now } = input;
  const fail = (code: FinancialErrorCode, refs: string[]): PendingDecisionsOutcome => ({
    ok: false,
    error: financialError(code, REQUEST_ID, refs),
  });
  if (!grantAllows(grant, "records.read")) return fail("unauthorized", ["capability:records.read"]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) throw new RangeError("now is not an instant");
  const shown = PENDING_DECISIONS_IDS_SHOWN;
  const bound = PENDING_DECISIONS_COUNT_BOUND + 1;

  const lines: PendingDecisionLine[] = [];
  if (served.cardSettlements) {
    lines.push(
      await sqlLine(sql, "card-settlement.statement", PENDING_CARD_SETTLEMENTS_SQL, [shown], false),
      await sqlLine(sql, "card-ownership.account", PENDING_CARD_OWNERSHIP_SQL, [shown], false),
    );
  } else
    lines.push(
      unavailable("card-settlement.statement", "not_served", true),
      unavailable("card-ownership.account", "not_served", true),
    );
  lines.push(...(await accountLines(sql)), ...(await instrumentLines(sql)));
  lines.push(
    served.cardPurchases
      ? await sqlLine(sql, "pending-posted.link", PENDING_POSTED_LINKS_SQL, [bound, shown], true)
      : unavailable("pending-posted.link", "not_served", true),
  );
  const scheduleSources = grant.scopes.scheduleSources ?? [];
  lines.push(
    !served.schedules
      ? unavailable("maintenance-survey.proposal", "not_served", true)
      : !grantAllows(grant, "schedules.read")
        ? unavailable("maintenance-survey.proposal", "unauthorized", true)
        : await sqlLine(
            sql,
            "maintenance-survey.proposal",
            PENDING_SURVEY_PROPOSALS_SQL,
            [bound, shown, scheduleSources === "*" ? null : JSON.stringify([...scheduleSources])],
            true,
          ),
  );
  lines.push(
    served.commands
      ? await sqlLine(
          sql,
          "change-plan.open",
          PENDING_CHANGE_PLANS_SQL,
          [
            bound,
            shown,
            new Date(instant - PLAN_LIFETIME_MAX_MS).toISOString(),
            new Date(instant).toISOString(),
          ],
          true,
        )
      : unavailable("change-plan.open", "not_served", true),
  );
  return {
    ok: true,
    answer: {
      schemaVersion: "kogane-pending-decisions-v1",
      asOf: new Date(instant).toISOString(),
      bounds: {
        idsShown: PENDING_DECISIONS_IDS_SHOWN,
        idBytes: PENDING_DECISIONS_ID_BYTES,
        countBound: PENDING_DECISIONS_COUNT_BOUND,
        maxBytes: PENDING_DECISIONS_MAX_BYTES,
      },
      kinds: lines,
      notCovered: PENDING_DECISIONS_NOT_COVERED,
      decisions: "elsewhere",
    },
  };
}
