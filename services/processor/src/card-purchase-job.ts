// Card purchase recognition (card purchase plan §1, PR2 and PR4): the bounded
// writer that turns adopted Vpass and MyJCB usage rows into `purchase` and
// `refund` events on the `purchase-recognition` basis.
//
// Why this is automatic. Recognising one posted usage row as a purchase
// asserts no correspondence between two claims (INV07): the provider itself
// states that the charge was posted to that card, inside one verified
// namespace (source + producer + external id namespace + source account). The
// row is adopted when its parse run is published and it belongs to the latest
// complete snapshot (`currentCardUsageSql`, the one definition of "current").
// Every revision is still recorded as a `rule` decision under
// `rule:card-purchase-recognition-v1`, and the scope is deliberately narrow:
// only single-payment rows with an exact amount and a stable card identity are
// recognised (`classifyCardUsage`); every other row is skipped with a reason
// code and never guessed (INV05). Linking a pending row to its posted row as
// one purchase is a reviewed decision (the change lifecycle's
// `relation.accept`, packages/application/src/operations/pending-posted-review.ts),
// except for a pair the provider itself linked; refund allocation and "this
// row is not a purchase" stay reviewed decisions.
//
// One tick:
//   1. the retire pass: every live recognised event none of whose provider
//      rows is current any more gets a revision in state `unknown` with no leg
//      (`provider_status_absent`), a merged event (several keys) included. It
//      runs first so that a key change (a card ordinal change, a parser
//      fingerprint change, a month's customized capture replaced by its web
//      capture) retires the old event before the new row is recognised, never
//      after it. While it fills its page and retires every event on it,
//      recognition waits a tick (bounded: see `cardPurchaseSweep`);
//   2. the recognition pass: one page of current usage after the scan cursor.
//      Each row is classified; its key's live holder is the event it revises,
//      otherwise it names a new event; the content digest decides between
//      nothing, `revise` and `reanchor` (`nextCardPurchaseAction`). A merged
//      event's content follows its posted row, still holding its pending key;
//      its pending row has nothing to add;
//   3. each event is written by the guarded 0047 batch
//      (`cardPurchaseRecognitionWrites`) as its own `db.batch`. A replay, a
//      stale plan or a key another live event holds writes nothing in any
//      table and counts as a conflict;
//   4. the cursor moves to the last row handled, and back to 0 after the last
//      page: a row below the cursor can become current again later. It moves
//      only from the value this tick read, so an overlapping tick never pulls
//      it back;
//   5. the candidate pass: `stageBProposals` over the recognised pending and
//      captured events of every group the page touched — (resolved account,
//      source, statement period) for Vpass, or the usage month where Vpass
//      gave no recognised period; (resolved account, source, usage month) for
//      MyJCB, whose confirmed rows often sit at a relative position no rule
//      places (`groupOf`) — written as `reconciliation_proposals` under the
//      matcher's own digest (idempotent). The recognition cursor cycles
//      through every current row, so no pair is starved the way a
//      first-1,000-rows read starves it. A pair the provider itself linked (`autoAcceptable`) is
//      accepted and merged in one batch as a rule decision; every other pair
//      stays a proposal for review.
//
// The log line carries counts only: no amount, merchant, account or key.
import {
  cardPurchaseEventId,
  cardPurchaseLinkedRevision,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  cardStatementPeriod,
  classifyCardUsage,
  CARD_PURCHASE_ACTOR,
  CARD_PURCHASE_POLICY,
  nextCardPurchaseAction,
  recognitionKey,
  validCardPurchaseFacts,
  type CardPurchaseDraft,
  type CardPurchaseKey,
  type CardUsageExclusion,
  type CardUsageFact,
} from "../../../packages/domain/src/card-purchase.ts";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  PENDING_POSTED_RELATION_KIND,
  proposalSubjectRef,
} from "../../../packages/domain/src/pending-posted-review.ts";
import {
  DEFAULT_MATCH_OPTIONS,
  proposalIdentity,
  stageBProposals,
  type MatchFact,
  type ReconciliationProposal,
} from "../../../packages/domain/src/reconcile.ts";
import {
  quantityFromNormalizedDecimal,
  type Quantity,
} from "../../../packages/domain/src/values.ts";
import type { NormalizedDecimal } from "../../../packages/observation-shared/src/normalized-decimal.ts";
import {
  candidateMerge,
  loadLiveCardPurchases,
  type LiveCardPurchase,
} from "../../../packages/application/src/operations/card-purchase-links.ts";
import {
  loadPendingPostedCandidates,
  type CandidateReader,
} from "../../../packages/application/src/query/card-purchase-candidates.ts";
import {
  STALE_CARD_PURCHASE_KEY_LIMIT,
  staleCardPurchaseKeysSql,
  type StaleCardPurchaseKeyRow,
} from "../../../packages/read-model/src/card-purchase-keys.ts";
import {
  CARD_USAGE_PAGE_LIMIT,
  currentCardUsageSql,
  type CurrentCardUsageRow,
} from "../../../packages/read-model/src/card-usage.ts";
import {
  cardPurchaseMergeWrites,
  cardPurchaseRecognitionWrites,
} from "../../../packages/storage-d1/src/atomic/card-purchase-recognition.ts";
import type { SqlWrite } from "../../../packages/storage-d1/src/core/operations.ts";

