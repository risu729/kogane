// Card statements without a settlement candidate (#548, ADR 0074's
// 2026-11-07 amendment, docs/card-settlements.md, Statements without a
// candidate). One bounded page of the current provider statement totals that
// no candidate cites, each with the closed code the sweep would count it
// under and, for a statement whose window holds debits but none of the same
// amount, the ADR 0074 planner's read-only answer under the owner's display
// policy. The `カード照合` page
// (`GET /api/v2/reconciliation/card-statements-unmatched`) and an agent
// (`kogane.card-settlements.unmatched`) both call
// `reviewUnmatchedCardStatements` and nothing else, so a page and an agent
// read one answer.
//
// It reads, and nothing else: no lane, table, writer or command uses the
// planner's answer, and no allocation it lists can be accepted (the
// acceptance writer claims one debit; `acceptable` is always false).
//
// - The grant decides. `records.read` over the whole store: a statement is
//   compared with debits of any bank, so a grant listed on either axis is
//   refused before anything is read.
// - Bounded. A page is at most `UNMATCHED_PAGE_SIZE` statements; each due
//   date is read once with the sweep's own bank read (at most 1,000 rows);
//   a planner run is at most 16 statements and 32 debits, and a run past
//   them is answered `input_bound_exceeded`, never cut. The grant's
//   `maxRows` bounds how deep a caller pages (`budget_exceeded`).
import { cardSettlementCandidate } from "../../../domain/src/card-settlement.ts";
import {
  CARD_STATEMENT_ALLOCATION_DEBITS_MAX,
  CARD_STATEMENT_ALLOCATION_RELEASE,
  CARD_STATEMENT_ALLOCATION_STATEMENTS_MAX,
  planCardStatementAllocations,
  type AllocationDebitInput,
  type AllocationOutcomeCode,
  type AllocationStatementInput,
  type AllocationStatementRefusal,
  type CardStatementAllocationRun,
} from "../../../domain/src/card-settlement-allocation.ts";
import {
  CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY,
  comparableTotal,
  unmatchedStatementCode,
  UNMATCHED_STATEMENT_CODES,
  type UnmatchedStatementCode,
} from "../../../domain/src/card-settlement-unmatched.ts";
import { aliasClassText } from "../../../domain/src/economic-contract.ts";
import type { SourceFactRef } from "../../../domain/src/events.ts";
import type { FinancialError } from "../../../domain/src/result.ts";
import { humanAdoptedRowIdentity } from "../../../domain/src/row-identity.ts";
import { daysBetween, parseLocalDate, type TemporalValue } from "../../../domain/src/time.ts";
import type { Quantity } from "../../../domain/src/values.ts";
import {
  bankDebitFactOf,
  CARD_SETTLEMENT_BANK_DEBITS_LIMIT,
  CARD_SETTLEMENT_BANK_DEBITS_SQL,
  statementFactOf,
  sweepRowAmount,
  sweepRowEvidence,
  type CardSettlementSweepRow,
} from "../../../read-model/src/card-settlement-bank-debits.ts";
import { cardSettlementOwnershipCtes } from "../../../read-model/src/card-settlement-ownership.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type Grant, grantAllows } from "../grants.ts";

const REQUEST_ID = "card-settlements.unmatched";
/** Statements one page holds. */
export const UNMATCHED_PAGE_SIZE = 50;
/** The largest offset a request may name. */
export const UNMATCHED_MAX_OFFSET = 100_000;
/** Every key a request may carry; any other key is refused, never ignored. */
export const UNMATCHED_KEYS = ["offset"] as const;
/**
 * Two due dates whose windows (three days either side) share a day: their
 * statements go to one planner run, so a debit both could use is contested.
 */
const OVERLAP_DAYS =
  CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY.window.maxDaysFromDue -
  CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY.window.minDaysFromDue;

export { UNMATCHED_STATEMENT_CODES, type UnmatchedStatementCode };

export interface UnmatchedCardStatementsRequest {
  offset: number;
}

