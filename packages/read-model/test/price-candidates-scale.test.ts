// The candidate reads on a scaled store with the complete CORE schema and no
// table statistics, as D1 runs them: 13 currencies on a board published four
// times a day. The read takes every row of each wanted key's whole history
// (the window bounds what it returns, not what it reads), so its cost grows
// with that history; these tests hold the plan to index searches and the
// answers to `selectPrices`'. CI builds `CI_BOARDS`; set
// KOGANE_PRICE_CANDIDATES_SCALE=full to build `FULL_BOARDS` (three years, or
// KOGANE_PRICE_CANDIDATES_BOARDS boards) and print the timings ADR 0056 and
// docs/calculation-and-reports.md quote. Every value is synthetic.
//
// D1 has no table statistics, and neither does this store, so the planner
// chooses the same plan at 200 boards as on an empty store: the CI run guards
// the plan's structure only (no SCAN of a stored table, one
// price_observations_instrument SEARCH, one MATERIALIZE keyed) and the
// answers. The cost's growth with history is only observed when
// KOGANE_PRICE_CANDIDATES_SCALE=full builds the large store.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  selectionReadWindow,
  selectPrice,
  type KnowledgeMode,
  type PriceKey,
  type PriceSelectionPolicy,
  type SelectionBound,
} from "../../domain/src/market-data.ts";
import {
  PRICE_CANDIDATES_KNOWN_AT_SQL,
  PRICE_CANDIDATES_SQL,
  priceCandidateArgs,
  selectPriceCandidates,
  selectPrices,
} from "../src/price-selection";
import { executor, migratedDatabase, PriceStore } from "./price-candidates-fixture";

const FULL = process.env["KOGANE_PRICE_CANDIDATES_SCALE"] === "full";
const CI_BOARDS = 200;
const FULL_BOARDS = Number(process.env["KOGANE_PRICE_CANDIDATES_BOARDS"] ?? 4_380);
const BOARDS = FULL ? FULL_BOARDS : CI_BOARDS;
const TIMEOUT = FULL ? 1_800_000 : 60_000;
const CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "NZD",
  "CAD",
  "HKD",
  "SGD",
  "ZAR",
  "NOK",
  "TRY",
  "CNY",
  "BRL",
];
const KEYS: PriceKey[] = CURRENCIES.map((code) => ({
  baseInstrumentRef: code,
  quoteUnitRef: "JPY",
  priceKind: "reference",
}));
const POLICY: PriceSelectionPolicy = {
  policyId: "test:fx-selection",
  admittedRules: ["fx-sbi-shinsei-board-v1"],
  priceKinds: ["reference"],
  acceptedBases: ["provider", "collector"],
  zone: "Asia/Tokyo",
  freshness: { unit: "calendar-days", maxAgeDays: 4 },
  dateOnly: "exclude",
  multiSource: "refuse-on-overlap",
  candidateScope: "latest-in-window",
};
// The last board is published at 2026-09-08T00:00Z, one every six hours before it.
const LAST = Date.parse("2026-09-08T00:00:00.000Z");
const at = (board: number): string => new Date(LAST - (BOARDS - board) * 21_600_000).toISOString();
const bound = (knowledge: KnowledgeMode): SelectionBound => ({
  effectiveBefore: "2026-09-08T15:00:00.000Z",
  asOfDate: "2026-09-08",
  knowledge,
});
const MODES: KnowledgeMode[] = [
  { mode: "current" },
  { mode: "known-at", knownAt: "2026-09-08T12:00:00.000Z" },
];

let store: PriceStore;

beforeAll(() => {
  migratedDatabase().close();
  store = new PriceStore();
  store.db.exec("BEGIN");
  for (let board = 1; board <= BOARDS; board += 1) {
    store.parse(board, board).publish(board, board, at(board));
    for (const key of KEYS)
      store.price({
        id: `${key.baseInstrumentRef}-${String(board).padStart(5, "0")}`,
        run: board,
        key,
        amount: `${100 + (board % 50)}.25`,
        at: at(board),
        recordedAt: at(board),
      });
  }
  store.db.exec("COMMIT");
}, TIMEOUT);

