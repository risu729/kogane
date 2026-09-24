// One bounded read path that explains recognised card purchases: the provider
// rows behind each event, the provider statement it was posted to, the
// reviewed settlement of that statement and the bank debit that paid it. It
// never writes, and it never computes a difference between a statement total
// and the purchases on it (docs/card-settlements.md): a statement total is the
// provider's own figure and is shown beside the purchase figures, never
// subtracted from them or summed with them.
//
// The chain is derived at read time, never from an allocation:
//
//   purchase (resolved account, source, statement period `YYYY-MM`)
//     → card_statement_facts whose card_settlement_fact_ownership(kind='balance')
//       resolves to the same account (so a changed card ordinal still joins)
//     → card_settlement_reviews of that (source, account, period), accepted first
//     → its settlement event, its `settlement` allocation and the bank debit
//       cited in its facts.
//
// Every figure is an exact decimal added in `@kogane/domain`; no SQL sums an
// amount. States stay apart: `captured` and `authorized` are never added, and
// an `unknown` event is counted, never summed.
import {
  CARD_USAGE_EXCLUSIONS,
  cardPurchaseSummary,
  validCardPurchaseFacts,
  type CardPurchaseAction,
  type CardPurchaseKeyRole,
  type CardPurchaseKind,
  type CardPurchaseSourceId,
} from "../../../domain/src/card-purchase.ts";
import type {
  CardPurchasePage,
  CardPurchaseRevisionEntry,
  CardPurchaseSettlementLink,
  CardPurchaseSourceRow,
  CardPurchaseStatementLink,
  CardPurchaseView,
} from "../../../domain/src/card-purchase-view.ts";
import {
  validCardSettlementFacts,
  type CardSettlementStatus,
} from "../../../domain/src/card-settlement.ts";
import {
  validSourceFactRef,
  type EconomicEventRevision,
  type EconomicLeg,
  type EventState,
  type LegRole,
  type RecognitionBasis,
  type SourceFactRef,
  type UnknownStateReason,
} from "../../../domain/src/events.ts";
import { validLocalDateText, type TemporalValue } from "../../../domain/src/time.ts";
import {
  absentQuantity,
  exactQuantity,
  normalizeDecimal,
  type Quantity,
} from "../../../domain/src/values.ts";
import { cardSettlementOwnershipCtes } from "../../../read-model/src/card-settlement-ownership.ts";
import { CURRENT_CARD_USAGE_SQL } from "../../../read-model/src/card-usage.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

export const CARD_PURCHASE_PAGE_SIZE = 50;
/** Revisions listed per event, newest first; older ones stay stored. */
const CARD_PURCHASE_HISTORY_LIMIT = 20;
/**
 * Live events one request may total. The figures cover the whole filter, so a
 * larger filter is refused rather than partially summed; a statement period
 * narrows it.
 */
const CARD_PURCHASE_SUMMARY_LIMIT = 10_000;
export const CARD_PURCHASE_PERIOD = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/u;
export const CARD_PURCHASE_EVENT_ID = /^(?:purchase|refund)_[0-9a-f]{64}$/u;
/** The provider usage and statement dates are Japanese civil dates. */
const ZONE = "Asia/Tokyo";

/** The filter selects more live events than one answer may total. */
export class CardPurchaseLimitError extends Error {
  constructor() {
    super("card_purchase_summary_limit");
  }
}

export interface CardPurchaseQuery {
  offset?: number;
  /** A statement period, `YYYY-MM`. */
  period?: string;
  /** One event, `purchase_<sha256>` or `refund_<sha256>`. */
  eventId?: string;
}

/**
 * One row of the whole-filter selection: only what the figures, the order and
 * the statement links need. The evidence, the decision and the stored facts
 * of an event are read for the page's events alone (PAGE_SQL), so a filter of
 * thousands of events transfers a few hundred bytes per event.
 */