/** One debit of a listed allocation: its whole amount, never split. */
export interface UnmatchedAllocationMember {
  ref: SourceFactRef;
  sourceId: string;
  sourceAccount: string;
  accountId: string | null;
  amount: Quantity;
}

export interface UnmatchedAllocation {
  kind: "single-debit" | "multiple-debits";
  members: UnmatchedAllocationMember[];
  ownership: "established-same" | "unknown" | "different";
  rejectionConditions: string[];
}

/** The planner's answer for one statement; null when the planner was not asked. */
export type UnmatchedPlannerAnswer =
  | { status: "run_refused"; code: "input_bound_exceeded" }
  | { status: "refused"; code: AllocationStatementRefusal }
  | {
      status: "proposed" | "needs_review" | "unsupported";
      codes: AllocationOutcomeCode[];
      allocations: UnmatchedAllocation[];
    };

export interface UnmatchedCardStatement {
  statement: {
    ref: SourceFactRef;
    sourceId: string;
    sourceAccount: string;
    accountId: string | null;
    /** The provider's total; null when it is not exact (INV05). */
    amount: Quantity | null;
    /** The provider's due date; null when absent or not a civil date. */
    paymentDate: TemporalValue | null;
    period: string | null;
  };
  code: UnmatchedStatementCode;
  /** Rows the window read returned; null when no read was made. */
  debitsInWindow: number | null;
  planner: UnmatchedPlannerAnswer | null;
  /** Always false: no allocation listed here can be accepted. */
  acceptable: false;
}

export interface UnmatchedCardStatementsReview {
  schemaVersion: "kogane-card-statements-unmatched-v1";
  query: UnmatchedCardStatementsRequest;
  manifest: {
    codes: readonly UnmatchedStatementCode[];
    planner: {
      release: typeof CARD_STATEMENT_ALLOCATION_RELEASE;
      policy: typeof CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY;
      /** Statements of this page whose windows share a day are planned together. */
      partition: "page-overlapping-windows";
      bounds: { statements: number; debits: number };
    };
    pageSize: number;
    /** No allocation listed is acceptable: the acceptance writer claims one debit. */
    acceptance: "single-debit-candidates-only";
  };
  items: UnmatchedCardStatement[];
  nextOffset: number | null;
}

export type UnmatchedCardStatementsOutcome =
  | { ok: true; review: UnmatchedCardStatementsReview }
  | { ok: false; error: FinancialError };

type Row = CardSettlementSweepRow & {
  payment_date: string | null;
  period: string | null;
  statement_key: string;
};
type BankRow = CardSettlementSweepRow & {
  bank_key: string;
  external_id: string | null;
  extra_json: string | null;
};

/**
 * A page of the current statement totals no candidate cites (`?1` the page
 * size plus one, `?2` the offset), by id, with their owners. A candidate cites
 * a statement by its observation and parse run; it is found through the
 * candidates' `statement_key` index.
 */
export const UNMATCHED_STATEMENTS_SQL = `WITH page AS MATERIALIZED (
 SELECT f.* FROM card_statement_facts f
 WHERE NOT EXISTS(SELECT 1 FROM card_settlement_candidates c
  WHERE c.statement_key=f.statement_key AND c.statement_observation_id=f.id AND c.statement_parse_run_id=f.parse_run_id)
 ORDER BY f.id LIMIT ?1 OFFSET ?2
), observed AS (SELECT id AS observation_id FROM page),
${cardSettlementOwnershipCtes("balance")}
SELECT page.*,ownership.account_id,ownership.owner_ref,ownership.evidence_refs_json FROM page
 LEFT JOIN ownership ON ownership.observation_id=page.id ORDER BY page.id`;

/** The parser of each debit row (`?1` a JSON array of observation ids), which names its identity function. */
export const UNMATCHED_DEBIT_PARSERS_SQL = `SELECT t.id,p.parser_name FROM json_each(?1) j
 JOIN transaction_observations t ON t.id=j.value JOIN parse_runs p ON p.id=t.parse_run_id`;

