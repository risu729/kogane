import { describe, expect, test } from "bun:test";
import { parseStGeorgeSnapshot, type StGeorgeSnapshot } from "../src/st-george-contract.ts";
import { stGeorgeBalances, stGeorgeTransactions } from "../src/parsers/st-george.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import type { ArtifactMeta } from "../src/types.ts";

const meta = (overrides: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  id: 1,
  sourceId: "st-george",
  runStatus: "success",
  runFailureCount: 0,
  dataset: "account-snapshot",
  artifactKey: "account-snapshot.json",
  url: null,
  mime: "application/json",
  fetchedAt: "2026-09-13T00:00:00Z",
  sha256: "0".repeat(64),
  ...overrides,
});
const snapshot = (): StGeorgeSnapshot => ({
  schema: "st-george-browser-v1",
  observedAt: "2026-09-13T00:00:00Z",
  currency: "AUD",
  currencyEvidence: "source-configured",
  accounts: [
    {
      accountKey: "a".repeat(64),
      label: "Synthetic account",
      currentBalanceText: "$1,234.56",
      availableBalanceText: "1,200.00",
      openingBalanceText: "1,246.90",
      closingBalanceText: "1,234.56",
      historyState: "observed",
      pendingState: "unknown",
      transactions: [
        {
          dateText: "12/09/2026",
          description: "Synthetic purchase",
          category: "Other",
          debitText: "12.34",
          creditText: "",
          balanceText: "1,234.56",
        },
      ],
    },
  ],
});
const bytes = (value: unknown = snapshot()) => new TextEncoder().encode(JSON.stringify(value));

describe("St.George provider projection contract", () => {
  test("validates immutable projection with no extra secret fields", () => {
    expect(parseStGeorgeSnapshot(snapshot())).toEqual(snapshot());
    expect(() => parseStGeorgeSnapshot({ ...snapshot(), cookie: "synthetic-secret" })).toThrow(
      "invalid-st-george-snapshot",
    );
    expect(() => parseStGeorgeSnapshot({ ...snapshot(), accounts: [] })).toThrow();
  });
  test("rejects duplicate/redacted-incomplete account identities", () => {
    const input = snapshot();
    input.accounts.push({ ...input.accounts[0]! });
    expect(() => parseStGeorgeSnapshot(input)).toThrow();
    input.accounts[0]!.accountKey = "index:0";
    expect(() => parseStGeorgeSnapshot(input)).toThrow();
  });
  test("rejects impossible dates including UTC rollover timestamps", () => {
    for (const observedAt of [
      "2026-02-30T00:00:00Z",
      "2026-09-13T24:00:00Z",
      "2026-09-13T00:00:00+00:00",
    ]) {
      expect(() => parseStGeorgeSnapshot({ ...snapshot(), observedAt })).toThrow();
    }
    const input = snapshot();
    input.accounts[0]!.transactions[0]!.dateText = "31/02/2026";
    expect(() => parseStGeorgeSnapshot(input)).toThrow();
  });
  test("rejects malformed amount grouping, ambiguous sign and overflow", () => {
    for (const debitText of ["1,23.00", "12", "-12.34", "900719925474099.99"]) {
      const input = snapshot();
      input.accounts[0]!.transactions[0]!.debitText = debitText;
      expect(() => parseStGeorgeSnapshot(input)).toThrow();
    }
    const input = snapshot();
    input.accounts[0]!.transactions[0]!.creditText = "1.00";
    expect(() => parseStGeorgeSnapshot(input)).toThrow();
  });
});

