// One bounded read path for review UI. It never writes a financial decision.
import {
  cardSettlementEligible,
  cardSettlementImpact,
  validCardSettlementFacts,
  type CardSettlementStatus,
} from "../../../domain/src/card-settlement.ts";
import {
  CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS,
  type CardSettlementDebitAccountReview,
  type CardSettlementLeadSearch,
  type CardSettlementReview,
  type CardSettlementReviewPage,
  type CardSettlementStatementGroup,
  type CardSettlementStatementPage,
} from "../../../domain/src/card-settlement-review.ts";
import {
  CARD_DEBIT_ACCOUNT_POLICY,
  CARD_DEBIT_ACCOUNT_REASONS,
  type CardDebitAccountReason,
} from "../../../domain/src/card-debit-account.ts";
import { CARD_INFORMATION_READER_VERSION } from "../../../domain/src/myjcb-card-information.ts";
import { cardSettlementReadinessCtes } from "../../../read-model/src/card-settlement-readiness.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

export const CARD_SETTLEMENT_PAGE_SIZE = 50;
/** Statements per page of the grouped list. */
export const CARD_SETTLEMENT_STATEMENT_PAGE_SIZE = 10;
/** The newest candidates of each statement the grouped list judges. */
export const CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT = 5;
/**
 * The older candidates of a statement one pass of the grouped list's search
 * for a ready lead judges (ADR 0090).
 */
export const CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS = 50;
/**
 * The most older candidates of a statement the search judges on one read of
 * the grouped list, a whole number of passes (ADR 0090). A statement the
 * search leaves unfinished says so (`leadSearch: "truncated"`), so a page
 * load reads at most four more times however long the statements' histories
 * grow.
 */
export const CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED =
  4 * CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS;
const HISTORY_LIMIT = 20;
const STATEMENT_KEY_LIMIT = 1024;
interface ReviewRow {
  id: string;
  facts_json: string;
  revision: number;
  status: CardSettlementStatus;
  decision_revision_id: string | null;
  event_id: string | null;
  obligation_id: string | null;
  settlement_id: string | null;
  created_at: string;
  statement_current: number | null;
  bank_current: number | null;
  ownership_current: number | null;
  allocation_available: number | null;
  /** Only the grouped list's read selects it. */
  statement_key?: string;
}
interface StatementRow {
  statement_key: string;
  candidate_count: number;
}
interface HistoryRow {
  proposal_id: string;
  revision: number;
  status: Exclude<CardSettlementStatus, "proposed">;
  decision_revision_id: string;
  created_at: string;
}

/**
 * One chosen candidate's evidence row (all its columns NULL when it has none)
 * and the refusal code of its own statement page's reading (NULL when the
 * page has no refused reading under the current reader version).
 */
interface DebitAccountRow {
  candidate_id: string;
  statement_id: number | null;
  reader_version: string | null;
  outcome: string | null;
  reason: string | null;
  proposal_json: string | null;
  created_at: string | null;
  refusal_code: string | null;
}

/**
 * What the card provider's statement of its debit account says about each
 * chosen candidate (`?1` a JSON array of candidate ids), under policy `?2` and
 * reader version `?3`:
 *
 * - the newest `card_settlement_debit_account_evidence` row under the policy
 *   whose cited `card_debit_account_statement` reading was made under the
 *   reader version. The version is a condition of the choice, so a later row
 *   citing an earlier reader's reading neither wins nor hides an earlier row
 *   citing a current one. Found through
 *   `card_settlement_debit_account_evidence_candidate`
 *   (candidate_id, statement_id, policy, id) and the reading's key;
 * - the refusal code of the reading of the candidate's own statement page
 *   (the raw object its statement parse run read, its card) under the reader
 *   version, found through the parse run's and artifact's keys and the
 *   reading's unique `(raw_sha256, card_source_account, reader_version)` key.
 *   The sweep cites only `read` readings, so a refused page has no evidence
 *   row of its own.
 *
 * One row per chosen candidate. A list page holds at most 50 candidates and a
 * grouped page its ten statements' five newest and accepted ones and at most
 * one older ready one each (ADR 0090), each with a row per changed outcome.
 */