/** Current usage rows one tick reads after the cursor. */
export const SCAN_LIMIT = 500;
/** Recognition batches (recognize, revise, reanchor) one tick may commit. */
export const WRITE_LIMIT = 200;
/** Stale keys one tick reads for the retire pass, and so at most the events it retires. */
export const RETIRE_LIMIT = 100;
/** Recognised events one candidate group may hold; a larger group is counted and skipped. */
export const CANDIDATE_GROUP_LIMIT = 200;
/** Recognised events the candidate pass reads in one tick, over every group of the page. */
export const CANDIDATE_READ_LIMIT = 2_000;
/** New proposals one tick writes, in one batch. */
export const CANDIDATE_WRITE_LIMIT = 100;
/**
 * Proposal digests one stored-proposal lookup binds. Stage B pairs every
 * pending event with every posted event of a group (a group of 200 events is
 * up to 10,000 pairs, and a tick reads up to 2,000 events), so one lookup of
 * every pair could bind a JSON array of megabytes, past D1's 2 MB value
 * limit; chunked, each lookup binds at most about 67 KB.
 */
export const CANDIDATE_LOOKUP_CHUNK = 1_000;
/** Provider-linked merges one tick commits, each its own batch. */
export const LINK_MERGE_LIMIT = 20;

/** Off unless explicitly enabled; the default deploy writes nothing. */
export function purchaseRecognitionEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** Counts only: nothing a provider displayed and no identifier is logged. */
export interface CardPurchaseSweepResult {
  /** Current usage rows read after the cursor this tick. */
  scanned: number;
  recognized: number;
  revised: number;
  reanchored: number;
  retired: number;
  /** Rows not recognised, per closed exclusion code (`CARD_USAGE_EXCLUSIONS`). */
  skipped: Partial<Record<CardUsageExclusion, number>>;
  /**
   * Rows or events left alone because the stored state disagrees with the
   * plan: a guarded batch that wrote nothing (stale, replayed or key held), a
   * transition `eventTransition` refuses (a different kind), or a holder this
   * writer cannot read. Nothing is written for them.
   */
  conflicts: number;
  /** Batches D1 rejected with an error; nothing of them was written. */
  failed: number;
  /** True when recognition waited because the retire pass retired a whole full page. */
  deferred: boolean;
  /** New pending-to-posted proposals written by the candidate pass. */
  proposed: number;
  /** Provider-linked pairs accepted and merged as rule decisions. */
  merged: number;
  /** Candidate groups too large to pair (or read), skipped this tick. */
  groupsSkipped: number;
}

export interface CardPurchaseSweepOptions {
  now?: string;
  scanLimit?: number;
  writeLimit?: number;
  retireLimit?: number;
  /** New proposals the candidate pass may write this tick. */
  candidateWriteLimit?: number;
  /** Proposal digests one stored-proposal lookup binds, at most `CANDIDATE_LOOKUP_CHUNK`. */
  candidateLookupChunk?: number;
}

/** The structural reader the shared application loaders take, over a D1 binding. */
function readerOf(db: D1Database): CandidateReader {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      (
        await db
          .prepare(sql)
          .bind(...args)
          .all<T>()
      ).results,
  };
}

/** The decimal-v1 amount of a row; an absent projection is `missing`, never zero. */
function amountOf(row: CurrentCardUsageRow): Quantity {
  const normalized: NormalizedDecimal = {
    policyVersion: "decimal-v1",
    status: row.value_status ?? "missing",
    coefficient: row.coefficient,
    scale: row.scale,
    basis: row.value_basis ?? "none",
  };
  return quantityFromNormalizedDecimal(row.unit_ref ?? "unknown-unit", normalized);
}

/**
 * The fact the domain classifies. Every returned row is already the newest
 * representation (step 3 of `currentCardUsageSql`). A mapping whose status is
 * `unresolved` names a placeholder account, not a card, so it reads as no
 * account at all (`account_not_resolved`).
 */
