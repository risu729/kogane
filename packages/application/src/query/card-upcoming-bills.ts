// Each card's next bill, the account it is debited from and whether that
// account's reported balance covers it: the `upcoming` view of the card
// debit-account read (ADR 0114, 2026-11-19 amendment; docs/card-settlements.md,
// Upcoming bills; issues 1414 and 1415).
//
// The `カード照合` page's `次回の引落` section
// (`GET /api/v2/reconciliation/card-debit-accounts?view=upcoming`) and an agent
// (`kogane.card-settlements.debit-accounts` with `view: "upcoming"`) both call
// `reviewUpcomingCardBills` and nothing else, so a page and an agent read one
// answer (ADR 0081).
//
// It composes two existing answers and adds one keyed read:
//
// - `reviewCardDebitAccounts` (./card-debit-accounts.ts): each card's newest
//   current statement and its debit-account answer. It grades the grant
//   (`records.read` over the whole store, the card bound against `maxRows`)
//   before anything is read, and bounds the cards at 100 (`cardsTruncated`).
// - `queryDatedState` (./dated-state.ts) for the date: the provider-reported
//   balance of each debit account, and which account entity a bank source
//   account maps to (reported state is keyed by source account). It is called
//   with `includeStatementsBeforeWindow: false`, so it neither counts the
//   statements before the payable window nor lists the scheduled payments:
//   this read uses only the state's accounts and pins no reported-state
//   context id. A read past its row bound leaves every balance `missing` with
//   `reported_state_limit_exceeded`, never cut into a partial answer.
// - `ACCOUNT_LABELS_SQL`: the labels of the account entities named, by key.
//
// It reads, and nothing else: no lane, table, writer or command uses it.
import { CARD_DEBIT_ACCOUNT_ANSWER_RULE } from "../../../domain/src/card-debit-account-answer.ts";
import {
  CARD_UPCOMING_BILLS_RULE,
  CARD_UPCOMING_BILLS_SCHEMA,
  upcomingCardBills,
  type UpcomingAccountInput,
  type UpcomingCardBills,
  type UpcomingCardInput,
  type UpcomingDebitAccount,
} from "../../../domain/src/card-upcoming-bills.ts";
import {
  captureDate,
  REPORTED_STATE_ZONE,
  type ReportedAccount,
  type ReportedState,
} from "../../../domain/src/reported-state.ts";
import type { FinancialError } from "../../../domain/src/result.ts";
import { parseLocalDate } from "../../../domain/src/time.ts";
import { absentQuantity, type Quantity } from "../../../domain/src/values.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import type { Grant } from "../grants.ts";
import {
  CARD_DEBIT_ACCOUNTS_CARDS_MAX,
  reviewCardDebitAccounts,
  type CardDebitAccountCard,
} from "./card-debit-accounts.ts";
import { DatedStateLimitError, queryDatedState } from "./dated-state.ts";

/** The metric a debit account's balance is read from: a deposit's point-in-time balance. */
const UPCOMING_BALANCE_METRIC = "deposit.balance";

export interface UpcomingCardBillsReview extends UpcomingCardBills {
  schemaVersion: typeof CARD_UPCOMING_BILLS_SCHEMA;
  view: "upcoming";
  /** The civil date in Asia/Tokyo the bills are due from. */
  date: string;
  zone: typeof REPORTED_STATE_ZONE;
  rules: [typeof CARD_UPCOMING_BILLS_RULE, typeof CARD_DEBIT_ACCOUNT_ANSWER_RULE];
  cardsMax: number;
  /** True when more cards exist than `cardsMax`: cards past the bound are not listed. */
  cardsTruncated: boolean;
}

export type UpcomingCardBillsOutcome =
  | { ok: true; review: UpcomingCardBillsReview }
  | { ok: false; error: FinancialError };

/** The labels of the account entities named (`?1` a JSON array of ids), each by its key. */
export const ACCOUNT_LABELS_SQL = `SELECT a.id,a.label FROM json_each(?1) ids
 CROSS JOIN accounts a ON a.id=ids.value ORDER BY a.id`;

/** Today's civil date in Asia/Tokyo at `now` (epoch milliseconds). */
export function tokyoDate(now: number): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

const sourceKey = (sourceId: string, sourceAccount: string) =>
  "source:" + JSON.stringify([sourceId, sourceAccount]);

interface ResolvedAccount {
  key: string;
  account: string | null;
  sourceAccount: string;
  references: ReportedAccount[];
}