export const CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL = `WITH chosen AS MATERIALIZED (
 SELECT c.id,c.statement_parse_run_id,json_extract(c.facts_json,'$.statement.sourceAccount') AS card_source_account,
  (SELECT e.id FROM card_settlement_debit_account_evidence e
   JOIN card_debit_account_statement cited ON cited.id=e.statement_id AND cited.reader_version=?3
   WHERE e.candidate_id=c.id AND e.policy=?2 ORDER BY e.id DESC LIMIT 1) AS evidence_id
 FROM json_each(?1) selected JOIN card_settlement_candidates c ON c.id=selected.value
)
SELECT chosen.id AS candidate_id,e.statement_id,s.reader_version,e.outcome,e.reason,e.proposal_json,e.created_at,
 (SELECT r.refusal_code FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
  JOIN card_debit_account_statement r ON r.raw_sha256=a.sha256
   AND r.card_source_account=chosen.card_source_account AND r.reader_version=?3
  WHERE p.id=chosen.statement_parse_run_id AND r.outcome='refused') AS refusal_code
FROM chosen LEFT JOIN card_settlement_debit_account_evidence e ON e.id=chosen.evidence_id
LEFT JOIN card_debit_account_statement s ON s.id=e.statement_id`;

const reasonCode = (value: unknown): value is CardDebitAccountReason =>
  (CARD_DEBIT_ACCOUNT_REASONS as readonly unknown[]).includes(value);

const refusalCode = (
  value: unknown,
): value is (typeof CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS)[number] =>
  (CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS as readonly unknown[]).includes(value);

/**
 * The candidate's evidence row if it has one; else, when the lane refused its
 * statement page under the current reader version, `absent` with the lane's
 * refusal code; else null (the caller's `absentDebitAccount` stands). A
 * malformed row or an unknown refusal code is an unavailable answer, never a
 * missing one.
 */
function debitAccountReview(row: DebitAccountRow): CardSettlementDebitAccountReview | null {
  const invalid = () => new Error("card_settlement_debit_account_evidence_invalid");
  if (row.outcome === null) {
    if (row.refusal_code === null) return null;
    if (!refusalCode(row.refusal_code)) throw invalid();
    return {
      outcome: "absent",
      reason: row.refusal_code,
      policy: CARD_DEBIT_ACCOUNT_POLICY,
      statementRef: null,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
      recordedAt: null,
    };
  }
  if (row.statement_id === null || row.reader_version === null || row.created_at === null)
    throw invalid();
  const statementRef = {
    kind: "typed-claim" as const,
    id: `card_debit_account_statement:${row.statement_id}`,
    revision: `reader:${row.reader_version}`,
  };
  const base = { policy: CARD_DEBIT_ACCOUNT_POLICY, statementRef, recordedAt: row.created_at };
  if (row.outcome === "not_proposed") {
    if (!reasonCode(row.reason) || row.proposal_json !== null) throw invalid();
    return {
      ...base,
      outcome: "not_proposed",
      reason: row.reason,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
    };
  }
  if (row.outcome !== "supports" && row.outcome !== "names_other_account") throw invalid();
  if (row.reason !== null || row.proposal_json === null) throw invalid();
  const proposal: unknown = JSON.parse(row.proposal_json);
  if (
    proposal === null ||
    typeof proposal !== "object" ||
    !("bankSourceId" in proposal) ||
    !("bankSourceAccount" in proposal) ||
    !("visibleDigitCount" in proposal) ||
    typeof proposal.bankSourceId !== "string" ||
    typeof proposal.bankSourceAccount !== "string" ||
    typeof proposal.visibleDigitCount !== "number" ||
    !Number.isSafeInteger(proposal.visibleDigitCount) ||
    proposal.visibleDigitCount < 1
  )
    throw invalid();
  return {
    ...base,
    outcome: row.outcome,
    reason: null,
    bankSourceId: proposal.bankSourceId,
    bankSourceAccount: proposal.bankSourceAccount,
    visibleDigitCount: proposal.visibleDigitCount,
  };
}

/**
 * No evidence row and no refused page: only MyJCB has a debit-account
 * statement (ADR 0032).
 */