/**
 * Which of the keys (`?1`) a live holder holds in book `cash-movement`: a live
 * `economic_claims` row, or an accepted settlement of a live revision (the
 * key half of `claim_available`, card-settlement-readiness.ts).
 */
export const UNMATCHED_HELD_KEYS_SQL = `SELECT k.value AS held FROM json_each(?1) k
 WHERE EXISTS(SELECT 1 FROM economic_claims x
  JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
  WHERE x.book='cash-movement' AND x.consumption_key=k.value AND r.superseded_by IS NULL)
 OR EXISTS(SELECT 1 FROM card_settlement_candidates c
  JOIN card_settlement_decisions d ON d.proposal_id=c.id AND d.status='accepted'
  JOIN economic_event_revisions r ON r.event_id=d.event_id AND r.revision=d.revision
  WHERE c.bank_key=k.value AND r.superseded_by IS NULL)`;

/** Which of the alias classes (`?1`) a live `economic_claims` row holds in book `cash-movement`. */
export const UNMATCHED_HELD_ALIASES_SQL = `SELECT a.value AS held FROM json_each(?1) a
 WHERE EXISTS(SELECT 1 FROM economic_claims x
  JOIN economic_event_revisions r ON r.event_id=x.event_id AND r.revision=x.revision
  WHERE x.book='cash-movement' AND x.alias_class=a.value AND r.superseded_by IS NULL)`;

/** Which of the statement keys (`?1`) an accepted settlement of a live revision reserves. */
export const UNMATCHED_RESERVED_STATEMENTS_SQL = `SELECT s.value AS held FROM json_each(?1) s
 WHERE EXISTS(SELECT 1 FROM card_settlement_candidates c
  JOIN card_settlement_decisions d ON d.proposal_id=c.id AND d.status='accepted'
  JOIN economic_event_revisions r ON r.event_id=d.event_id AND r.revision=d.revision
  WHERE c.statement_key=s.value AND r.superseded_by IS NULL)`;

/** Parse an untrusted request body: only `offset`, a bounded integer. */
export function parseUnmatchedCardStatementsRequest(
  body: unknown,
): { ok: true; value: UnmatchedCardStatementsRequest } | { ok: false; refs: string[] } {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { ok: false, refs: ["body"] };
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => !(UNMATCHED_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) return { ok: false, refs: unknown.map((key) => "key:" + key) };
  const offset = record["offset"] ?? 0;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > UNMATCHED_MAX_OFFSET
  )
    return { ok: false, refs: ["offset"] };
  return { ok: true, value: { offset } };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface Pending {
  row: Row;
  total: Quantity;
  date: string;
  banks: readonly BankRow[];
}

/** Statements whose windows share a day, in due-date order; each group is one planner run. */
function groups(pending: readonly Pending[]): Pending[][] {
  const sorted = [...pending].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.row.id - b.row.id,
  );
  const result: Pending[][] = [];
  let last: string | null = null;
  for (const entry of sorted) {
    if (
      last !== null &&
      daysBetween(parseLocalDate(last)!, parseLocalDate(entry.date)!) <= OVERLAP_DAYS
    )
      result.at(-1)!.push(entry);
    else result.push([entry]);
    last = entry.date;
  }
  return result;
}

async function heldOf(sql: SqlExecutor, query: string, values: readonly string[]) {
  if (values.length === 0) return [];
  const rows = await sql.all<{ held: string }>(query, [JSON.stringify(values)]);
  return rows.map((row) => row.held);
}

