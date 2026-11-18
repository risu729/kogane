// SBI Securities identity policy versions (ADR 0113). Policy 1 gave a
// security code with no RIC, no MIC and no country the placeholder scope
// `unknown-country`, so two different securities sharing such a code shared
// one identifier. Policy 2 maps that shape `unresolved`, scoped to its fetch
// run. Every other shape plans exactly as policy 1 did. Synthetic inputs only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ArtifactMeta, Observation } from "../../parsers/src/types.ts";
import { sbiAccountAssetsCurrent } from "../../parsers/src/parsers/sbi-account-assets-current.ts";
import { sbiDomesticCashPositions } from "../../parsers/src/parsers/sbi-domestic-cash-positions.ts";
import { sbiDomesticTradeRecords } from "../../parsers/src/parsers/sbi-domestic-trade-records.ts";
import { sbiForeignCashBalances } from "../../parsers/src/parsers/sbi-foreign-cash-balances.ts";
import { sbiForeignCashPositions } from "../../parsers/src/parsers/sbi-foreign-cash-positions.ts";
import { sbiForeignTradeRecords } from "../../parsers/src/parsers/sbi-foreign-trade-records.ts";
import { sbiYenDetailHistory } from "../../parsers/src/parsers/sbi-yen-detail-history.ts";
import { SBI_SECURITIES_POLICY_VERSION, sbiIdentity } from "../src/sbi.ts";
import type { IdentityInput, InstrumentIdentity } from "../src/types.ts";

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
  test("the scopeless security rule starts at policy 2", () => {
    expect(SBI_SECURITIES_POLICY_VERSION).toBe(2);
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
    expect(at(row, undefined)).toEqual(at(row, 2));
    expect(at(row, 10)).toEqual(at(row, 2));
  });

  test("every shape with a RIC, a MIC or a country plans identically under both versions", () => {
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
    for (const row of rows) expect(at(row, 2)).toEqual(at(row, 1));
  });

  test("every SBI parser fixture plans identically under both versions", () => {
    const basic = "sbi-securities/2026-08-20/run-20260820-210000-poc01";
    const cases = [
      [sbiDomesticCashPositions, "sbi-parser-boundaries/domestic-cash-positions.json"],
      [sbiDomesticTradeRecords, `${basic}/domestic-trade-records.json`],
      [sbiForeignCashPositions, `${basic}/foreign-cash-positions.json`],
      [sbiForeignCashBalances, `${basic}/foreign-cash-balances.json`],
      [sbiForeignTradeRecords, "sbi-parser-boundaries/foreign-trade-records.json"],
      [sbiYenDetailHistory, "sbi-parser-boundaries/yen-detail-history.json"],
      [sbiAccountAssetsCurrent, "sbi-parser-boundaries/account-assets-current.json"],
    ] as const;
    for (const [parser, path] of cases) {
      const observations = parser.parse(fixture(path), artifact(null)).observations;
      expect(observations.length).toBeGreaterThan(0);
      for (const [ordinal, observation] of observations.entries()) {
        const row = fromObservation(observation, ordinal);
        expect(at(row, 2)).toEqual(at(row, 1));
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
