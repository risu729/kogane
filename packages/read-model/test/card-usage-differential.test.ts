// The rewritten current card usage reads against the text #233 and #236
// shipped (card-usage-legacy-sql.ts), row for row, on small random card stores
// (card-usage-random-store.ts, which lists the states each seed draws at
// random). The last test checks that the seeds together drew every one of
// those states. Every value is synthetic.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CURRENT_CARD_USAGE_SQL,
  type CurrentCardUsageRow,
  currentCardUsageSql,
  type PageSql,
  type StaleCardPurchaseKeyRow,
  staleCardPurchaseKeysSql,
  unrecognizedCardUsageCountSql,
} from "../src/index";
import {
  LEGACY_CURRENT_CARD_USAGE_SQL,
  STATEMENT_SLOT_CURRENT_CARD_USAGE_SQL,
  STATEMENT_SLOT_STALE_CARD_PURCHASE_KEYS_SQL,
  STATEMENT_SLOT_UNRECOGNIZED_CARD_USAGE_COUNT_SQL,
} from "./card-usage-legacy-sql";
import { all, drawn, RandomStore, SEED_COUNT, SEEDS } from "./card-usage-random-store";

/** One read by the current text and by the shipped text; they must return the same rows. */
function same<T>(db: Database, page: PageSql, legacy: string): T[] {
  const found = all<T>(db, page.sql, page.args);
  expect(found).toEqual(all<T>(db, legacy, page.args));
  return found;
}

/**
 * Every read the lane and the operator view make, by both texts: the whole
 * set, the lane's paging at two page sizes, short pages after cursors inside
 * the set, the stale keys at every page size and the unrecognised count.
 */
function expectSameReads(db: Database): void {
  const current = same<CurrentCardUsageRow>(
    db,
    { sql: CURRENT_CARD_USAGE_SQL, args: [0, -1] },
    STATEMENT_SLOT_CURRENT_CARD_USAGE_SQL,
  );
  for (const limit of [25, 1000]) {
    const paged: CurrentCardUsageRow[] = [];
    for (let afterId = 0; ;) {
      const page = same<CurrentCardUsageRow>(
        db,
        currentCardUsageSql({ afterId, limit }),
        STATEMENT_SLOT_CURRENT_CARD_USAGE_SQL,
      );
      paged.push(...page);
      if (page.length < limit) break;
      afterId = page.at(-1)!.observation_id;
    }
    expect(paged).toEqual(current);
  }
  for (const row of [0.3, 0.7].map((at) => current[Math.floor(current.length * at)]!))
    for (const limit of [1, 3])
      same(
        db,
        currentCardUsageSql({ afterId: row.observation_id, limit }),
        STATEMENT_SLOT_CURRENT_CARD_USAGE_SQL,
      );
  for (const limit of [1, 3, 100, 1000]) {
    const stale = same<StaleCardPurchaseKeyRow>(
      db,
      staleCardPurchaseKeysSql(limit),
      STATEMENT_SLOT_STALE_CARD_PURCHASE_KEYS_SQL,
    );
    if (stale.length > 0) drawn.add("stale keys");
    if (stale.some((row) => row.key_count > 1)) drawn.add("stale merged revision");
  }
  same(db, unrecognizedCardUsageCountSql(), STATEMENT_SLOT_UNRECOGNIZED_CARD_USAGE_COUNT_SQL);

  // The MyJCB rules the stores exercise: each is recorded when dropping it
  // (or the shipped one-slot text) would change the rows.
  const without = (from: string): CurrentCardUsageRow[] => {
    expect(CURRENT_CARD_USAGE_SQL.split(from)).toHaveLength(2);
    return all(db, CURRENT_CARD_USAGE_SQL.replace(from, ""), [0, -1]);
  };
  if (!Bun.deepEquals(all(db, LEGACY_CURRENT_CARD_USAGE_SQL, [0, -1]), current))
    drawn.add("shipped one-slot text differs");
  if (!Bun.deepEquals(without("AND position_rank = 1"), current))
    drawn.add("position rule decides a capture");
  if (
    !Bun.deepEquals(
      without("AND (NOT pending_capture OR fetch_run_id = newest_position_run)"),
      current,
    )
  )
    drawn.add("account position rule decides a row");
  const pendingPositions = new Map<string, Set<string>>();
  for (const row of current)
    if (row.source_id === "myjcb" && row.display_state === "pending") {
      const { artifact_key: key } = db
        .query("SELECT artifact_key FROM observation_fetch_artifacts WHERE id=?")
        .get(row.fetch_artifact_id) as { artifact_key: string };
      const [connection = "", position = ""] = key.split("/");
      pendingPositions.set(
        connection,
        (pendingPositions.get(connection) ?? new Set()).add(position),
      );
    }
  if ([...pendingPositions.values()].some((positions) => positions.size > 1))
    drawn.add("two pending statements current in one connection");

  const rows = current;
  if (rows.some((row) => row.recognition_key === null)) drawn.add("current row without a key");
  if (rows.some((row) => row.source_account_id === null)) drawn.add("current row without identity");
  if (rows.some((row) => row.value_status === null)) drawn.add("current row without decimal-v1");
  if (rows.some((row) => row.provider_family === null)) drawn.add("current row without extras");
  if (rows.some((row) => row.policy_family === "vpass-card-binding"))
    drawn.add("current row identified by binding");
  if (rows.some((row) => row.policy_family === "identity-default"))
    drawn.add("current row identified by default");
  for (const row of rows) drawn.add(`current ${row.source_id} ${row.display_state}`);
}