describe("St.George downstream parsers", () => {
  test("registers separate complete balance and partial transaction projections", () => {
    expect(PARSERS.filter((parser) => parser.accepts(meta()))).toEqual([
      stGeorgeBalances,
      stGeorgeTransactions,
    ]);
    expect(stGeorgeBalances.accepts(meta({ sourceId: "other" }))).toBe(false);
    expect(stGeorgeTransactions.accepts(meta({ artifactKey: "other.json" }))).toBe(false);
  });
  test("balances are eligible complete membership despite unknown pending/history scope", () => {
    const parsed = stGeorgeBalances.parse(bytes(), meta());
    expect(
      parsed.observations.map((row) => (row.kind === "balance" ? row.amountMinor : null)),
    ).toEqual([123456, 120000]);
    expect(parsed.observations.map((row) => row.sourceAccount)).toEqual([
      "st-george:" + "a".repeat(64),
      "st-george:" + "a".repeat(64),
    ]);
    expect(parsed.coverage?.[0]).toMatchObject({
      mode: "complete-container",
      completeness: "complete",
      membershipComplete: true,
      observedCount: 2,
    });
  });
  test("transactions retain direction/date/raw text with explicit derived identity and no posted status", () => {
    const parsed = stGeorgeTransactions.parse(bytes(), meta());
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0]).toMatchObject({
      kind: "transaction",
      amountMinor: -1234,
      amountText: "-12.34",
      amountScale: 2,
      currency: "AUD",
      asOf: "2026-09-12",
      description: "Synthetic purchase",
    });
    expect(parsed.observations[0]).toHaveProperty("externalId");
    expect(parsed.observations[0]?.extra).toMatchObject({
      _kogane: { identityOrigin: "derived-normalized-row+occurrence" },
    });
    expect(parsed.observations[0]).not.toHaveProperty("status");
    expect(parsed.coverage?.[0]).toMatchObject({
      mode: "evidence-only",
      completeness: "partial",
      membershipComplete: false,
    });
    expect(stGeorgeTransactions.parse(bytes(), meta())).toEqual(parsed);
  });
  test("identical legitimate rows get distinct occurrence identities stable across repeated captures", () => {
    const input = snapshot();
    input.accounts[0]!.transactions.push({ ...input.accounts[0]!.transactions[0]! });
    const first = stGeorgeTransactions.parse(bytes(input), meta()).observations;
    const second = stGeorgeTransactions.parse(
      bytes({ ...input, observedAt: "2026-09-13T01:00:00Z" }),
      meta(),
    ).observations;
    const ids = (rows: typeof first) =>
      rows.map((row) => (row.kind === "transaction" ? row.externalId : undefined));
    expect(new Set(ids(first)).size).toBe(2);
    expect(ids(first)).toEqual(ids(second));
  });
  test("zero debit and zero credit have distinct derived identities", () => {
    const debit = snapshot();
    debit.accounts[0]!.transactions[0]!.debitText = "0.00";
    const credit = structuredClone(debit);
    Object.assign(credit.accounts[0]!.transactions[0]!, { debitText: "", creditText: "0.00" });
    const debitRow = stGeorgeTransactions.parse(bytes(debit), meta()).observations[0]!;
    const creditRow = stGeorgeTransactions.parse(bytes(credit), meta()).observations[0]!;
    expect(debitRow.kind === "transaction" ? debitRow.externalId : null).not.toBe(
      creditRow.kind === "transaction" ? creditRow.externalId : null,
    );
  });
  test("unknown history does not become complete-empty and does not drop balances", () => {
    const input = snapshot();
    Object.assign(input.accounts[0]!, {
      historyState: "unknown",
      transactions: [],
      openingBalanceText: null,
      closingBalanceText: null,
    });
    expect(stGeorgeBalances.parse(bytes(input), meta()).observations).toHaveLength(2);
    const parsed = stGeorgeTransactions.parse(bytes(input), meta());
    expect(parsed.observations).toHaveLength(0);
    expect(parsed.coverage?.[0]).toMatchObject({
      completeness: "partial",
      absenceMeaning: "unknown",
    });
  });
  test("failed acquisition cannot publish a valid-looking projection", () => {
    expect(() => stGeorgeBalances.parse(bytes(), meta({ runStatus: "failed" }))).toThrow(
      "invalid-st-george-artifact",
    );
    expect(() => stGeorgeTransactions.parse(bytes(), meta({ runFailureCount: 1 }))).toThrow(
      "invalid-st-george-artifact",
    );
  });
  test("malformed raw JSON cannot appear in parser error text", () => {
    expect(() =>
      stGeorgeBalances.parse(new TextEncoder().encode('{"private":"SYNTHETIC_SECRET'), meta()),
    ).toThrow("invalid-st-george-snapshot");
  });
});
