// Candidate reads for as-of selection (src/price-selection.ts,
// `selectPriceCandidates`, ADR 0056) over the migrated CORE schema, decided by
// the domain's `selectPrice`. Synthetic prices, claims, parses and
// publications only; every instrument and amount is invented.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../domain/src/context.ts";
import {
  selectionReadWindow,
  selectPrice,
  type KnowledgeMode,
  type PriceKey,
  type PriceSelection,
  type PriceSelectionPolicy,
  type SelectionBound,
} from "../../domain/src/market-data.ts";
import { civilDateOfInstant } from "../../domain/src/time.ts";
import {
  PRICE_CANDIDATE_ROW_BOUND,
  PRICE_CANDIDATES_KNOWN_AT_SQL,
  PRICE_CANDIDATES_SQL,
  PRICE_SELECTION_BOUND,
  PRICE_SELECTION_SQL,
  PriceCandidateError,
  selectPriceCandidates,
  selectPrices,
  type PriceCandidateWant,
} from "../src/price-selection";
import { executor, migratedDatabase, PriceStore, USD } from "./price-candidates-fixture";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

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
const CURRENT: KnowledgeMode = { mode: "current" };
const knownAt = (at: string): KnowledgeMode => ({ mode: "known-at", knownAt: at });
const bound = (knowledge: KnowledgeMode = CURRENT, asOfDate = "2026-09-10"): SelectionBound => ({
  effectiveBefore: new Date(Date.parse(`${asOfDate}T00:00:00.000Z`) + 15 * 3_600_000).toISOString(),
  asOfDate,
  knowledge,
});

async function select(
  store: PriceStore,
  options: {
    knowledge?: KnowledgeMode;
    key?: PriceKey;
    policy?: PriceSelectionPolicy;
    snapshot?: number | null;
    asOfDate?: string;
  } = {},
): Promise<PriceSelection> {
  const policy = options.policy ?? POLICY;
  const at = bound(options.knowledge, options.asOfDate);
  const key = options.key ?? USD;
  const [rows] = await selectPriceCandidates(executor(store.db), {
    wants: [
      {
        key,
        snapshotParseRunId: options.snapshot ?? null,
        window: selectionReadWindow(policy, at, null),
      },
    ],
    knowledge: at.knowledge,
  });
  return selectPrice(
    key,
    rows!.map((row) => row.candidate),
    at,
    policy,
    null,
  );
}
const chosen = (selection: PriceSelection): string | null =>
  selection.status === "selected" ? selection.candidate.price.id : null;