/**
 * The account entity a bank source account maps to in the reported state,
 * and the entity's source-account references: one entity when the source
 * account's entries name exactly one, else the source account itself.
 */
function resolveAccount(
  state: Pick<ReportedState, "accounts"> | null,
  sourceId: string,
  sourceAccount: string,
): ResolvedAccount {
  const entries = (state?.accounts ?? []).filter(
    (entry) => entry.sourceId === sourceId && entry.sourceAccount === sourceAccount,
  );
  const ids = [...new Set(entries.map((entry) => entry.accountId))];
  const account = ids.length === 1 ? ids[0] : undefined;
  if (typeof account === "string") {
    return {
      key: "entity:" + account,
      account,
      sourceAccount,
      references: state!.accounts.filter((entry) => entry.accountId === account),
    };
  }
  return {
    key: sourceKey(sourceId, sourceAccount),
    account: null,
    sourceAccount,
    references: entries,
  };
}

/**
 * The entity's reported balance in `unit`: the `deposit.balance` of the newest
 * capture among its references. Two references captured together that state
 * different values are a conflict; none is `missing`. Never a sum (INV06):
 * every reference is the same account.
 */
function reportedBalance(
  resolved: ResolvedAccount,
  unit: string,
  stateReason: string | null,
): { balance: Quantity; capturedAt: string | null } {
  if (stateReason !== null)
    return { balance: absentQuantity(unit, "missing", stateReason), capturedAt: null };
  const found: { balance: Quantity; capturedAt: string }[] = [];
  for (const entry of resolved.references)
    for (const balance of entry.balances) {
      if (balance.metric.metricId !== UPCOMING_BALANCE_METRIC || balance.amount.unitRef !== unit)
        continue;
      const snapshot = entry.snapshots.find((item) => item.ref === balance.snapshotRef);
      if (snapshot === undefined) throw new Error("upcoming_bill_snapshot_missing");
      found.push({ balance: balance.amount, capturedAt: snapshot.capturedAt });
    }
  if (found.length === 0)
    return { balance: absentQuantity(unit, "missing", "balance_not_reported"), capturedAt: null };
  const newest = found.reduce((a, b) => (b.capturedAt > a.capturedAt ? b : a)).capturedAt;
  const latest = found.filter((item) => item.capturedAt === newest);
  const values = new Set(latest.map((item) => JSON.stringify(item.balance.value)));
  return values.size === 1
    ? latest[0]!
    : { balance: absentQuantity(unit, "conflict", "balances_disagree"), capturedAt: newest };
}

const localDate = (value: string | null | undefined): string | null =>
  typeof value === "string" && parseLocalDate(value) !== null ? value : null;

/** The reported state on a date, as far as upcoming bills read it: its accounts. */
export type UpcomingReportedStateRead = (
  sql: SqlExecutor,
  date: string,
) => Promise<Pick<ReportedState, "accounts">>;

/**
 * The state this read builds on: without the count of the statements before
 * the payable window and without the scheduled payments, which it never uses.
 */
const readAccountsState: UpcomingReportedStateRead = (sql, date) =>
  queryDatedState(sql, { date, includeStatementsBeforeWindow: false });

/**
 * Each card's next bill on `date` (`YYYY-MM-DD`, Asia/Tokyo; the adapters pass
 * today), for whoever the grant allows. Reads only.
 */
export function reviewUpcomingCardBills(input: {
  grant: Grant;
  sql: SqlExecutor;
  date: string;
}): Promise<UpcomingCardBillsOutcome> {
  return reviewUpcomingCardBillsWith(input, readAccountsState);
}

/**
 * `reviewUpcomingCardBills` over the reported state `readState` answers. Only
 * the tests call it with another read: the full state the view read until
 * 2026-11-21, to show the answer does not depend on which one it reads.
 */