interface SelectionRow {
  event_id: string;
  revision: number;
  kind: CardPurchaseKind;
  state: EventState;
  unknown_reason: UnknownStateReason | null;
  account_id: string;
  source_id: CardPurchaseSourceId;
  statement_period: string | null;
  provider_status: string | null;
  usage_date: string | null;
  leg_index: number | null;
  subject_ref: string | null;
  unit_ref: string | null;
  value_status: string | null;
  coefficient: string | null;
  scale: number | null;
  value_reason_code: string | null;
  role: LegRole | null;
  basis: RecognitionBasis | null;
}
interface LiveEvent {
  eventId: string;
  revision: number;
  kind: CardPurchaseKind;
  state: EventState;
  unknownReason: UnknownStateReason | null;
  accountId: string;
  sourceId: CardPurchaseSourceId;
  statementPeriod: string | null;
  posted: boolean;
  /** The provider usage date (`facts_json.usageDate`), which is also the event's effective date. */
  usageDate: string;
  legs: EconomicLeg[];
}
/** The page's own columns, read for at most one page of events. */
interface PageRow {
  event_id: string;
  facts_json: string;
  evidence_support_json: string;
  decision_revision_id: string;
}
interface KeyRow {
  event_id: string;
  recognition_key: string;
  role: CardPurchaseKeyRole;
  observation_id: number;
  parse_run_id: number;
  as_of: string | null;
  counterparty: string | null;
  raw_locator: string | null;
}
interface HistoryRow {
  event_id: string;
  revision: number;
  action: CardPurchaseAction;
  state: EventState;
  unknown_reason: UnknownStateReason | null;
  decision_revision_id: string;
  created_at: string;
}
interface AmountRow {
  event_id: string;
  revision: number;
  unit_ref: string;
  value_status: string;
  coefficient: string | null;
  scale: number | null;
  value_reason_code: string | null;
}
interface StatementRow {
  account_id: string;
  source_id: CardPurchaseSourceId;
  period: string;
  id: number;
  parse_run_id: number;
  unit_ref: string;
  value_status: string | null;
  coefficient: string | null;
  scale: number | null;
  payment_date: string | null;
}
interface SettlementRow {
  account_id: string;
  source_id: string;
  period: string;
  id: string;
  facts_json: string;
  status: CardSettlementStatus;
  decision_revision_id: string | null;
  event_id: string | null;
  settlement_id: string | null;
}
interface CurrentRow {
  current_key: string | null;
  unrecognized: number | null;
}

/**
 * Every live purchase/refund revision the filter selects, with its one leg (a
 * retirement has none, so the leg columns are NULL). At most one leg per
 * revision is a 0047 invariant, so a row is an event. Only the columns the
 * figures, the order and the statement links read; the rest is PAGE_SQL's.
 */
const SELECTION_SQL = `SELECT c.event_id,c.revision,c.kind,c.state,c.unknown_reason,c.account_id,c.source_id,
  c.statement_period,json_extract(c.facts_json,'$.providerStatus') AS provider_status,
  json_extract(c.facts_json,'$.usageDate') AS usage_date,
  l.leg_index,l.subject_ref,l.unit_ref,l.value_status,l.coefficient,l.scale,l.value_reason_code,l.role,l.basis
 FROM current_card_purchase_recognitions c
 LEFT JOIN economic_legs l ON l.event_id=c.event_id AND l.revision=c.revision
 WHERE (?1 IS NULL OR c.statement_period=?1) AND (?2 IS NULL OR c.event_id=?2)
 LIMIT ?3`;

/**
 * The stored facts (validated before anything is shown), the evidence and the
 * decision of the page's live revisions, by the exact revision selected.
 */
const PAGE_SQL = `SELECT c.event_id,c.facts_json,r.evidence_support_json,r.decision_revision_id
 FROM card_purchase_recognitions c
 JOIN json_each(?1) selected ON c.event_id=json_extract(selected.value,'$.eventId')
  AND c.revision=json_extract(selected.value,'$.revision')
 JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision`;

/** The provider rows of the page's live revisions: posted first, then pending. */
const KEYS_SQL = `SELECT k.event_id,k.recognition_key,k.role,k.observation_id,k.parse_run_id,
  t.as_of,t.counterparty,t.raw_locator
 FROM card_purchase_recognition_keys k
 JOIN json_each(?1) selected ON k.event_id=json_extract(selected.value,'$.eventId')
  AND k.revision=json_extract(selected.value,'$.revision')
 JOIN transaction_observations t ON t.id=k.observation_id
 ORDER BY k.event_id,k.role='posted' DESC,k.observation_id`;