export function cardUsageFactOf(row: CurrentCardUsageRow): CardUsageFact {
  return {
    observationId: row.observation_id,
    parseRunId: row.parse_run_id,
    sourceId: row.source_id,
    producerId: row.producer_id,
    externalIdNamespace: row.external_id_namespace,
    sourceAccount: row.source_account,
    externalId: row.external_id,
    accountId: row.account_status === "unresolved" ? null : row.account_id,
    identityPolicyFamily: row.policy_family,
    providerStatus: row.provider_status,
    amount: amountOf(row),
    usageDate: row.as_of,
    paymentType: row.payment_type,
    statementPeriod: row.statement_period,
    // The row's own capture: a MyJCB snapshot is one ledger artifact, so this
    // is the `fetched_at` its relative `detailMonth-N` label is resolved from.
    capturedAt: row.snapshot_fetched_at,
    providerSaleCode: row.provider_sale_code,
    usageAmountText: row.usage_amount_text,
    paymentAmountText: row.payment_amount_text,
    newestRepresentation: true,
  };
}

type Outcome = "written" | "conflict" | "failed";

/** One guarded batch; the first statement carries every guard. */
async function run(db: D1Database, writes: readonly SqlWrite[]): Promise<Outcome> {
  try {
    const results = await db.batch(
      writes.map((write) => db.prepare(write.sql).bind(...write.binds)),
    );
    return (results[0]?.meta.changes ?? 0) > 0 ? "written" : "conflict";
  } catch {
    // D1 rolled the whole batch back. The error text may carry values, so
    // only the count leaves this function.
    return "failed";
  }
}

/** One event, one guarded batch. */
async function commit(
  db: D1Database,
  draft: CardPurchaseDraft,
  expectedRevision: number | null,
  now: string,
): Promise<Outcome> {
  let writes: SqlWrite[];
  try {
    writes = cardPurchaseRecognitionWrites({ draft, expectedRevision, now });
  } catch {
    return "failed";
  }
  return run(db, writes);
}

async function page<T>(db: D1Database, query: { sql: string; args: unknown[] }): Promise<T[]> {
  return (
    await db
      .prepare(query.sql)
      .bind(...query.args)
      .all<T>()
  ).results;
}

/** A positive integer option, at most `max` (the page its query accepts), else the default. */
function bounded(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

/**
 * Retire every live recognised event none of whose provider rows is current
 * any more, a merged event holding a pending and a posted key included: the
 * stale read reports a revision only when none of its keys is current. True
 * when the page was full and every event on it was retired: more stale keys
 * may be waiting, and nothing on the page was one this pass cannot act on.
 */
async function retirePass(
  db: D1Database,
  result: CardPurchaseSweepResult,
  limit: number,
  now: string,
): Promise<boolean> {
  const stale = await page<StaleCardPurchaseKeyRow>(db, staleCardPurchaseKeysSql(limit));
  const byEvent = new Map<string, StaleCardPurchaseKeyRow[]>();
  for (const row of stale) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row]);
  const live = await loadLiveCardPurchases(readerOf(db), [...byEvent.keys()]);
  let retired = 0;
  for (const [eventId, rows] of byEvent) {
    const current = live.get(eventId);
    // The live revision read now must be the one the stale read reported,
    // holding as many keys; the page may cut an event's keys, but each one
    // it reports is stale, and so is every other key of that revision.
    if (
      !current ||
      current.revision.revision !== rows[0]!.revision ||
      current.keys.length !== rows[0]!.key_count
    ) {
      result.conflicts += 1;
      continue;
    }
    const draft = await cardPurchaseRetirement({
      live: current.revision,
      keys: current.keys,
      sidecar: current.sidecar,
    });
    if (!draft) {
      result.conflicts += 1;
      continue;
    }
    const outcome = await commit(db, draft, current.revision.revision, now);
    if (outcome === "written") retired += 1;
    else if (outcome === "conflict") result.conflicts += 1;
    else result.failed += 1;
  }
  result.retired += retired;
  return stale.length === limit && byEvent.size > 0 && retired === byEvent.size;
}

/**
 * One page of current usage after the cursor, each row recognised, revised or
 * left alone. Returns the rows read, which the candidate pass pairs.
 */