/** One planner run over a group, answered per statement id. */
async function planGroup(
  sql: SqlExecutor,
  group: readonly Pending[],
): Promise<Map<number, UnmatchedPlannerAnswer>> {
  const answers = new Map<number, UnmatchedPlannerAnswer>();
  const debits = new Map<number, BankRow>();
  let truncated = false;
  for (const entry of group) {
    if (entry.banks.length >= CARD_SETTLEMENT_BANK_DEBITS_LIMIT) truncated = true;
    for (const bank of entry.banks) debits.set(bank.id, bank);
  }
  if (
    truncated ||
    group.length > CARD_STATEMENT_ALLOCATION_STATEMENTS_MAX ||
    debits.size > CARD_STATEMENT_ALLOCATION_DEBITS_MAX
  ) {
    for (const entry of group)
      answers.set(entry.row.id, { status: "run_refused", code: "input_bound_exceeded" });
    return answers;
  }
  const parsers = new Map(
    (
      await sql.all<{ id: number; parser_name: string }>(UNMATCHED_DEBIT_PARSERS_SQL, [
        JSON.stringify([...debits.keys()]),
      ])
    ).map((row) => [row.id, row.parser_name]),
  );
  const debitInputs: AllocationDebitInput[] = [];
  for (const bank of debits.values()) {
    const fact = bankDebitFactOf(bank);
    if (fact === null) continue; // not exact or no valid date: the sweep never compares it either
    const parserName = parsers.get(bank.id);
    // An unresolved account has no alias class: `identity_not_admitted`.
    const identity =
      parserName === undefined || bank.account_id === null
        ? null
        : humanAdoptedRowIdentity({
            sourceId: bank.source_id,
            parserName,
            sourceAccount: bank.source_account,
            externalId: bank.external_id,
            extra: parseJson(bank.extra_json),
            accountId: bank.account_id,
          });
    debitInputs.push({
      debit: fact,
      bankKey: bank.bank_key,
      aliasClass: identity?.admitted ? aliasClassText(identity.aliasClass) : null,
    });
  }
  const statements: AllocationStatementInput[] = group.map((entry) => ({
    statement: statementFactOf(entry.row, entry.total, entry.date),
    statementKey: entry.row.statement_key,
  }));
  const run: CardStatementAllocationRun = planCardStatementAllocations({
    statements,
    debits: debitInputs,
    policy: CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY,
    held: {
      bankKeys: await heldOf(
        sql,
        UNMATCHED_HELD_KEYS_SQL,
        debitInputs.map((debit) => debit.bankKey),
      ),
      aliasClasses: await heldOf(
        sql,
        UNMATCHED_HELD_ALIASES_SQL,
        debitInputs.flatMap((debit) => (debit.aliasClass === null ? [] : [debit.aliasClass])),
      ),
      statementKeys: await heldOf(
        sql,
        UNMATCHED_RESERVED_STATEMENTS_SQL,
        statements.map((statement) => statement.statementKey),
      ),
    },
  });
  if (!run.ok) {
    // The policy is the module's own and the bounds were checked above, so
    // only the bound can refuse; any refusal is the run's, never a zero.
    for (const entry of group)
      answers.set(entry.row.id, { status: "run_refused", code: "input_bound_exceeded" });
    return answers;
  }
  for (const result of run.statements) {
    const id = Number(result.statementRef?.id.slice("balance:".length));
    const outcome = result.outcome;
    answers.set(
      id,
      outcome.status === "refused"
        ? { status: "refused", code: outcome.code }
        : {
            status: outcome.status,
            codes: [...outcome.codes],
            allocations: outcome.allocations.map((allocation) => ({
              kind: allocation.kind,
              members: allocation.members.map((member) => ({
                ref: member.ref,
                sourceId: member.sourceId,
                sourceAccount: member.sourceAccount,
                accountId: member.accountId,
                amount: member.allocated,
              })),
              ownership: allocation.ownership,
              rejectionConditions: [...allocation.rejectionConditions],
            })),
          },
    );
  }
  return answers;
}

/**
 * One page of the statements without a candidate, for whoever the grant
 * allows. Reads only.
 */
