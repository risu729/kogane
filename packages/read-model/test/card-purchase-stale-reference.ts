// What `staleCardPurchaseKeysSql` returns since ADR 0002's amendment of
// 2026-11-21, stated from the frozen shipped text (card-usage-legacy-sql.ts):
// the shipped rows, plus every key of each live authorized or captured
// revision that holds a posted key, none of whose posted keys is current,
// and that still holds a current pending key (the revisions the shipped text
// kept because their pending row was current). Nothing else may differ. The
// additions are found here in TypeScript, from the live keys and the current
// rows, never from the amended text. Tests only.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { expect } from "bun:test";
import {
  CURRENT_CARD_USAGE_SQL,
  type CurrentCardUsageRow,
  type PageSql,
  type StaleCardPurchaseKeyRow,
} from "../src/index";
import { STATEMENT_SLOT_STALE_CARD_PURCHASE_KEYS_SQL } from "./card-usage-legacy-sql";

const all = <T>(db: Database, sql: string, args: readonly unknown[]): T[] =>
  db.query(sql).all(...(args as SQLQueryBindings[])) as T[];

/** Every key of every live authorized or captured purchase/refund revision. */
const LIVE_KEYS_SQL = `SELECT k.event_id, k.revision, k.recognition_key, k.role, k.observation_id,
        k.parse_run_id, c.kind, c.state,
        (SELECT count(*) FROM card_purchase_recognition_keys all_keys
          WHERE all_keys.event_id = k.event_id AND all_keys.revision = k.revision) AS key_count
   FROM current_card_purchase_keys k
   JOIN current_card_purchase_recognitions c ON c.event_id = k.event_id AND c.revision = k.revision
  WHERE c.state IN ('authorized', 'captured')`;

const order = (a: StaleCardPurchaseKeyRow, b: StaleCardPurchaseKeyRow): number =>
  a.event_id !== b.event_id
    ? a.event_id < b.event_id
      ? -1
      : 1
    : a.recognition_key < b.recognition_key
      ? -1
      : a.recognition_key > b.recognition_key
        ? 1
        : 0;

/**
 * The keys the amendment adds to the shipped read: those of revisions whose
 * posted keys are all gone while one of their pending keys is current.
 */
export function addedStaleKeys(db: Database): StaleCardPurchaseKeyRow[] {
  const current = new Set(
    all<CurrentCardUsageRow>(db, CURRENT_CARD_USAGE_SQL, [0, -1]).flatMap((row) =>
      row.recognition_key === null ? [] : [row.recognition_key],
    ),
  );
  const byRevision = new Map<string, StaleCardPurchaseKeyRow[]>();
  for (const row of all<StaleCardPurchaseKeyRow>(db, LIVE_KEYS_SQL, [])) {
    const id = JSON.stringify([row.event_id, row.revision]);
    byRevision.set(id, [...(byRevision.get(id) ?? []), row]);
  }
  const added: StaleCardPurchaseKeyRow[] = [];
  for (const rows of byRevision.values()) {
    const posted = rows.filter((row) => row.role === "posted");
    const pending = rows.filter((row) => row.role === "pending");
    if (
      posted.length > 0 &&
      posted.every((row) => !current.has(row.recognition_key)) &&
      pending.some((row) => current.has(row.recognition_key))
    )
      added.push(...rows);
  }
  return added.sort(order);
}

/**
 * Runs the amended read and checks it against the shipped text plus exactly
 * `addedStaleKeys`, in the read's order and up to its page size.
 */
export function expectStaleKeys(db: Database, page: PageSql): StaleCardPurchaseKeyRow[] {
  const found = all<StaleCardPurchaseKeyRow>(db, page.sql, page.args);
  const limit = page.args[2] as number;
  const shipped = all<StaleCardPurchaseKeyRow>(db, STATEMENT_SLOT_STALE_CARD_PURCHASE_KEYS_SQL, [
    ...page.args.slice(0, 2),
    -1,
  ]);
  const added = addedStaleKeys(db);
  // The shipped text never reported a revision the amendment adds.
  const shippedEvents = new Set(shipped.map((row) => row.event_id));
  expect(added.filter((row) => shippedEvents.has(row.event_id))).toEqual([]);
  expect(found).toEqual([...shipped, ...added].sort(order).slice(0, limit));
  return found;
}