async function recognitionPass(
  db: D1Database,
  result: CardPurchaseSweepResult,
  limits: { scan: number; write: number },
  now: string,
): Promise<CurrentCardUsageRow[]> {
  const cursor =
    (
      await db
        .prepare("SELECT last_observation_id FROM card_purchase_scan_cursor WHERE singleton=1")
        .first<{ last_observation_id: number }>()
    )?.last_observation_id ?? 0;
  const rows = await page<CurrentCardUsageRow>(
    db,
    currentCardUsageSql({ afterId: cursor, limit: limits.scan }),
  );
  result.scanned = rows.length;
  const pageKeys = rows.flatMap((row) =>
    row.recognition_key === null ? [] : [row.recognition_key],
  );
  const holders = new Map(
    (
      await page<{ recognition_key: string; event_id: string }>(db, {
        sql: `SELECT recognition_key,event_id FROM current_card_purchase_keys
WHERE recognition_key IN (SELECT value FROM json_each(?1))`,
        args: [JSON.stringify(pageKeys)],
      })
    ).map((row) => [row.recognition_key, row.event_id]),
  );
  const live = await loadLiveCardPurchases(readerOf(db), [...holders.values()]);
  let writes = 0;
  let handled = cursor;
  let budgetReached = false;
  for (const row of rows) {
    const fact = cardUsageFactOf(row);
    const classified = classifyCardUsage(fact);
    if (!classified.ok) {
      result.skipped[classified.reasonCode] = (result.skipped[classified.reasonCode] ?? 0) + 1;
      handled = row.observation_id;
      continue;
    }
    const key = recognitionKey(fact);
    const holderId = row.recognition_key === null ? undefined : holders.get(row.recognition_key);
    let planned: { draft: CardPurchaseDraft; expected: number | null } | "none" | "conflict";
    if (key === null || JSON.stringify(key) !== row.recognition_key) {
      // The key the 0047 guard re-derives must be the one the domain names.
      planned = "conflict";
    } else if (holderId === undefined) {
      const draft = await cardPurchaseRevision({
        action: "recognize",
        eventId: await cardPurchaseEventId(classified.kind, key),
        revision: 1,
        fact,
      });
      planned = draft ? { draft, expected: null } : "conflict";
    } else {
      planned = await plannedRevision(
        live.get(holderId),
        fact,
        classified.kind,
        row.recognition_key!,
      );
    }
    if (planned === "none" || planned === "conflict") {
      if (planned === "conflict") result.conflicts += 1;
      handled = row.observation_id;
      continue;
    }
    if (writes >= limits.write) {
      budgetReached = true;
      break;
    }
    writes += 1;
    const outcome = await commit(db, planned.draft, planned.expected, now);
    if (outcome === "written") {
      if (planned.draft.action === "recognize") result.recognized += 1;
      else if (planned.draft.action === "reanchor") result.reanchored += 1;
      else result.revised += 1;
    } else if (outcome === "conflict") result.conflicts += 1;
    else result.failed += 1;
    handled = row.observation_id;
  }
  // The last page wraps to the start: a row below the cursor can become
  // current again (a reappearing row, a newly resolved identity). The update
  // is conditional on the value this tick read, so a tick that overlapped
  // this one and already moved the cursor is never pulled back.
  const next = budgetReached ? handled : rows.length < limits.scan ? 0 : handled;
  if (next !== cursor)
    await db
      .prepare(
        "UPDATE card_purchase_scan_cursor SET last_observation_id=?1 WHERE singleton=1 AND last_observation_id=?2",
      )
      .bind(next, cursor)
      .run();
  return rows;
}

/**
 * What to write for a row whose key a live event already holds. A merged
 * event (one posted key and its pending key(s), the shape a reviewed or
 * provider-linked merge leaves) follows its posted row and keeps its pending
 * key(s); the pending row adds nothing to it. Only the posted row's parse run
 * decides a re-anchor: the pending row is not re-anchored, so a merged event
 * whose pending parse is no longer published is still up to date.
 */
async function plannedRevision(
  current: LiveCardPurchase | undefined,
  fact: CardUsageFact,
  kind: "purchase" | "refund",
  rowKey: string,
): Promise<{ draft: CardPurchaseDraft; expected: number } | "none" | "conflict"> {
  const own = current?.keys.find((entry) => entry.key === rowKey);
  if (!current || !own) return "conflict";
  const { revision } = current;
  const posted = current.keys.filter((entry) => entry.role === "posted");
  const pending = current.keys.filter((entry) => entry.role === "pending");
  const merged = current.keys.length > 1;
  if (merged) {
    if (posted.length !== 1 || pending.length === 0) return "conflict";
    if (own.role === "pending") return "none";
  }
  // A different kind is never a revision of the same event (`nextCardPurchaseAction`).
  if (revision.kind !== kind) return "conflict";
  const input = { eventId: revision.eventId, revision: revision.revision + 1, fact };
  const build = (action: "revise" | "reanchor") =>
    merged
      ? cardPurchaseLinkedRevision({ action, ...input, pendingKeys: pending })
      : cardPurchaseRevision({ action, ...input });
  const next = await build("revise");
  if (!next) return "conflict";
  const decisive: readonly CardPurchaseKey[] = merged ? posted : current.keys;
  const action = nextCardPurchaseAction({
    live: {
      kind: revision.kind,
      state: revision.state,
      contentDigest: current.contentDigest,
      evidenceAdopted: decisive.every((entry) => current.published.get(entry.key) === true),
      statementPeriod: current.sidecar.statementPeriod,
    },
    next: {
      kind,
      state: next.revision.state,
      contentDigest: next.contentDigest,
      statementPeriod: next.sidecar.statementPeriod,
    },
  });
  if (action === "none") return "none";
  if (action === "revise") return { draft: next, expected: revision.revision };
  if (action === "reanchor") {
    const draft = await build("reanchor");
    return draft ? { draft, expected: revision.revision } : "conflict";
  }
  return "conflict";
}

