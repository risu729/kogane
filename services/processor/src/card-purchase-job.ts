// Card purchase recognition (card purchase plan §1, PR2): the bounded writer
// that turns adopted Vpass and MyJCB usage rows into `purchase` and `refund`
// events on the `purchase-recognition` basis.
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
// code and never guessed (INV05). Pending-to-posted merging, refund
// allocation and "this row is not a purchase" stay reviewed decisions.
//
// One tick:
//   1. the retire pass: every live recognised event whose provider row is no
//      longer current gets a revision in state `unknown` with no leg
//      (`provider_status_absent`). It runs first so that a key change (a card
//      ordinal change, a parser fingerprint change, a month's customized
//      capture replaced by its web capture) retires the old event before the
//      new row is recognised, never after it. While it still finds a full page
//      of stale keys and is making progress, recognition waits a tick;
//   2. the recognition pass: one page of current usage after the scan cursor.
//      Each row is classified; its key's live holder is the event it revises,
//      otherwise it names a new event; the content digest decides between
//      nothing, `revise` and `reanchor` (`nextCardPurchaseAction`);
//   3. each event is written by the guarded 0047 batch
//      (`cardPurchaseRecognitionWrites`) as its own `db.batch`. A replay, a
//      stale plan or a key another live event holds writes nothing in any
//      table and counts as a conflict;
//   4. the cursor moves to the last row handled, and back to 0 after the last
//      page: a row below the cursor can become current again later.
//
// The log line carries counts only: no amount, merchant, account or key.
import {
  cardPurchaseEventId,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  classifyCardUsage,
  nextCardPurchaseAction,
  recognitionKey,
  type CardPurchaseDraft,
  type CardPurchaseKey,
  type CardPurchaseSidecar,
  type CardUsageExclusion,
  type CardUsageFact,
} from "../../../packages/domain/src/card-purchase.ts";
import type { EconomicEventRevision, EconomicLeg } from "../../../packages/domain/src/events.ts";
import {
  exactQuantity,
  normalizeDecimal,
  quantityFromNormalizedDecimal,
  type Quantity,
} from "../../../packages/domain/src/values.ts";
import type { NormalizedDecimal } from "../../../packages/observation-shared/src/normalized-decimal.ts";
import {
  staleCardPurchaseKeysSql,
  type StaleCardPurchaseKeyRow,
} from "../../../packages/read-model/src/card-purchase-keys.ts";
import {
  currentCardUsageSql,
  type CurrentCardUsageRow,
} from "../../../packages/read-model/src/card-usage.ts";
import { cardPurchaseRecognitionWrites } from "../../../packages/storage-d1/src/atomic/card-purchase-recognition.ts";

/** Current usage rows one tick reads after the cursor. */
export const SCAN_LIMIT = 500;
/** Recognition batches (recognize, revise, reanchor) one tick may commit. */
export const WRITE_LIMIT = 200;
/** Stale keys one tick reads for the retire pass, and so at most the events it retires. */
export const RETIRE_LIMIT = 100;

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
   * writer does not own (several keys, unreadable). Nothing is written for them.
   */
  conflicts: number;
  /** Batches D1 rejected with an error; nothing of them was written. */
  failed: number;
  /** True when recognition waited for a full retire page to drain first. */
  deferred: boolean;
}

export interface CardPurchaseSweepOptions {
  now?: string;
  scanLimit?: number;
  writeLimit?: number;
  retireLimit?: number;
}

/** A live recognised revision with what the writer compares against. */
interface LiveRecognition {
  revision: EconomicEventRevision;
  keys: CardPurchaseKey[];
  sidecar: CardPurchaseSidecar;
  contentDigest: string;
  /** Every parse run the live keys pin is still published. */
  evidenceAdopted: boolean;
}

interface LiveRow {
  event_id: string;
  revision: number;
  content_digest: string;
  account_id: string;
  source_id: string;
  statement_period: string | null;
  facts_json: string;
  kind: string;
  state: string;
  unknown_reason: string | null;
  effective_time_json: string;
  basis: string;
  evidence_support_json: string;
  decision_revision_id: string;
}
interface LegRow {
  event_id: string;
  revision: number;
  leg_index: number;
  subject_ref: string;
  unit_ref: string;
  value_status: string;
  coefficient: string | null;
  scale: number | null;
  role: string;
  basis: string;
}
interface KeyRow {
  event_id: string;
  recognition_key: string;
  role: string;
  observation_id: number;
  parse_run_id: number;
  published: number;
}

const IN_EVENTS = "IN (SELECT value FROM json_each(?1))";