export async function reviewUpcomingCardBillsWith(
  input: { grant: Grant; sql: SqlExecutor; date: string },
  readState: UpcomingReportedStateRead,
): Promise<UpcomingCardBillsOutcome> {
  const { grant, sql, date } = input;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(date) || parseLocalDate(date) === null)
    throw new Error("invalid_date");
  const outcome = await reviewCardDebitAccounts({ grant, sql });
  if (!outcome.ok) return outcome;
  const { items, cardsTruncated } = outcome.review;

  let state: Pick<ReportedState, "accounts"> | null = null;
  let stateReason: string | null = null;
  try {
    state = await readState(sql, date);
  } catch (error) {
    if (!(error instanceof DatedStateLimitError)) throw error;
    stateReason = "reported_state_limit_exceeded";
  }

  // Every bank account an answer or an accepted settlement names, resolved once.
  const resolved = new Map<string, ResolvedAccount>();
  const resolve = (sourceId: string, sourceAccount: string): ResolvedAccount => {
    const id = sourceKey(sourceId, sourceAccount);
    let found = resolved.get(id);
    if (found === undefined) {
      found = resolveAccount(state, sourceId, sourceAccount);
      resolved.set(id, found);
    }
    return found;
  };
  const named = (item: CardDebitAccountCard): ResolvedAccount | null =>
    item.answer.basis === "unknown"
      ? null
      : resolve(item.answer.account.bankSourceId, item.answer.account.bankSourceAccount);

  const ids = new Set<string>();
  for (const item of items) {
    if (item.card.accountId !== null) ids.add(item.card.accountId);
    const account = named(item)?.account;
    if (account) ids.add(account);
  }
  const labels = new Map(
    (
      await sql.all<{ id: string; label: string }>(ACCOUNT_LABELS_SQL, [
        JSON.stringify([...ids].sort()),
      ])
    ).map((row) => [row.id, row.label]),
  );

  // The latest card debit from each account due on or before the date that
  // this read knows of: each card's newest accepted settlement's debit per
  // bank account, or the newest statement, when already due, of a card the
  // account answers for; a card's older statements are not considered
  // (docs/card-settlements.md, Upcoming bills, limits). A balance captured on
  // or before it may not show it.
  const previous = new Map<string, string>();
  const debited = (key: string, value: string | null) => {
    if (value === null || value > date) return;
    const known = previous.get(key);
    if (known === undefined || value > known) previous.set(key, value);
  };
  for (const item of items) {
    for (const settled of item.settled)
      debited(
        resolve(settled.bankSourceId, settled.bankSourceAccount).key,
        localDate(settled.latest.debitDate),
      );
    const account = named(item);
    const due = localDate(
      item.latestStatement?.paymentDate?.kind === "local-date"
        ? item.latestStatement.paymentDate.value
        : null,
    );
    if (account !== null && due !== null && due < date) debited(account.key, due);
  }

  const cards: UpcomingCardInput[] = items.map((item) => {
    const account = named(item);
    const answer = item.answer;
    const debitAccount: UpcomingDebitAccount =
      answer.basis === "unknown"
        ? {
            answer: "unknown",
            key: null,
            account: null,
            sourceAccount: null,
            label: null,
            since: null,
            codes: [answer.reason],
          }
        : {
            answer: answer.basis,
            key: account!.key,
            account: account!.account,
            sourceAccount: account!.sourceAccount,
            label: account!.account === null ? null : (labels.get(account!.account) ?? null),
            since:
              answer.basis === "provider-stated"
                ? captureDate(answer.observedAt)
                : localDate(answer.debitDate),
            codes: [...answer.codes],
          };
    const statement = item.latestStatement;
    return {
      card: {
        source: item.card.sourceId,
        sourceAccount: item.card.sourceAccount,
        label: item.card.accountId === null ? null : (labels.get(item.card.accountId) ?? null),
      },
      statement:
        statement === null
          ? null
          : {
              period: statement.period,
              paymentDate:
                statement.paymentDate?.kind === "local-date"
                  ? localDate(statement.paymentDate.value)
                  : null,
              amount: statement.amount,
            },
      settledPeriods: item.settled.flatMap((settled) =>
        settled.latest.period === null ? [] : [settled.latest.period],
      ),
      debitAccount,
    };
  });

  // The balance of every account a bill is debited from, in the bills' unit.
  const accounts = new Map<string, UpcomingAccountInput>();
  for (const card of cards) {
    const key = card.debitAccount.key;
    if (key === null || card.statement === null || accounts.has(key)) continue;
    const account = [...resolved.values()].find((entry) => entry.key === key)!;
    const { balance, capturedAt } = reportedBalance(
      account,
      card.statement.amount.unitRef,
      stateReason,
    );
    accounts.set(key, { balance, capturedAt, previousDebit: previous.get(key) ?? null });
  }

  return {
    ok: true,
    review: {
      schemaVersion: CARD_UPCOMING_BILLS_SCHEMA,
      view: "upcoming",
      date,
      zone: REPORTED_STATE_ZONE,
      rules: [CARD_UPCOMING_BILLS_RULE, CARD_DEBIT_ACCOUNT_ANSWER_RULE],
      cardsMax: CARD_DEBIT_ACCOUNTS_CARDS_MAX,
      ...upcomingCardBills({ date, cards, accounts }),
      cardsTruncated,
    },
  };
}
