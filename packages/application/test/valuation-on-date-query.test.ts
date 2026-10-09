// `queryValuationOnDate` (src/query/valuation-on-date.ts) end to end over the
// migrated CORE schema: synthetic container snapshots with identities
// (packages/read-model/test/dated-state-fixture.ts), prices claimed from those
// snapshots and an exchange-rate board written as the promotion lane writes
// them. Every account, code, quantity, price, rate and time is invented.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/src/context.ts";
import type { FxConversionPolicy, PriceSelectionPolicy } from "../../domain/src/market-data.ts";
import { decimalToString, type Quantity } from "../../domain/src/values.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { DatedStore, type Capture } from "../../read-model/test/dated-state-fixture.ts";
import { migratedDatabase } from "../../read-model/test/price-candidates-fixture.ts";
import type { MarketDataPolicies } from "../src/query/market-data.ts";
import {
  ACCOUNT_EXISTS_SQL,
  queryValuationOnDate,
  SOURCE_EXISTS_SQL,
  VALUATION_HOLDING_BOUND,
  ValuationOnDateError,
  type ValuationOnDateRequest,
} from "../src/query/valuation-on-date.ts";

function counting(store: DatedStore): SqlExecutor & { calls: number } {
  const sql = {
    calls: 0,
    all: async <T>(text: string, args: readonly unknown[]) => {
      sql.calls += 1;
      return store.db.query(text).all(...(args as SQLQueryBindings[])) as T[];
    },
    first: async <T>(text: string, args: readonly unknown[]) => {
      sql.calls += 1;
      return (store.db.query(text).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
  return sql;
}

const DOMESTIC = {
  source: "sbi-securities",
  dataset: "domestic-cash-positions",
  parser: "sbi-domestic-cash-positions",
} as const;
const FOREIGN = {
  source: "sbi-securities",
  dataset: "foreign-cash-positions",
  parser: "sbi-foreign-cash-positions",
  version: "0.3.0",
} as const;

const EQUITY: PriceSelectionPolicy = {
  policyId: "test:equity-same-snapshot",
  admittedRules: ["sbi-domestic-current-price-v1", "sbi-foreign-stock-price-last-v1"],
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
const REQUEST: ValuationOnDateRequest = {
  date: "2026-09-10",
  today: "2026-09-12",
  baseUnit: "JPY",
  knowledge: { mode: "current" },
};

let next = 90_000;
/** A price claimed from observation `observation` of parse `parse`, as the promotion lane writes it. */
function claimPrice(
  store: DatedStore,
  options: {
    id: string;
    parse: number;
    observation: number;
    claimKind: "position" | "valuation";
    rule: string;
    base: string;
    quote: string;
    amount: string;
    at: string;
    recordedAt?: string;
  },
): void {
  const [whole, fraction = ""] = options.amount.split(".");
  store.db.run(
    `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,
       quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,
       source_claim_ref,recorded_at)
     VALUES(?,?,'1',0,?,?,?,'reference',?,?,?)`,
    [
      options.id,
      options.base,
      options.quote,
      String(BigInt(`${whole}${fraction}`)),
      fraction.length,
      JSON.stringify({ kind: "instant", value: options.at, zone: "Asia/Tokyo", basis: "provider" }),
      `${options.claimKind}_observations/${options.observation}#$.price`,
      options.recordedAt ?? "2026-09-10T03:00:00.000Z",
    ],
  );
  store.db.run(
    `INSERT INTO price_observation_claims(price_id,rule_id,claim_kind,observation_id,parse_run_id,json_path,created_at)
     VALUES(?,?,?,?,?,'$.price','2026-09-10T03:00:00.000Z')`,
    [options.id, options.rule, options.claimKind, options.observation, options.parse],
  );
}

/** A published exchange-rate board with one mid rate per currency, each promoted to a price. */
function board(
  store: DatedStore,
  at: string,
  rates: Record<string, string>,
  recordedAt?: string,
): number {
  next += 1;
  const parse = next;
  store.db.run(
    "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'sbi-shinsei-exchange-rate','1.0.0','2026-09-01','ok','[]')",
    [parse, parse],
  );
  store.db.run(
    "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,'sbi-shinsei-exchange-rate',?,'1.0.0','2026-09-01','normal')",
    [parse, parse],
  );
  for (const [currency, amount] of Object.entries(rates)) {
    const observation = Number(
      store.db.run(
        `INSERT INTO valuation_observations(parse_run_id,source_account,subject,metric,amount_text,amount_scale,currency,raw_locator,extra_json)
         VALUES(?,'test:board',?,'bank_mid_rate',?,0,'JPY','$.rates','{}')`,
        [parse, currency, amount],
      ).lastInsertRowid,
    );
    claimPrice(store, {
      id: `${currency.toLowerCase()}-mid-${parse}`,
      parse,
      observation,
      claimKind: "valuation",
      rule: "fx-sbi-shinsei-board-v1",
      base: currency,
      quote: "JPY",
      amount,
      at,
      ...(recordedAt === undefined ? {} : { recordedAt }),
    });
  }
  return parse;
}

/** Each position of `capture` priced from its own snapshot. */
function ownPrices(
  store: DatedStore,
  capture: Capture,
  rule: string,
  quote: string,
  entries: readonly { code: string; amount: string; at: string }[],
): void {
  entries.forEach((entry, index) =>
    claimPrice(store, {
      id: `px-${capture.parse}-${entry.code}`,
      parse: capture.parse,
      observation: capture.positions[index]!,
      claimKind: "position",
      rule,
      base: `instrument:sbi-securities:-:${entry.code}`,
      quote,
      amount: entry.amount,
      at: entry.at,
    }),
  );
}

/** A yen holding and a dollar holding, each with its own snapshot's price, and a USD board. */
/** The VC position container captured empty on the date: it holds nothing, and has a snapshot. */
function emptyVc(store: DatedStore): void {
  store.capture({
    source: "sbi-vc-trade",
    dataset: "position-summary",
    parser: "sbi-vc-position-summary",
    version: "0.2.0",
    fetchedAt: "2026-09-10T00:30:00Z",
  });
}

function world(options: { vc?: boolean } = {}): DatedStore {
  const store = new DatedStore();
  if (options.vc ?? true) emptyVc(store);
  const domestic = store.capture({
    ...DOMESTIC,
    fetchedAt: "2026-09-10T01:00:00Z",
    positions: [{ account: "sbi-a", code: "1001", quantity: "100" }],
  });
  store.identify(domestic, DOMESTIC.source, "acct-sbi", "identified", ["inst-1001"]);
  ownPrices(store, domestic, "sbi-domestic-current-price-v1", "JPY", [
    { code: "1001", amount: "1500", at: "2026-09-10T10:00:00+09:00" },
  ]);
  const foreign = store.capture({
    ...FOREIGN,
    fetchedAt: "2026-09-10T02:00:00Z",
    positions: [{ account: "sbi-a", code: "ALPHA", quantity: "12", currency: "USD" }],
  });
  store.identify(foreign, FOREIGN.source, "acct-sbi", "identified", ["inst-alpha"]);
  ownPrices(store, foreign, "sbi-foreign-stock-price-last-v1", "USD", [
    { code: "ALPHA", amount: "130.70", at: "2026-09-10T06:00:00+09:00" },
  ]);
  board(store, "2026-09-10T10:00:00+09:00", { USD: "146.25" });
  return store;
}

/** The publication history of every current pointer, which the known-at read follows. */
function publishedAsEvents(store: DatedStore): void {
  store.db.run(
    `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
     SELECT fetch_artifact_id,parser_name,NULL,parse_run_id,'normal','pipeline','test','2026-09-10T00:00:00.000Z'
     FROM published_parse_runs`,
  );
}

const text = (quantity: Quantity): string | false =>
  quantity.value.status === "exact" && decimalToString(quantity.value.value);

async function refusal(
  sql: SqlExecutor,
  request: ValuationOnDateRequest,
  policies: MarketDataPolicies | null,
): Promise<string> {
  try {
    await queryValuationOnDate(sql, request, policies);
  } catch (error) {
    return error instanceof ValuationOnDateError ? error.code : String(error);
  }
  return "answered";
}

describe("queryValuationOnDate", () => {
  test("values each reported holding at its own snapshot's price and the board's rate, with an exact total", async () => {
    const store = world();
    const result = await queryValuationOnDate(counting(store), REQUEST, POLICIES);
    expect(
      result.holdings.map((entry) => [
        entry.instrumentRef,
        entry.outcome,
        entry.outcome === "valued" && text(entry.value),
      ]),
    ).toEqual([
      ["instrument:sbi-securities:-:1001", "valued", "150000"],
      ["instrument:sbi-securities:-:ALPHA", "valued", "229378.5"],
    ]);
    const alpha = result.holdings[1]!;
    if (alpha.outcome !== "valued") throw new Error(alpha.outcome);
    expect(text(alpha.local)).toBe("1568.4");
    expect(alpha.legs.map((leg) => [leg.leg, leg.priceId])).toEqual([
      ["price", expect.stringMatching(/^px-\d+-ALPHA$/u)],
      ["fx", expect.stringMatching(/^usd-mid-\d+$/u)],
    ]);
    expect(result.total.status === "exact" && text(result.total.value)).toBe("379378.5");
    expect(result.manifest).toMatchObject({
      asOf: {
        date: "2026-09-10",
        effectiveBefore: "2026-09-10T15:00:00.000Z",
        knowledge: "current",
      },
      reportedState: {
        date: "2026-09-10",
        cutoff: "2026-09-10T15:00:00.000Z",
        filters: { source: null, account: null },
        quantityPolicy: "decimal-v1",
      },
    });
    expect(result.manifest.snapshots).toHaveLength(2);
    expect(result.manifest.selectionContextId).toBe(
      await canonicalDigest(result.manifest.selection),
    );
    expect(result.contextId).toBe(await canonicalDigest(result.manifest));
    expect(result.reportedState.contextId).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("the same store gives the same context; a corrected rate gives a new one", async () => {
    const store = world();
    const first = await queryValuationOnDate(counting(store), REQUEST, POLICIES);
    expect((await queryValuationOnDate(counting(store), REQUEST, POLICIES)).contextId).toBe(
      first.contextId,
    );
    // A later board on the same day states a corrected rate.
    board(store, "2026-09-10T11:00:00+09:00", { USD: "146.30" }, "2026-09-10T04:00:00.000Z");
    const second = await queryValuationOnDate(counting(store), REQUEST, POLICIES);
    expect(second.contextId).not.toBe(first.contextId);
    expect(second.total.status === "exact" && text(second.total.value)).toBe("379456.92");
    // Known before the correction was recorded, the first rate is the one used.
    publishedAsEvents(store);
    const before = await queryValuationOnDate(
      counting(store),
      { ...REQUEST, knowledge: { mode: "known-at", knownAt: "2026-09-10T03:30:00.000Z" } },
      POLICIES,
    );
    expect(before.total.status === "exact" && text(before.total.value)).toBe("379378.5");
  });

  test("a holding of a stale snapshot is snapshot_stale, never valued at the date's prices", async () => {
    // The reviewer's shape: a domestic capture 40 days old under a
    // latest-in-window price policy, beside a fresh foreign holding.
    const store = new DatedStore();
    emptyVc(store);
    const old = store.capture({
      ...DOMESTIC,
      fetchedAt: "2026-08-01T01:00:00Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "100" }],
    });
    store.identify(old, DOMESTIC.source, "acct-sbi", "identified", ["inst-1001"]);
    const foreign = store.capture({
      ...FOREIGN,
      fetchedAt: "2026-09-10T02:00:00Z",
      positions: [{ account: "sbi-a", code: "ALPHA", quantity: "12", currency: "USD" }],
    });
    store.identify(foreign, FOREIGN.source, "acct-sbi", "identified", ["inst-alpha"]);
    ownPrices(store, foreign, "sbi-foreign-stock-price-last-v1", "USD", [
      { code: "ALPHA", amount: "130.70", at: "2026-09-10T06:00:00+09:00" },
    ]);
    // A fresh price of the same code, which a latest-in-window policy could take.
    claimPrice(store, {
      id: "px-1001-fresh",
      parse: foreign.parse,
      observation: foreign.positions[0]!,
      claimKind: "position",
      rule: "sbi-domestic-current-price-v1",
      base: "instrument:sbi-securities:-:1001",
      quote: "JPY",
      amount: "1500",
      at: "2026-09-10T10:00:00+09:00",
    });
    board(store, "2026-09-10T10:00:00+09:00", { USD: "146.25" });
    const latest: MarketDataPolicies = {
      ...POLICIES,
      price: { ...EQUITY, policyId: "test:latest", candidateScope: "latest-in-window" },
    };
    const result = await queryValuationOnDate(counting(store), REQUEST, latest);
    expect(
      result.holdings.map((entry) => [
        entry.snapshotRef,
        entry.outcome,
        entry.outcome === "snapshot_stale" ? entry.ageDays : null,
      ]),
    ).toEqual([
      [`artifact:${old.artifact}`, "snapshot_stale", 40],
      [`artifact:${foreign.artifact}`, "valued", null],
    ]);
    expect(result.total).toEqual({ status: "absent", reason: "holding_not_valued" });
    expect(result.reportedState.coverage.staleSnapshots.map((entry) => entry.ref)).toEqual([
      `artifact:${old.artifact}`,
    ]);
    // The stale holding selected no price.
    expect(result.manifest.selection.selected).not.toContain("px-1001-fresh");
  });

  test("a recent snapshot whose own price is older than the policy allows is unpriced stale", async () => {
    const store = new DatedStore();
    emptyVc(store);
    const recent = store.capture({
      ...DOMESTIC,
      fetchedAt: "2026-09-07T01:00:00Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "100" }],
    });
    store.identify(recent, DOMESTIC.source, "acct-sbi", "identified", ["inst-1001"]);
    ownPrices(store, recent, "sbi-domestic-current-price-v1", "JPY", [
      { code: "1001", amount: "1500", at: "2026-09-07T10:00:00+09:00" },
    ]);
    const strict: MarketDataPolicies = {
      ...POLICIES,
      price: { ...EQUITY, freshness: { unit: "calendar-days", maxAgeDays: 2 } },
    };
    const result = await queryValuationOnDate(counting(store), REQUEST, strict);
    expect(result.holdings[0]).toMatchObject({
      outcome: "unpriced",
      reason: "stale",
      ageDays: 3,
      candidateIds: [`px-${recent.parse}-1001`],
    });
    expect(result.total).toEqual({ status: "absent", reason: "holding_not_valued" });
  });

  test("a position container without a snapshot makes the total a partial verified scope", async () => {
    const store = world();
    const full = await queryValuationOnDate(counting(store), REQUEST, POLICIES);
    expect(full.total.status).toBe("exact");
    // The same holdings, but the VC position container has no snapshot on the date.
    const lacking = world({ vc: false });
    const partial = await queryValuationOnDate(counting(lacking), REQUEST, POLICIES);
    expect(partial.total).toMatchObject({
      status: "partial-verified-scope",
      positionContainersWithoutSnapshot: 1,
    });
    expect(partial.total.status !== "absent" && text(partial.total.value)).toBe("379378.5");
    expect(partial.manifest.reportedState.positionContainersWithoutSnapshot).toEqual([
      {
        sourceId: "sbi-vc-trade",
        parserName: "sbi-vc-position-summary",
        dataset: "position-summary",
      },
    ]);
    expect(partial.contextId).not.toBe(full.contextId);
  });

  test("an unidentified holding and an unreadable quantity are named, and select no price", async () => {
    const store = new DatedStore();
    store.capture({
      ...DOMESTIC,
      fetchedAt: "2026-09-10T01:00:00Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "100" }],
    });
    const unreadable = store.capture({
      ...FOREIGN,
      fetchedAt: "2026-09-10T02:00:00Z",
      positions: [{ account: "sbi-b", code: "ALPHA", quantity: "unreadable", currency: "USD" }],
    });
    store.identify(unreadable, FOREIGN.source, "acct-sbi", "identified", ["inst-alpha"]);
    const result = await queryValuationOnDate(counting(store), REQUEST, POLICIES);
    expect(
      result.holdings.map((entry) => [
        entry.outcome,
        entry.outcome === "instrument_unresolved"
          ? entry.status
          : entry.outcome === "quantity_unknown"
            ? entry.reason
            : null,
      ]),
    ).toEqual([
      ["instrument_unresolved", "not-recorded"],
      ["quantity_unknown", "unparsed:stored:unparsed"],
    ]);
    expect(result.manifest.selection).toMatchObject({ selected: [], refused: [] });
    expect(result.total).toEqual({ status: "absent", reason: "holding_not_valued" });
  });

  test("no holdings on the date is no total, not zero", async () => {
    const result = await queryValuationOnDate(counting(new DatedStore()), REQUEST, POLICIES);
    expect(result.holdings).toEqual([]);
    expect(result.total).toEqual({ status: "absent", reason: "no_holdings" });
  });

  test("an account filter narrows the holdings; an account that does not exist is refused", async () => {
    const store = world();
    const narrowed = await queryValuationOnDate(
      counting(store),
      { ...REQUEST, account: "acct-sbi" },
      POLICIES,
    );
    expect(narrowed.holdings).toHaveLength(2);
    expect(narrowed.manifest.reportedState.filters).toEqual({ source: null, account: "acct-sbi" });
    expect(await refusal(counting(store), { ...REQUEST, account: "acct-nobody" }, POLICIES)).toBe(
      "unknown_account",
    );
  });

  test("a source filter narrows the holdings; a source that does not exist is refused", async () => {
    const store = world();
    // The synthetic Layer A stub seeds only three sources; CORE seeds the rest.
    store.db.run("INSERT INTO sources(id,provider) VALUES('sbi-securities','synthetic')");
    const narrowed = await queryValuationOnDate(
      counting(store),
      { ...REQUEST, source: "sbi-securities" },
      POLICIES,
    );
    expect(narrowed.holdings).toHaveLength(2);
    expect(narrowed.manifest.reportedState.filters).toEqual({
      source: "sbi-securities",
      account: null,
    });
    // A known source with no positions: no holdings, answered.
    const none = await queryValuationOnDate(
      counting(store),
      { ...REQUEST, source: "smbc-bank" },
      POLICIES,
    );
    expect(none.total).toEqual({ status: "absent", reason: "no_holdings" });
    expect(await refusal(counting(store), { ...REQUEST, source: "no-such-source" }, POLICIES)).toBe(
      "unknown_source",
    );
  });

  test("a different reported state on the date is a different valuation context", async () => {
    const store = world();
    const first = await queryValuationOnDate(counting(store), REQUEST, POLICIES);
    // A card statement changes the reported state's answer, not the holdings.
    store.statement({
      card: "card-a",
      period: "2026-09",
      paymentDate: "2026-09-26",
      minor: 30_000,
      fetchedAt: "2026-09-05T01:00:00Z",
    });
    const second = await queryValuationOnDate(counting(store), REQUEST, POLICIES);
    expect(second.reportedState.contextId).not.toBe(first.reportedState.contextId);
    expect(second.manifest.reportedState.contextId).toBe(second.reportedState.contextId);
    expect(second.contextId).not.toBe(first.contextId);
    expect(second.total).toEqual(first.total);
  });
});

describe("refusals", () => {
  test("no policy is refused before anything is read", async () => {
    const sql = counting(world());
    expect(await refusal(sql, REQUEST, null)).toBe("policy_missing");
    expect(sql.calls).toBe(0);
  });

  test("a policy that cannot apply is refused", async () => {
    const sql = counting(world());
    const cases: MarketDataPolicies[] = [
      { ...POLICIES, price: { ...EQUITY, priceKinds: ["reference", "nav"] } },
      { ...POLICIES, price: { ...EQUITY, policyId: "proposal:test-equity" } },
      { ...POLICIES, fx: { ...FX, selection: { ...FX.selection, zone: "Australia/Sydney" } } },
      { ...POLICIES, price: { ...EQUITY, policyId: FX.selection.policyId } },
    ];
    for (const policies of cases)
      expect(await refusal(sql, REQUEST, policies)).toBe("invalid_policy");
  });

  test("malformed requests and dates after today are refused", async () => {
    const sql = counting(world());
    for (const request of [
      { ...REQUEST, date: "2026-02-30" },
      { ...REQUEST, today: "today" },
      { ...REQUEST, baseUnit: "yen" },
      { ...REQUEST, knowledge: { mode: "known-at", knownAt: "2026-09-10T03:00:00.0001Z" } },
      { ...REQUEST, source: "" },
      { ...REQUEST, knowledge: { mode: "current", knownAt: "2026-09-10T03:00:00Z" } },
      { ...REQUEST, knowledge: null },
    ] as ValuationOnDateRequest[])
      expect(await refusal(sql, request, POLICIES)).toBe("invalid_request");
    expect(await refusal(sql, { ...REQUEST, date: "2026-09-13" }, POLICIES)).toBe("date_in_future");
  });
});

describe("bounds are refused, never cut", () => {
  function many(count: number, distinct: boolean): DatedStore {
    const store = new DatedStore();
    const capture = store.capture({
      ...FOREIGN,
      fetchedAt: "2026-09-10T02:00:00Z",
      positions: Array.from({ length: count }, (_, index) => ({
        account: "sbi-a",
        code: distinct ? `C${index}` : "SAME",
        quantity: "1",
        currency: "USD",
      })),
    });
    store.identify(
      capture,
      FOREIGN.source,
      "acct-sbi",
      "identified",
      Array.from({ length: count }, (_, index) => `inst-${distinct ? index : 0}`),
    );
    return store;
  }

  test(`more than ${VALUATION_HOLDING_BOUND} holdings`, async () => {
    expect(
      await refusal(counting(many(VALUATION_HOLDING_BOUND + 1, false)), REQUEST, POLICIES),
    ).toBe("holding_limit_exceeded");
    // At the bound, one shared key and one currency: answered.
    const result = await queryValuationOnDate(
      counting(many(VALUATION_HOLDING_BOUND, false)),
      REQUEST,
      POLICIES,
    );
    expect(result.holdings).toHaveLength(VALUATION_HOLDING_BOUND);
    expect(result.counts.unpriced).toBe(VALUATION_HOLDING_BOUND);
  }, 30_000);

  test("more selections than the candidate read takes", async () => {
    // 500 distinct instruments and USD: 501 selections.
    expect(await refusal(counting(many(VALUATION_HOLDING_BOUND, true)), REQUEST, POLICIES)).toBe(
      "selection_limit_exceeded",
    );
    // 499 and USD: 500, answered.
    const result = await queryValuationOnDate(
      counting(many(VALUATION_HOLDING_BOUND - 1, true)),
      REQUEST,
      POLICIES,
    );
    expect(result.manifest.selection.refused).toHaveLength(VALUATION_HOLDING_BOUND);
  }, 30_000);
});

describe("plans without table statistics", () => {
  test("the account and source checks reach their tables by primary key", () => {
    const db = migratedDatabase();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const plan = (text: string) =>
      (db.query(`EXPLAIN QUERY PLAN ${text}`).all("x") as { detail: string }[]).map(
        (row) => row.detail,
      );
    expect(plan(ACCOUNT_EXISTS_SQL)).toEqual([
      expect.stringMatching(
        /^SEARCH accounts USING (COVERING )?INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/u,
      ),
    ]);
    expect(plan(SOURCE_EXISTS_SQL)).toEqual([
      expect.stringMatching(
        /^SEARCH sources USING (COVERING )?INDEX sqlite_autoindex_sources_1 \(id=\?\)$/u,
      ),
    ]);
    db.close();
  });
});