const wants = (knowledge: KnowledgeMode) =>
  KEYS.map((key) => ({
    key,
    snapshotParseRunId: null,
    window: selectionReadWindow(POLICY, bound(knowledge), null),
  }));

/** Median wall time of `runs` calls, in milliseconds. */
async function timed(call: () => Promise<unknown>, runs = 5): Promise<number> {
  const times: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now();
    await call();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

describe(`price candidates on ${BOARDS} boards of ${KEYS.length} currencies`, () => {
  test("the store is what D1 runs: every CORE migration, no ANALYZE", () => {
    expect(
      store.db
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(store.db.query("SELECT count(*) AS n FROM price_observations").get()).toEqual({
      n: BOARDS * KEYS.length,
    });
  });

  test("both plans stay index searches over the whole history", () => {
    for (const knowledge of MODES) {
      const read = priceCandidateArgs({ wants: wants(knowledge), knowledge });
      const lines = (
        store.db.query(`EXPLAIN QUERY PLAN ${read.sql}`).all(...(read.args as never[])) as {
          detail: string;
        }[]
      ).map((row) => row.detail);
      expect(
        lines.filter((line) =>
          /SCAN (po|price_observations|c|price_observation_claims|pub|published_parse_runs|pr|parse_runs|e|publication_events)\b/u.test(
            line,
          ),
        ),
      ).toEqual([]);
      expect(
        lines.filter((line) =>
          line.startsWith("SEARCH po USING INDEX price_observations_instrument"),
        ),
      ).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith("MATERIALIZE keyed"))).toHaveLength(1);
      expect(read.sql).toBe(
        knowledge.mode === "current" ? PRICE_CANDIDATES_SQL : PRICE_CANDIDATES_KNOWN_AT_SQL,
      );
    }
  });

  test("only the window comes back, and every key gets the price selectPrices picks", async () => {
    const sql = executor(store.db);
    const shipped = new Map(
      (
        await selectPrices(sql, {
          baseInstrumentRefs: CURRENCIES,
          cutoff: "2026-09-08T12:00:00.000Z",
        })
      ).map((row) => [row.price.baseInstrumentRef, row.price.id]),
    );
    for (const knowledge of MODES) {
      const read = await selectPriceCandidates(sql, { wants: wants(knowledge), knowledge });
      // The window starts 2026-09-02 00:00Z: 25 boards up to 09-08 00:00Z, and
      // the newest board before it. Older history is read but not returned.
      for (const rows of read)
        expect(
          rows.reduce<Record<string, number>>((counts, row) => {
            counts[row.reach] = (counts[row.reach] ?? 0) + 1;
            return counts;
          }, {}),
        ).toEqual({ window: 25, "before-window": 1 });
      KEYS.forEach((key, index) => {
        const selection = selectPrice(
          key,
          read[index]!.map((row) => row.candidate),
          bound(knowledge),
          POLICY,
          null,
        );
        expect(
          selection.status === "selected" ? selection.candidate.price.id : selection.reason,
        ).toBe(shipped.get(key.baseInstrumentRef)!);
      });
    }
  });

  test(
    "timings (printed at full scale)",
    async () => {
      const sql = executor(store.db);
      // One after the other: interleaved calls would time each other's work.
      const current = await timed(() =>
        selectPriceCandidates(sql, { wants: wants(MODES[0]!), knowledge: MODES[0]! }),
      );
      const knownAt = await timed(() =>
        selectPriceCandidates(sql, { wants: wants(MODES[1]!), knowledge: MODES[1]! }),
      );
      const legacy = await timed(() =>
        selectPrices(sql, { baseInstrumentRefs: CURRENCIES, cutoff: "2026-09-08T15:00:00.000Z" }),
      );
      if (FULL)
        console.log(
          `${BOARDS} boards: current ${current.toFixed(0)} ms, known-at ${knownAt.toFixed(0)} ms, selectPrices ${legacy.toFixed(0)} ms`,
        );
      expect(current).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
