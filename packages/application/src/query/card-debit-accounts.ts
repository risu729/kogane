// Which bank account each credit card is debited from (#1357, ADR 0114,
// docs/card-settlements.md, Debit account per card). One answer per card
// that has a current statement total, a stated debit-account reading or a
// settlement candidate: the provider-stated account when the card provider
// names one, else the account of the newest accepted settlement, else
// unknown with a closed reason; beside it, the evidence on each side and the
// accounts undecided candidates name, which never answer (INV07).
//
// The `カード照合` page (`GET /api/v2/reconciliation/card-debit-accounts`)
// and an agent (`kogane.card-settlements.debit-accounts`) both call
// `reviewCardDebitAccounts` and nothing else, so a page and an agent read one
// answer.
//
// It reads, and nothing else: no lane, table, writer or command uses the
// answer, and it changes no candidate's eligibility.
//
// - The grant decides. `records.read` over the whole store: a card is
//   compared with accounts of any bank, so a grant listed on either axis is
//   refused before anything is read.
// - Bounded. At most `CARD_DEBIT_ACCOUNTS_CARDS_MAX` cards are listed (more
//   are said, `cardsTruncated`). Only the statement read has that bound: the
//   stated side returns, for every card, the evidence rows of at most two
//   readings; the candidate side one row per card, bank account and decision
//   state; cards past the bound are dropped after reading. Those two reads
//   grow with the cards the store holds, not with `maxRows`. The grant's
//   `maxRows` below the card bound is `budget_exceeded`, before any read.
import {
  CARD_DEBIT_ACCOUNT_POLICY,
  CARD_DEBIT_ACCOUNT_REASONS,
  type CardDebitAccountReason,
} from "../../../domain/src/card-debit-account.ts";
import {
  answerCardDebitAccount,
  CARD_DEBIT_ACCOUNT_ANSWER_CODES,
  CARD_DEBIT_ACCOUNT_ANSWER_RULE,
  CARD_DEBIT_ACCOUNT_BASES,
  CARD_DEBIT_ACCOUNT_UNKNOWN_REASONS,
  compareDebitBankAccounts,
  compareMatchedDebitAccounts,
  STATED_ABSENT_REASONS,
  statedDebitAccount,
  type CardDebitAccountAnswer,
  type DebitBankAccount,
  type MatchedDebitAccount,
  type StatedDebitAccount,
  type StatedReading,
} from "../../../domain/src/card-debit-account-answer.ts";
import type { SourceFactRef } from "../../../domain/src/events.ts";
import { CARD_INFORMATION_READER_VERSION } from "../../../domain/src/myjcb-card-information.ts";
import type { FinancialError } from "../../../domain/src/result.ts";
import { parseLocalDate, type TemporalValue } from "../../../domain/src/time.ts";
import type { Quantity } from "../../../domain/src/values.ts";
import {
  sweepRowAmount,
  type CardSettlementSweepRow,
} from "../../../read-model/src/card-settlement-bank-debits.ts";
import { cardSettlementOwnershipCtes } from "../../../read-model/src/card-settlement-ownership.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type Grant, grantAllows } from "../grants.ts";
import { pageBeyondBudget } from "./page-budget.ts";

const REQUEST_ID = "card-settlements.debit-accounts";
/** The most cards one answer lists. */
export const CARD_DEBIT_ACCOUNTS_CARDS_MAX = 100;
/** A request carries no key: any key is refused, never ignored. */
export const CARD_DEBIT_ACCOUNTS_KEYS = [] as const;

export {
  CARD_DEBIT_ACCOUNT_ANSWER_CODES,
  CARD_DEBIT_ACCOUNT_UNKNOWN_REASONS,
  STATED_ABSENT_REASONS,
  type CardDebitAccountAnswer,
  type DebitBankAccount,
  type MatchedDebitAccount,
  type StatedDebitAccount,
  type StatedReading,
};

/** The card sources whose statements the settlement review reads. */
export type CardDebitAccountSource = "vpass" | "myjcb";
/** Sources with a reader of a provider-stated debit account (ADR 0032). */
const STATED_READER_SOURCES: readonly CardDebitAccountSource[] = ["myjcb"];