/** Newest revisions first, never past the live revision that was read. */
const HISTORY_SQL = `SELECT event_id,revision,action,state,unknown_reason,decision_revision_id,created_at FROM (
  SELECT c.event_id,c.revision,c.action,r.state,r.unknown_reason,r.decision_revision_id,c.created_at,
   ROW_NUMBER() OVER (PARTITION BY c.event_id ORDER BY c.revision DESC) AS ordinal
  FROM card_purchase_recognitions c
  JOIN json_each(?1) selected ON c.event_id=json_extract(selected.value,'$.eventId')
   AND c.revision<=json_extract(selected.value,'$.revision')
  JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision
 ) WHERE ordinal<=?2 ORDER BY event_id,revision DESC`;

/**
 * The newest purchase-recognition leg up to the live revision: the last known
 * amount. `CROSS JOIN` keeps the page's events as the outer loop: without
 * table statistics (D1 is never analyzed) the planner otherwise walks every
 * purchase-recognition leg ever written through `economic_legs_basis`.
 */
const LAST_AMOUNT_SQL = `SELECT event_id,revision,unit_ref,value_status,coefficient,scale,value_reason_code FROM (
  SELECT l.event_id,l.revision,l.unit_ref,l.value_status,l.coefficient,l.scale,l.value_reason_code,
   ROW_NUMBER() OVER (PARTITION BY l.event_id ORDER BY l.revision DESC,l.leg_index) AS ordinal
  FROM json_each(?1) selected
  CROSS JOIN economic_legs l ON l.event_id=json_extract(selected.value,'$.eventId')
   AND l.revision<=json_extract(selected.value,'$.revision')
  WHERE l.basis='purchase-recognition'
 ) WHERE ordinal=1`;

/**
 * The newest published provider statement of each (resolved account, source,
 * period). The account is the statement observation's own resolved account
 * (`card_settlement_fact_ownership`), so a card ordinal that changed under one
 * account still joins, and a statement whose mapping is ambiguous (NULL) joins
 * nothing.
 *
 * The owner is resolved for the requested statements only, through the keyed
 * form of the ownership view (card-settlement-ownership.ts): the view itself
 * starts from every published parse run and groups every balance identity, which
 * on D1's unanalyzed planner cost more than the rest of the page together
 * (docs/card-settlements.md, Cost). `card_statement_facts` is still read whole
 * once: its newest capture per statement is ranked over the statement totals of
 * the whole history.
 */
export const STATEMENT_SQL = `WITH wanted AS MATERIALIZED (
  SELECT DISTINCT json_extract(value,'$[0]') AS account_id,json_extract(value,'$[1]') AS source_id,
   json_extract(value,'$[2]') AS period FROM json_each(?1)
 ), statements AS MATERIALIZED (
  SELECT s.id,s.parse_run_id,s.source_id,s.period,s.fetched_at,s.unit_ref,s.value_status,s.coefficient,s.scale,s.payment_date
  FROM card_statement_facts s
  WHERE EXISTS(SELECT 1 FROM wanted WHERE wanted.source_id=s.source_id AND wanted.period=s.period)
 ), observed AS (SELECT id AS observation_id FROM statements),
 ${cardSettlementOwnershipCtes("balance")}
 SELECT account_id,source_id,period,id,parse_run_id,unit_ref,value_status,coefficient,scale,payment_date FROM (
  SELECT wanted.account_id,wanted.source_id,wanted.period,statements.id,statements.parse_run_id,statements.unit_ref,
   statements.value_status,statements.coefficient,statements.scale,statements.payment_date,
   ROW_NUMBER() OVER (PARTITION BY wanted.account_id,wanted.source_id,wanted.period
    ORDER BY statements.fetched_at DESC,statements.id DESC) AS position
  FROM wanted
  JOIN statements ON statements.source_id=wanted.source_id AND statements.period=wanted.period
  JOIN ownership ON ownership.observation_id=statements.id AND ownership.account_id=wanted.account_id
 ) WHERE position=1`;