export async function reviewUnmatchedCardStatements(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: UnmatchedCardStatementsRequest;
}): Promise<UnmatchedCardStatementsOutcome> {
  const { grant, sql, request } = input;
  if (!grantAllows(grant, "records.read"))
    return {
      ok: false,
      error: financialError("unauthorized", REQUEST_ID, ["capability:records.read"]),
    };
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0)
    return { ok: false, error: financialError("evidence_restricted", REQUEST_ID, narrowed) };
  // The grant's row budget bounds how deep a caller pages.
  if (request.offset + UNMATCHED_PAGE_SIZE > grant.budget.maxRows)
    return {
      ok: false,
      error: financialError("budget_exceeded", REQUEST_ID, [
        `budget:maxRows=${String(grant.budget.maxRows)}`,
      ]),
    };
  const rows = await sql.all<Row>(UNMATCHED_STATEMENTS_SQL, [
    UNMATCHED_PAGE_SIZE + 1,
    request.offset,
  ]);
  const page = rows.slice(0, UNMATCHED_PAGE_SIZE);
  // Each due date is read once, with the sweep's own read and bound.
  const windows = new Map<string, readonly BankRow[]>();
  const items = new Map<number, UnmatchedCardStatement>();
  const pending: Pending[] = [];
  for (const row of page) {
    const total = sweepRowAmount(row);
    const date =
      row.payment_date !== null && parseLocalDate(row.payment_date) !== null
        ? row.payment_date
        : null;
    const item: UnmatchedCardStatement = {
      statement: {
        ref: {
          kind: "balance",
          id: "balance:" + row.id,
          revision: "parse_run:" + row.parse_run_id,
        },
        sourceId: row.source_id,
        sourceAccount: row.source_account,
        accountId: row.account_id ?? null,
        amount: total,
        paymentDate:
          date === null
            ? null
            : { kind: "local-date", value: date, zone: "Asia/Tokyo", basis: "provider" },
        period: row.period ?? null,
      },
      code: unmatchedStatementCode(total, false, null),
      debitsInWindow: null,
      planner: null,
      acceptable: false,
    };
    items.set(row.id, item);
    // The sweep reads the window of every statement with an exact total, a
    // due date and a period; a refund or zero total is then never matched.
    if (total === null || date === null || !row.period) continue;
    let banks = windows.get(date);
    if (banks === undefined) {
      banks = await sql.all<BankRow>(CARD_SETTLEMENT_BANK_DEBITS_SQL, [
        date,
        date,
        CARD_SETTLEMENT_BANK_DEBITS_LIMIT,
      ]);
      windows.set(date, banks);
    }
    item.debitsInWindow = banks.length;
    item.code = unmatchedStatementCode(total, true, banks.length);
    if (item.code !== "no_equal_amount_debit" || !comparableTotal(total)) continue;
    const statement = statementFactOf(row, total, date);
    const pairs = banks.some((bank) => {
      const debit = bankDebitFactOf(bank);
      return (
        debit !== null &&
        cardSettlementCandidate(statement, debit, [
          ...new Set([...sweepRowEvidence(row), ...sweepRowEvidence(bank)]),
        ]) !== null
      );
    });
    if (pairs) item.code = "equal_amount_debit_awaiting_sweep";
    else pending.push({ row, total, date, banks });
  }
  for (const group of groups(pending))
    for (const [id, answer] of await planGroup(sql, group)) {
      const item = items.get(id);
      if (item) item.planner = answer;
    }
  return {
    ok: true,
    review: {
      schemaVersion: "kogane-card-statements-unmatched-v1",
      query: request,
      manifest: {
        codes: UNMATCHED_STATEMENT_CODES,
        planner: {
          release: CARD_STATEMENT_ALLOCATION_RELEASE,
          policy: CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY,
          partition: "page-overlapping-windows",
          bounds: {
            statements: CARD_STATEMENT_ALLOCATION_STATEMENTS_MAX,
            debits: CARD_STATEMENT_ALLOCATION_DEBITS_MAX,
          },
        },
        pageSize: UNMATCHED_PAGE_SIZE,
        acceptance: "single-debit-candidates-only",
      },
      items: page.map((row) => items.get(row.id)!),
      nextOffset: rows.length > UNMATCHED_PAGE_SIZE ? request.offset + UNMATCHED_PAGE_SIZE : null,
    },
  };
}
