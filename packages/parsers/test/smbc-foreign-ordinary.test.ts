import { expect, test } from "bun:test";
import {
  smbcForeignOrdinaryBalance,
  smbcForeignOrdinaryHistory,
} from "../src/parsers/smbc-foreign-ordinary.ts";
import type { ArtifactMeta } from "../src/types.ts";

const BALANCE = {
  currency: "AUD",
  amount: "123.45",
  yenEquivalent: "12000",
  referenceRate: "97.205",
  observedAt: "2099-04-02T01:00:00.000Z",
};
const HISTORY = {
  currency: "AUD",
  range: { start: "2099-01-01", end: "2099-01-31" },
  emptyCode: "PC-AIFDDT1-00134-E",
  transactions: [],
};
function artifact(balance = true): ArtifactMeta {
  return {
    id: 1,
    sourceId: "smbc-bank",
    runStatus: "success",
    runFailureCount: 0,
    dataset: balance ? "foreign-ordinary-aud-balance" : "foreign-ordinary-aud-history",
    artifactKey: balance
      ? "foreign-ordinary-aud/balance.json"
      : "foreign-ordinary-aud/history/20990101-20990131.json",
    fetchUnitKey: balance ? "foreign-ordinary-aud-balance" : "foreign-ordinary-aud-history",
    mime: "application/json",
    url: null,
    fetchedAt: "2099-04-02T01:00:00.000Z",
    sha256: "0".repeat(64),
  };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("the AUD balance stays exact and its current quote never becomes a transaction rate or another balance", () => {
  const result = smbcForeignOrdinaryBalance.parse(bytes(BALANCE), artifact());
  expect(result.observations).toHaveLength(1);
  expect(result.observations[0]).toMatchObject({
    kind: "balance",
    metric: "account_balance",
    instrument: "AUD",
    amountMinor: 12345,
    amountText: "123.45",
    amountScale: 2,
    extra: {
      yenEquivalent: "12000",
      referenceRate: "97.205",
      _kogane: { rateMeaning: "current_reference_foreign_to_yen" },
    },
  });
  expect(result.coverage?.[0]).toMatchObject({ completeness: "complete", observedCount: 1 });
});

test("only the observed explicit-empty history proves no movements", () => {
  const result = smbcForeignOrdinaryHistory.parse(bytes(HISTORY), artifact(false));
  expect(result.observations).toEqual([]);
  expect(result.coverage?.[0]).toMatchObject({
    completeness: "complete",
    absenceMeaning: "complete-empty",
    observedCount: 0,
    expectedCount: 0,
  });
  for (const changed of [
    { ...HISTORY, transactions: [{}] },
    { ...HISTORY, emptyCode: "unexpected" },
    { ...HISTORY, accountNo: "0012345" },
  ])
    expect(() => smbcForeignOrdinaryHistory.parse(bytes(changed), artifact(false))).toThrow();
});

test("unsupported currencies, drift, inexact cents and incomplete runs never publish balances", () => {
  for (const changed of [
    { ...BALANCE, currency: "USD" },
    { ...BALANCE, amount: "0.001" },
    { ...BALANCE, cookie: "synthetic-secret" },
    { ...BALANCE, observedAt: "2099-04-31T01:00:00.000Z" },
  ])
    expect(() => smbcForeignOrdinaryBalance.parse(bytes(changed), artifact())).toThrow();
  expect(() =>
    smbcForeignOrdinaryBalance.parse(bytes(BALANCE), { ...artifact(), runStatus: "partial" }),
  ).toThrow();
  expect(smbcForeignOrdinaryBalance.accepts({ ...artifact(), sourceId: "smbc-direct" })).toBe(
    false,
  );
  expect(
    smbcForeignOrdinaryBalance.accepts({ ...artifact(), artifactKey: "balance.normalized.json" }),
  ).toBe(false);
  expect(smbcForeignOrdinaryBalance.accepts({ ...artifact(), dataset: null })).toBe(false);
  expect(
    smbcForeignOrdinaryBalance.parse(bytes(BALANCE), {
      ...artifact(),
      runStatus: "partial",
      runFailureCount: 1,
      unitScopeEligibility: "unit-independent-v1",
    }).observations,
  ).toHaveLength(1);
});
