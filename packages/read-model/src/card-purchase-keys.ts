// Recognition keys against current card usage (CORE 0047; card purchase plan
// §1.2). Two reads the purchase-recognition writer and its operator view need
// beside `currentCardUsageSql`:
//
//   * `staleCardPurchaseKeysSql` — the keys of each live, still-recognised
//     (authorized or captured) purchase/refund revision none of whose provider
//     rows is current any more. The writer retires those events (state
//     `unknown`, no legs).
//   * `unrecognizedCardUsageCountSql` — current usage rows no live revision
//     holds: rows the writer skipped (an unsupported shape, an unresolved
//     account, no external id) or has not reached yet.
//
// Both compose `CURRENT_CARD_USAGE_SQL` whole, as a subquery run over every
// current row (`?1 = 0`, `?2 = -1`, SQLite's "no limit"), so "current" keeps
// exactly one definition (card-usage.ts). It is materialized once per call and
// never evaluated per key.
import { CURRENT_CARD_USAGE_SQL } from "./card-usage";
import type { PageSql } from "./scope";

/** Largest page `staleCardPurchaseKeysSql` may request. */
export const STALE_CARD_PURCHASE_KEY_LIMIT = 1000;

/** One key of a live recognised revision whose provider row is no longer current. */
export interface StaleCardPurchaseKeyRow {
  event_id: string;
  revision: number;
  recognition_key: string;
  role: "posted" | "pending";
  observation_id: number;
  parse_run_id: number;
  kind: "purchase" | "refund";
  state: "authorized" | "captured";
  /** How many keys the live revision holds in all, so a caller can tell whether every one is stale. */
  key_count: number;
}

/** The whole current card usage set, every page at once. */
const ALL_CURRENT_USAGE = `(${CURRENT_CARD_USAGE_SQL})`;
const ALL_PAGES = [0, -1] as const;

/**
 * `?3` is the page size. A retired revision (`unknown`) keeps its keys and is
 * never reported, so the page cannot fill up with events that are already
 * retired; a key whose row is current again is the writer's to revise, not to
 * retire. A revision that still holds one current key is not reported either:
 * the event is still displayed (a merged pending key whose posted row is
 * current), so its other keys can never occupy the page. Ordered by event and
 * key so one event's keys stay together.
 */
export const STALE_CARD_PURCHASE_KEYS_SQL = `WITH current_keys AS MATERIALIZED (
         SELECT recognition_key FROM ${ALL_CURRENT_USAGE}
         WHERE recognition_key IS NOT NULL
       )
       SELECT k.event_id, k.revision, k.recognition_key, k.role, k.observation_id,
              k.parse_run_id, c.kind, c.state,
              (SELECT count(*) FROM card_purchase_recognition_keys all_keys
                WHERE all_keys.event_id = k.event_id AND all_keys.revision = k.revision) AS key_count
       FROM current_card_purchase_keys k
       JOIN current_card_purchase_recognitions c
         ON c.event_id = k.event_id AND c.revision = k.revision
       WHERE c.state IN ('authorized', 'captured')
         AND NOT EXISTS (SELECT 1 FROM card_purchase_recognition_keys held
                          WHERE held.event_id = k.event_id AND held.revision = k.revision
                            AND held.recognition_key IN (SELECT recognition_key FROM current_keys))
       ORDER BY k.event_id, k.recognition_key
       LIMIT ?3`;

/**
 * One page of stale keys, at most `limit` (1 to `STALE_CARD_PURCHASE_KEY_LIMIT`).
 * The writer re-reads from the start every time: a key it retired is no longer
 * reported, so no cursor is needed.
 */
export function staleCardPurchaseKeysSql(limit: number): PageSql {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > STALE_CARD_PURCHASE_KEY_LIMIT)
    throw new Error(
      `read-model: limit must be an integer from 1 to ${STALE_CARD_PURCHASE_KEY_LIMIT}`,
    );
  return { sql: STALE_CARD_PURCHASE_KEYS_SQL, args: [...ALL_PAGES, limit] };
}

/** The single row `unrecognizedCardUsageCountSql` returns. */
export interface UnrecognizedCardUsageCountRow {
  /** Current usage rows with no live holder, a row without a recognition key included. */
  unrecognized: number;
}

/**
 * Current card usage rows no live revision holds. A retired revision still
 * holds its key, so a row that has just reappeared is not counted here; the
 * writer revises it on its next pass. A count, never a sum of amounts.
 */
export const UNRECOGNIZED_CARD_USAGE_COUNT_SQL = `SELECT count(*) AS unrecognized
       FROM ${ALL_CURRENT_USAGE} usage
       WHERE usage.recognition_key IS NULL
          OR NOT EXISTS (SELECT 1 FROM current_card_purchase_keys k
                          WHERE k.recognition_key = usage.recognition_key)`;

export function unrecognizedCardUsageCountSql(): PageSql {
  return { sql: UNRECOGNIZED_CARD_USAGE_COUNT_SQL, args: [...ALL_PAGES] };
}