export interface CardDebitAccountCard {
  card: { sourceId: CardDebitAccountSource; sourceAccount: string; accountId: string | null };
  /**
   * The card's newest current statement total (by period, then due date), so
   * a reader sees how old the answer is beside it; null when the card has
   * none current.
   */
  latestStatement: {
    ref: SourceFactRef;
    period: string | null;
    /** The provider's due date; null when absent or not a civil date. */
    paymentDate: TemporalValue | null;
    /** The provider's total; null when it is not exact (INV05). */
    amount: Quantity | null;
  } | null;
  stated: StatedDebitAccount;
  /** Accepted settlements per bank account, newest debit first. */
  settled: MatchedDebitAccount[];
  /**
   * Undecided candidates per bank account, of statements no accepted
   * settlement covers, newest debit first. A proposal only: never an answer.
   */
  proposed: MatchedDebitAccount[];
  answer: CardDebitAccountAnswer;
}

export interface CardDebitAccountsReview {
  schemaVersion: "kogane-card-debit-accounts-v1";
  manifest: {
    rule: typeof CARD_DEBIT_ACCOUNT_ANSWER_RULE;
    /** The stated side: the rule policy and reader version its evidence was made under. */
    statedPolicy: typeof CARD_DEBIT_ACCOUNT_POLICY;
    readerVersion: typeof CARD_INFORMATION_READER_VERSION;
    /** The bases an answer rests on, strongest first; undecided candidates are none. */
    bases: typeof CARD_DEBIT_ACCOUNT_BASES;
    cardsMax: number;
  };
  /** Cards by source, then source account. */
  items: CardDebitAccountCard[];
  /** True when more cards exist than `cardsMax`. */
  cardsTruncated: boolean;
}

export type CardDebitAccountsOutcome =
  | { ok: true; review: CardDebitAccountsReview }
  | { ok: false; error: FinancialError };

type CardRow = CardSettlementSweepRow & { payment_date: string | null; period: string | null };

/**
 * Each card's newest current statement total (`?1` the card bound plus one),
 * by source and source account, with its resolved account. The card is the
 * statement's source and source account; the ranking is over
 * `card_statement_facts`, as the settlement sweep's own page.
 */
export const CARD_DEBIT_ACCOUNT_CARDS_SQL = `WITH latest AS MATERIALIZED (
 SELECT * FROM (SELECT f.*,row_number() OVER(PARTITION BY f.source_id,f.source_account
   ORDER BY f.period IS NULL,f.period DESC,f.payment_date IS NULL,f.payment_date DESC,f.id DESC) AS card_position
  FROM card_statement_facts f)
 WHERE card_position=1 ORDER BY source_id,source_account LIMIT ?1
), observed AS (SELECT id AS observation_id FROM latest),
${cardSettlementOwnershipCtes("balance")}
SELECT latest.*,ownership.account_id,ownership.owner_ref,ownership.evidence_refs_json FROM latest
 LEFT JOIN ownership ON ownership.observation_id=latest.id ORDER BY latest.source_id,latest.source_account`;

interface ReadingRow {
  reading_id: number;
  source_id: string;
  card_source_account: string;
  observed_at: string;
  reader_version: string;
  evidence_id: number;
  outcome: string;
  reason: string | null;
  proposal_json: string | null;
}

/**
 * The stated side (`?1` the rule policy, `?2` the reader version): the
 * current `card_settlement_debit_account_evidence` row under the policy for
 * each candidate and reading (the sweep appends a row whenever the outcome
 * changes, so only the newest one per candidate, reading and policy counts),
 * whose cited `card_debit_account_statement` reading was made under the reader version,
 * for at most two readings per card: the newest one with evidence, and the
 * newest one whose rows name exactly one account. Readings are ordered by
 * the page's capture time, then id. The evidence is reached by a scan of its
 * table (one row per candidate and changed outcome), each reading by key, and
 * a newer row for the same candidate, reading and policy by the
 * `(candidate_id,statement_id,policy,id)` index.
 */
