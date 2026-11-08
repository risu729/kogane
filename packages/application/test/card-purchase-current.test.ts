// The purchases read's one pass over current card usage (`CURRENT_SQL`,
// src/query/card-purchases.ts) against the text it shipped before #1020
// classified unrecognised rows (card-purchase-current-legacy-sql.ts), on the
// small random card stores of
// packages/read-model/test/card-usage-random-store.ts: the same page keys and
// the same unrecognised count, and exactly the unrecognised rows, whole and in
// observation id order, up to the bound. The reasons the page then reports are
// each row's own `classifyCardUsage` reason. The scaled-store comparison is in
// card-purchase-scale.test.ts. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CARD_PURCHASE_SOURCES,
  CARD_USAGE_UNRECOGNIZED_REASONS,
  classifyCardUsage,
  type CardUsageUnrecognizedReason,
} from "../../domain/src/card-purchase.ts";
import type { CardPurchaseUnrecognizedReasons } from "../../domain/src/card-purchase-view.ts";
import {
  CURRENT_CARD_USAGE_SQL,
  type CurrentCardUsageRow,
} from "../../read-model/src/card-usage.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  all,
  RandomStore,
  SEED_COUNT,
  SEEDS,
} from "../../read-model/test/card-usage-random-store.ts";
import { cardUsageFactOf } from "../src/card-usage-fact.ts";
import {
  CARD_PURCHASE_UNRECOGNIZED_LIMIT,
  CURRENT_SQL,
  queryCardPurchases,
} from "../src/query/card-purchases.ts";
import { LEGACY_CURRENT_SQL } from "./card-purchase-current-legacy-sql.ts";

interface PassRow extends CurrentCardUsageRow {
  on_page: number;
  unrecognized: number;
  unrecognized_total: number;
  position: number;
}

function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(query: string, args: readonly unknown[]) => all<T>(db, query, args),
    first: async <T>(query: string, args: readonly unknown[]) =>
      (db.query(query).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

/** A pass row without the columns the pass adds: the current usage row itself. */
function usageOf(row: PassRow): CurrentCardUsageRow {
  const {
    on_page: _onPage,
    unrecognized: _unrecognized,
    unrecognized_total: _total,
    position: _position,
    ...usage
  } = row;
  return usage;
}

/** The reasons the seeds reported, for the coverage check. */
const reported = new Set<CardUsageUnrecognizedReason>();

async function expectSamePass(db: Database): Promise<void> {
  const current = all<CurrentCardUsageRow>(db, CURRENT_CARD_USAGE_SQL, [0, -1]);
  const held = new Set(
    all<{ recognition_key: string }>(
      db,
      "SELECT recognition_key FROM current_card_purchase_keys",
      [],
    ).map((row) => row.recognition_key),
  );
  const unheld = current
    .filter((row) => row.recognition_key === null || !held.has(row.recognition_key))
    .sort((a, b) => a.observation_id - b.observation_id);
  // Page key lists: none, every other current key (held and unheld alike),
  // held keys that may no longer be current, and a key nothing has.
  const lists = [
    [],
    [
      ...current.flatMap((row, index) =>
        row.recognition_key !== null && index % 2 === 0 ? [row.recognition_key] : [],
      ),
      ...[...held].slice(0, 5),
      JSON.stringify(["vpass", "none", null, "none", "none"]),
    ],
  ];
  for (const keys of lists) {
    const json = JSON.stringify(keys);
    const legacy = all<{ current_key: string | null; unrecognized: number | null }>(
      db,
      LEGACY_CURRENT_SQL,
      [0, -1, json],
    );
    const legacyKeys = legacy.flatMap((row) => (row.current_key === null ? [] : [row.current_key]));
    const legacyCount = legacy.find((row) => row.current_key === null)?.unrecognized;
    expect(legacyCount).toBe(unheld.length);
    // A bound of at least one, as shipped: with any unrecognised row, one is
    // returned, so the total always rides on a row.
    for (const bound of [1, 3, CARD_PURCHASE_UNRECOGNIZED_LIMIT]) {
      const rows = all<PassRow>(db, CURRENT_SQL, [0, -1, json, bound]);
      // Every row is on the page or unrecognised, in observation id order.
      expect(rows.every((row) => row.on_page === 1 || row.unrecognized === 1)).toBe(true);
      const ids = rows.map((row) => row.observation_id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      // The same page keys, row for row, as the shipped text.
      expect(
        rows
          .flatMap((row) =>
            row.on_page === 1 && row.recognition_key !== null ? [row.recognition_key] : [],
          )
          .sort(),
      ).toEqual([...legacyKeys].sort());
      // The same count, on every row and whatever the bound.
      expect(new Set<unknown>(rows.map((row) => row.unrecognized_total))).toEqual(
        new Set<unknown>(rows.length === 0 ? [] : [legacyCount]),
      );
      if (rows.length === 0) expect(legacyCount).toBe(0);
      // Exactly the first `bound` unrecognised rows, whole.
      expect(
        rows.filter((row) => row.unrecognized === 1 && row.position <= bound).map(usageOf),
      ).toEqual(unheld.slice(0, bound));
    }
  }

  // The page counts each of those rows under its own rule's reason.
  const page = await queryCardPurchases(executor(db));
  expect(page.coverage.unrecognizedCurrentRows).toBe(unheld.length);
  const classified = unheld.slice(0, CARD_PURCHASE_UNRECOGNIZED_LIMIT);
  const expected: CardPurchaseUnrecognizedReasons["counts"] = [];
  for (const sourceId of CARD_PURCHASE_SOURCES)
    for (const reasonCode of CARD_USAGE_UNRECOGNIZED_REASONS) {
      const rows = classified.filter((row) => {
        if (row.source_id !== sourceId) return false;
        const outcome = classifyCardUsage(cardUsageFactOf(row));
        return (outcome.ok ? "recognition_pending" : outcome.reasonCode) === reasonCode;
      }).length;
      if (rows > 0) expected.push({ sourceId, reasonCode, rows });
    }
  expect(page.coverage.unrecognizedReasons).toEqual({
    complete: classified.length === unheld.length,
    counts: expected,
  });
  for (const entry of page.coverage.unrecognizedReasons.counts) reported.add(entry.reasonCode);
}

describe("the purchases read's pass over current usage equals the shipped one", () => {
  for (const seed of SEEDS)
    test(`seed ${seed}`, async () => {
      const world = new RandomStore(seed);
      world.capture(4);
      await expectSamePass(world.db);
      await world.recognise();
      world.capture(3);
      await expectSamePass(world.db);
      await world.retire();
      await world.recognise();
      await expectSamePass(world.db);
    }, 30_000);

  test.if(SEED_COUNT >= 4)("the seeds reported the reasons random stores produce", () => {
    // Payment types recognition skips, rows the rule accepts that nothing
    // holds yet, and rows without a stable identity or an exact amount.
    for (const reason of [
      "payment_type_unsupported",
      "recognition_pending",
      "card_identity_unstable",
      "amount_not_exact",
    ] as const)
      expect(reported).toContain(reason);
  });
});