// ---------------------------------------------------------------------------
// The candidate pass
// ---------------------------------------------------------------------------

interface GroupFactRow {
  event_id: string;
  revision: number;
  account_id: string;
  source_id: string;
  statement_period: string | null;
  facts_json: string;
  kind: string;
  state: string;
  recognition_key: string;
  role: string;
  observation_id: number;
  parse_run_id: number;
  counterparty: string | null;
  provider_link_id: string | null;
}

/**
 * The single-key live recognised events of the given groups that can be one
 * side of a link: a pending row's event while it is authorized or retired
 * (`unknown`: a Vpass pending row leaves the display when the month's posted
 * capture arrives), a posted row's event while it is captured. A group is
 * `[account, source, statement period, usage month]` (`groupOf`): the
 * statement period when it names one, otherwise the usage month, which for
 * MyJCB matches every event of that month whatever its sidecar period. The
 * counterparty and a provider link id are read from the cited row to compare,
 * never stored.
 */
const GROUP_FACTS_SQL = `SELECT c.event_id,c.revision,c.account_id,c.source_id,c.statement_period,c.facts_json,
 r.kind,r.state,
 k.recognition_key,k.role,k.observation_id,k.parse_run_id,t.counterparty,
 CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json,'$._kogane.providerLinkId')='text'
   AND length(json_extract(t.extra_json,'$._kogane.providerLinkId')) BETWEEN 1 AND 256
  THEN json_extract(t.extra_json,'$._kogane.providerLinkId') END AS provider_link_id
FROM json_each(?1) g
JOIN card_purchase_recognitions c ON c.account_id=json_extract(g.value,'$[0]')
 AND c.source_id=json_extract(g.value,'$[1]')
 AND CASE WHEN json_extract(g.value,'$[2]') IS NOT NULL THEN c.statement_period=json_extract(g.value,'$[2]')
  ELSE (c.statement_period IS NULL OR c.source_id='myjcb')
   AND substr(json_extract(c.facts_json,'$.usageDate'),1,7)=json_extract(g.value,'$[3]') END
JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision AND r.superseded_by IS NULL
JOIN card_purchase_recognition_keys k ON k.event_id=c.event_id AND k.revision=c.revision
JOIN transaction_observations t ON t.id=k.observation_id
WHERE (SELECT count(*) FROM card_purchase_recognition_keys n WHERE n.event_id=c.event_id AND n.revision=c.revision)=1
 AND ((k.role='pending' AND r.state IN ('authorized','unknown')) OR (k.role='posted' AND r.state='captured'))
ORDER BY c.account_id,c.source_id,c.statement_period,c.event_id
LIMIT ?2`;

/** One recognised event as the matcher compares it, or null when its stored key or facts are unreadable. */
function matchFactOf(row: GroupFactRow): MatchFact | null {
  let key: unknown;
  let facts: unknown;
  try {
    key = JSON.parse(row.recognition_key);
    facts = JSON.parse(row.facts_json);
  } catch {
    return null;
  }
  if (
    !Array.isArray(key) ||
    key.length !== 5 ||
    typeof key[0] !== "string" ||
    typeof key[1] !== "string" ||
    typeof key[3] !== "string" ||
    !validCardPurchaseFacts(facts)
  )
    return null;
  const [sourceId, producerId, namespace, sourceAccount, externalId] = key as [
    string,
    string,
    string | null,
    string,
    string | null,
  ];
  return {
    ref: {
      kind: "transaction",
      id: `transaction:${row.observation_id}`,
      revision: `parse_run:${row.parse_run_id}`,
    },
    // The namespace of the reconciliation job (reconciliation-job.ts `factOf`).
    scope: {
      sourceId,
      credentialEpoch: `${producerId}/${namespace ?? "-"}`,
      accountNamespace: sourceAccount,
    },
    sourceAccount,
    externalId,
    identifierOrigin: "collector-fingerprint",
    providerLinkId: row.provider_link_id,
    settlementState: row.role === "pending" ? "pending" : "posted",
    quantity: facts.amount,
    occurred: { kind: "local-date", value: facts.usageDate, zone: null, basis: "provider" },
    counterparty: row.counterparty,
    statementPeriod: row.statement_period,
    ownerRef: null,
  };
}

/** `[account, source, statement period, usage month]`: the month only when there is no period. */
type Group = [string, string, string | null, string | null];

