// Candidate-read regressions the store suite and the tie-free oracles leave
// open (`selectPriceCandidates`, ADR 0056), decided by the domain's
// `selectPrice`. Synthetic prices, claims, parses and publications only;
// every instrument and amount is invented.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  CANDIDATE_EXCLUSIONS,
  selectionReadWindow,
  selectPrice,
  type ExclusionCounts,
  type KnowledgeMode,
  type PriceCandidate,
  type PriceKey,
  type PriceSelection,
  type PriceSelectionPolicy,
  type SelectionBound,
} from "../../domain/src/market-data.ts";
import { selectPriceCandidates, type ReadPriceCandidate } from "../src/price-selection";
import { executor, migratedDatabase, PriceStore } from "./price-candidates-fixture";

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

const chosen = (selection: PriceSelection): string | null =>
  selection.status === "selected" ? selection.candidate.price.id : null;

const zeroExclusions = (): ExclusionCounts =>
  Object.fromEntries(CANDIDATE_EXCLUSIONS.map((code) => [code, 0])) as ExclusionCounts;

/** One key through the candidate read, then `selectPrice` of those rows in read order. */
async function readAndSelect(
  store: PriceStore,
  key: PriceKey,
  knowledge: KnowledgeMode = CURRENT,
): Promise<{
  rows: ReadPriceCandidate[];
  selection: PriceSelection;
  decide: (candidates: readonly PriceCandidate[]) => PriceSelection;
}> {
  const at = bound(knowledge);
  const [rows] = await selectPriceCandidates(executor(store.db), {
    wants: [
      {
        key,
        snapshotParseRunId: null,
        window: selectionReadWindow(POLICY, at, null),
      },
    ],
    knowledge: at.knowledge,
  });
  const read = rows!;
  const decide = (candidates: readonly PriceCandidate[]): PriceSelection =>
    selectPrice(key, candidates, at, POLICY, null);
  return { rows: read, selection: decide(read.map((row) => row.candidate)), decide };
}

function publicationRows(store: PriceStore): {
  id: number;
  run: number;
  occurred_at: string;
}[] {
  return store.db
    .query(
      `SELECT id, new_parse_run_id AS run, occurred_at
       FROM publication_events ORDER BY id`,
    )
    .all() as { id: number; run: number; occurred_at: string }[];
}

const QUOTE = "unit:synthetic:quote";
const SAME_INSTANT = "2026-09-10T00:00:00Z";