describe("knowledge: current and known-at", () => {
  // Parse 1 published at t1, its price recorded a minute later; a re-parse
  // published at t2, its price recorded a minute after that; then a rollback.
  const T1 = "2026-09-08T00:00:00.000Z";
  const T2 = "2026-09-09T00:00:00.000Z";
  const T3 = "2026-09-09T12:00:00.000Z";
  function history(): PriceStore {
    return new PriceStore()
      .parse(1, 1)
      .publish(1, 1, T1)
      .price({ id: "p-first", run: 1, amount: "146", recordedAt: "2026-09-08T00:01:00.000Z" })
      .parse(2, 1)
      .publish(1, 2, T2)
      .price({ id: "p-reparse", run: 2, amount: "147", recordedAt: "2026-09-09T00:01:00.000Z" });
  }

  test("a re-parse supersedes in current mode; known-at sees what was published then", async () => {
    const store = history();
    expect(chosen(await select(store))).toBe("p-reparse");
    expect(chosen(await select(store, { knowledge: knownAt("2026-09-08T12:00:00Z") }))).toBe(
      "p-first",
    );
    // Before the first price was recorded there was nothing to know.
    const before = await select(store, { knowledge: knownAt("2026-09-08T00:00:30Z") });
    expect([before.status, before.status === "refused" && before.reason]).toEqual([
      "refused",
      "missing",
    ]);
    // The pointer had moved to the re-parse, whose price was not recorded yet:
    // the first parse's price is not current any more, so it is not used.
    expect(chosen(await select(store, { knowledge: knownAt("2026-09-09T00:00:30Z") }))).toBeNull();
    // 12:00 in Tokyo is 03:00Z, after the re-parse's price was recorded.
    expect(chosen(await select(store, { knowledge: knownAt("2026-09-09T12:00:00+09:00") }))).toBe(
      "p-reparse",
    );
  });

  test("a rollback moves both modes back, and history before it stays as it was", async () => {
    const store = history().publish(1, 1, T3, "rollback");
    expect(chosen(await select(store))).toBe("p-first");
    expect(chosen(await select(store, { knowledge: knownAt("2026-09-09T06:00:00Z") }))).toBe(
      "p-reparse",
    );
    expect(chosen(await select(store, { knowledge: knownAt(T3) }))).toBe("p-first");
  });

  test("ties at the knowledge instant are included: recorded at K, published at K", async () => {
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-10T01:00:00.000Z")
      .price({ id: "at-k", run: 1, amount: "146", recordedAt: "2026-09-10T02:00:00.000Z" });
    expect(chosen(await select(store, { knowledge: knownAt("2026-09-10T02:00:00Z") }))).toBe(
      "at-k",
    );
    expect(
      chosen(await select(store, { knowledge: knownAt("2026-09-10T01:59:59.999Z") })),
    ).toBeNull();
    const published = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-10T03:00:00.000Z")
      .price({ id: "p", run: 1, amount: "146", recordedAt: "2026-09-10T02:00:00.000Z" });
    expect(
      chosen(await select(published, { knowledge: knownAt("2026-09-10T12:00:00+09:00") })),
    ).toBe("p");
    expect(
      chosen(await select(published, { knowledge: knownAt("2026-09-10T02:59:59.999Z") })),
    ).toBeNull();
  });

  test("known-at is exact: a price recorded a fraction of a millisecond after K is not known", async () => {
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-10T01:00:00.000Z")
      .price({ id: "after-k", run: 1, amount: "146", recordedAt: "2026-09-10T02:00:00.0004Z" });
    // SQLite's julianday rounds both to the same millisecond; the domain does not.
    const result = await select(store, { knowledge: knownAt("2026-09-10T02:00:00.000Z") });
    expect(result).toMatchObject({ status: "refused", reason: "missing" });
    expect(result.excluded.recorded_after_known_at).toBe(1);
    // K itself is refused when it is finer than the millisecond SQL compares at.
    await expect(
      select(store, { knowledge: knownAt("2026-09-10T02:00:00.0001Z") }),
    ).rejects.toThrow("knowledge_invalid");
  });

  test("same effective and recorded time: equal amounts tie-break by id, different ones disagree", async () => {
    const store = new PriceStore().parse(1, 1).publish(1, 1, "2026-09-10T01:00:00.000Z");
    store.parse(2, 2).publish(2, 2, "2026-09-10T01:00:00.000Z");
    store.price({ id: "a", run: 1, amount: "146" }).price({ id: "b", run: 2, amount: "146" });
    const agree = await select(store);
    expect([chosen(agree), agree.status === "selected" && agree.corroboratedBy]).toEqual([
      "b",
      ["a"],
    ]);
    store.parse(3, 3).publish(3, 3, "2026-09-10T01:00:00.000Z");
    store.price({ id: "c", run: 3, amount: "146.5" });
    expect(await select(store)).toMatchObject({
      status: "refused",
      reason: "disagree",
      candidateIds: ["a", "b", "c"],
    });
  });
});