describe("the rewritten reads equal the shipped reads on random card stores", () => {
  for (const seed of SEEDS)
    test(`seed ${seed}`, async () => {
      // Each read costs a few milliseconds whatever the store, so three checkpoints:
      // captures only, live events of which some are stale, then some retired.
      const world = new RandomStore(seed);
      world.capture(4);
      expectSameReads(world.db);
      await world.recognise();
      world.capture(3);
      expectSameReads(world.db);
      await world.retire();
      await world.recognise();
      expectSameReads(world.db);
    }, 30_000);

  test.if(SEED_COUNT >= 4)("the seeds drew every state the shipped reads handle", () => {
    expect([...drawn].sort()).toEqual(
      [
        "binding excluded",
        "card ordinal changed",
        "current myjcb pending",
        "current myjcb posted",
        "current row identified by binding",
        "current row identified by default",
        "current row without a key",
        "current row without decimal-v1",
        "current row without extras",
        "current row without identity",
        "current vpass pending",
        "current vpass posted",
        "identity run unsealed",
        "identity v1",
        "identity v1 superseded by v2",
        "malformed extras",
        "merged revision",
        "mistyped extras",
        "myjcb confirmed",
        "myjcb run failure",
        "myjcb run success",
        "myjcb unconfirmed",
        "parse never identified",
        "publication none",
        "publication published",
        "publication unpublished",
        "retired event",
        "row without a decimal-v1 value",
        "row without an external id",
        "stale keys",
        "stale merged revision",
        "superseded parse",
        "tied capture time",
        "two cards, one account",
        "two connections, one account",
        "myjcb run per connection",
        "myjcb confirmed position 0",
        "myjcb confirmed position 1",
        "myjcb confirmed position 2",
        "myjcb unconfirmed position 0",
        "myjcb unconfirmed position 1",
        "myjcb confirmed relative label",
        "myjcb unconfirmed relative label",
        "shipped one-slot text differs",
        "position rule decides a capture",
        "account position rule decides a row",
        "two pending statements current in one connection",
        "vpass customized",
        "vpass run failure",
        "vpass run success",
        "vpass web",
      ].sort(),
    );
  });
});