describe("candidate conflicts the shipped reads leave open", () => {
  test("later recorded_at does not override disagree", async () => {
    const key: PriceKey = {
      baseInstrumentRef: "instrument:synthetic:same-time-disagree",
      quoteUnitRef: QUOTE,
      priceKind: "reference",
    };
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-09-08T00:00:00.000Z")
      .price({
        id: "early",
        run: 1,
        amount: "2",
        key,
        at: SAME_INSTANT,
        recordedAt: "2026-09-08T00:00:00.000Z",
      })
      .price({
        id: "late",
        run: 1,
        amount: "5",
        key,
        at: SAME_INSTANT,
        recordedAt: "2026-09-09T00:00:00.000Z",
      });
    // The shipped store test uses one recorded_at for every row, and the oracles
    // never place two rows on one effective instant. Step 6 refuses before
    // later-recorded / higher-id, and refusal ids are sorted, so input order
    // must not choose a price.
    for (const knowledge of [CURRENT, knownAt("2026-09-09T00:00:00.000Z")]) {
      const read = await readAndSelect(store, key, knowledge);
      expect(read.rows.map((row) => [row.candidate.price.id, row.reach])).toEqual([
        ["early", "window"],
        ["late", "window"],
      ]);
      const reversed = read.decide([...read.rows.map((row) => row.candidate)].reverse());
      for (const result of [read.selection, reversed]) {
        expect(result).toMatchObject({
          status: "refused",
          reason: "disagree",
          candidateIds: ["early", "late"],
        });
        expect(result.excluded).toEqual(zeroExclusions());
        expect(chosen(result)).toBeNull();
      }
    }
  });

  test("equal occurred_at adopts the higher publication_events id", async () => {
    const key: PriceKey = {
      baseInstrumentRef: "instrument:synthetic:publication-same-time",
      quoteUnitRef: QUOTE,
      priceKind: "reference",
    };
    const published = "2026-09-08T00:00:00.000Z";
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, published)
      .price({
        id: "lower-id",
        run: 1,
        amount: "2",
        key,
        at: SAME_INSTANT,
        recordedAt: published,
      })
      .parse(2, 1)
      .publish(1, 2, published)
      .price({
        id: "higher-id",
        run: 2,
        amount: "5",
        key,
        at: SAME_INSTANT,
        recordedAt: published,
      });
    const events = publicationRows(store);
    expect(events.map((event) => [event.run, event.occurred_at])).toEqual([
      [1, published],
      [2, published],
    ]);
    expect(events[1]!.id).toBeGreaterThan(events[0]!.id);
    // The random oracle increases publication time by at least 1 ms, so
    // occurred_at order and id order never diverge. Same timestamp only,
    // matching ORDER BY e.id DESC after the julianday filter.
    const read = await readAndSelect(store, key, knownAt("2026-09-10T00:00:00.000Z"));
    expect(read.rows.map((row) => row.candidate.price.id)).toEqual(["higher-id"]);
    expect(read.selection).toMatchObject({
      status: "selected",
      corroboratedBy: [],
    });
    expect(chosen(read.selection)).toBe("higher-id");
  });

  test("an event time SQLite cannot parse does not adopt, in known-at", async () => {
    const key: PriceKey = {
      baseInstrumentRef: "instrument:synthetic:unreadable-event",
      quoteUnitRef: QUOTE,
      priceKind: "reference",
    };
    const recordedAt = "2026-09-08T00:00:00.000Z";
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, recordedAt)
      .price({
        id: "readable-event",
        run: 1,
        amount: "2",
        key,
        at: SAME_INSTANT,
        recordedAt,
      })
      .parse(2, 1)
      .publish(1, 2, "not-a-time")
      .price({
        id: "unreadable-event",
        run: 2,
        amount: "5",
        key,
        at: SAME_INSTANT,
        recordedAt,
      });
    const events = publicationRows(store);
    expect(events.map((event) => [event.run, event.occurred_at])).toEqual([
      [1, recordedAt],
      [2, "not-a-time"],
    ]);
    expect(events[1]!.id).toBeGreaterThan(events[0]!.id);
    // The pointer moved: current mode does not parse the event time.
    const current = await readAndSelect(store, key);
    expect(current.rows.map((row) => row.candidate.price.id)).toEqual(["unreadable-event"]);
    expect(chosen(current.selection)).toBe("unreadable-event");
    // julianday of an unparseable occurred_at is null, so the known-at filter
    // drops that event and the older readable event stays adopted (ADR 0056
    // consequence). The unreadable row was not read, so it is not
    // recorded_after_known_at.
    const known = await readAndSelect(store, key, knownAt("2026-09-10T00:00:00.000Z"));
    expect(known.rows.map((row) => row.candidate.price.id)).toEqual(["readable-event"]);
    expect(known.selection).toMatchObject({ status: "selected", corroboratedBy: [] });
    expect(chosen(known.selection)).toBe("readable-event");
    expect(known.selection.excluded).toEqual(zeroExclusions());
  });

  test("a SQLite-placed, domain-invalid instant is the only before-window row, so the older valid price is not read and the key is missing, not stale", async () => {
    const key: PriceKey = {
      baseInstrumentRef: "instrument:synthetic:masked-before-window",
      quoteUnitRef: QUOTE,
      priceKind: "reference",
    };
    const store = new PriceStore()
      .parse(1, 1)
      .publish(1, 1, "2026-08-01T00:00:00.000Z")
      .price({
        id: "older-valid",
        run: 1,
        amount: "2",
        key,
        at: "2026-08-01T00:00:00Z",
        recordedAt: "2026-08-01T00:00:00.000Z",
      })
      .price({
        id: "masked",
        run: 1,
        amount: "5",
        key,
        recordedAt: "2026-08-20T00:00:00.000Z",
        effective:
          '{"kind":"instant","value":"2026-08-20 00:00:00","zone":"UTC","basis":"provider"}',
      });
    // A null julianday (already tested as garbled) does not mask the older row;
    // this space-separated instant is a real SQLite time and wins RANK() on the
    // before-window arm, then the domain excludes it. ADR 0056: the newest old
    // row may be one the domain cannot read, and the key is missing rather than
    // stale.
    const read = await readAndSelect(store, key);
    expect(read.rows.map((row) => [row.candidate.price.id, row.reach])).toEqual([
      ["masked", "before-window"],
    ]);
    expect(read.selection).toMatchObject({
      status: "refused",
      reason: "missing",
      candidateIds: [],
    });
    expect(read.selection.excluded).toEqual({
      ...zeroExclusions(),
      invalid_effective_time: 1,
    });
  });
});