describe("scope, window and stored shapes", () => {
  test("same-snapshot never takes an older snapshot's price", async () => {
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-09T01:00:00.000Z")
      .parse(2, 2)
      .publish(2, 2, "2026-09-10T01:00:00.000Z")
      .price({ id: "older-snapshot", run: 1, amount: "146", at: "2026-09-09T10:00:00+09:00" });
    const policy = { ...POLICY, candidateScope: "same-snapshot" as const };
    expect(chosen(await select(store, { policy, snapshot: 2 }))).toBeNull();
    expect(chosen(await select(store, { policy, snapshot: 1 }))).toBe("older-snapshot");
    expect(chosen(await select(store))).toBe("older-snapshot");
  });

  test("the newest rows before the window are returned so that stale is told from missing", async () => {
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-01T01:00:00.000Z")
      .price({ id: "old-a", run: 1, amount: "140", at: "2026-08-20T10:00:00+09:00" })
      .price({ id: "old-b", run: 1, amount: "141", at: "2026-08-30T10:00:00+09:00" })
      .price({ id: "old-c", run: 1, amount: "141", at: "2026-08-30T01:00:00Z" })
      .price({ id: "future", run: 1, amount: "150", at: "2026-09-20T10:00:00+09:00" });
    const at = bound();
    const [rows] = await selectPriceCandidates(executor(store.db), {
      wants: [
        { key: USD, snapshotParseRunId: null, window: selectionReadWindow(POLICY, at, null) },
      ],
      knowledge: CURRENT,
    });
    // Both rows of the newest instant before the window, nothing older, nothing far ahead.
    expect(rows!.map((row) => [row.reach, row.candidate.price.id])).toEqual([
      ["before-window", "old-b"],
      ["before-window", "old-c"],
    ]);
    expect(await select(store)).toMatchObject({
      status: "refused",
      reason: "stale",
      candidateIds: ["old-b", "old-c"],
      ageDays: 11,
    });
  });

  test("an unreadable stored effective time is returned and counted, a date-only one is placed", async () => {
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-01T01:00:00.000Z")
      .price({
        id: "garbled",
        run: 1,
        amount: "146",
        effective: JSON.stringify({
          kind: "instant",
          value: "not a time",
          zone: "UTC",
          basis: "provider",
        }),
      })
      .price({
        id: "half-read",
        run: 1,
        amount: "146",
        effective: JSON.stringify({
          kind: "instant",
          value: "2026-09-10 10:00",
          zone: "UTC",
          basis: "provider",
        }),
      })
      .price({
        id: "dated",
        run: 1,
        amount: "146",
        effective: JSON.stringify({
          kind: "local-date",
          value: "2026-09-09",
          zone: "Asia/Tokyo",
          basis: "provider",
        }),
      });
    const at = bound();
    const [rows] = await selectPriceCandidates(executor(store.db), {
      wants: [
        { key: USD, snapshotParseRunId: null, window: selectionReadWindow(POLICY, at, null) },
      ],
      knowledge: CURRENT,
    });
    expect(
      rows!.map((row) => [
        row.candidate.price.id,
        row.reach,
        row.candidate.price.effectiveTime.kind,
      ]),
    ).toEqual([
      ["dated", "window", "local-date"],
      ["garbled", "unordered", "unknown"],
      // SQLite reads "2026-09-10 10:00" as a time; the domain does not accept it.
      ["half-read", "window", "unknown"],
    ]);
    const result = await select(store);
    expect(result).toMatchObject({ status: "refused", reason: "missing" });
    expect(result.excluded).toMatchObject({ invalid_effective_time: 2, date_only_excluded: 1 });
    const civil = await select(store, { policy: { ...POLICY, dateOnly: "civil-date-in-zone" } });
    expect(chosen(civil)).toBe("dated");
  });

  test("the read is refused, never cut, past its bounds", async () => {
    const store = new PriceStore().parse(1, 1).publish(1, 1, "2026-09-01T01:00:00.000Z");
    const window = selectionReadWindow(POLICY, bound(), null);
    const want: PriceCandidateWant = { key: USD, snapshotParseRunId: null, window };
    const sql = executor(store.db);
    await expect(
      selectPriceCandidates(sql, {
        wants: Array.from({ length: PRICE_SELECTION_BOUND + 1 }, () => want),
        knowledge: CURRENT,
      }),
    ).rejects.toThrow("too_many_keys");
    await expect(
      selectPriceCandidates(sql, {
        wants: [{ ...want, window: { ...window, from: "2026-09-01" } }],
        knowledge: CURRENT,
      }),
    ).rejects.toThrow(PriceCandidateError);
    await expect(
      selectPriceCandidates(sql, {
        wants: [want],
        knowledge: { mode: "known-at", knownAt: "today" },
      }),
    ).rejects.toThrow("knowledge_invalid");
    await expect(
      selectPriceCandidates(sql, {
        wants: [{ ...want, key: { ...USD, priceKind: "guess" as never } }],
        knowledge: CURRENT,
      }),
    ).rejects.toThrow("key_invalid");
    store.db.exec("BEGIN");
    for (let index = 0; index <= PRICE_CANDIDATE_ROW_BOUND; index += 1)
      store.price({
        id: `p-${String(index).padStart(5, "0")}`,
        run: 1,
        amount: "146",
        at: new Date(Date.parse("2026-09-09T00:00:00Z") + index * 1000).toISOString(),
      });
    store.db.exec("COMMIT");
    await expect(selectPriceCandidates(sql, { wants: [want], knowledge: CURRENT })).rejects.toThrow(
      "too_many_candidates",
    );
    expect(await selectPriceCandidates(sql, { wants: [], knowledge: CURRENT })).toEqual([]);
  });
});

