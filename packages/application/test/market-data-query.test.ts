// `selectMarketData` (src/query/market-data.ts) over the migrated CORE schema
// with synthetic parses, publications and prices
// (packages/read-model/test/price-candidates-fixture.ts): one read, the
// domain's selection per key, and a manifest whose digest is the context id.
// Every instrument, amount and time is invented.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  valueInBase,
  type FxConversionPolicy,
  type PriceKey,
  type PriceSelectionPolicy,
  type SelectionBound,
} from "../../domain/src/market-data.ts";
import { exactQuantity, decimalLiteral, decimalToString } from "../../domain/src/values.ts";
import {
  executor,
  migratedDatabase,
  PriceStore,
  USD,
} from "../../read-model/test/price-candidates-fixture.ts";
import {
  MarketDataRequestError,
  selectMarketData,
  type MarketDataPolicies,
  type MarketDataRequest,
} from "../src/query/market-data.ts";

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

const ALPHA: PriceKey = {
  baseInstrumentRef: "instrument:test:alpha",
  quoteUnitRef: "USD",
  priceKind: "reference",
};
const EQUITY: PriceSelectionPolicy = {
  policyId: "test:equity-same-snapshot",
  admittedRules: ["sbi-foreign-stock-price-last-v1"],
  priceKinds: ["reference"],
  acceptedBases: ["provider", "collector"],
  zone: "Asia/Tokyo",
  freshness: { unit: "calendar-days", maxAgeDays: 3 },
  dateOnly: "exclude",
  multiSource: "refuse-on-overlap",
  candidateScope: "same-snapshot",
};
const FX: FxConversionPolicy = {
  policyId: "test:fx-conversion",
  pivot: "JPY",
  currencies: ["USD", "AUD"],
  selection: {
    ...EQUITY,
    policyId: "test:fx-selection",
    admittedRules: ["fx-sbi-shinsei-board-v1"],
    freshness: { unit: "calendar-days", maxAgeDays: 4 },
    candidateScope: "latest-in-window",
  },
  inverse: null,
};
const POLICIES: MarketDataPolicies = { price: EQUITY, fx: FX, calendars: [] };
const BOUND: SelectionBound = {
  effectiveBefore: "2026-09-10T15:00:00.000Z",
  asOfDate: "2026-09-10",
  knowledge: { mode: "current" },
};
const REQUEST: MarketDataRequest = {
  bound: BOUND,
  prices: [{ key: ALPHA, snapshotParseRunId: 1 }],
  fxCurrencies: ["USD", "AUD"],
};

/** A holding's snapshot (parse 1) with its own price, and a board (parse 2) with a USD rate. */
function world(): PriceStore {
  return new PriceStore()
    .parse(1, 1)
    .publish(1, 1, "2026-09-10T01:00:00.000Z")
    .parse(2, 2)
    .publish(2, 2, "2026-09-10T01:00:00.000Z")
    .price({
      id: "alpha-snapshot",
      run: 1,
      key: ALPHA,
      rule: "sbi-foreign-stock-price-last-v1",
      amount: "130.70",
      at: "2026-09-10T06:00:00Z",
    })
    .price({ id: "usd-mid", run: 2, amount: "146.25", at: "2026-09-10T10:00:00+09:00" });
}