/** The live revision, legs and keys of each event, read in three bounded queries. */
async function liveRecognitions(
  db: D1Database,
  eventIds: readonly string[],
): Promise<Map<string, LiveRecognition>> {
  const live = new Map<string, LiveRecognition>();
  if (eventIds.length === 0) return live;
  const ids = JSON.stringify([...new Set(eventIds)]);
  const [revisions, legs, keys] = await Promise.all([
    db
      .prepare(`SELECT c.event_id,c.revision,c.content_digest,c.account_id,c.source_id,c.statement_period,
 c.facts_json,r.kind,r.state,r.unknown_reason,r.effective_time_json,r.basis,r.evidence_support_json,
 r.decision_revision_id
FROM current_card_purchase_recognitions c
JOIN economic_event_revisions r ON r.event_id=c.event_id AND r.revision=c.revision
WHERE c.event_id ${IN_EVENTS}`)
      .bind(ids)
      .all<LiveRow>(),
    db
      .prepare(`SELECT l.event_id,l.revision,l.leg_index,l.subject_ref,l.unit_ref,l.value_status,
 l.coefficient,l.scale,l.role,l.basis
FROM economic_legs l
JOIN current_card_purchase_recognitions c ON c.event_id=l.event_id AND c.revision=l.revision
WHERE c.event_id ${IN_EVENTS}
ORDER BY l.event_id,l.leg_index`)
      .bind(ids)
      .all<LegRow>(),
    db
      .prepare(`SELECT k.event_id,k.recognition_key,k.role,k.observation_id,k.parse_run_id,
 EXISTS(SELECT 1 FROM published_parse_runs p WHERE p.parse_run_id=k.parse_run_id) AS published
FROM current_card_purchase_keys k
WHERE k.event_id ${IN_EVENTS}
ORDER BY k.event_id,k.recognition_key`)
      .bind(ids)
      .all<KeyRow>(),
  ]);
  for (const row of revisions.results) {
    const parsed = liveRecognition(
      row,
      legs.results.filter((leg) => leg.event_id === row.event_id),
      keys.results.filter((key) => key.event_id === row.event_id),
    );
    if (parsed) live.set(row.event_id, parsed);
  }
  return live;
}

/** The stored rows read back into the domain shape, or null when any part is malformed. */
function liveRecognition(
  row: LiveRow,
  legRows: readonly LegRow[],
  keyRows: readonly KeyRow[],
): LiveRecognition | null {
  try {
    const legs: EconomicLeg[] = [];
    for (const leg of legRows) {
      if (leg.value_status !== "exact" || leg.coefficient === null || leg.scale === null)
        return null;
      legs.push({
        eventId: leg.event_id,
        revision: leg.revision,
        legIndex: leg.leg_index,
        subjectRef: leg.subject_ref,
        quantity: exactQuantity(
          leg.unit_ref,
          normalizeDecimal(BigInt(leg.coefficient), leg.scale),
          "decimal-v1",
        ),
        role: leg.role as EconomicLeg["role"],
        basis: leg.basis as EconomicLeg["basis"],
      });
    }
    const keys = keyRows.map((key): CardPurchaseKey => ({
      key: key.recognition_key,
      role: key.role as CardPurchaseKey["role"],
      observationId: key.observation_id,
      parseRunId: key.parse_run_id,
    }));
    if (keys.length === 0 || (row.source_id !== "vpass" && row.source_id !== "myjcb")) return null;
    return {
      revision: {
        eventId: row.event_id,
        revision: row.revision,
        kind: row.kind as EconomicEventRevision["kind"],
        state: row.state as EconomicEventRevision["state"],
        unknownReason: row.unknown_reason as EconomicEventRevision["unknownReason"],
        effectiveTime: JSON.parse(
          row.effective_time_json,
        ) as EconomicEventRevision["effectiveTime"],
        basis: row.basis as EconomicEventRevision["basis"],
        evidenceSupport: JSON.parse(
          row.evidence_support_json,
        ) as EconomicEventRevision["evidenceSupport"],
        decisionRevisionRef: row.decision_revision_id,
        supersededBy: null,
        legs,
      },
      keys,
      sidecar: {
        accountId: row.account_id,
        sourceId: row.source_id,
        statementPeriod: row.statement_period,
        facts: JSON.parse(row.facts_json) as CardPurchaseSidecar["facts"],
      },
      contentDigest: row.content_digest,
      evidenceAdopted: keyRows.every((key) => key.published === 1),
    };
  } catch {
    // Unreadable JSON is a holder this writer cannot plan against, never an absent one.
    return null;
  }
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
    providerSaleCode: row.provider_sale_code,
    usageAmountText: row.usage_amount_text,
    paymentAmountText: row.payment_amount_text,
    newestRepresentation: true,
  };
}

type Outcome = "written" | "conflict" | "failed";