describe("overlap does not depend on the read margin", () => {
  test("a stale row of another rule refuses nothing, inside or outside the margin", async () => {
    const both: PriceSelectionPolicy = {
      ...POLICY,
      admittedRules: ["fx-sbi-shinsei-board-v1", "sbi-domestic-current-price-v1"],
    };
    // Inside the one-day margin: read, and five days old.
    const inMargin = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-01T00:00:00.000Z")
      .price({ id: "a-fresh", run: 1, amount: "146", at: "2026-09-10T10:00:00+09:00" })
      .price({
        id: "b-old",
        run: 1,
        amount: "140",
        rule: "sbi-domestic-current-price-v1",
        at: "2026-09-05T10:00:00+09:00",
      });
    // Outside it, behind a newer row of the first rule: not read.
    const outside = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-01T00:00:00.000Z")
      .price({ id: "a-fresh", run: 1, amount: "146", at: "2026-09-10T10:00:00+09:00" })
      .price({ id: "a-old", run: 1, amount: "141", at: "2026-09-04T12:00:00+09:00" })
      .price({
        id: "b-old",
        run: 1,
        amount: "140",
        rule: "sbi-domestic-current-price-v1",
        at: "2026-09-04T10:00:00+09:00",
      });
    expect(chosen(await select(inMargin, { policy: both }))).toBe("a-fresh");
    expect(chosen(await select(outside, { policy: both }))).toBe("a-fresh");
  });
});

describe("plans without table statistics", () => {
  const plan = (db: Database, text: string, args: unknown[]): string[] =>
    (db.query(`EXPLAIN QUERY PLAN ${text}`).all(...(args as never[])) as { detail: string }[]).map(
      (row) => row.detail,
    );
  const wanted = JSON.stringify([
    ["USD", "JPY", "reference", null, "2026-09-05T00:00:00Z", "2026-09-11T15:00:01Z"],
  ]);

  test("both candidate texts reach prices by instrument, claims by key and publication by key", () => {
    const db = new PriceStore().db;
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    for (const [text, args, publication] of [
      [PRICE_CANDIDATES_SQL, [wanted, 10], "published_parse_runs_run"],
      [
        PRICE_CANDIDATES_KNOWN_AT_SQL,
        [wanted, 10, "2026-09-10T00:00:00Z"],
        "publication_events_target",
      ],
    ] as const) {
      const lines = plan(db, text, [...args]);
      for (const table of [
        "po|price_observations",
        "c|price_observation_claims",
        "pub|published_parse_runs",
        "pr|parse_runs",
        "e|publication_events",
      ])
        expect(lines.filter((line) => new RegExp(`SCAN (${table})\\b`, "u").test(line))).toEqual(
          [],
        );
      expect(lines.some((line) => line.includes("price_observations_instrument"))).toBe(true);
      expect(
        lines.some((line) => line.includes("sqlite_autoindex_price_observation_claims_1")),
      ).toBe(true);
      expect(lines.some((line) => line.includes(publication))).toBe(true);
      // The keyed rows are read once and shared by the three arms of the union.
      expect(lines.filter((line) => line.startsWith("MATERIALIZE keyed"))).toHaveLength(1);
      expect(lines.filter((line) => line.includes("SEARCH po "))).toHaveLength(1);
    }
    expect(
      plan(db, PRICE_CANDIDATES_KNOWN_AT_SQL, [wanted, 10, "2026-09-10T00:00:00Z"]).some((line) =>
        line.startsWith("SEARCH pr USING INTEGER PRIMARY KEY"),
      ),
    ).toBe(true);
  });
});

describe("the shipped selection is unchanged", () => {
  test("PRICE_SELECTION_SQL and selectPrices are byte-identical to the shipped text", async () => {
    expect(await sha256Hex(PRICE_SELECTION_SQL)).toBe(
      "794e2727d46558fbdb5f51e0f887357ec2d1d4e1136d209c632883b444c229a3",
    );
    const source = readFileSync(join(import.meta.dir, "../src/price-selection.ts"), "utf8");
    const block = (start: string): string => {
      const from = source.indexOf(start);
      return source.slice(from, source.indexOf("\n}\n", from) + 3);
    };
    expect(
      await sha256Hex(
        block("/** The latest published price per (base, quote, kind) at the cutoff. */"),
      ),
    ).toBe("748a0142a2203a7c045d38dfa47dc880c643c4617d2543b847b80b7eccf0703f");
    expect(await sha256Hex(block("export function priceSelectionArgs"))).toBe(
      "95ed6b343389b9878767d77ee69341532dacc1484f7fa9b5607d165ce8472130",
    );
  });
});

