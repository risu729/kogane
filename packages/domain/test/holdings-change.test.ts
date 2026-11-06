// Reported holdings changes between two dates (src/holdings-change.ts; ADR
// 0075). Every source, account, code, quantity and time here is invented.
import { describe, expect, test } from "bun:test";
import {
  compareReportedHoldings,
  HOLDING_CHANGE_REASONS,
  HOLDING_CHANGE_STATUSES,
  HOLDINGS_CHANGE_SIDE_BOUND,
  type HoldingChange,
  type HoldingsChangeInput,
  type HoldingsChangeObservation,
  type HoldingsChangeSide,
  type HoldingsChangeSnapshot,
} from "../src/holdings-change.ts";
import { absentQuantity, decimalLiteral, subtractDecimals } from "../src/values.ts";
import { exact, q, quantityText } from "./helpers.ts";

const SOURCE = "synthetic-broker";
const CONTAINER = { sourceId: SOURCE, parserName: "synthetic-positions", dataset: "positions" };
const OTHER = { sourceId: SOURCE, parserName: "synthetic-foreign", dataset: "foreign" };

function snapshot(
  ref: string,
  capturedAt: string,
  container: typeof CONTAINER = CONTAINER,
  freshness: HoldingsChangeSnapshot["freshness"] = "same-day",
  unitKey: string | null = null,
): HoldingsChangeSnapshot {
  return {
    ...container,
    ref,
    unitKey,
    capturedAt,
    captureDate: capturedAt.slice(0, 10),
    ageDays: freshness === "stale" ? 9 : 0,
    freshness,
  };
}

const unit = (code: string, market: string | null = null) =>
  `instrument:${SOURCE}:${market ?? "-"}:${code}`;

function holding(
  positionRef: string,
  snapshotRef: string,
  code: string,
  quantity: string | null,
  options: { account?: string; accountId?: string | null; instrumentId?: string | null } = {},
): HoldingsChangeObservation {
  return {
    positionRef,
    snapshotRef,
    sourceAccount: options.account ?? "broker-a",
    accountId: options.accountId === undefined ? "acct-broker" : options.accountId,
    accountIdentity: options.accountId === null ? "not-recorded" : "identified",
    market: null,
    securityCode: code,
    instrument: {
      instrumentId: options.instrumentId === undefined ? `inst-${code}` : options.instrumentId,
      status: options.instrumentId === null ? "not-recorded" : "identified",
    },
    quantityText: quantity ?? "unreadable",
    quantity:
      quantity === null
        ? absentQuantity(unit(code), "unparsed", "stored:unparsed")
        : q(unit(code), quantity),
  };
}

function side(
  date: string,
  snapshots: HoldingsChangeSnapshot[],
  holdings: HoldingsChangeObservation[],
  containersWithoutSnapshot: HoldingsChangeSide["containersWithoutSnapshot"] = [],
): HoldingsChangeSide {
  return { date, reportedContextId: `ctx-${date}`, snapshots, holdings, containersWithoutSnapshot };
}

function input(
  start: HoldingsChangeSide,
  end: HoldingsChangeSide,
  account: string | null = null,
): HoldingsChangeInput {
  return { start, end, filters: { source: null, account }, quantityPolicy: "decimal-v1" };
}

const byCode = (holdings: HoldingChange[], code: string): HoldingChange => {
  const found = holdings.find((entry) => entry.key.securityCode === code);
  if (found === undefined) throw new Error(`no holding ${code}`);
  return found;
};