function absentDebitAccount(sourceId: string): CardSettlementDebitAccountReview {
  return {
    outcome: "absent",
    reason:
      sourceId === "myjcb" ? "evidence_not_recorded" : "source_has_no_debit_account_statement",
    policy: CARD_DEBIT_ACCOUNT_POLICY,
    statementRef: null,
    bankSourceId: null,
    bankSourceAccount: null,
    visibleDigitCount: null,
    recordedAt: null,
  };
}

/** A malformed persisted candidate is an unavailable answer, never a zero-filled result. */
function review(row: ReviewRow): CardSettlementReview {
  const facts: unknown = JSON.parse(row.facts_json);
  if (!validCardSettlementFacts(facts)) throw new Error("card_settlement_facts_invalid");
  const blockers: string[] = [];
  if (!cardSettlementEligible(facts)) {
    if (facts.ownership === "different") blockers.push("owner_differs");
    else if (facts.ownership !== "established-same" || facts.ownershipEvidenceRefs.length === 0)
      blockers.push("owner_not_established");
    if (facts.statement.accountId === null || facts.bankDebit.accountId === null)
      blockers.push("account_not_resolved");
    if (blockers.length === 0) blockers.push("settlement_not_eligible");
  }
  if (row.statement_current !== 1) blockers.push("statement_changed");
  if (row.bank_current !== 1) blockers.push("bank_debit_changed");
  if (
    row.ownership_current !== 1 &&
    !blockers.includes("owner_not_established") &&
    !blockers.includes("owner_differs")
  )
    blockers.push("ownership_changed");
  if (row.allocation_available !== 1) blockers.push("allocation_already_used");
  return {
    proposalId: row.id,
    revision: row.revision,
    status: row.status,
    facts,
    acceptanceBlockers: blockers,
    impact: cardSettlementImpact(facts, row.status),
    decisionRevisionId: row.decision_revision_id,
    eventId: row.event_id,
    obligationId: row.obligation_id,
    settlementId: row.settlement_id,
    createdAt: row.created_at,
    history: [],
    historyTruncated: false,
    debitAccount: absentDebitAccount(facts.statement.sourceId),
  };
}

/**
 * The reviews `chosen` names (`?1` a proposal id, `?2` the page size plus one,
 * `?3` the offset), newest first, with their `card_settlement_readiness`
 * flags. The page is chosen first and only its candidates are judged, through
 * the keyed form of the view (card-settlement-readiness.ts): joined whole, the
 * view ranked every statement total and bank debit row and resolved the owners of
 * the whole store for every candidate (docs/card-settlements.md, Cost).
 * A review is one candidate and its latest decision, so choosing candidates
 * chooses the same reviews.
 */
const reviewsSql = (chosen: string, extra = ""): string => `WITH chosen AS MATERIALIZED (
 ${chosen}
), ${cardSettlementReadinessCtes()}
SELECT c.id,c.facts_json,c.revision,c.status,c.decision_revision_id,c.event_id,c.obligation_id,c.settlement_id,c.created_at,
 r.statement_current,r.bank_current,r.ownership_current,r.allocation_available${extra}
FROM chosen JOIN card_settlement_reviews c ON c.id=chosen.id LEFT JOIN readiness r ON r.id=c.id
ORDER BY c.created_at DESC,c.id DESC`;
/** A page of the list: every candidate is ordered (`?1` is NULL here). */
export const CARD_SETTLEMENT_PAGE_SQL = reviewsSql(
  "SELECT id FROM card_settlement_candidates review_page WHERE ?1 IS NULL ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3",
);
/** One proposal by id, found by its key. */
export const CARD_SETTLEMENT_REVIEW_SQL = reviewsSql(
  "SELECT id FROM card_settlement_candidates WHERE id=?1 ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3",
);
/**
 * A page of one statement's candidates (`?1` its `statement_key`), found by
 * `card_settlement_candidates_statement` (migration 0044).
 */
