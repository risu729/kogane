// SBI Securities identity policy versions. Policy 1 gave a security code with
// no RIC, no MIC and no country the placeholder scope `unknown-country`, so
// two different securities sharing such a code shared one identifier. Policy
// 2 maps that shape `unresolved`, scoped to its fetch run (ADR 0113). Policies
// 1 and 2 left a foreign custody or cash-balance row with no account
// discriminator on the bare `sbi-securities:foreign` reference that the
// foreign cash history uses; policy 3 scopes it to its fetch run (ADR 0117).
// Every other shape plans exactly as policy 1 did. Synthetic inputs only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ArtifactMeta, Observation, Parser } from "../../parsers/src/types.ts";
import { sbiAccountAssetsCurrent } from "../../parsers/src/parsers/sbi-account-assets-current.ts";
import { sbiAccountAssetsHistory } from "../../parsers/src/parsers/sbi-account-assets-history.ts";
import { sbiDomesticCashPositions } from "../../parsers/src/parsers/sbi-domestic-cash-positions.ts";
import { sbiDomesticTradeRecords } from "../../parsers/src/parsers/sbi-domestic-trade-records.ts";
import { sbiForeignCashBalances } from "../../parsers/src/parsers/sbi-foreign-cash-balances.ts";
import { sbiForeignCashHistory } from "../../parsers/src/parsers/sbi-foreign-cash-history.ts";
import { sbiForeignCashPositions } from "../../parsers/src/parsers/sbi-foreign-cash-positions.ts";
import { sbiForeignTradeRecords } from "../../parsers/src/parsers/sbi-foreign-trade-records.ts";
import { sbiYenDetailHistory } from "../../parsers/src/parsers/sbi-yen-detail-history.ts";
import {
  SBI_SCOPELESS_SECURITY_POLICY_VERSION,
  SBI_SECURITIES_POLICY_VERSION,
  SBI_UNDISCRIMINATED_ACCOUNT_POLICY_VERSION,
  sbiIdentity,
} from "../src/sbi.ts";
import type { AccountIdentity, IdentityInput, InstrumentIdentity } from "../src/types.ts";

function input(patch: Partial<IdentityInput> = {}): IdentityInput {
  return {
    kind: "position",
    observationId: 1,
    parseRunId: 2,
    artifactId: 3,
    fetchRunId: 4,
    sourceId: "sbi-securities",
    producerId: "synthetic-producer",
    sourceAccount: "sbi-securities:foreign",
    currency: "USD",
    instrument: null,
    securityCode: "SYNX",
    securityName: null,
    market: null,
    subject: null,
    extra: {},
    ...patch,
  };
}

/**
 * A foreign position element as `sbi-foreign-cash-positions` carries it in
 * `extra`, with neither `countryCode` nor a RIC: the parser does not require
 * them, though every observed capture states both.
 */
function scopeless(name: string, fetchRunId: number, observationId = 1): IdentityInput {
  return input({
    fetchRunId,
    observationId,
    securityName: name,
    extra: {
      specificAccountCode: "SPECIFIC",
      currencyCode: "USD",
      securities: { securitiesCode: "SYNX", securitiesName: name },
    },
  });
}

const at = (row: IdentityInput, policyVersion: number | undefined) =>
  sbiIdentity(policyVersion === undefined ? row : { ...row, policyVersion });
const security = (row: IdentityInput, policyVersion: number | undefined): InstrumentIdentity => {
  const found = at(row, policyVersion).instruments.find((item) => item.role === "security");
  if (!found) throw new Error("expected a security instrument");
  return found;
};
/** The identifier's key as the store derives it (`identityKey("ii", ...)`). */
const identifier = (item: InstrumentIdentity) => [item.namespace, item.scope, item.value];