describe("selectMarketData", () => {
  test("selects each key under its policy and values a holding in two exact hops", async () => {
    const result = await selectMarketData(executor(world().db), REQUEST, POLICIES);
    expect(
      result.prices.map((p) => [p.status, p.status === "selected" && p.candidate.price.id]),
    ).toEqual([["selected", "alpha-snapshot"]]);
    expect(
      result.fx.map((p) => [
        p.key.baseInstrumentRef,
        p.status === "refused" ? p.reason : p.policyId,
      ]),
    ).toEqual([
      ["USD", "test:fx-selection"],
      ["AUD", "missing"],
    ]);
    const value = valueInBase(
      exactQuantity(ALPHA.baseInstrumentRef, decimalLiteral("12")),
      result.prices[0]!,
      "JPY",
      new Map(result.fx.map((p) => [p.key.baseInstrumentRef, p])),
      FX,
    );
    if (!value.ok) throw new Error(value.reason);
    expect(value.value.value.status === "exact" && decimalToString(value.value.value.value)).toBe(
      "229378.5",
    );
    expect(result.manifest).toMatchObject({
      schema: "market-data-selection-v1",
      selected: ["alpha-snapshot", "usd-mid"],
      refused: [{ key: { ...USD, baseInstrumentRef: "AUD" }, reason: "missing", candidateIds: [] }],
      knowledge: "current",
      knowledgeBoundary: "2026-09-10T02:00:00.000Z",
    });
    expect(result.manifest.policies.map((p) => p.policyId)).toEqual([
      "test:equity-same-snapshot",
      "test:fx-conversion",
      "test:fx-selection",
    ]);
    expect(result.contextId).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("the same inputs give the same context id; a new price, a policy change or the mode a new one", async () => {
    const store = world();
    const sql = executor(store.db);
    const first = await selectMarketData(sql, REQUEST, POLICIES);
    expect((await selectMarketData(sql, REQUEST, POLICIES)).contextId).toBe(first.contextId);
    const stricter = await selectMarketData(sql, REQUEST, {
      ...POLICIES,
      fx: {
        ...FX,
        selection: { ...FX.selection, freshness: { unit: "calendar-days", maxAgeDays: 3 } },
      },
    });
    expect(stricter.contextId).not.toBe(first.contextId);
    const knownAt = (at: string) =>
      selectMarketData(
        sql,
        { ...REQUEST, bound: { ...BOUND, knowledge: { mode: "known-at", knownAt: at } } },
        POLICIES,
      );
    const k1 = await knownAt("2026-09-10T03:00:00Z");
    expect(k1.contextId).not.toBe(first.contextId);
    // A newer rate on another board, recorded later.
    store.parse(3, 3).publish(3, 3, "2026-09-10T03:30:00.000Z").price({
      id: "usd-mid-later",
      run: 3,
      amount: "146.30",
      at: "2026-09-10T11:00:00+09:00",
      recordedAt: "2026-09-10T04:00:00.000Z",
    });
    const second = await selectMarketData(sql, REQUEST, POLICIES);
    expect(second.contextId).not.toBe(first.contextId);
    expect(second.manifest.selected).toEqual(["alpha-snapshot", "usd-mid-later"]);
    expect(second.manifest.knowledgeBoundary).toBe("2026-09-10T04:00:00.000Z");
    // Known at an instant before it, nothing changed: the same context as before it existed.
    expect((await knownAt("2026-09-10T03:45:00Z")).contextId).toBe(k1.contextId);
  });

  test("an inapplicable request or policy is refused, never repaired", async () => {
    const sql = executor(world().db);
    const refused = async (request: MarketDataRequest, policies: MarketDataPolicies) => {
      try {
        await selectMarketData(sql, request, policies);
      } catch (error) {
        return error instanceof MarketDataRequestError ? error.code : String(error);
      }
      return "accepted";
    };
    expect(
      await refused({ ...REQUEST, prices: [{ key: ALPHA, snapshotParseRunId: null }] }, POLICIES),
    ).toBe("invalid_request");
    expect(
      await refused(
        { ...REQUEST, prices: [{ key: ALPHA, snapshotParseRunId: 1 }] },
        { ...POLICIES, price: { ...EQUITY, candidateScope: "latest-in-window" } },
      ),
    ).toBe("invalid_request");
    expect(await refused({ ...REQUEST, fxCurrencies: ["JPY"] }, POLICIES)).toBe("invalid_request");
    expect(await refused({ ...REQUEST, fxCurrencies: ["USD", "USD"] }, POLICIES)).toBe(
      "invalid_request",
    );
    expect(
      await refused({ ...REQUEST, bound: { ...BOUND, effectiveBefore: "2026-09-11" } }, POLICIES),
    ).toBe("invalid_request");
    expect(
      await refused(REQUEST, {
        ...POLICIES,
        fx: { ...FX, selection: { ...FX.selection, candidateScope: "same-snapshot" } },
      }),
    ).toBe("invalid_policy");
    expect(
      await refused(REQUEST, {
        ...POLICIES,
        price: { ...EQUITY, extra: 1 } as PriceSelectionPolicy,
      }),
    ).toBe("invalid_policy");
    expect(await refused(REQUEST, POLICIES)).toBe("accepted");
  });
});