export const CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL = reviewsSql(
  "SELECT id FROM card_settlement_candidates WHERE statement_key=?1 ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3",
);
/**
 * The other candidates `?1` competes with: those sharing its statement key,
 * its bank key, or its statement's (source, resolved account, period), the
 * three terms by which an accepted review makes every other one
 * `allocation_already_used` (card-settlement-readiness.ts). Each term is found
 * through its own index (`card_settlement_candidates_statement`, `_bank` and
 * `_statement_period`, migrations 0044 and 0050); a missing account or period
 * matches nothing, as in the reservation. The first term is the one
 * `CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL` pages alone; here the three are
 * paged as one list, without the candidate itself. Every status is listed,
 * so the correction of a wrong acceptance (its withdrawal, then another
 * candidate's acceptance) starts from it (docs/card-settlements.md,
 * Correcting a match).
 */
export const CARD_SETTLEMENT_RELATED_SQL = reviewsSql(`SELECT id FROM (
 SELECT related.id,related.created_at FROM card_settlement_candidates anchor
  JOIN card_settlement_candidates related ON related.statement_key=anchor.statement_key
  WHERE anchor.id=?1
 UNION SELECT related.id,related.created_at FROM card_settlement_candidates anchor
  JOIN card_settlement_candidates related ON related.bank_key=anchor.bank_key
  WHERE anchor.id=?1
 UNION SELECT related.id,related.created_at FROM card_settlement_candidates anchor
  JOIN card_settlement_candidates related
   ON json_extract(related.facts_json,'$.statement.sourceId')=json_extract(anchor.facts_json,'$.statement.sourceId')
   AND json_extract(related.facts_json,'$.statement.accountId')=json_extract(anchor.facts_json,'$.statement.accountId')
   AND json_extract(related.facts_json,'$.statement.period')=json_extract(anchor.facts_json,'$.statement.period')
  WHERE anchor.id=?1
 ) related_review WHERE id<>?1 ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3`);
/** Whether the candidate `?1` exists, by its key. */
export const CARD_SETTLEMENT_EXISTS_SQL =
  "SELECT 1 AS present FROM card_settlement_candidates WHERE id=?1";
/**
 * A page of statements (`?1` the page size plus one, `?2` the offset): every
 * `statement_key` the sweep proposed for, newest candidate first, with how
 * many candidates it has. Like the flat list's page, it orders every
 * candidate (`statement_page`); nothing else is read.
 */
export const CARD_SETTLEMENT_STATEMENT_PAGE_SQL = `SELECT statement_key,count(*) AS candidate_count
FROM card_settlement_candidates statement_page
GROUP BY statement_key ORDER BY max(created_at) DESC,statement_key DESC LIMIT ?1 OFFSET ?2`;
/**
 * The candidates the grouped list judges for the statements `?1` (a JSON array
 * of statement keys): the `?2` newest of each and every accepted one, which
 * may be older. Each statement's candidates are found by
 * `card_settlement_candidates_statement`; the judged set is bounded by the
 * page, not by the history.
 */
export const CARD_SETTLEMENT_STATEMENT_GROUP_SQL = reviewsSql(
  `SELECT id FROM (
  SELECT c.id,row_number() OVER (PARTITION BY c.statement_key ORDER BY c.created_at DESC,c.id DESC) AS position
  FROM json_each(?1) page JOIN card_settlement_candidates c ON c.statement_key=page.value
 ) WHERE position<=?2
 UNION
 SELECT c.id FROM json_each(?1) page JOIN card_settlement_candidates c ON c.statement_key=page.value
 WHERE EXISTS(SELECT 1 FROM card_settlement_decisions d WHERE d.proposal_id=c.id AND d.status='accepted'
  AND d.revision=(SELECT max(latest.revision) FROM card_settlement_decisions latest WHERE latest.proposal_id=c.id))`,
  ",c.statement_key",
);
/**
 * The older candidates the grouped list judges, at most `?4` per statement and
 * pass, for a statement whose newest candidates hold no acceptance and none
 * ready to accept (ADR 0090): of each statement `?1` (a JSON array of statement
 * keys), the candidates after its `?2` newest that no decision names and whose
 * facts claim the same established owner and both accounts, newest first,
 * after the `?3` such ones earlier passes judged. A candidate any decision
 * names is accepted, rejected or withdrawn (migration 0044 allows no other
 * status), so it is not proposed; and `cardSettlementEligible` requires the
 * three facts terms, so a candidate the terms leave out has an acceptance
 * blocker. Each statement's candidates are found by
 * `card_settlement_candidates_statement`.
 */