/**
 * One settlement review per statement (source, account, period), the key 0044
 * reserves an acceptance under: accepted first, then a review still due, then
 * a withdrawn and finally a rejected one, newest first within each. The three
 * `json_extract` terms are the expressions of
 * `card_settlement_candidates_statement_period` (migration 0048), which reaches
 * each key's reviews directly; they must stay written exactly so.
 */
export const SETTLEMENT_SQL = `SELECT account_id,source_id,period,id,facts_json,status,decision_revision_id,event_id,settlement_id FROM (
  SELECT w.account_id,w.source_id,w.period,c.id,c.facts_json,c.status,c.decision_revision_id,c.event_id,c.settlement_id,
   ROW_NUMBER() OVER (PARTITION BY w.account_id,w.source_id,w.period
    ORDER BY CASE c.status WHEN 'accepted' THEN 0 WHEN 'proposed' THEN 1 WHEN 'withdrawn' THEN 2 ELSE 3 END,
     c.created_at DESC,c.id DESC) AS position
  FROM (SELECT DISTINCT json_extract(value,'$[0]') AS account_id,json_extract(value,'$[1]') AS source_id,
    json_extract(value,'$[2]') AS period FROM json_each(?1)) w
  JOIN card_settlement_reviews c
   ON json_extract(c.facts_json,'$.statement.accountId')=w.account_id
   AND json_extract(c.facts_json,'$.statement.sourceId')=w.source_id
   AND json_extract(c.facts_json,'$.statement.period')=w.period
 ) WHERE position=1`;

/**
 * Which of the page's recognition keys the provider still displays, and how
 * many current usage rows no live event holds, in one pass over the one
 * definition of "current" (packages/read-model/src/card-usage.ts). `?1`/`?2`
 * are that query's cursor and page size: from the start, without a bound (a
 * negative LIMIT is none in SQLite). An unrecognised row is one the policy
 * excludes (installments, revolving, bonus, amountless, unstable identity) or
 * one the writer has not reached yet; a row without an external id has no key
 * and is always unrecognised.
 */
const CURRENT_SQL = `WITH usage AS MATERIALIZED (
  SELECT recognition_key FROM (${CURRENT_CARD_USAGE_SQL})
 )
 SELECT recognition_key AS current_key,NULL AS unrecognized FROM usage
  WHERE recognition_key IN (SELECT value FROM json_each(?3))
 UNION ALL
 SELECT NULL,count(*) FROM usage u
  WHERE u.recognition_key IS NULL
   OR NOT EXISTS(SELECT 1 FROM current_card_purchase_keys k WHERE k.recognition_key=u.recognition_key)`;

function quantity(
  unitRef: string,
  status: string | null,
  coefficient: string | null,
  scale: number | null,
  reasonCode: string | null,
): Quantity {
  if (status === "exact" && coefficient !== null && scale !== null)
    return exactQuantity(unitRef, normalizeDecimal(BigInt(coefficient), scale), "decimal-v1");
  const absent =
    status === "missing" || status === "unparsed" || status === "conflict" ? status : "missing";
  return absentQuantity(unitRef, absent, reasonCode ?? `stored:${status ?? "absent"}`);
}

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
}

/** Group the selected rows (one per leg) into events. */
function liveEvents(rows: readonly SelectionRow[]): LiveEvent[] {
  const events = new Map<string, LiveEvent>();
  for (const row of rows) {
    let event = events.get(row.event_id);
    if (event === undefined) {
      if (row.usage_date === null || !validLocalDateText(row.usage_date))
        throw new Error("card_purchase_facts_invalid");
      event = {
        eventId: row.event_id,
        revision: row.revision,
        kind: row.kind,
        state: row.state,
        unknownReason: row.unknown_reason,
        accountId: row.account_id,
        sourceId: row.source_id,
        statementPeriod: row.statement_period,
        posted: row.provider_status === "posted" || row.provider_status === "confirmed",
        usageDate: row.usage_date,
        legs: [],
      };
      events.set(row.event_id, event);
    }
    if (row.leg_index === null || row.unit_ref === null) continue;
    event.legs.push({
      eventId: row.event_id,
      revision: row.revision,
      legIndex: row.leg_index,
      subjectRef: row.subject_ref ?? "",
      quantity: quantity(
        row.unit_ref,
        row.value_status,
        row.coefficient,
        row.scale,
        row.value_reason_code,
      ),
      role: row.role ?? "unresolved",
      basis: row.basis ?? "unknown",
    });
  }
  return [...events.values()];
}