/** One event, one guarded batch. The first statement carries every guard. */
async function commit(
  db: D1Database,
  draft: CardPurchaseDraft,
  expectedRevision: number | null,
  now: string,
): Promise<Outcome> {
  try {
    const writes = cardPurchaseRecognitionWrites({ draft, expectedRevision, now });
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

async function page<T>(db: D1Database, query: { sql: string; args: unknown[] }): Promise<T[]> {
  return (
    await db
      .prepare(query.sql)
      .bind(...query.args)
      .all<T>()
  ).results;
}

function bounded(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Retire every live recognised event whose provider row is no longer current. */
async function retirePass(
  db: D1Database,
  result: CardPurchaseSweepResult,
  limit: number,
  now: string,
): Promise<number> {
  const stale = await page<StaleCardPurchaseKeyRow>(db, staleCardPurchaseKeysSql(limit));
  const byEvent = new Map<string, StaleCardPurchaseKeyRow[]>();
  for (const row of stale) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row]);
  const live = await liveRecognitions(db, [...byEvent.keys()]);
  for (const [eventId, rows] of byEvent) {
    const current = live.get(eventId);
    // Only an event none of whose keys is current any more is retired; an
    // event holding several keys is a reviewed merge and is not this pass's.
    if (
      !current ||
      current.revision.revision !== rows[0]!.revision ||
      current.keys.length !== 1 ||
      rows.length !== current.keys.length
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
    if (outcome === "written") result.retired += 1;
    else if (outcome === "conflict") result.conflicts += 1;
    else result.failed += 1;
  }
  return stale.length;
}

/** One page of current usage after the cursor, each row recognised, revised or left alone. */
async function recognitionPass(
  db: D1Database,
  result: CardPurchaseSweepResult,
  limits: { scan: number; write: number },
  now: string,
): Promise<void> {
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
  const live = await liveRecognitions(db, [...holders.values()]);
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
      planned = await plannedRevision(live.get(holderId), fact, classified.kind);
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
  // current again (a reappearing row, a newly resolved identity).
  const next = budgetReached ? handled : rows.length < limits.scan ? 0 : handled;
  if (next !== cursor)
    await db
      .prepare("UPDATE card_purchase_scan_cursor SET last_observation_id=? WHERE singleton=1")
      .bind(next)
      .run();
}

/** What to write for a row whose key a live event already holds. */
async function plannedRevision(
  current: LiveRecognition | undefined,
  fact: CardUsageFact,
  kind: "purchase" | "refund",
): Promise<{ draft: CardPurchaseDraft; expected: number } | "none" | "conflict"> {
  // A merged event (several keys) is revised by its reviewed flow, not here.
  if (!current || current.keys.length !== 1) return "conflict";
  const { revision } = current;
  // A different kind is never a revision of the same event (`nextCardPurchaseAction`).
  if (revision.kind !== kind) return "conflict";
  const input = { eventId: revision.eventId, revision: revision.revision + 1, fact };
  const next = await cardPurchaseRevision({ action: "revise", ...input });
  if (!next) return "conflict";
  const action = nextCardPurchaseAction({
    live: {
      kind: revision.kind,
      state: revision.state,
      contentDigest: current.contentDigest,
      evidenceAdopted: current.evidenceAdopted,
    },
    next: { kind, state: next.revision.state, contentDigest: next.contentDigest },
  });
  if (action === "none") return "none";
  if (action === "revise") return { draft: next, expected: revision.revision };
  if (action === "reanchor") {
    const draft = await cardPurchaseRevision({ action: "reanchor", ...input });
    return draft ? { draft, expected: revision.revision } : "conflict";
  }
  return "conflict";
}

/**
 * One bounded tick: at most `RETIRE_LIMIT` stale keys retired, then at most
 * `SCAN_LIMIT` current rows read and `WRITE_LIMIT` events written. Re-running
 * it over unchanged rows writes nothing: every revision's decision id is a
 * digest of its event, revision, content and action, and the live content
 * digest already matches.
 */
export async function cardPurchaseSweep(
  db: D1Database,
  options: CardPurchaseSweepOptions = {},
): Promise<CardPurchaseSweepResult> {
  const now = options.now ?? new Date().toISOString();
  const retireLimit = bounded(options.retireLimit, RETIRE_LIMIT);
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
  };
  const stale = await retirePass(db, result, retireLimit, now);
  // More stale keys may remain and this tick retired some: finish retiring
  // before recognising, so a changed key never counts one purchase twice.
  // A full page that made no progress does not hold recognition back.
  if (stale === retireLimit && result.retired > 0) {
    result.deferred = true;
    return result;
  }
  await recognitionPass(
    db,
    result,
    {
      scan: bounded(options.scanLimit, SCAN_LIMIT),
      write: bounded(options.writeLimit, WRITE_LIMIT),
    },
    now,
  );
  return result;
}