export const CARD_SETTLEMENT_STATEMENT_OLDER_SQL = reviewsSql(
  `SELECT id FROM (
  SELECT candidate_id AS id,
   row_number() OVER (PARTITION BY candidate_key ORDER BY candidate_created_at DESC,candidate_id DESC) AS older
  FROM (
   SELECT c.id AS candidate_id,c.statement_key AS candidate_key,c.created_at AS candidate_created_at,
    c.facts_json AS candidate_facts,
    row_number() OVER (PARTITION BY c.statement_key ORDER BY c.created_at DESC,c.id DESC) AS position
   FROM json_each(?1) page JOIN card_settlement_candidates c ON c.statement_key=page.value
  ) WHERE position>?2
  AND NOT EXISTS(SELECT 1 FROM card_settlement_decisions d WHERE d.proposal_id=candidate_id)
  AND json_extract(candidate_facts,'$.ownership')='established-same'
  AND json_extract(candidate_facts,'$.statement.accountId') IS NOT NULL
  AND json_extract(candidate_facts,'$.bankDebit.accountId') IS NOT NULL
 ) WHERE older>?3 AND older<=?3+?4`,
  ",c.statement_key",
);

/** Each review's decision history and provider-stated debit account evidence. */
async function withHistory(sql: SqlExecutor, items: CardSettlementReview[]): Promise<void> {
  if (items.length === 0) return;
  const history = await sql.all<HistoryRow>(
    `SELECT proposal_id,revision,status,decision_revision_id,created_at FROM (
        SELECT proposal_id,revision,status,decision_revision_id,created_at,
          ROW_NUMBER() OVER (PARTITION BY proposal_id ORDER BY revision DESC) AS ordinal
        FROM card_settlement_decisions d JOIN json_each(?1) selected ON d.proposal_id=json_extract(selected.value,'$.proposalId')
        WHERE d.revision<=json_extract(selected.value,'$.revision')
      ) WHERE ordinal<=?2 ORDER BY proposal_id,revision DESC`,
    [
      JSON.stringify(
        items.map((item) => ({
          proposalId: item.proposalId,
          revision: item.revision,
        })),
      ),
      HISTORY_LIMIT + 1,
    ],
  );
  for (const item of items) {
    const revisions = history.filter((row) => row.proposal_id === item.proposalId);
    item.history = revisions.slice(0, HISTORY_LIMIT).map((row) => ({
      revision: row.revision,
      status: row.status,
      decisionRevisionId: row.decision_revision_id,
      createdAt: row.created_at,
    }));
    item.historyTruncated = revisions.length > HISTORY_LIMIT;
  }
  const evidence = await sql.all<DebitAccountRow>(CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL, [
    JSON.stringify(items.map((item) => item.proposalId)),
    CARD_DEBIT_ACCOUNT_POLICY,
    CARD_INFORMATION_READER_VERSION,
  ]);
  for (const item of items) {
    const row = evidence.find((entry) => entry.candidate_id === item.proposalId);
    const found = row === undefined ? null : debitAccountReview(row);
    if (found !== null) item.debitAccount = found;
  }
}

function validOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
    throw new Error("invalid_offset");
}

/**
 * Offset lists, one statement's candidates and exact-id reads share the same
 * financial and explanation DTO.
 */