/**
 * The live revision as `cardPurchaseSummary` reads it: kind, state,
 * supersession and legs. Its evidence and decision are never read by the
 * summary, so the whole-filter selection does not carry them; the effective
 * time is the usage date the recognition writer sets it to.
 */
function summaryRevision(event: LiveEvent): EconomicEventRevision {
  return {
    eventId: event.eventId,
    revision: event.revision,
    kind: event.kind,
    state: event.state,
    unknownReason: event.unknownReason,
    effectiveTime: { kind: "local-date", value: event.usageDate, zone: ZONE, basis: "provider" },
    basis: "purchase-recognition",
    evidenceSupport: [],
    decisionRevisionRef: "",
    supersededBy: null,
    legs: event.legs,
  };
}

/** Newest usage first; the event id breaks ties, so the order is total and pages are stable. */
function byUsageDate(a: LiveEvent, b: LiveEvent): number {
  if (a.usageDate !== b.usageDate) return a.usageDate < b.usageDate ? 1 : -1;
  const x = a.eventId,
    y = b.eventId;
  return x < y ? 1 : x > y ? -1 : 0;
}

const tripleKey = (accountId: string, sourceId: string, period: string): string =>
  JSON.stringify([accountId, sourceId, period]);

type LinkedStatement = Extract<CardPurchaseStatementLink, { status: "linked" }>;

function statementLink(row: StatementRow): LinkedStatement {
  const paymentDate: TemporalValue =
    row.payment_date !== null && validLocalDateText(row.payment_date)
      ? { kind: "local-date", value: row.payment_date, zone: ZONE, basis: "provider" }
      : { kind: "unknown", reasonCode: "payment_date_absent" };
  return {
    status: "linked",
    ref: { kind: "balance", id: `balance:${row.id}`, revision: `parse_run:${row.parse_run_id}` },
    period: row.period,
    paymentDate,
    providerTotal: quantity(
      row.unit_ref,
      row.value_status,
      row.coefficient,
      row.scale,
      row.value_status === null ? "decimal_not_projected" : null,
    ),
  };
}

/** A malformed stored settlement is an unavailable answer, never a plausible blank. */
function settlementLink(row: SettlementRow): CardPurchaseSettlementLink {
  const facts: unknown = parseJson(row.facts_json, "card_settlement_facts_invalid");
  if (!validCardSettlementFacts(facts)) throw new Error("card_settlement_facts_invalid");
  const accepted = row.status === "accepted";
  return {
    proposalId: row.id,
    reviewStatus: row.status,
    decisionRevisionId: row.decision_revision_id,
    settlementEventId: accepted ? row.event_id : null,
    allocationId: accepted ? row.settlement_id : null,
    bankDebit: accepted
      ? {
          ref: facts.bankDebit.ref,
          sourceId: facts.bankDebit.sourceId,
          amount: facts.bankDebit.amount,
          occurred: facts.bankDebit.occurred,
        }
      : null,
  };
}

const refText = (ref: SourceFactRef): string => `${ref.id}@${ref.revision}`;

/**
 * Offset lists, a statement-period filter and exact-id reads share one DTO.
 * The summary covers every live event the filter selects, not only the page.
 */