describe("compareReportedHoldings", () => {
  test("states the exact change of a holding listed on both dates, a zero change included", async () => {
    const result = await compareReportedHoldings(
      input(
        side(
          "2026-09-01",
          [snapshot("artifact:1", "2026-09-01T01:00:00.000Z")],
          [
            holding("position:1", "artifact:1", "1001", "10.5"),
            holding("position:2", "artifact:1", "1002", "3"),
          ],
        ),
        side(
          "2026-09-10",
          [snapshot("artifact:2", "2026-09-10T01:00:00.000Z")],
          [
            holding("position:3", "artifact:2", "1001", "12.25"),
            holding("position:4", "artifact:2", "1002", "3.000"),
          ],
        ),
      ),
    );
    const grown = byCode(result.holdings, "1001");
    expect(grown.status).toBe("compared");
    expect(grown.reasons).toEqual([]);
    expect(grown.unitRef).toBe(unit("1001"));
    expect(quantityText(grown.change)).toBe("1.75");
    expect(grown.change!.unitRef).toBe(unit("1001"));
    // Two exact provider figures that are equal: a computed zero, not a default.
    expect(byCode(result.holdings, "1002")).toMatchObject({ status: "compared" });
    expect(quantityText(byCode(result.holdings, "1002").change)).toBe("0");
    expect(result.counts).toEqual({
      compared: 2,
      listed_at_start_only: 0,
      listed_at_end_only: 0,
      not_comparable: 0,
    });
    expect(result.coverage.total).toBe("not-computed");
    expect(result.coverage.valuation).toBe("not-computed");
  });

  test("a holding the other date's complete capture does not list has no figure, never a zero", async () => {
    const result = await compareReportedHoldings(
      input(
        side(
          "2026-09-01",
          [snapshot("artifact:1", "2026-09-01T01:00:00.000Z")],
          [holding("position:1", "artifact:1", "1001", "10")],
        ),
        side(
          "2026-09-10",
          [snapshot("artifact:2", "2026-09-10T01:00:00.000Z")],
          [holding("position:2", "artifact:2", "2002", "4")],
        ),
      ),
    );
    const closed = byCode(result.holdings, "1001");
    expect(closed).toMatchObject({
      status: "listed_at_start_only",
      reasons: [],
      change: null,
      start: { state: "listed", positionRef: "position:1" },
      end: { state: "not_listed", snapshotRef: "artifact:2" },
    });
    const opened = byCode(result.holdings, "2002");
    expect(opened).toMatchObject({
      status: "listed_at_end_only",
      change: null,
      start: { state: "not_listed", snapshotRef: "artifact:1" },
      end: { state: "listed", positionRef: "position:2" },
    });
  });

  test("a container without a capture on a date is a reason, not an empty holding", async () => {
    const result = await compareReportedHoldings(
      input(
        side("2026-09-01", [], [], [CONTAINER]),
        side(
          "2026-09-10",
          [snapshot("artifact:2", "2026-09-10T01:00:00.000Z")],
          [holding("position:2", "artifact:2", "1001", "4")],
        ),
      ),
    );
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      status: "not_comparable",
      reasons: ["no_snapshot_at_start"],
      start: { state: "no_snapshot" },
      change: null,
    });
    expect(result.coverage.containersWithoutSnapshot).toEqual([{ side: "start", ...CONTAINER }]);
  });

  test("a capture that is complete and empty lists nothing: the holding is not listed there", async () => {
    const result = await compareReportedHoldings(
      input(
        side(
          "2026-09-01",
          [snapshot("artifact:1", "2026-09-01T01:00:00.000Z")],
          [holding("position:1", "artifact:1", "1001", "10")],
        ),
        side("2026-09-10", [snapshot("artifact:2", "2026-09-10T01:00:00.000Z")], []),
      ),
    );
    expect(result.holdings[0]).toMatchObject({
      status: "listed_at_start_only",
      end: { state: "not_listed", snapshotRef: "artifact:2" },
    });
  });

  test("the same capture chosen on both dates leaves the change unobserved", async () => {
    const capture = snapshot("artifact:1", "2026-09-01T01:00:00.000Z");
    const listed = holding("position:1", "artifact:1", "1001", "10");
    const result = await compareReportedHoldings(
      input(
        side("2026-09-01", [capture], [listed]),
        side("2026-09-10", [{ ...capture, ageDays: 9, freshness: "stale" }], [listed]),
      ),
    );
    expect(result.holdings[0]).toMatchObject({
      status: "not_comparable",
      reasons: ["same_capture_both_dates"],
      change: null,
    });
    expect(result.coverage.staleSnapshots).toEqual([
      {
        side: "end",
        ref: "artifact:1",
        sourceId: SOURCE,
        parserName: CONTAINER.parserName,
        ageDays: 9,
      },
    ]);
  });

  test("absence is judged against the capture of the same fetch unit only", async () => {
    const start = side(
      "2026-09-01",
      [snapshot("artifact:1", "2026-09-01T01:00:00.000Z", CONTAINER, "same-day", "unit-a")],
      [holding("position:1", "artifact:1", "1001", "10")],
    );
    // Only unit b was captured by the end date: unit a's holding is unknown there.
    const onlyB = side(
      "2026-09-10",
      [snapshot("artifact:2", "2026-09-10T01:00:00.000Z", CONTAINER, "same-day", "unit-b")],
      [holding("position:2", "artifact:2", "1001", "11", { account: "broker-b" })],
    );
    const result = await compareReportedHoldings(input(start, onlyB));
    const a = result.holdings.find((entry) => entry.key.sourceAccount === "broker-a")!;
    expect(a).toMatchObject({
      status: "not_comparable",
      reasons: ["no_snapshot_at_end"],
      end: { state: "no_snapshot" },
    });
    const b = result.holdings.find((entry) => entry.key.sourceAccount === "broker-b")!;
    expect(b).toMatchObject({
      status: "not_comparable",
      reasons: ["no_snapshot_at_start"],
      start: { state: "no_snapshot" },
    });
    // With unit a captured too, its complete capture states the absence.
    const both = await compareReportedHoldings(
      input(start, {
        ...onlyB,
        snapshots: [
          ...onlyB.snapshots,
          snapshot("artifact:3", "2026-09-10T01:00:00.000Z", CONTAINER, "same-day", "unit-a"),
        ],
      }),
    );
    expect(both.holdings.find((entry) => entry.key.sourceAccount === "broker-a")).toMatchObject({
      status: "listed_at_start_only",
      end: { state: "not_listed", snapshotRef: "artifact:3" },
    });
    // A run without units is not a capture of unit a.
    const unitless = await compareReportedHoldings(
      input(start, side("2026-09-10", [snapshot("artifact:4", "2026-09-10T01:00:00.000Z")], [])),
    );
    expect(unitless.holdings[0]).toMatchObject({ reasons: ["no_snapshot_at_end"] });
  });

  test("a key listed in captures of several fetch units has no one capture to be absent from", async () => {
    const result = await compareReportedHoldings(
      input(
        side(
          "2026-09-01",
          [
            snapshot("artifact:1", "2026-09-01T01:00:00.000Z", CONTAINER, "same-day", "unit-a"),
            snapshot("artifact:2", "2026-09-01T01:00:00.000Z", CONTAINER, "same-day", "unit-b"),
          ],
          [
            holding("position:1", "artifact:1", "1001", "10"),
            holding("position:2", "artifact:2", "1001", "5"),
          ],
        ),
        side(
          "2026-09-10",
          [
            snapshot("artifact:4", "2026-09-10T01:00:00.000Z", CONTAINER, "same-day", "unit-b"),
            snapshot("artifact:3", "2026-09-10T01:00:00.000Z", CONTAINER, "same-day", "unit-a"),
          ],
          [],
        ),
      ),
    );
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      status: "not_comparable",
      reasons: ["snapshot_scope_ambiguous_at_end", "holding_key_ambiguous_at_start"].sort(
        (a, b) =>
          HOLDING_CHANGE_REASONS.indexOf(a as never) - HOLDING_CHANGE_REASONS.indexOf(b as never),
      ),
      start: { state: "listed_more_than_once", snapshotRefs: ["artifact:1", "artifact:2"] },
      end: { state: "snapshot_scope_ambiguous", snapshotRefs: ["artifact:3", "artifact:4"] },
      change: null,
    });
  });

  test("a key listed twice on a date has no one quantity", async () => {
    const result = await compareReportedHoldings(
      input(
        side(
          "2026-09-01",
          [snapshot("artifact:1", "2026-09-01T01:00:00.000Z")],
          [
            holding("position:2", "artifact:1", "1001", "4"),
            holding("position:1", "artifact:1", "1001", "6"),
          ],
        ),
        side(
          "2026-09-10",
          [snapshot("artifact:2", "2026-09-10T01:00:00.000Z")],
          [holding("position:3", "artifact:2", "1001", "10")],
        ),
      ),
    );
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      status: "not_comparable",
      reasons: ["holding_key_ambiguous_at_start"],
      start: {
        state: "listed_more_than_once",
        positionRefs: ["position:1", "position:2"],
        snapshotRefs: ["artifact:1"],
      },
      change: null,
    });
  });

  test("an inexact quantity, a moved identity or an inverted capture order has no figure", async () => {
    const result = await compareReportedHoldings(
      input(
        side(
          "2026-09-01",
          [snapshot("artifact:1", "2026-09-05T01:00:00.000Z")],
          [
            holding("position:1", "artifact:1", "1001", null),
            holding("position:2", "artifact:1", "1002", "5", { accountId: "acct-x" }),
            holding("position:3", "artifact:1", "1003", "5", { instrumentId: "inst-old" }),
            holding("position:4", "artifact:1", "1004", "5", { accountId: null }),
          ],
        ),
        side(
          "2026-09-10",
          [snapshot("artifact:2", "2026-09-04T01:00:00.000Z")],
          [
            holding("position:5", "artifact:2", "1001", "7"),
            holding("position:6", "artifact:2", "1002", "5", { accountId: "acct-y" }),
            holding("position:7", "artifact:2", "1003", "5"),
            holding("position:8", "artifact:2", "1004", "5"),
          ],
        ),
      ),
    );
    expect(byCode(result.holdings, "1001").reasons).toEqual([
      "capture_order_inverted",
      "quantity_not_exact_at_start",
    ]);
    expect(byCode(result.holdings, "1002").reasons).toEqual([
      "capture_order_inverted",
      "account_differs",
    ]);
    expect(byCode(result.holdings, "1003").reasons).toEqual([
      "capture_order_inverted",
      "instrument_differs",
    ]);
    // An identity not recorded on one date is not a difference.
    expect(byCode(result.holdings, "1004").reasons).toEqual(["capture_order_inverted"]);
    for (const entry of result.holdings) {
      expect(entry.status).toBe("not_comparable");
      expect(entry.change).toBeNull();
    }
  });

  test("the account filter keeps a key either date names, and judges absence on the whole listing", async () => {
    const start = side(
      "2026-09-01",
      [snapshot("artifact:1", "2026-09-01T01:00:00.000Z")],
      [
        holding("position:1", "artifact:1", "1001", "10"),
        holding("position:2", "artifact:1", "2001", "1", { account: "other", accountId: "acct-o" }),
      ],
    );
    const end = side(
      "2026-09-10",
      [snapshot("artifact:2", "2026-09-10T01:00:00.000Z")],
      // This capture's identity is not recorded yet: the holding is still listed.
      [holding("position:3", "artifact:2", "1001", "12", { accountId: null })],
    );
    const result = await compareReportedHoldings(input(start, end, "acct-broker"));
    expect(result.filters).toEqual({ source: null, account: "acct-broker" });
    expect(result.holdings.map((entry) => entry.key.securityCode)).toEqual(["1001"]);
    expect(result.holdings[0]).toMatchObject({ status: "compared" });
    expect(quantityText(result.holdings[0]!.change)).toBe("2");
    expect((await compareReportedHoldings(input(start, end, "acct-o"))).holdings[0]).toMatchObject({
      status: "listed_at_start_only",
      key: { securityCode: "2001" },
    });
    expect((await compareReportedHoldings(input(start, end, "acct-none"))).holdings).toEqual([]);
  });

  test("containers are compared one by one: the same code in another container is another key", async () => {
    const result = await compareReportedHoldings(
      input(
        side(
          "2026-09-01",
          [snapshot("artifact:1", "2026-09-01T01:00:00.000Z")],
          [holding("position:1", "artifact:1", "1001", "10")],
        ),
        side(
          "2026-09-10",
          [
            snapshot("artifact:2", "2026-09-10T01:00:00.000Z"),
            snapshot("artifact:3", "2026-09-10T01:00:00.000Z", OTHER),
          ],
          [
            holding("position:2", "artifact:2", "1001", "10"),
            holding("position:3", "artifact:3", "1001", "10"),
          ],
        ),
      ),
    );
    expect(result.holdings.map((entry) => [entry.key.parserName, entry.status])).toEqual([
      ["synthetic-foreign", "not_comparable"],
      ["synthetic-positions", "compared"],
    ]);
    expect(result.holdings[0]!.reasons).toEqual(["no_snapshot_at_start"]);
  });

  test("refuses a reversed range, unknown snapshots, duplicates and the bound", async () => {
    const one = side(
      "2026-09-10",
      [snapshot("artifact:1", "2026-09-10T01:00:00.000Z")],
      [holding("position:1", "artifact:1", "1001", "1")],
    );
    const earlier = { ...one, date: "2026-09-01" };
    await expect(compareReportedHoldings(input(one, earlier))).rejects.toThrow("invalid_range");
    await expect(compareReportedHoldings(input(one, one))).rejects.toThrow("invalid_range");
    await expect(
      compareReportedHoldings(
        input(earlier, { ...one, holdings: [holding("position:1", "artifact:9", "1001", "1")] }),
      ),
    ).rejects.toThrow("position_snapshot_not_found");
    await expect(
      compareReportedHoldings(
        input(earlier, { ...one, holdings: [...one.holdings, ...one.holdings] }),
      ),
    ).rejects.toThrow("position_duplicated");
    await expect(
      compareReportedHoldings(
        input(earlier, { ...one, snapshots: [...one.snapshots, ...one.snapshots] }),
      ),
    ).rejects.toThrow("snapshot_duplicated");
    const many = Array.from({ length: HOLDINGS_CHANGE_SIDE_BOUND + 1 }, (_, index) =>
      holding(`position:${index + 10}`, "artifact:1", `C${index}`, "1"),
    );
    await expect(
      compareReportedHoldings(input(earlier, { ...one, holdings: many })),
    ).rejects.toThrow("holding_bound_exceeded");
    await expect(
      compareReportedHoldings({
        ...input(earlier, one),
        filters: { source: "another-source", account: null },
      }),
    ).rejects.toThrow("source_filter");
    await expect(
      compareReportedHoldings(
        input(earlier, {
          ...one,
          holdings: [
            { ...holding("position:1", "artifact:1", "1001", "1"), quantity: q("JPY", "1") },
          ],
        }),
      ),
    ).rejects.toThrow("holding_unit_mismatch");
  });
});

