// The purchases read's one pass over current card usage
// (`CARD_PURCHASE_CURRENT_SQL`, src/query/card-purchases.ts) against the text
// it shipped before it classified unrecognised rows
// (card-purchase-current-legacy-sql.ts), on the small random card stores of
// packages/read-model/test/card-usage-random-store.ts: the same page keys and
// the same unrecognised count, and exactly the unrecognised rows, with the
// columns recognition classifies, up to the bound. The reasons the page then
// reports are each row's own `classifyCardUsage` reason. Every value is
// synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CARD_USAGE_UNRECOGNIZED_REASONS,
  unrecognizedReasonCounts,
  type CardUsageUnrecognizedReason,
} from "../../domain/src/card-purchase.ts";
import {
  CURRENT_CARD_USAGE_SQL,
  type CurrentCardUsageRow,
} from "../../read-model/src/card-usage.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { RandomStore, SEED_COUNT, SEEDS } from "../../read-model/test/card-usage-random-store.ts";
import { CARD_PURCHASE_CURRENT_SQL, queryCardPurchases } from "../src/query/card-purchases.ts";
import { CARD_USAGE_FACT_COLUMNS, cardUsageFactOf } from "../src/query/card-usage-fact.ts";
import { LEGACY_CARD_PURCHASE_CURRENT_SQL } from "./card-purchase-current-legacy-sql.ts";

function all<T>(db: Database, sql: string, args: readonly unknown[]): T[] {
  return db.query(sql).all(...(args as SQLQueryBindings[])) as T[];
}

function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(query: string, args: readonly unknown[]) => all<T>(db, query, args),
    first: async <T>(query: string, args: readonly unknown[]) =>
      (db.query(query).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

const project = (row: Record<string, unknown>) =>
  Object.fromEntries(CARD_USAGE_FACT_COLUMNS.map((column) => [column, row[column]]));

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
  // A page's keys: every other current key, held keys that may not be current,
  // and a key nothing has.
  const asked = JSON.stringify([
    ...current.flatMap((row, index) =>
      row.recognition_key !== null && index % 2 === 0 ? [row.recognition_key] : [],
    ),
    ...[...held].slice(0, 5),
    JSON.stringify(["vpass", "none", null, "none", "none"]),
  ]);
  const legacy = all<{ current_key: string | null; unrecognized: number | null }>(
    db,
    LEGACY_CARD_PURCHASE_CURRENT_SQL,
    [0, -1, asked],
  );
  const legacyKeys = legacy.flatMap((row) => (row.current_key === null ? [] : [row.current_key]));
  const legacyCount = legacy.find((row) => row.current_key === null)?.unrecognized;
  const unheld = current
    .filter((row) => row.recognition_key === null || !held.has(row.recognition_key))
    .sort((a, b) => a.observation_id - b.observation_id);
  expect(legacyCount).toBe(unheld.length);
  for (const limit of [-1, 0, 1, 3]) {
    const rows = all<Record<string, unknown> & { part: string }>(db, CARD_PURCHASE_CURRENT_SQL, [
      0,
      -1,
      asked,
      limit,
    ]);
    expect(rows.flatMap((row) => (row.part === "key" ? [row["current_key"]] : [])).sort()).toEqual(
      [...legacyKeys].sort(),
    );
    expect(rows.filter((row) => row.part === "count").map((row) => row["unrecognized"])).toEqual([
      legacyCount,
    ]);
    const bounded = limit < 0 ? unheld : unheld.slice(0, limit);
    expect(rows.filter((row) => row.part === "row").map(project)).toEqual(bounded.map(project));
  }
  const page = await queryCardPurchases(executor(db));
  expect(page.coverage.unrecognizedCurrentRows).toBe(unheld.length);
  expect(page.coverage.unrecognizedReasons).toEqual(
    unrecognizedReasonCounts(unheld.map(cardUsageFactOf), unheld.length),
  );
  expect(page.coverage.unrecognizedReasons.reduce((sum, entry) => sum + entry.rows, 0)).toBe(
    unheld.length,
  );
  for (const entry of page.coverage.unrecognizedReasons) reported.add(entry.reasonCode);
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
    // Unsupported payment types (installment and revolving wording, Vpass
    // codes other than 1), rows the rule accepts but nothing holds yet, and
    // rows without a key or an amount.
    for (const reason of [
      "payment_type_unsupported",
      "not_yet_recognized",
      "card_identity_unstable",
      "amount_not_exact",
    ] as const)
      expect(reported).toContain(reason);
    for (const reason of reported) expect(CARD_USAGE_UNRECOGNIZED_REASONS).toContain(reason);
  });
});