export async function queryCardPurchases(
  sql: SqlExecutor,
  input: CardPurchaseQuery = {},
): Promise<CardPurchasePage> {
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
    throw new Error("invalid_offset");
  const period = input.period ?? null;
  const eventId = input.eventId ?? null;
  if (period !== null && !CARD_PURCHASE_PERIOD.test(period)) throw new Error("invalid_period");
  if (eventId !== null && !CARD_PURCHASE_EVENT_ID.test(eventId))
    throw new Error("invalid_event_id");

  const rows = await sql.all<SelectionRow>(SELECTION_SQL, [
    period,
    eventId,
    CARD_PURCHASE_SUMMARY_LIMIT + 1,
  ]);
  if (rows.length > CARD_PURCHASE_SUMMARY_LIMIT) throw new CardPurchaseLimitError();
  const events = liveEvents(rows).sort(byUsageDate);
  const totals = cardPurchaseSummary(events.map(summaryRevision));
  if (!totals.ok) throw new Error("card_purchase_amount_invalid");

  // Statements and their settlements, for every posted event of the filter:
  // the page needs its own, and the summary shows all of them beside the figures.
  const triples = new Map<string, [string, string, string]>();
  for (const event of events)
    if (event.posted && event.statementPeriod !== null)
      triples.set(tripleKey(event.accountId, event.sourceId, event.statementPeriod), [
        event.accountId,
        event.sourceId,
        event.statementPeriod,
      ]);
  const statements = new Map<string, { row: StatementRow; link: LinkedStatement }>();
  if (triples.size > 0)
    for (const row of await sql.all<StatementRow>(STATEMENT_SQL, [
      JSON.stringify([...triples.values()]),
    ]))
      statements.set(tripleKey(row.account_id, row.source_id, row.period), {
        row,
        link: statementLink(row),
      });
  const settlements = new Map<string, CardPurchaseSettlementLink>();
  if (statements.size > 0)
    for (const row of await sql.all<SettlementRow>(SETTLEMENT_SQL, [
      JSON.stringify(
        [...statements.values()].map(({ row }) => [row.account_id, row.source_id, row.period]),
      ),
    ]))
      settlements.set(tripleKey(row.account_id, row.source_id, row.period), settlementLink(row));

  const page = events.slice(offset, offset + CARD_PURCHASE_PAGE_SIZE);
  const selected = JSON.stringify(
    page.map((event) => ({ eventId: event.eventId, revision: event.revision })),
  );
  const [pageRows, keyRows, historyRows, amountRows] =
    page.length === 0
      ? [[], [], [], []]
      : await Promise.all([
          sql.all<PageRow>(PAGE_SQL, [selected]),
          sql.all<KeyRow>(KEYS_SQL, [selected]),
          sql.all<HistoryRow>(HISTORY_SQL, [selected, CARD_PURCHASE_HISTORY_LIMIT + 1]),
          sql.all<AmountRow>(LAST_AMOUNT_SQL, [selected]),
        ]);
  const details = new Map<string, { evidence: unknown[]; decisionRevisionId: string }>();
  for (const row of pageRows) {
    if (!validCardPurchaseFacts(parseJson(row.facts_json, "card_purchase_facts_invalid")))
      throw new Error("card_purchase_facts_invalid");
    const evidence = parseJson(row.evidence_support_json, "card_purchase_event_invalid");
    if (!Array.isArray(evidence)) throw new Error("card_purchase_event_invalid");
    details.set(row.event_id, { evidence, decisionRevisionId: row.decision_revision_id });
  }
  if (details.size !== page.length) throw new Error("card_purchase_facts_invalid");

  // One pass over current usage: the page's current keys and the unrecognised count.
  const current = await sql.all<CurrentRow>(CURRENT_SQL, [
    0,
    -1,
    JSON.stringify([...new Set(keyRows.map((row) => row.recognition_key))]),
  ]);
  const currentKeys = new Set(
    current.flatMap((row) => (row.current_key === null ? [] : [row.current_key])),
  );
  const unrecognizedCurrentRows = current.find((row) => row.current_key === null)?.unrecognized;
  if (typeof unrecognizedCurrentRows !== "number") throw new Error("card_usage_count_missing");

  const items = page.map((event): CardPurchaseView => {
    const id = event.eventId;
    const detail = details.get(id)!;
    const sourceRows: CardPurchaseSourceRow[] = keyRows
      .filter((row) => row.event_id === id)
      .map((row) => ({
        role: row.role,
        ref: {
          kind: "transaction",
          id: `transaction:${row.observation_id}`,
          revision: `parse_run:${row.parse_run_id}`,
        },
        usageDate: row.as_of,
        counterparty: row.counterparty,
        current: currentKeys.has(row.recognition_key),
        rawLocator: row.raw_locator,
      }));
    const leg = event.legs.find((entry) => entry.basis === "purchase-recognition") ?? null;
    const last = amountRows.find((row) => row.event_id === id);
    const lastKnownAmount =
      leg?.quantity ??
      (last === undefined
        ? null
        : quantity(
            last.unit_ref,
            last.value_status,
            last.coefficient,
            last.scale,
            last.value_reason_code,
          ));
    const found =
      event.posted && event.statementPeriod !== null
        ? statements.get(tripleKey(event.accountId, event.sourceId, event.statementPeriod))
        : undefined;
    const statement: CardPurchaseStatementLink = !event.posted
      ? { status: "unlinked", reasonCode: "not_posted" }
      : event.statementPeriod === null
        ? { status: "unlinked", reasonCode: "period_unrecognized" }
        : (found?.link ?? { status: "unlinked", reasonCode: "statement_not_collected" });
    const settlement =
      found === undefined
        ? null
        : (settlements.get(tripleKey(event.accountId, event.sourceId, found.row.period)) ?? null);
    const revisions = historyRows.filter((row) => row.event_id === id);
    const history: CardPurchaseRevisionEntry[] = revisions
      .slice(0, CARD_PURCHASE_HISTORY_LIMIT)
      .map((row) => ({
        revision: row.revision,
        action: row.action,
        state: row.state,
        unknownReason: row.unknown_reason,
        decisionRevisionId: row.decision_revision_id,
        createdAt: row.created_at,
      }));
    const explanationRefs = [
      ...new Set([
        `event:${id}@${event.revision}`,
        ...event.legs.map((entry) => `leg:${id}@${event.revision}#${entry.legIndex}`),
        `decision_revision:${detail.decisionRevisionId}`,
        ...sourceRows.map((row) => refText(row.ref)),
        // Recognition stores SourceFactRef objects; anything else is not a citation.
        ...detail.evidence.filter(validSourceFactRef).map(refText),
        ...(statement.status === "linked" ? [refText(statement.ref)] : []),
        ...(settlement === null
          ? []
          : [
              `card-settlement:${settlement.proposalId}`,
              ...(settlement.settlementEventId === null
                ? []
                : [`event:${settlement.settlementEventId}`]),
              ...(settlement.allocationId === null
                ? []
                : [`allocation:${settlement.allocationId}`]),
              ...(settlement.bankDebit === null ? [] : [refText(settlement.bankDebit.ref)]),
            ]),
      ]),
    ];
    return {
      eventId: id,
      revision: event.revision,
      kind: event.kind,
      state: event.state,
      unknownReason: event.unknownReason,
      sourceId: event.sourceId,
      accountId: event.accountId,
      usageDate: event.usageDate,
      statementPeriod: event.statementPeriod,
      amount: leg?.quantity ?? null,
      lastKnownAmount,
      sourceRows,
      statement,
      settlement,
      history,
      historyTruncated: revisions.length > CARD_PURCHASE_HISTORY_LIMIT,
      explanationRefs,
    };
  });

  const statementTotals = [...statements.values()]
    .map(({ row, link }) => ({
      sourceId: row.source_id,
      accountId: row.account_id,
      period: row.period,
      ref: link.ref,
      total: link.providerTotal,
    }))
    .sort((a, b) => {
      const x = [b.period, a.sourceId, a.accountId].join("\u0000");
      const y = [a.period, b.sourceId, b.accountId].join("\u0000");
      return x < y ? -1 : x > y ? 1 : 0;
    });

  return {
    items,
    nextOffset:
      offset + CARD_PURCHASE_PAGE_SIZE < events.length ? offset + CARD_PURCHASE_PAGE_SIZE : null,
    summary: {
      units: totals.summary.units,
      unresolved: totals.summary.unresolved,
      events: events.length,
      statementTotals,
      settlementAddsPurchaseExpense: false,
    },
    coverage: {
      scope: "card-purchase-recognition",
      completeTransactionHistory: false,
      unsupportedShapes: [...CARD_USAGE_EXCLUSIONS],
      unrecognizedCurrentRows,
      limit: CARD_PURCHASE_PAGE_SIZE,
    },
  };
}
