import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sbiIdentity } from "../src/identity/sbi.ts";
import type { IdentityInput } from "../src/identity/types.ts";
import type { ArtifactMeta, Observation } from "../src/types.ts";
import { sbiDomesticCashPositions } from "../src/parsers/sbi-domestic-cash-positions.ts";
import { sbiDomesticTradeRecords } from "../src/parsers/sbi-domestic-trade-records.ts";
import { sbiForeignCashPositions } from "../src/parsers/sbi-foreign-cash-positions.ts";
import { sbiForeignCashBalances } from "../src/parsers/sbi-foreign-cash-balances.ts";
import { sbiForeignTradeRecords } from "../src/parsers/sbi-foreign-trade-records.ts";
import { sbiYenDetailHistory } from "../src/parsers/sbi-yen-detail-history.ts";
import { sbiAccountAssetsCurrent } from "../src/parsers/sbi-account-assets-current.ts";

function input(patch: Partial<IdentityInput> = {}): IdentityInput {
  return {
    kind: "position",
    observationId: 1,
    parseRunId: 2,
    artifactId: 3,
    fetchRunId: 4,
    sourceId: "sbi-securities",
    producerId: "synthetic",
    sourceAccount: "sbi-securities:domestic:deposit-type=0",
    currency: "JPY",
    instrument: null,
    securityCode: "1234",
    securityName: "Synthetic",
    market: "XTKS",
    subject: null,
    extra: {},
    ...patch,
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
describe("SBI identity", () => {
  test("friendly names are display-only and custody labels preserve exact codes", () => {
    const original = sbiIdentity(input({ securityName: "Synthetic old name" }));
    const renamed = sbiIdentity(input({ securityName: "Synthetic new name" }));
    const oldSecurity = original.instruments.find((i) => i.role === "security")!;
    const newSecurity = renamed.instruments.find((i) => i.role === "security")!;
    expect(oldSecurity.label).toBe("Synthetic old name");
    expect(newSecurity.label).toBe("Synthetic new name");
    expect([oldSecurity.namespace, oldSecurity.scope, oldSecurity.value]).toEqual([
      newSecurity.namespace,
      newSecurity.scope,
      newSecurity.value,
    ]);
    expect(original.account.key).toEqual(renamed.account.key);
    expect(original.account.label).toContain("特定預り");
    expect(original.account.label).toContain("区分コード: 0");
    expect(
      sbiIdentity(input({ sourceAccount: "sbi-securities:yen-cash", kind: "transaction" })).account
        .label,
    ).toContain("円貨預り金");
    expect(
      sbiIdentity(
        input({
          sourceAccount: "sbi-securities:foreign",
          extra: { specificAccountCode: "SPECIFIC" },
        }),
      ).account.label,
    ).toContain("外国株式");
    expect(
      sbiIdentity(
        input({
          sourceAccount: "sbi-securities:foreign",
          kind: "balance",
          instrument: "USD",
          extra: { account: { accountKind: "GENERAL" } },
        }),
      ).account.label,
    ).toContain("外貨預り金");
    const foreign = sbiIdentity(
      input({
        sourceAccount: "sbi-securities:foreign",
        securityName: null,
        extra: {
          specificAccountCode: "SPECIFIC",
          securities: {
            securitiesCode: "SYN",
            securitiesName: "Synthetic foreign name",
            ric: "SYN.O",
            countryCode: "US",
          },
        },
      }),
    );
    expect(foreign.instruments.find((i) => i.role === "security")?.label).toBe(
      "Synthetic foreign name",
    );
  });
  test("all seven parser outputs remain immutable and retain source account references", () => {
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
      const artifact: ArtifactMeta = {
        id: 1,
        sourceId: "sbi-securities",
        runStatus: "success",
        runFailureCount: 0,
        dataset: null,
        url: null,
        mime: "application/json",
        fetchedAt: "2099-01-01T00:00:00Z",
        sha256: "synthetic",
      };
      const observations = parser.parse(
        readFileSync(new URL(`../fixtures/${path}`, import.meta.url)),
        artifact,
      ).observations;
      expect(observations.length).toBeGreaterThan(0);
      const inputs = observations.map(fromObservation);
      const before = JSON.stringify(inputs);
      const plans = inputs.map(sbiIdentity);
      expect(JSON.stringify(inputs)).toBe(before);
      expect(plans.length).toBe(observations.length);
      for (const [ordinal, plan] of plans.entries()) {
        expect(plan.account.key[0]).toBe(observations[ordinal]!.sourceAccount);
        expect(inputs[ordinal]!.observationId).toBe(ordinal);
      }
    }
  });
  test("domestic valuation and position share listing, never trim codes or merge tax aliases", () => {
    const position = sbiIdentity(input({ securityCode: "12345" }));
    const valuation = sbiIdentity(
      input({
        kind: "valuation",
        securityCode: null,
        subject: "12345",
        market: null,
        extra: { _kogane: { marketCode: "TKY" } },
      }),
    );
    const positionSecurity = position.instruments.find((item) => item.role === "security")!;
    const valuationSecurity = valuation.instruments.find((item) => item.role === "security")!;
    expect([positionSecurity.namespace, positionSecurity.scope, positionSecurity.value]).toEqual([
      valuationSecurity.namespace,
      valuationSecurity.scope,
      valuationSecurity.value,
    ]);
    const accounts = ["1", "-", "5", "6", "7", "J"].map((code) =>
      sbiIdentity(
        input({ sourceAccount: `sbi-securities:domestic:deposit-type=${code}` }),
      ).account.key.join("/"),
    );
    expect(new Set(accounts).size).toBe(6);
    const trade = sbiIdentity(
      input({
        kind: "transaction",
        sourceAccount: "sbi-securities:domestic",
        securityCode: null,
        market: null,
        extra: { issueCode: "123A", marketLabel: "東証", accountLabel: "特定" },
      }),
    );
    expect(trade.account.key).toEqual(["sbi-securities:domestic", "accountLabel", "特定"]);
    expect(trade.instruments.find((item) => item.role === "security")?.value).toBe("123A");
  });
  test("foreign security and cash discriminator namespaces remain distinct, roles keep settlement and trade currency", () => {
    const trade = sbiIdentity(
      input({
        kind: "transaction",
        sourceAccount: "sbi-securities:foreign",
        securityCode: null,
        market: null,
        extra: {
          specificAccountCode: "SPECIFIC",
          tradeCurrencyCode: "USD",
          settlementCurrencyCode: "JPY",
          securities: { securitiesCode: "SYN", countryCode: "US", ric: "SYN.O" },
        },
      }),
    );
    expect(trade.account.key).toEqual([
      "sbi-securities:foreign",
      "specificAccountCode",
      "SPECIFIC",
    ]);
    expect(trade.instruments.map((item) => [item.role, item.value])).toEqual([
      ["unit", "JPY"],
      ["trade-unit", "USD"],
      ["security", "SYN.O"],
    ]);
    expect(trade.instruments[2]?.status).toBe("provider-local");
    const cash = sbiIdentity(
      input({
        kind: "balance",
        sourceAccount: "sbi-securities:foreign",
        currency: null,
        instrument: "USD",
        extra: { account: { accountKind: "SPECIFIC" } },
      }),
    );
    expect(cash.account.key).toEqual(["sbi-securities:foreign", "accountKind", "SPECIFIC"]);
    expect(cash.instruments).toHaveLength(1);
  });
  test("unknown identifiers stay unresolved without invented venue, RIC, or security", () => {
    const foreign = sbiIdentity(
      input({
        sourceAccount: "sbi-securities:foreign",
        market: null,
        currency: "USD",
        extra: { securities: { securitiesCode: "SYN", countryCode: "US" } },
      }),
    );
    expect(foreign.account.status).toBe("unresolved");
    expect(foreign.instruments.find((item) => item.role === "security")?.namespace).toBe(
      "sbi-security-code",
    );
    const missing = sbiIdentity(input({ securityCode: "", market: null }));
    expect(missing.issues).toContain("missing-security-identifier");
    expect(missing.instruments.some((item) => item.role === "security")).toBe(false);
    const aggregate = sbiIdentity(
      input({
        kind: "valuation",
        sourceAccount: "sbi-securities:account-assets",
        subject: "portfolio:summary:domestic",
      }),
    );
    expect(aggregate.account.status).toBe("aggregate");
    expect(aggregate.instruments.some((item) => item.role === "security")).toBe(false);
    expect(() => sbiIdentity(input({ sourceId: "other" }))).toThrow();
  });
});
