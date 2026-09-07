import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARSERS } from "../src/parsers/registry.ts";
import { smbcDirectBalance, smbcDirectTransactions } from "../src/parsers/smbc-direct.ts";
import type { ArtifactMeta } from "../src/types.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "smbc-direct-parser-boundaries");

function artifact(dataset: string, overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "smbc-bank",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-05T00:01:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

function fixture(name: string): Uint8Array {
  return readFileSync(join(FIXTURE_DIR, `${name}.json`));
}

function value(name: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture(name))) as Record<string, unknown>;
}

function encode(input: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(input));
}

describe("SMBC Direct canonical Layer-B routing", () => {
  test("routes only normalized JSON from the canonical source", () => {
    expect(PARSERS.filter((parser) => parser.accepts(artifact("balance-normalized")))).toEqual([
      smbcDirectBalance,
    ]);
    expect(PARSERS.filter((parser) => parser.accepts(artifact("transactions-normalized")))).toEqual(
      [smbcDirectTransactions],
    );
    expect(PARSERS.filter((parser) => parser.accepts(artifact("balance-raw")))).toEqual([]);
    expect(PARSERS.filter((parser) => parser.accepts(artifact("transactions-raw")))).toEqual([]);
    expect(
      PARSERS.filter((parser) =>
        parser.accepts(artifact("balance-normalized", { sourceId: "smbc-direct" })),
      ),
    ).toEqual([]);
    expect(
      PARSERS.filter((parser) =>
        parser.accepts(
          artifact("balance-normalized", {
            mime: "application/json; charset=utf-8",
          }),
        ),
      ),
    ).toEqual([]);
  });

  test("emits one exact JPY balance with normalized-to-raw lineage", () => {
    expect(
      smbcDirectBalance.parse(fixture("balance-normalized"), artifact("balance-normalized")),
    ).toEqual({
      observations: [
        {
          kind: "balance",
          sourceAccount: "smbc-bank:ordinary-yen",
          metric: "account_balance",
          amountMinor: 345678,
          amountText: "345678",
          amountScale: 0,
          instrument: "JPY",
          asOf: "2026-09-05T00:00:00.000Z",
          observedAt: "2026-09-05T00:00:00.000Z",
          rawLocator: "json:$",
          extra: {
            amount: 345678,
            currency: "JPY",
            observedAt: "2026-09-05T00:00:00.000Z",
            _kogane: {
              canonicalDataset: "balance-normalized",
              derivedFromDataset: "balance-raw",
              balanceScope: "ordinary_yen_account",
            },
          },
        },
      ],
      warnings: [],
    });
  });

  test("emits signed posted transactions and preserves row/range/totals", () => {
    const result = smbcDirectTransactions.parse(
      fixture("transactions-normalized"),
      artifact("transactions-normalized"),
    );
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(2);
    const transactions = result.observations.filter((row) => row.kind === "transaction");
    expect(transactions.map((row) => row.amountMinor)).toEqual([12000, -2300]);
    expect(transactions.map((row) => row.externalId)).toEqual([
      "synthetic-credit-001",
      "synthetic-debit-001",
    ]);
    expect(result.observations[1]).toMatchObject({
      kind: "transaction",
      sourceAccount: "smbc-bank:ordinary-yen",
      status: "posted",
      currency: "JPY",
      asOf: "2026-08-10T00:00:00+09:00",
      rawLocator: "json:$.transactions[1]",
      extra: {
        amount: 2300,
        balanceAfter: 333678,
        direction: "debit",
        range: { start: "2026-08-01", end: "2026-08-31" },
        depositsTotal: 12000,
        withdrawalsTotal: 2300,
        _kogane: { direction: "outflow", identityOrigin: "provider-id" },
      },
    });
  });

  test("rejects non-terminal, failed-evidence, and malformed balance artifacts", () => {
    for (const overrides of [
      { runStatus: "partial" as const, runFailureCount: 1 },
      { runStatus: "success" as const, runFailureCount: 1 },
    ]) {
      expect(() =>
        smbcDirectBalance.parse(
          fixture("balance-normalized"),
          artifact("balance-normalized", overrides),
        ),
      ).toThrow(/failure-free/u);
    }
    const unknown = value("balance-normalized");
    unknown["newField"] = true;
    expect(() => smbcDirectBalance.parse(encode(unknown), artifact("balance-normalized"))).toThrow(
      /schema drift/u,
    );
    const wrongCurrency = value("balance-normalized");
    wrongCurrency["currency"] = "USD";
    expect(() =>
      smbcDirectBalance.parse(encode(wrongCurrency), artifact("balance-normalized")),
    ).toThrow(/JPY/u);
    const invalidInstant = value("balance-normalized");
    invalidInstant["observedAt"] = "2026-09-05T00:00:00Z";
    expect(() =>
      smbcDirectBalance.parse(encode(invalidInstant), artifact("balance-normalized")),
    ).toThrow(/canonical UTC/u);
  });

  test("rejects transaction schema, calendar, range, order, identity, and totals drift", () => {
    const mutations: ((input: Record<string, unknown>) => void)[] = [
      (input) => {
        input["unexpected"] = true;
      },
      (input) => {
        (input["range"] as Record<string, unknown>)["start"] = "2026-02-30";
      },
      (input) => {
        ((input["transactions"] as Record<string, unknown>[])[0] ?? {})["date"] =
          "2026-09-01T00:00:00+09:00";
      },
      (input) => {
        (input["transactions"] as unknown[]).reverse();
      },
      (input) => {
        const rows = input["transactions"] as Record<string, unknown>[];
        rows[1]!["id"] = rows[0]!["id"];
      },
      (input) => {
        input["withdrawalsTotal"] = 2299;
      },
      (input) => {
        ((input["transactions"] as Record<string, unknown>[])[0] ?? {})["amount"] = -1;
      },
      (input) => {
        ((input["transactions"] as Record<string, unknown>[])[0] ?? {})["newField"] = true;
      },
    ];
    for (const mutate of mutations) {
      const input = value("transactions-normalized");
      mutate(input);
      expect(() =>
        smbcDirectTransactions.parse(encode(input), artifact("transactions-normalized")),
      ).toThrow();
    }
  });

  test("accepts an exact empty monthly statement", () => {
    const input = value("transactions-normalized");
    input["transactions"] = [];
    input["depositsTotal"] = 0;
    input["withdrawalsTotal"] = 0;
    expect(
      smbcDirectTransactions.parse(encode(input), artifact("transactions-normalized")),
    ).toEqual({
      observations: [],
      warnings: [],
    });
  });
});