export async function queryCardSettlements(
  sql: SqlExecutor,
  input: { offset?: number; proposalId?: string; statementKey?: string } = {},
): Promise<CardSettlementReviewPage> {
  const offset = input.offset ?? 0;
  validOffset(offset);
  if (input.proposalId !== undefined && input.statementKey !== undefined)
    throw new Error("invalid_query");
  if (
    input.statementKey !== undefined &&
    (input.statementKey.length === 0 || input.statementKey.length > STATEMENT_KEY_LIMIT)
  )
    throw new Error("invalid_statement_key");
  const rows =
    input.statementKey !== undefined
      ? await sql.all<ReviewRow>(CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL, [
          input.statementKey,
          CARD_SETTLEMENT_PAGE_SIZE + 1,
          offset,
        ])
      : await sql.all<ReviewRow>(
          (input.proposalId ?? null) === null
            ? CARD_SETTLEMENT_PAGE_SQL
            : CARD_SETTLEMENT_REVIEW_SQL,
          [input.proposalId ?? null, CARD_SETTLEMENT_PAGE_SIZE + 1, offset],
        );
  return reviewPage(sql, rows, offset);
}

/**
 * A page of the candidates `proposalId` competes with
 * (CARD_SETTLEMENT_RELATED_SQL), in the list's DTO and order, or null when
 * `proposalId` names no candidate.
 */
export async function queryRelatedCardSettlements(
  sql: SqlExecutor,
  proposalId: string,
  input: { offset?: number } = {},
): Promise<CardSettlementReviewPage | null> {
  const offset = input.offset ?? 0;
  validOffset(offset);
  if ((await sql.first<{ present: number }>(CARD_SETTLEMENT_EXISTS_SQL, [proposalId])) === null)
    return null;
  const rows = await sql.all<ReviewRow>(CARD_SETTLEMENT_RELATED_SQL, [
    proposalId,
    CARD_SETTLEMENT_PAGE_SIZE + 1,
    offset,
  ]);
  return reviewPage(sql, rows, offset);
}

/** The list's page of the rows read (page size plus one), with history and evidence. */
async function reviewPage(
  sql: SqlExecutor,
  rows: ReviewRow[],
  offset: number,
): Promise<CardSettlementReviewPage> {
  const items = rows.slice(0, CARD_SETTLEMENT_PAGE_SIZE).map(review);
  await withHistory(sql, items);
  return {
    items,
    nextOffset: rows.length > CARD_SETTLEMENT_PAGE_SIZE ? offset + CARD_SETTLEMENT_PAGE_SIZE : null,
    coverage: {
      scope: "card-statement-bank-debit-candidates",
      completeTransactionHistory: false,
      netAssets: "unknown",
      limit: CARD_SETTLEMENT_PAGE_SIZE,
    },
  };
}

/**
 * The statement a group leads with: its accepted candidate (an acceptance
 * reserves the statement, so a live one is the statement's answer), else the
 * newest proposed one with no acceptance blocker, else the newest one. The
 * rest follow newest first. Readiness is never guessed: a candidate is ready
 * only when the readiness flags and the facts say so (`acceptanceBlockers`).
 */
export function leadFirst(candidates: CardSettlementReview[]): CardSettlementReview[] {
  const lead =
    candidates.find((candidate) => candidate.status === "accepted") ??
    candidates.find(
      (candidate) => candidate.status === "proposed" && candidate.acceptanceBlockers.length === 0,
    ) ??
    candidates[0];
  return lead === undefined ? [] : [lead, ...candidates.filter((candidate) => candidate !== lead)];
}

/** Whether `leadFirst` leads with this candidate for what it is, not for being newest. */
const decidable = (candidate: CardSettlementReview): boolean =>
  candidate.status === "accepted" ||
  (candidate.status === "proposed" && candidate.acceptanceBlockers.length === 0);

/**
 * The newest ready candidate of each statement `keys` names among its
 * candidates older than the judged window, judged
 * `CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS` at a time, newest first; a
 * statement leaves the search at its first ready candidate or once a pass
 * returns fewer than a full pass of its candidates. Only candidates no
 * decision names and whose facts could be eligible are judged
 * (`CARD_SETTLEMENT_STATEMENT_OLDER_SQL`), at most
 * `CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED` per statement: a statement still
 * searching after them is `truncated`, never reported as having none ready.
 */