/**
 * The group a recognised event is paired in. Vpass: its statement period, or
 * its usage month when it has none. MyJCB: always its usage month. A MyJCB
 * pending row's label resolves to a payment month from its capture time
 * (`cardStatementPeriod`: `detailMonth-0` and `detailMonth-1`), but the
 * confirmed row of the same purchase usually sits at a later position the
 * rule does not place (`detailMonth-2` and beyond, docs/observations.md), so
 * grouping by period would keep the two apart. The usage date is the one
 * key both displays of a purchase share; the resolved periods still reach the
 * matcher, which claims `same_statement_period` only when both sides have the
 * same one.
 */
function groupOf(
  accountId: string,
  sourceId: string,
  period: string | null,
  usageDate: string,
): Group {
  const month = usageDate.slice(0, 7);
  if (sourceId === "myjcb") return [accountId, sourceId, null, month];
  return [accountId, sourceId, period, period === null ? month : null];
}

/** The idempotent proposal insert of the reconciliation job, as a statement. */
async function proposalWrite(
  proposal: ReconciliationProposal,
  now: string,
): Promise<{ id: string; digest: string; write: SqlWrite }> {
  const digest = await canonicalDigest(proposalIdentity(proposal));
  return {
    id: `rp_${digest}`,
    digest,
    write: {
      sql: `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,
 rationale_codes_json,rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,'proposed',NULL,?,? WHERE NOT EXISTS(SELECT 1 FROM reconciliation_proposals WHERE proposal_digest=?)`,
      binds: [
        `rp_${digest}`,
        proposal.kind,
        proposal.stage,
        JSON.stringify(proposal.targetRefs),
        proposal.method,
        proposal.policyRelease,
        JSON.stringify(proposal.rationaleCodes),
        JSON.stringify(proposal.rejectionConditions),
        JSON.stringify(proposal.evidenceRefs),
        digest,
        now,
        digest,
      ],
    },
  };
}

/**
 * Pair the recognised pending and captured events of every group this
 * tick's page touched (`groupOf`), and write the candidates. Returns the
 * provider-linked proposals, for the merge step.
 */
async function candidatePass(
  db: D1Database,
  result: CardPurchaseSweepResult,
  rows: readonly CurrentCardUsageRow[],
  limits: { write: number; lookup: number },
  now: string,
): Promise<string[]> {
  const limit = limits.write;
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const fact = cardUsageFactOf(row);
    if (fact.accountId === null || fact.usageDate === null || !classifyCardUsage(fact).ok) continue;
    const entry = groupOf(fact.accountId, fact.sourceId, cardStatementPeriod(fact), fact.usageDate);
    groups.set(JSON.stringify(entry), entry);
  }
  if (groups.size === 0) return [];
  const facts = await page<GroupFactRow>(db, {
    sql: GROUP_FACTS_SQL,
    args: [JSON.stringify([...groups.values()]), CANDIDATE_READ_LIMIT + 1],
  });
  // A truncated read would pair a partial group; every group waits instead.
  if (facts.length > CANDIDATE_READ_LIMIT) {
    result.groupsSkipped += groups.size;
    return [];
  }
  const byGroup = new Map<string, { size: number; kinds: Map<string, MatchFact[]> }>();
  for (const row of facts) {
    const fact = matchFactOf(row);
    if (fact === null || fact.occurred.kind !== "local-date") continue;
    const key = JSON.stringify(
      groupOf(row.account_id, row.source_id, row.statement_period, fact.occurred.value),
    );
    const group = byGroup.get(key) ?? { size: 0, kinds: new Map<string, MatchFact[]>() };
    group.size += 1;
    // A purchase and a refund are never one event, so they are never paired.
    group.kinds.set(row.kind, [...(group.kinds.get(row.kind) ?? []), fact]);
    byGroup.set(key, group);
  }
  const proposals: ReconciliationProposal[] = [];
  for (const group of byGroup.values()) {
    if (group.size > CANDIDATE_GROUP_LIMIT) {
      result.groupsSkipped += 1;
      continue;
    }
    for (const members of group.kinds.values())
      for (const proposal of stageBProposals(members, DEFAULT_MATCH_OPTIONS))
        proposals.push(proposal);
  }
  const linked: string[] = [];
  for (const proposal of proposals)
    if (proposal.autoAcceptable) linked.push((await proposalWrite(proposal, now)).id);
  // Only proposals not stored yet take the write budget, so the pairs a
  // group already proposed never starve its new ones. The stored ones are
  // looked up a bounded chunk at a time, until the budget is full.
  const writes: SqlWrite[] = [];
  for (let start = 0; start < proposals.length && writes.length < limit; start += limits.lookup) {
    const chunk = await Promise.all(
      proposals.slice(start, start + limits.lookup).map((proposal) => proposalWrite(proposal, now)),
    );
    const stored = new Set(
      (
        await page<{ proposal_digest: string }>(db, {
          sql: `SELECT proposal_digest FROM reconciliation_proposals
WHERE proposal_digest IN (SELECT value FROM json_each(?1))`,
          args: [JSON.stringify(chunk.map((candidate) => candidate.digest))],
        })
      ).map((row) => row.proposal_digest),
    );
    for (const candidate of chunk)
      if (writes.length < limit && !stored.has(candidate.digest)) writes.push(candidate.write);
  }
  if (writes.length > 0) {
    try {
      const results = await db.batch(
        writes.map((write) => db.prepare(write.sql).bind(...write.binds)),
      );
      result.proposed += results.filter((entry) => entry.meta.changes > 0).length;
    } catch {
      result.failed += 1;
    }
  }
  return linked;
}