/** A small deterministic generator: the same seed gives the same world. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomSide(
  random: () => number,
  date: string,
  hour: string,
  refBase: number,
): HoldingsChangeSide {
  const containers = [CONTAINER, OTHER];
  const snapshots: HoldingsChangeSnapshot[] = [];
  const without: HoldingsChangeSide["containersWithoutSnapshot"] = [];
  for (const [index, container] of containers.entries()) {
    const roll = random();
    if (roll < 0.15) without.push(container);
    else {
      // One capture of a run without units, or one capture per fetch unit.
      const units =
        roll < 0.4
          ? [null]
          : roll < 0.7
            ? ["unit-a", "unit-b"]
            : [random() < 0.5 ? "unit-a" : "unit-b"];
      for (const [n, unitKey] of units.entries())
        snapshots.push(
          snapshot(
            `artifact:${refBase + index * 10 + n}`,
            `${date}T${hour}:00:00.000Z`,
            container,
            random() < 0.2 ? "stale" : "recent",
            unitKey,
          ),
        );
    }
  }
  const holdings: HoldingsChangeObservation[] = [];
  let position = refBase * 100;
  for (const capture of snapshots)
    for (const code of ["1001", "1002", "1003", "1004"]) {
      const roll = random();
      if (roll < 0.35) continue;
      const repeats = roll > 0.95 ? 2 : 1;
      for (let n = 0; n < repeats; n += 1) {
        position += 1;
        const quantity =
          random() < 0.1 ? null : `${Math.floor(random() * 2000)}.${n}${Math.floor(random() * 10)}`;
        holdings.push(
          holding(`position:${position}`, capture.ref, code, quantity, {
            account: random() < 0.5 ? "broker-a" : "broker-b",
            accountId: random() < 0.2 ? null : random() < 0.9 ? "acct-broker" : "acct-other",
          }),
        );
      }
    }
  return side(date, snapshots, holdings, without);
}

function shuffle<T>(random: () => number, values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

describe("compareReportedHoldings on random worlds", () => {
  for (let seed = 1; seed <= 40; seed += 1)
    test(`seed ${seed}: every key once, figures only when compared, input order irrelevant`, async () => {
      const random = generator(seed);
      const start = randomSide(random, "2026-09-01", "01", 1);
      const end = randomSide(random, "2026-09-10", "02", 5);
      const account = random() < 0.5 ? null : "acct-broker";
      const result = await compareReportedHoldings(input(start, end, account));

      const keys = result.holdings.map((entry) => JSON.stringify(entry.key));
      expect(new Set(keys).size).toBe(keys.length);
      expect([...keys].sort()).toEqual(keys);
      expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(result.holdings.length);
      for (const entry of result.holdings) {
        expect(HOLDING_CHANGE_STATUSES).toContain(entry.status);
        for (const reason of entry.reasons) expect(HOLDING_CHANGE_REASONS).toContain(reason);
        expect(entry.reasons).toEqual(
          HOLDING_CHANGE_REASONS.filter((r) => entry.reasons.includes(r)),
        );
        expect(entry.status === "not_comparable").toBe(entry.reasons.length > 0);
        expect(
          entry.start.state === "listed" ||
            entry.end.state === "listed" ||
            entry.start.state === "listed_more_than_once" ||
            entry.end.state === "listed_more_than_once",
        ).toBe(true);
        if (entry.status === "compared") {
          expect(entry.start.state).toBe("listed");
          expect(entry.end.state).toBe("listed");
          if (entry.start.state !== "listed" || entry.end.state !== "listed") continue;
          // The change is exactly end minus start, in the key's own unit.
          expect(exact(entry.change!)).toEqual(
            subtractDecimals(exact(entry.end.quantity), exact(entry.start.quantity)),
          );
          expect(entry.change!.unitRef).toBe(entry.unitRef);
          expect(entry.start.snapshotRef).not.toBe(entry.end.snapshotRef);
        } else expect(entry.change).toBeNull();
        if (entry.status === "listed_at_start_only") expect(entry.end.state).toBe("not_listed");
        if (entry.status === "listed_at_end_only") expect(entry.start.state).toBe("not_listed");
        if (entry.start.state === "no_snapshot")
          expect(entry.reasons).toContain("no_snapshot_at_start");
        if (entry.end.state === "no_snapshot")
          expect(entry.reasons).toContain("no_snapshot_at_end");
        if (account !== null) {
          const names = [start, end].flatMap((s) =>
            s.holdings.filter(
              (h) =>
                h.securityCode === entry.key.securityCode &&
                h.sourceAccount === entry.key.sourceAccount &&
                s.snapshots.find((snap) => snap.ref === h.snapshotRef)!.parserName ===
                  entry.key.parserName,
            ),
          );
          expect(names.some((h) => h.accountId === account)).toBe(true);
        }
      }
      // Without a filter, every listed key of either date is present.
      if (account === null) {
        const listed = new Set(
          [start, end].flatMap((s) =>
            s.holdings.map((h) => {
              const capture = s.snapshots.find((snap) => snap.ref === h.snapshotRef)!;
              return JSON.stringify([capture.parserName, h.sourceAccount, h.securityCode]);
            }),
          ),
        );
        expect(result.holdings.length).toBe(listed.size);
      }

      const shuffled = await compareReportedHoldings(
        input(
          {
            ...start,
            snapshots: shuffle(random, start.snapshots),
            holdings: shuffle(random, start.holdings),
          },
          {
            ...end,
            snapshots: shuffle(random, end.snapshots),
            holdings: shuffle(random, end.holdings),
          },
          account,
        ),
      );
      expect(shuffled).toEqual(result);
    });

  test("the random worlds reach every status and every side's reasons", async () => {
    const statuses = new Set<string>();
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = generator(seed);
      const start = randomSide(random, "2026-09-01", "01", 1);
      const end = randomSide(random, "2026-09-10", "02", 5);
      const result = await compareReportedHoldings(input(start, end, null));
      for (const entry of result.holdings) {
        statuses.add(entry.status);
        for (const reason of entry.reasons) reasons.add(reason);
      }
    }
    expect([...statuses].sort()).toEqual([...HOLDING_CHANGE_STATUSES].sort());
    // Same capture, inverted order and moved identities are pinned above, not drawn here.
    for (const reason of [
      "no_snapshot_at_start",
      "no_snapshot_at_end",
      "snapshot_scope_ambiguous_at_start",
      "snapshot_scope_ambiguous_at_end",
      "holding_key_ambiguous_at_start",
      "holding_key_ambiguous_at_end",
      "account_differs",
      "quantity_not_exact_at_start",
      "quantity_not_exact_at_end",
    ])
      expect(reasons).toContain(reason);
  });

  test("the context id follows the outcome, not the input order", async () => {
    const make = (quantity: string) =>
      input(
        side(
          "2026-09-01",
          [snapshot("artifact:1", "2026-09-01T01:00:00.000Z")],
          [holding("position:1", "artifact:1", "1001", "10")],
        ),
        side(
          "2026-09-10",
          [snapshot("artifact:2", "2026-09-10T01:00:00.000Z")],
          [holding("position:2", "artifact:2", "1001", quantity)],
        ),
      );
    const a = await compareReportedHoldings(make("12"));
    const b = await compareReportedHoldings(make("12"));
    expect(a.contextId).toBe(b.contextId);
    expect(a.contextId).toMatch(/^[0-9a-f]{64}$/u);
    // A different reported context on a date is a different answer.
    const moved = make("12");
    moved.end.reportedContextId = "ctx-other";
    expect((await compareReportedHoldings(moved)).contextId).not.toBe(a.contextId);
    expect(decimalLiteral("2")).toEqual(exact(a.holdings[0]!.change!));
  });
});