/** A small deterministic generator (mulberry32) so a failing store can be rebuilt from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("differential against selectPrices", () => {
  const KEYS: PriceKey[] = [
    USD,
    { ...USD, priceKind: "bid" },
    { ...USD, baseInstrumentRef: "EUR" },
    { baseInstrumentRef: "instrument:test:alpha", quoteUnitRef: "USD", priceKind: "reference" },
  ];
  const OFFSETS = ["Z", "+09:00", "-05:00", "+05:30"];
  // Unbounded calendar-day freshness, every rule, kind and basis, date-only
  // excluded: the policy under which selectPrice must agree with selectPrices.
  const OPEN: PriceSelectionPolicy = {
    policyId: "test:differential",
    admittedRules: [
      "fx-sbi-shinsei-board-v1",
      "sbi-domestic-current-price-v1",
      "sbi-foreign-stock-price-last-v1",
    ],
    priceKinds: ["execution", "bid", "ask", "reference", "nav", "provider-value"],
    acceptedBases: ["provider", "collector", "derived"],
    zone: "Asia/Tokyo",
    freshness: { unit: "calendar-days", maxAgeDays: 36_600 },
    dateOnly: "exclude",
    multiSource: "refuse-on-overlap",
    candidateScope: "latest-in-window",
  };
  const render = (ms: number, offset: string): string => {
    if (offset === "Z") return new Date(ms).toISOString().replace(".000Z", "Z");
    const sign = offset.startsWith("-") ? -1 : 1;
    const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
    return `${new Date(ms + minutes * 60_000).toISOString().slice(0, 19)}${offset}`;
  };

  test("the same price per key on random tie-free stores, at random cutoffs", async () => {
    let compared = 0;
    let found = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const store = new PriceStore();
      let run = 0;
      const runs: number[] = [];
      for (let artifact = 1; artifact <= 4; artifact += 1) {
        const count = 1 + Math.floor(next() * 2);
        const own: number[] = [];
        for (let index = 0; index < count; index += 1) {
          run += 1;
          store.parse(run, artifact);
          own.push(run);
          runs.push(run);
        }
        if (next() < 0.8) store.publish(artifact, pick(own), "2026-09-01T00:00:00.000Z");
      }
      // Distinct instants across the whole store: no two rows tie anywhere.
      const base = Date.parse("2026-09-01T00:00:00Z");
      const slots = Array.from({ length: 400 }, (_, index) => index);
      for (let index = slots.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [slots[index], slots[other]] = [slots[other]!, slots[index]!];
      }
      const rows = 5 + Math.floor(next() * 25);
      for (let index = 0; index < rows; index += 1) {
        const key = pick(KEYS);
        store.price({
          id: `s${seed}-${index}`,
          run: pick(runs),
          key,
          rule:
            key.quoteUnitRef === "JPY"
              ? "fx-sbi-shinsei-board-v1"
              : "sbi-domestic-current-price-v1",
          amount: `${100 + Math.floor(next() * 100)}.${Math.floor(next() * 100)}`,
          at: render(base + slots[index]! * 1_877_000, pick(OFFSETS)),
          recordedAt: new Date(base + Math.floor(next() * 1e9)).toISOString(),
        });
      }
      for (let probe = 0; probe < 4; probe += 1) {
        const cutoff = new Date(base + Math.floor(next() * 800) * 1_000_000).toISOString();
        const shipped = new Map(
          (
            await selectPrices(executor(store.db), {
              baseInstrumentRefs: [...new Set(KEYS.map((key) => key.baseInstrumentRef))],
              cutoff,
            })
          ).map((row) => [
            JSON.stringify([
              row.price.baseInstrumentRef,
              row.price.quoteUnitRef,
              row.price.priceKind,
            ]),
            row.price.id,
          ]),
        );
        // Inclusive cutoff as an exclusive bound one nanosecond later.
        const at: SelectionBound = {
          effectiveBefore: cutoff.replace("Z", "000001Z"),
          asOfDate: civilDateOfInstant(cutoff, "Asia/Tokyo")!,
          knowledge: CURRENT,
        };
        const window = selectionReadWindow(OPEN, at, null);
        const read = await selectPriceCandidates(executor(store.db), {
          wants: KEYS.map((key) => ({ key, snapshotParseRunId: null, window })),
          knowledge: CURRENT,
        });
        KEYS.forEach((key, index) => {
          const selection = selectPrice(
            key,
            read[index]!.map((row) => row.candidate),
            at,
            OPEN,
            null,
          );
          const expected =
            shipped.get(JSON.stringify([key.baseInstrumentRef, key.quoteUnitRef, key.priceKind])) ??
            null;
          if (expected === null)
            expect([seed, probe, selection.status === "refused" && selection.reason]).toEqual([
              seed,
              probe,
              "missing",
            ]);
          else {
            expect([seed, probe, chosen(selection)]).toEqual([seed, probe, expected]);
            found += 1;
          }
          compared += 1;
        });
      }
    }
    expect(compared).toBe(30 * 4 * KEYS.length);
    // Both outcomes are exercised: keys with a price and keys without one.
    expect(found).toBeGreaterThan(compared / 4);
    expect(found).toBeLessThan(compared);
  });
});