export const CARD_DEBIT_ACCOUNT_READINGS_SQL = `WITH cited AS MATERIALIZED (
 SELECT s.id AS reading_id,s.source_id,s.card_source_account,s.observed_at,s.reader_version,
  e.id AS evidence_id,e.outcome,e.reason,e.proposal_json,
  CASE WHEN e.outcome<>'not_proposed' THEN json_extract(e.proposal_json,'$.bankSourceId')||char(10)||json_extract(e.proposal_json,'$.bankSourceAccount') END AS named
 FROM card_settlement_debit_account_evidence e
 JOIN card_debit_account_statement s ON s.id=e.statement_id AND s.reader_version=?2
 WHERE e.policy=?1 AND NOT EXISTS (SELECT 1 FROM card_settlement_debit_account_evidence n
  WHERE n.candidate_id=e.candidate_id AND n.statement_id=e.statement_id AND n.policy=e.policy AND n.id>e.id)
), readings AS (
 SELECT reading_id,card_source_account,observed_at,count(DISTINCT named) AS named_accounts
 FROM cited GROUP BY reading_id,card_source_account,observed_at
), ranked AS (
 SELECT reading_id,named_accounts,
  row_number() OVER(PARTITION BY card_source_account ORDER BY observed_at DESC,reading_id DESC) AS latest_position,
  row_number() OVER(PARTITION BY card_source_account,named_accounts=1 ORDER BY observed_at DESC,reading_id DESC) AS named_position
 FROM readings
)
SELECT cited.reading_id,cited.source_id,cited.card_source_account,cited.observed_at,cited.reader_version,
 cited.evidence_id,cited.outcome,cited.reason,cited.proposal_json
FROM ranked JOIN cited ON cited.reading_id=ranked.reading_id
WHERE ranked.latest_position=1 OR (ranked.named_accounts=1 AND ranked.named_position=1)
ORDER BY cited.card_source_account,cited.reading_id,cited.evidence_id`;

interface CandidateRow {
  status: string;
  card_source_id: string | null;
  card_source_account: string | null;
  bank_source_id: string | null;
  bank_source_account: string | null;
  statements: number;
  latest_key: string;
  latest_period: string | null;
}

/**
 * The candidate side: per card, bank account and decision state, the
 * candidates whose latest decision is `accepted`, and those still `proposed`
 * whose statement no accepted candidate covers: how many distinct statements
 * they cover, and the one with the latest debit date (then the greatest id),
 * as `<debit date>\n<id>` with its period. SQLite takes a bare column from the
 * row of the one `max()` aggregate. Every candidate is read once, its latest
 * decision by key.
 */
export const CARD_DEBIT_ACCOUNT_CANDIDATES_SQL = `WITH live AS MATERIALIZED (
 SELECT r.id,r.status,r.statement_key,
  json_extract(r.facts_json,'$.statement.sourceId') AS card_source_id,
  json_extract(r.facts_json,'$.statement.sourceAccount') AS card_source_account,
  json_extract(r.facts_json,'$.statement.period') AS period,
  json_extract(r.facts_json,'$.bankDebit.sourceId') AS bank_source_id,
  json_extract(r.facts_json,'$.bankDebit.sourceAccount') AS bank_source_account,
  CASE WHEN json_extract(r.facts_json,'$.bankDebit.occurred.kind')='local-date'
   THEN json_extract(r.facts_json,'$.bankDebit.occurred.value') END AS debit_date
 FROM card_settlement_reviews r WHERE r.status IN ('accepted','proposed')
), settled AS (SELECT DISTINCT statement_key FROM live WHERE status='accepted')
SELECT status,card_source_id,card_source_account,bank_source_id,bank_source_account,
 count(DISTINCT statement_key) AS statements,
 max(coalesce(debit_date,'')||char(10)||id) AS latest_key,period AS latest_period
FROM live WHERE status='accepted' OR statement_key NOT IN (SELECT statement_key FROM settled)
GROUP BY status,card_source_id,card_source_account,bank_source_id,bank_source_account
ORDER BY card_source_id,card_source_account,status,bank_source_id,bank_source_account`;

/** Parse an untrusted request body: no key at all. */
export function parseCardDebitAccountsRequest(
  body: unknown,
): { ok: true; value: Record<string, never> } | { ok: false; refs: string[] } {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { ok: false, refs: ["body"] };
  const keys = Object.keys(body);
  return keys.length === 0
    ? { ok: true, value: {} }
    : { ok: false, refs: keys.map((key) => "key:" + key) };
}

const invalid = () => new Error("card_debit_accounts_row_invalid");
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const cardSource = (value: unknown): value is CardDebitAccountSource =>
  value === "vpass" || value === "myjcb";
const reasonCode = (value: unknown): value is CardDebitAccountReason =>
  (CARD_DEBIT_ACCOUNT_REASONS as readonly unknown[]).includes(value);