describe("SBI Securities identity policy versions", () => {
  test("the scopeless security rule starts at policy 2, the undiscriminated account rule at 3", () => {
    expect(SBI_SCOPELESS_SECURITY_POLICY_VERSION).toBe(2);
    expect(SBI_UNDISCRIMINATED_ACCOUNT_POLICY_VERSION).toBe(3);
    expect(SBI_SECURITIES_POLICY_VERSION).toBe(3);
  });

  test("policy 1 golden: a code with no RIC, MIC or country is recorded as it was", () => {
    // What policy-1 runs recorded, kept unchanged: the placeholder scope.
    expect(at(scopeless("Synthetic one", 4), 1)).toEqual({
      account: {
        key: ["sbi-securities:foreign", "specificAccountCode", "SPECIFIC"],
        label: "SBI証券 外国株式（預り区分: SPECIFIC）",
        role: "foreign-brokerage",
        status: "provider-local",
        reason: "exact-provider-account-reference",
      },
      instruments: [
        {
          role: "unit",
          kind: "money",
          namespace: "iso4217",
          scope: "global",
          value: "USD",
          label: "USD",
          status: "identified",
          reason: "explicit-currency-catalog",
          details: {},
        },
        {
          role: "security",
          kind: "security",
          namespace: "sbi-security-code",
          scope: "unknown-country",
          value: "SYNX",
          label: "Synthetic one",
          status: "provider-local",
          reason: "provider-code-without-global-crosswalk",
          details: { securityCode: "SYNX" },
        },
      ],
      issues: ["security-without-global-crosswalk"],
    });
    // Two different securities sharing the code shared one identifier.
    expect(identifier(security(scopeless("Synthetic two", 5), 1))).toEqual(
      identifier(security(scopeless("Synthetic one", 4), 1)),
    );
  });

  test("policy 2: two different securities sharing such a code never share an identifier", () => {
    const one = security(scopeless("Synthetic one", 4), 2);
    const two = security(scopeless("Synthetic two", 5), 2);
    expect(one).toEqual({
      role: "security",
      kind: "security",
      namespace: "sbi-security-code",
      scope: "fetch-run:4",
      value: "SYNX",
      label: "Synthetic one",
      status: "unresolved",
      reason: "missing-security-scope",
      details: { securityCode: "SYNX" },
    });
    expect(two).toMatchObject({ scope: "fetch-run:5", status: "unresolved" });
    expect(identifier(one)).not.toEqual(identifier(two));
    for (const item of [one, two]) expect(item.scope).not.toBe("unknown-country");
    expect(at(scopeless("Synthetic one", 4), 2).issues).toEqual([
      "security-without-global-crosswalk",
      "missing-security-scope",
    ]);
  });

  test("policy 2 changes only the security; the account and units are policy 1's", () => {
    const row = scopeless("Synthetic one", 4);
    const before = at(row, 1);
    const after = at(row, 2);
    expect(after.account).toEqual(before.account);
    expect(after.instruments.filter((item) => item.role !== "security")).toEqual(
      before.instruments.filter((item) => item.role !== "security"),
    );
  });

  test("within one fetch run a position and its valuation keep one identifier", () => {
    // The parser emits the element's position and its valuations as separate
    // observations of one capture; the fetch-run scope keeps them together.
    const position = security(scopeless("Synthetic one", 4, 1), 2);
    const valuation = security(
      input({
        kind: "valuation",
        observationId: 2,
        fetchRunId: 4,
        securityCode: null,
        subject: "SYNX",
        currency: "JPY",
        extra: scopeless("Synthetic one", 4).extra,
      }),
      2,
    );
    expect(identifier(valuation)).toEqual(identifier(position));
  });

  test("a resolver call without a version applies the newest rules", () => {
    const row = scopeless("Synthetic one", 4);
    expect(at(row, undefined)).toEqual(at(row, 3));
    expect(at(row, 10)).toEqual(at(row, 3));
    // Policy 3 changes nothing for a row that states its discriminator.
    expect(at(row, 3)).toEqual(at(row, 2));
  });

  test("every shape with a RIC, a MIC or a country plans identically under every version", () => {
    const rows: IdentityInput[] = [
      // Foreign with a country and no RIC: scope is the country.
      input({
        extra: {
          specificAccountCode: "SPECIFIC",
          securities: { securitiesCode: "SYNX", countryCode: "US", ric: "" },
        },
      }),
      // Foreign with the country on the element only.
      input({
        extra: {
          specificAccountCode: "SPECIFIC",
          countryCode: "US",
          securities: { securitiesCode: "SYNX" },
        },
      }),
      // Foreign with a RIC and no country.
      input({
        extra: {
          specificAccountCode: "SPECIFIC",
          securities: { securitiesCode: "SYNX", ric: "SYNX.O" },
        },
      }),
      // Domestic: country JP, with and without a mapped venue.
      input({
        sourceAccount: "sbi-securities:domestic:deposit-type=0",
        currency: "JPY",
        market: "XTKS",
        securityCode: "1234",
      }),
      input({
        sourceAccount: "sbi-securities:domestic:deposit-type=0",
        currency: "JPY",
        market: "PTS",
        securityCode: "1234",
      }),
      // No code at all stays a missing identifier under both versions.
      input({ securityCode: null, extra: { specificAccountCode: "SPECIFIC" } }),
    ];
    for (const row of rows) {
      expect(at(row, 2)).toEqual(at(row, 1));
      expect(at(row, 3)).toEqual(at(row, 1));
    }
  });

  test("every SBI parser fixture plans identically under every version", () => {
    const basic = "sbi-securities/2026-08-20/run-20260820-210000-poc01";
    const cases = [
      [sbiDomesticCashPositions, "sbi-parser-boundaries/domestic-cash-positions.json"],
      [sbiDomesticTradeRecords, `${basic}/domestic-trade-records.json`],
      [sbiForeignCashPositions, `${basic}/foreign-cash-positions.json`],
      [sbiForeignCashBalances, `${basic}/foreign-cash-balances.json`],
      [sbiForeignTradeRecords, "sbi-parser-boundaries/foreign-trade-records.json"],
      [sbiYenDetailHistory, "sbi-parser-boundaries/yen-detail-history.json"],
      [sbiAccountAssetsCurrent, "sbi-parser-boundaries/account-assets-current.json"],
      // Foreign cash history rows are `sbi-securities:foreign` transactions;
      // their schema admits no security, so they never reach the rule.
      [sbiForeignCashHistory, "sbi-parser-boundaries/foreign-cash-history.json"],
      [sbiAccountAssetsHistory, "sbi-parser-boundaries/account-assets-history.json"],
    ] as const;
    for (const [parser, path] of cases) {
      const observations = parser.parse(fixture(path), artifact(null)).observations;
      expect(observations.length).toBeGreaterThan(0);
      for (const [ordinal, observation] of observations.entries()) {
        const row = fromObservation(observation, ordinal);
        expect(at(row, 2)).toEqual(at(row, 1));
        expect(at(row, 3)).toEqual(at(row, 1));
      }
    }
  });

  test("through the real parsers: only a positions element without country or RIC reaches the rule", () => {
    // A synthetic mutation of the anonymous positions fixture: one element
    // states neither its country nor a RIC, at the element or the security.
    const body = JSON.parse(
      new TextDecoder().decode(
        fixture("sbi-securities/2026-08-20/run-20260820-210000-poc01/foreign-cash-positions.json"),
      ),
    ) as { listSecuritiesBalances: { securitiesBalances: Record<string, unknown>[] } };
    const element = body.listSecuritiesBalances.securitiesBalances[0]!;
    delete element["countryCode"];
    const securities = element["securities"] as Record<string, unknown>;
    delete securities["countryCode"];
    delete securities["ric"];
    const observations = sbiForeignCashPositions.parse(
      new TextEncoder().encode(JSON.stringify(body)),
      artifact("foreign-cash-positions"),
    ).observations;
    const code = securities["securitiesCode"];
    const reached = observations
      .map((observation, ordinal) => fromObservation(observation, ordinal))
      .filter((row) => (row.securityCode ?? row.subject) === code);
    // The position and its four valuations.
    expect(reached).toHaveLength(5);
    const scopes = new Set(reached.map((row) => security(row, 2).scope));
    expect([...scopes]).toEqual(["fetch-run:4"]);
    for (const row of reached) {
      expect(security(row, 1).scope).toBe("unknown-country");
      expect(security(row, 2).status).toBe("unresolved");
    }
    // The trade parser refuses the same shape outright: every trade states
    // its country (and it must be US), so trades never reach the rule.
    const trades = JSON.parse(
      new TextDecoder().decode(fixture("sbi-parser-boundaries/foreign-trade-records.json")),
    ) as {
      pages: { listTradeRecords: { tradeRecords: { securities: Record<string, unknown> }[] } }[];
    };
    delete trades.pages[0]!.listTradeRecords.tradeRecords[0]!.securities["countryCode"];
    expect(() =>
      sbiForeignTradeRecords.parse(
        new TextEncoder().encode(JSON.stringify(trades)),
        artifact("foreign-trade-records"),
      ),
    ).toThrow();
  });
});