/** A decision someone other than a rule recorded about either of two events (`event:<id>`). */
const REVIEWED_EVENT_SQL = `SELECT d.id FROM decision_revisions d
 WHERE d.subject_kind='relation' AND d.subject_ref IN (?,?) AND d.method<>'rule' LIMIT 1`;

/**
 * Accept and merge a pair the provider itself linked, as one batch of rule
 * decisions (card purchase plan §1.1): the merge (statement 1 carries the
 * merge guard and the proposal's state), the `proposal:` decision, the
 * relation decision and row, and the proposal's resolution. A pair the
 * reconciliation lane already accepted by rule is merged without a second
 * acceptance. A heuristic pair is never merged here, whatever else agrees.
 *
 * The rule never overrides a reviewer: once a human decision is recorded
 * about either event (a reviewed merge or a withdrawal's split), the pair is
 * left to review. Without this, a withdrawn link would be merged again as
 * soon as either row is re-anchored, because the re-anchored pair is a new
 * proposal the provider link makes `autoAcceptable` again.
 */
async function mergeLinked(
  db: D1Database,
  result: CardPurchaseSweepResult,
  proposalIds: readonly string[],
  now: string,
): Promise<void> {
  const reader = readerOf(db);
  // A merged pair holds several keys and is no longer paired, so every id
  // here is a pair still apart.
  for (const proposalId of [...new Set(proposalIds)].slice(0, LINK_MERGE_LIMIT)) {
    const [candidate] = await loadPendingPostedCandidates(reader, { proposalId });
    if (candidate === undefined || !candidate.view.providerLinked) continue;
    const { view, pending, posted } = candidate;
    const open = view.actions.includes("accept");
    // Accepted by the reconciliation lane's rule and not merged yet.
    const acceptedApart =
      view.proposalStatus === "accepted" &&
      view.relationStatus === "accepted" &&
      !candidate.merged &&
      pending.holder !== null &&
      posted.holder !== null &&
      pending.holder.eventId !== posted.holder.eventId;
    if (!open && !acceptedApart) continue;
    const events = [`event:${pending.holder?.eventId}`, `event:${posted.holder?.eventId}`];
    if ((await page<{ id: string }>(db, { sql: REVIEWED_EVENT_SQL, args: events })).length > 0)
      continue;
    const merge = await candidateMerge(reader, pending, posted, null);
    if (merge === null) {
      result.conflicts += 1;
      continue;
    }
    const relation = view.relation;
    const proposalState: SqlWrite = open
      ? {
          sql: "EXISTS(SELECT 1 FROM reconciliation_proposals WHERE id=? AND status='proposed')",
          binds: [proposalId],
        }
      : {
          sql: `EXISTS(SELECT 1 FROM reconciliation_proposals p JOIN decision_revisions d ON d.id=p.decision_revision_id
  WHERE p.id=? AND p.status='accepted' AND d.method='rule')
 AND (SELECT r.status FROM entity_relations r WHERE r.kind=? AND r.from_ref=? AND r.to_ref=?
  ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)='accepted'`,
          binds: [proposalId, PENDING_POSTED_RELATION_KIND, relation.fromRef, relation.toRef],
        };
    // Re-checked inside the batch: a review committed since the read above
    // leaves this merge unwritten.
    const state: SqlWrite = {
      sql: `${proposalState.sql}\n AND NOT EXISTS(${REVIEWED_EVENT_SQL})`,
      binds: [...proposalState.binds, ...events],
    };
    const writes = cardPurchaseMergeWrites({ merge, now, guard: state });
    if (open) {
      const mergeDecision = merge.draft.decisionRevisionId;
      const proposalDecision = `dr_link_${await canonicalDigest({ proposalId, mergeDecision, kind: "proposal" })}`;
      const relationDecision = `dr_link_${await canonicalDigest({ proposalId, mergeDecision, kind: "relation" })}`;
      const relationId = `rel_link_${await canonicalDigest({ proposalId, mergeDecision })}`;
      const evidence = JSON.stringify(relation.evidenceRefs);
      const reason = `${CARD_PURCHASE_POLICY}:provider-link`;
      const decision = (id: string, subject: string, after: string): SqlWrite => ({
        sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
 SELECT ?,'relation',?,1,'accept','rule',?,NULL,?,?,NULL,NULL,?
 WHERE EXISTS(SELECT 1 FROM decision_revisions WHERE id=?) AND NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`,
        binds: [id, subject, CARD_PURCHASE_ACTOR, reason, evidence, now, after, id],
      });
      writes.push(
        decision(proposalDecision, proposalSubjectRef(proposalId), mergeDecision),
        decision(relationDecision, relationId, proposalDecision),
        {
          sql: `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
 SELECT ?,?,?,?,NULL,NULL,'accepted',?,?,? WHERE EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)
 AND NOT EXISTS(SELECT 1 FROM entity_relations WHERE id=?)`,
          binds: [
            relationId,
            PENDING_POSTED_RELATION_KIND,
            relation.fromRef,
            relation.toRef,
            relationDecision,
            evidence,
            now,
            relationDecision,
            relationId,
          ],
        },
        {
          // The one permitted update on a proposal: name the decision that resolved it.
          sql: `UPDATE reconciliation_proposals SET status='accepted',decision_revision_id=?
 WHERE id=? AND status='proposed' AND EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`,
          binds: [proposalDecision, proposalId, proposalDecision],
        },
      );
    }
    const outcome = await run(db, writes);
    if (outcome === "written") result.merged += 1;
    else if (outcome === "conflict") result.conflicts += 1;
    else result.failed += 1;
  }
}

/**
 * One bounded tick: at most `RETIRE_LIMIT` stale keys retired, then at most
 * `SCAN_LIMIT` current rows read and `WRITE_LIMIT` events written, then the
 * candidates of the groups those rows belong to (at most
 * `CANDIDATE_WRITE_LIMIT` new proposals in one batch, the stored ones looked
 * up `CANDIDATE_LOOKUP_CHUNK` digests at a time, and `LINK_MERGE_LIMIT`
 * provider-linked merges). Re-running it over unchanged rows writes nothing:
 * every revision's decision id is a digest of its event, revision, content and
 * action, the live content digest already matches, and a proposal is keyed by
 * the matcher's own digest.
 *
 * Recognition waits a tick only when the retire pass filled its page and
 * retired every event on it, so a key change (a card ordinal, a parser
 * fingerprint) retires the old events before their replacements are
 * recognised and the captured total never counts one purchase twice. The wait
 * is bounded: every deferred tick takes `retireLimit` keys out of the live
 * authorized and captured set, and nothing refills that set while recognition,
 * its only writer, waits, so recognition runs again after at most
 * ceil(K / retireLimit) consecutive ticks, K being the keys that set held when
 * the wait began. A page with any conflict or failed batch never defers, so
 * keys this pass cannot retire never hold recognition back. A deferred tick
 * pairs nothing either: the candidate pass follows the page.
 */
export async function cardPurchaseSweep(
  db: D1Database,
  options: CardPurchaseSweepOptions = {},
): Promise<CardPurchaseSweepResult> {
  const now = options.now ?? new Date().toISOString();
  const retireLimit = bounded(options.retireLimit, RETIRE_LIMIT, STALE_CARD_PURCHASE_KEY_LIMIT);
  const result: CardPurchaseSweepResult = {
    scanned: 0,
    recognized: 0,
    revised: 0,
    reanchored: 0,
    retired: 0,
    skipped: {},
    conflicts: 0,
    failed: 0,
    deferred: false,
    proposed: 0,
    merged: 0,
    groupsSkipped: 0,
  };
  if (await retirePass(db, result, retireLimit, now)) {
    result.deferred = true;
    return result;
  }
  const rows = await recognitionPass(
    db,
    result,
    {
      scan: bounded(options.scanLimit, SCAN_LIMIT, CARD_USAGE_PAGE_LIMIT),
      write: bounded(options.writeLimit, WRITE_LIMIT, Number.MAX_SAFE_INTEGER),
    },
    now,
  );
  const linked = await candidatePass(
    db,
    result,
    rows,
    {
      write: bounded(options.candidateWriteLimit, CANDIDATE_WRITE_LIMIT, CANDIDATE_WRITE_LIMIT),
      lookup: bounded(options.candidateLookupChunk, CANDIDATE_LOOKUP_CHUNK, CANDIDATE_LOOKUP_CHUNK),
    },
    now,
  );
  await mergeLinked(db, result, linked, now);
  return result;
}