const cardKey = (sourceId: string, sourceAccount: string) => sourceId + "\n" + sourceAccount;
const localDate = (value: string | null): string | null =>
  value !== null && parseLocalDate(value) !== null ? value : null;

/** The account a `supports` or `names_other_account` row's proposal names. */
function namedAccount(json: string | null): { account: DebitBankAccount; digits: number } {
  if (json === null) throw invalid();
  let proposal: unknown;
  try {
    proposal = JSON.parse(json);
  } catch {
    throw invalid();
  }
  if (proposal === null || typeof proposal !== "object") throw invalid();
  const { bankSourceId, bankSourceAccount, visibleDigitCount } = proposal as Record<
    string,
    unknown
  >;
  if (
    !text(bankSourceId) ||
    !text(bankSourceAccount) ||
    typeof visibleDigitCount !== "number" ||
    !Number.isSafeInteger(visibleDigitCount) ||
    visibleDigitCount < 1
  )
    throw invalid();
  return { account: { bankSourceId, bankSourceAccount }, digits: visibleDigitCount };
}

/** One card's readings from its evidence rows. A malformed row fails the read. */
function readingsOf(rows: readonly ReadingRow[]): StatedReading[] {
  const byId = new Map<number, ReadingRow[]>();
  for (const row of rows) {
    const group = byId.get(row.reading_id);
    if (group) group.push(row);
    else byId.set(row.reading_id, [row]);
  }
  return [...byId.values()].map((group) => {
    const first = group[0]!;
    if (!text(first.observed_at) || !text(first.reader_version)) throw invalid();
    const accounts = new Map<string, DebitBankAccount>();
    const reasons = new Set<CardDebitAccountReason>();
    let digits: number | null = null;
    for (const row of group) {
      if (row.outcome === "not_proposed") {
        if (!reasonCode(row.reason) || row.proposal_json !== null) throw invalid();
        reasons.add(row.reason);
        continue;
      }
      if (row.outcome !== "supports" && row.outcome !== "names_other_account") throw invalid();
      if (row.reason !== null) throw invalid();
      const named = namedAccount(row.proposal_json);
      // One reading shows one number of leading digits, whatever it is compared with.
      if (digits !== null && digits !== named.digits) throw invalid();
      digits = named.digits;
      accounts.set(
        cardKey(named.account.bankSourceId, named.account.bankSourceAccount),
        named.account,
      );
    }
    return {
      readingRef: {
        kind: "typed-claim",
        id: `card_debit_account_statement:${first.reading_id}`,
        revision: `reader:${first.reader_version}`,
      },
      observedAt: first.observed_at,
      accounts: [...accounts.values()].sort(compareDebitBankAccounts),
      visibleDigitCount: digits,
      reasons: CARD_DEBIT_ACCOUNT_REASONS.filter((reason) => reasons.has(reason)),
    };
  });
}

/** One candidate group as the domain reads it. A malformed row fails the read. */
function matchedOf(row: CandidateRow): MatchedDebitAccount {
  if (
    !text(row.bank_source_id) ||
    !text(row.bank_source_account) ||
    !Number.isSafeInteger(row.statements) ||
    row.statements < 1 ||
    typeof row.latest_key !== "string"
  )
    throw invalid();
  const split = row.latest_key.indexOf("\n");
  const proposalId = row.latest_key.slice(split + 1);
  if (split < 0 || !text(proposalId)) throw invalid();
  return {
    bankSourceId: row.bank_source_id,
    bankSourceAccount: row.bank_source_account,
    statements: row.statements,
    latest: {
      proposalId,
      debitDate: localDate(row.latest_key.slice(0, split) || null),
      period: typeof row.latest_period === "string" ? row.latest_period : null,
    },
  };
}

interface CardEntry {
  sourceId: CardDebitAccountSource;
  sourceAccount: string;
  statement: CardRow | null;
  readings: ReadingRow[];
  settled: MatchedDebitAccount[];
  proposed: MatchedDebitAccount[];
}

/**
 * Which bank account each card is debited from, for whoever the grant
 * allows. Reads only.
 */