async function olderReadyCandidates(
  sql: SqlExecutor,
  keys: string[],
): Promise<{ found: Map<string, CardSettlementReview>; truncated: Set<string> }> {
  const found = new Map<string, CardSettlementReview>();
  let searching = keys;
  for (
    let passed = 0;
    searching.length > 0 && passed < CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED;
    passed += CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS
  ) {
    const rows = await sql.all<ReviewRow>(CARD_SETTLEMENT_STATEMENT_OLDER_SQL, [
      JSON.stringify(searching),
      CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
      passed,
      CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
    ]);
    const next: string[] = [];
    for (const key of searching) {
      // Newest first, as the read orders them; judged in that order.
      const own = rows.filter((row) => row.statement_key === key);
      let ready: CardSettlementReview | undefined;
      for (const row of own) {
        const candidate = review(row);
        if (candidate.status === "proposed" && candidate.acceptanceBlockers.length === 0) {
          ready = candidate;
          break;
        }
      }
      if (ready !== undefined) found.set(key, ready);
      else if (own.length === CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS) next.push(key);
    }
    searching = next;
  }
  return { found, truncated: new Set(searching) };
}

/**
 * The review list grouped by statement (`statement_key`, the statement the
 * sweep read: source, producer, namespace, card account and period), newest
 * candidate first. Each group judges its newest
 * `CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT` candidates and any accepted one;
 * when none of those is accepted or ready to accept and the statement has
 * older candidates, it also searches at most
 * `CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED` of those for the newest ready
 * one and says how far it looked (`leadSearch`, ADR 0090). It leads with
 * the one `leadFirst` picks and says how many candidates the statement has;
 * the rest are one
 * `queryCardSettlements({ statementKey })` away. No candidate is hidden or
 * removed: candidates are append-only.
 */
export async function queryCardSettlementStatements(
  sql: SqlExecutor,
  input: { offset?: number } = {},
): Promise<CardSettlementStatementPage> {
  const offset = input.offset ?? 0;
  validOffset(offset);
  const statements = await sql.all<StatementRow>(CARD_SETTLEMENT_STATEMENT_PAGE_SQL, [
    CARD_SETTLEMENT_STATEMENT_PAGE_SIZE + 1,
    offset,
  ]);
  const page = statements.slice(0, CARD_SETTLEMENT_STATEMENT_PAGE_SIZE);
  const rows =
    page.length === 0
      ? []
      : await sql.all<ReviewRow>(CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [
          JSON.stringify(page.map((row) => row.statement_key)),
          CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
        ]);
  const judged = page.map((statement) => ({
    statement,
    reviews: rows.filter((row) => row.statement_key === statement.statement_key).map(review),
  }));
  const searched = judged
    .filter(
      ({ statement, reviews }) =>
        reviews.length < statement.candidate_count && !reviews.some(decidable),
    )
    .map(({ statement }) => statement.statement_key);
  const older = await olderReadyCandidates(sql, searched);
  const chosen = judged.map(({ statement, reviews }) => {
    const key = statement.statement_key;
    const ready = older.found.get(key);
    const leadSearch: CardSettlementLeadSearch = !searched.includes(key)
      ? "not_searched"
      : ready !== undefined
        ? "found"
        : older.truncated.has(key)
          ? "truncated"
          : "none_ready";
    return { statement, leadSearch, reviews: ready === undefined ? reviews : [...reviews, ready] };
  });
  await withHistory(
    sql,
    chosen.flatMap((group) => group.reviews),
  );
  const groups: CardSettlementStatementGroup[] = chosen.map(
    ({ statement, leadSearch, reviews }) => {
      const candidates = leadFirst(reviews);
      if (candidates.length === 0) throw new Error("card_settlement_statement_unavailable");
      return {
        statementKey: statement.statement_key,
        candidateCount: statement.candidate_count,
        candidates,
        leadSearch,
      };
    },
  );
  return {
    statements: groups,
    nextOffset:
      statements.length > CARD_SETTLEMENT_STATEMENT_PAGE_SIZE
        ? offset + CARD_SETTLEMENT_STATEMENT_PAGE_SIZE
        : null,
    coverage: {
      scope: "card-statement-bank-debit-candidates",
      completeTransactionHistory: false,
      netAssets: "unknown",
      limit: CARD_SETTLEMENT_STATEMENT_PAGE_SIZE,
      candidatesPerStatement: CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
      olderCandidatesSearched: CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED,
    },
  };
}