describe("SBI Securities foreign rows with no account discriminator (ADR 0117)", () => {
  const BARE = ["sbi-securities:foreign"];
  /** A foreign trade row as the trade parser accepts it: the field stated, empty. */
  const trade = (fetchRunId = 4, specificAccountCode: unknown = "") =>
    input({
      kind: "transaction",
      fetchRunId,
      securityCode: null,
      extra: {
        specificAccountCode,
        tradeCurrencyCode: "USD",
        settlementCurrencyCode: "USD",
        securities: { securitiesCode: "SYNX", countryCode: "US", ric: "SYNX.O" },
      },
    });
  /** A foreign cash history row: its schema has no discriminator field at all. */
  const ledger = (fetchRunId = 4) =>
    input({
      kind: "transaction",
      fetchRunId,
      securityCode: null,
      extra: {
        valueDate: "2099-01-01",
        tradeType: "synthetic",
        description: "synthetic",
        _kogane: { identityOrigin: "row-occurrence" },
      },
    });
  const position = (fetchRunId = 4) =>
    input({
      fetchRunId,
      extra: { countryCode: "US", securities: { securitiesCode: "SYNX", ric: "SYNX.O" } },
    });
  const valuation = (fetchRunId = 4) =>
    input({
      kind: "valuation",
      fetchRunId,
      securityCode: null,
      subject: "SYNX",
      currency: "JPY",
      extra: position(fetchRunId).extra,
    });
  const balance = (fetchRunId = 4) =>
    input({
      kind: "balance",
      fetchRunId,
      currency: null,
      instrument: "USD",
      securityCode: null,
      extra: { account: {}, currencyEntry: { currencyCode: "USD" }, row: {} },
    });

  test("policies 1 and 2 golden: every such row is the cash ledger's bare reference", () => {
    // What policy-1 and policy-2 runs recorded, kept unchanged: the merge.
    const custody: AccountIdentity = {
      key: BARE,
      label: "SBI証券 外国株式（預り区分: 未確定）",
      role: "foreign-brokerage",
      status: "unresolved",
      reason: "exact-provider-account-reference",
    };
    for (const version of [1, 2]) {
      for (const row of [trade(), position(), valuation(), ledger()])
        expect(at(row, version).account).toEqual(custody);
      expect(at(balance(), version).account).toEqual({
        ...custody,
        label: "SBI証券 外貨預り金（口座区分: 未確定）",
      });
      expect(at(trade(), version).issues).toEqual(["missing-specificAccountCode"]);
      expect(at(balance(), version).issues).toEqual(["missing-accountKind"]);
      // Another capture names the same reference.
      expect(at(trade(5), version).account.key).toEqual(BARE);
    }
  });

  test("policy 3 golden: a custody row is unresolved on a source account scoped to its fetch run", () => {
    expect(at(trade(), 3)).toEqual({
      account: {
        key: ["sbi-securities:foreign", "missing-specificAccountCode", "fetch-run", "4"],
        label: "SBI証券 外国株式（預り区分: 未確定）",
        role: "foreign-brokerage",
        status: "unresolved",
        reason: "missing-specificAccountCode",
      },
      instruments: at(trade(), 2).instruments,
      issues: ["missing-specificAccountCode"],
    });
    expect(at(balance(), 3).account).toEqual({
      key: ["sbi-securities:foreign", "missing-accountKind", "fetch-run", "4"],
      label: "SBI証券 外貨預り金（口座区分: 未確定）",
      role: "foreign-brokerage",
      status: "unresolved",
      reason: "missing-accountKind",
    });
    // Only the account changes: units, security and issues are policy 2's.
    for (const row of [trade(), position(), valuation(), balance()]) {
      expect(at(row, 3).instruments).toEqual(at(row, 2).instruments);
      expect(at(row, 3).issues).toEqual(at(row, 2).issues);
    }
  });

  test("policy 3 never maps such a row onto the cash ledger, and keeps the namespaces apart", () => {
    const keys = [trade(), position(), valuation(), balance()].map((row) => at(row, 3).account.key);
    for (const key of keys) expect(key).not.toEqual(BARE);
    // Custody rows of one capture share one unresolved account; the cash
    // balance, in the `accountKind` namespace, does not join them.
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
    expect(keys[3]).not.toEqual(keys[0]);
    // Another capture gets another account.
    expect(at(trade(5), 3).account.key).not.toEqual(keys[0]);
    expect(at(balance(5), 3).account.key).not.toEqual(keys[3]);
    // A stated value never collides with the scoped key: a provider value
    // equal to the issue code still keys `specificAccountCode`.
    expect(at(trade(4, "missing-specificAccountCode"), 3).account.key).toEqual([
      "sbi-securities:foreign",
      "specificAccountCode",
      "missing-specificAccountCode",
    ]);
  });

  test("a stated but unusable value is missing; only an absent field marks the cash ledger", () => {
    for (const value of ["", "   ", null, 7])
      expect(at(trade(4, value), 3).account.key).toEqual([
        "sbi-securities:foreign",
        "missing-specificAccountCode",
        "fetch-run",
        "4",
      ]);
    // The cash history keeps its bare reference under every version, also an
    // explicit later one and a call without a version.
    for (const version of [1, 2, 3, 10, undefined]) {
      expect(at(ledger(), version)).toEqual(at(ledger(), 1));
      expect(at(ledger(5), version).account.key).toEqual(BARE);
    }
  });

  test("through the real parsers: the four datasets no longer share one account; history keeps its key", () => {
    // The scenario a reviewer reached with the anonymous fixtures: every
    // trade, position and balance with its discriminator blanked, in one
    // capture with the foreign cash history.
    const json = (path: string) =>
      JSON.parse(new TextDecoder().decode(fixture(path))) as Record<string, unknown>;
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const basic = "sbi-securities/2026-08-20/run-20260820-210000-poc01";
    const trades = json("sbi-parser-boundaries/foreign-trade-records.json") as {
      pages: { listTradeRecords: { tradeRecords: Record<string, unknown>[] } }[];
    };
    for (const page of trades.pages)
      for (const row of page.listTradeRecords.tradeRecords) row["specificAccountCode"] = "";
    const positions = json(`${basic}/foreign-cash-positions.json`) as {
      listSecuritiesBalances: { securitiesBalances: Record<string, unknown>[] };
    };
    for (const element of positions.listSecuritiesBalances.securitiesBalances)
      delete element["specificAccountCode"];
    const balances = json(`${basic}/foreign-cash-balances.json`) as {
      listForeignScheduleCashBalances: { foreignCashBalances: Record<string, unknown>[] };
    };
    for (const account of balances.listForeignScheduleCashBalances.foreignCashBalances)
      delete account["accountKind"];
    const rows = (parser: Parser, bytes: Uint8Array, dataset: string) => {
      const observations = parser.parse(bytes, artifact(dataset)).observations;
      expect(observations.length).toBeGreaterThan(0);
      return observations.map((observation, ordinal) => fromObservation(observation, ordinal));
    };
    const datasets = {
      history: rows(
        sbiForeignCashHistory,
        fixture("sbi-parser-boundaries/foreign-cash-history.json"),
        "foreign-cash-history",
      ),
      trade: rows(sbiForeignTradeRecords, encode(trades), "foreign-trade-records"),
      positions: rows(sbiForeignCashPositions, encode(positions), "foreign-cash-positions"),
      balances: rows(sbiForeignCashBalances, encode(balances), "foreign-cash-balances"),
    };
    expect(new Set(datasets.positions.map((row) => row.kind))).toEqual(
      new Set(["position", "valuation"]),
    );
    const keys = (version: number) =>
      Object.fromEntries(
        Object.entries(datasets).map(([name, list]) => [
          name,
          [...new Set(list.map((row) => JSON.stringify(at(row, version).account.key)))],
        ]),
      );
    // Policies 1 and 2: all four datasets on the one bare reference (the merge).
    for (const version of [1, 2])
      expect(keys(version)).toEqual({
        history: [JSON.stringify(BARE)],
        trade: [JSON.stringify(BARE)],
        positions: [JSON.stringify(BARE)],
        balances: [JSON.stringify(BARE)],
      });
    // Policy 3: history keeps its key; the other three leave it and each other.
    const custody = JSON.stringify([
      "sbi-securities:foreign",
      "missing-specificAccountCode",
      "fetch-run",
      "4",
    ]);
    expect(keys(3)).toEqual({
      history: [JSON.stringify(BARE)],
      trade: [custody],
      positions: [custody],
      balances: [
        JSON.stringify(["sbi-securities:foreign", "missing-accountKind", "fetch-run", "4"]),
      ],
    });
    // Nothing but the account changes, and the history plans are policy 1's.
    for (const row of datasets.history) expect(at(row, 3)).toEqual(at(row, 1));
    for (const list of [datasets.trade, datasets.positions, datasets.balances])
      for (const row of list) {
        expect(at(row, 3).instruments).toEqual(at(row, 2).instruments);
        expect(at(row, 3).issues).toEqual(at(row, 2).issues);
      }
  });
});

function fixture(path: string): Uint8Array {
  return readFileSync(
    new URL(`../../../tests/fixtures/observation-pipeline/${path}`, import.meta.url),
  );
}
function artifact(dataset: string | null): ArtifactMeta {
  return {
    id: 1,
    sourceId: "sbi-securities",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2099-01-01T00:00:00Z",
    sha256: "synthetic",
  };
}
function fromObservation(observation: Observation, ordinal: number): IdentityInput {
  return input({
    kind: observation.kind,
    observationId: ordinal,
    sourceAccount: observation.sourceAccount,
    currency: "currency" in observation ? (observation.currency ?? null) : null,
    instrument: "instrument" in observation ? observation.instrument : null,
    securityCode: "securityCode" in observation ? observation.securityCode : null,
    securityName: "securityName" in observation ? (observation.securityName ?? null) : null,
    market: "market" in observation ? (observation.market ?? null) : null,
    subject: "subject" in observation ? observation.subject : null,
    extra: observation.extra,
  });
}