export async function reviewCardDebitAccounts(input: {
  grant: Grant;
  sql: SqlExecutor;
}): Promise<CardDebitAccountsOutcome> {
  const { grant, sql } = input;
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
  if (pageBeyondBudget(0, CARD_DEBIT_ACCOUNTS_CARDS_MAX, grant))
    return {
      ok: false,
      error: financialError("budget_exceeded", REQUEST_ID, [
        `budget:maxRows=${String(grant.budget.maxRows)}`,
      ]),
    };
  const cards = new Map<string, CardEntry>();
  const entry = (sourceId: CardDebitAccountSource, sourceAccount: string): CardEntry => {
    const key = cardKey(sourceId, sourceAccount);
    let found = cards.get(key);
    if (!found) {
      found = { sourceId, sourceAccount, statement: null, readings: [], settled: [], proposed: [] };
      cards.set(key, found);
    }
    return found;
  };
  const statements = await sql.all<CardRow>(CARD_DEBIT_ACCOUNT_CARDS_SQL, [
    CARD_DEBIT_ACCOUNTS_CARDS_MAX + 1,
  ]);
  for (const row of statements) {
    if (!cardSource(row.source_id) || !text(row.source_account)) throw invalid();
    entry(row.source_id, row.source_account).statement = row;
  }
  for (const row of await sql.all<ReadingRow>(CARD_DEBIT_ACCOUNT_READINGS_SQL, [
    CARD_DEBIT_ACCOUNT_POLICY,
    CARD_INFORMATION_READER_VERSION,
  ])) {
    if (!cardSource(row.source_id) || !text(row.card_source_account)) throw invalid();
    entry(row.source_id, row.card_source_account).readings.push(row);
  }
  for (const row of await sql.all<CandidateRow>(CARD_DEBIT_ACCOUNT_CANDIDATES_SQL, [])) {
    if (!cardSource(row.card_source_id) || !text(row.card_source_account)) throw invalid();
    const card = entry(row.card_source_id, row.card_source_account);
    if (row.status === "accepted") card.settled.push(matchedOf(row));
    else if (row.status === "proposed") card.proposed.push(matchedOf(row));
    else throw invalid();
  }
  // The statement read is complete only up to its last card when it was cut,
  // so a card after that one is not listed: its newest statement is unknown.
  const cut =
    statements.length > CARD_DEBIT_ACCOUNTS_CARDS_MAX
      ? cardKey(
          statements[CARD_DEBIT_ACCOUNTS_CARDS_MAX - 1]!.source_id,
          statements[CARD_DEBIT_ACCOUNTS_CARDS_MAX - 1]!.source_account,
        )
      : null;
  const sorted = [...cards.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, card]) => card);
  const listed = sorted
    .filter((card) => cut === null || cardKey(card.sourceId, card.sourceAccount) <= cut)
    .slice(0, CARD_DEBIT_ACCOUNTS_CARDS_MAX);
  const items = listed.map((card) => {
    const settled = [...card.settled].sort(compareMatchedDebitAccounts);
    const proposed = [...card.proposed].sort(compareMatchedDebitAccounts);
    const stated = statedDebitAccount(
      STATED_READER_SOURCES.includes(card.sourceId),
      readingsOf(card.readings),
    );
    const row = card.statement;
    const paymentDate = row === null ? null : localDate(row.payment_date);
    return {
      card: {
        sourceId: card.sourceId,
        sourceAccount: card.sourceAccount,
        accountId: row?.account_id ?? null,
      },
      latestStatement:
        row === null
          ? null
          : {
              ref: {
                kind: "balance" as const,
                id: "balance:" + row.id,
                revision: "parse_run:" + row.parse_run_id,
              },
              period: row.period ?? null,
              paymentDate:
                paymentDate === null
                  ? null
                  : {
                      kind: "local-date" as const,
                      value: paymentDate,
                      zone: "Asia/Tokyo",
                      basis: "provider" as const,
                    },
              amount: sweepRowAmount(row),
            },
      stated,
      settled,
      proposed,
      answer: answerCardDebitAccount(stated, settled, proposed),
    } satisfies CardDebitAccountCard;
  });
  return {
    ok: true,
    review: {
      schemaVersion: "kogane-card-debit-accounts-v1",
      manifest: {
        rule: CARD_DEBIT_ACCOUNT_ANSWER_RULE,
        statedPolicy: CARD_DEBIT_ACCOUNT_POLICY,
        readerVersion: CARD_INFORMATION_READER_VERSION,
        bases: CARD_DEBIT_ACCOUNT_BASES,
        cardsMax: CARD_DEBIT_ACCOUNTS_CARDS_MAX,
      },
      items,
      cardsTruncated: listed.length < sorted.length,
    },
  };
}
