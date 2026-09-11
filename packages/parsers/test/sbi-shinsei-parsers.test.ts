import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PARSERS } from "../src/parsers/registry.ts";
import { sbiShinseiTopBalancesAndActivity } from "../src/parsers/sbi-shinsei-top-balances-and-activity.ts";
import { sbiShinseiYenDepositAccount } from "../src/parsers/sbi-shinsei-yen-deposit-account.ts";
import type { ArtifactMeta, Parser } from "../src/types.ts";

const ROOT = new URL(
  "../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/",
  import.meta.url,
);
function artifact(dataset: string, sourceId = "sbi-shinsei-bank"): ArtifactMeta {
  return {
    id: 1,
    sourceId,
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:02:00.000Z",
    sha256: "0".repeat(64),
  };
}
function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`${name}.json`, ROOT));
}
function value(name: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture(name))) as Record<string, unknown>;
}
function encode(input: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(input));
}
function parserFor(dataset: string): Parser {
  const matches = PARSERS.filter((parser) => parser.accepts(artifact(dataset)));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("SBI Shinsei parser routing", () => {
  test("routes only the two source artifacts with verified observation semantics", () => {
    expect(parserFor("top-accounts-balance-and-activity")).toBe(sbiShinseiTopBalancesAndActivity);
    expect(parserFor("yen-deposit-account")).toBe(sbiShinseiYenDepositAccount);
    for (const dataset of [
      "balance-summary-and-stage",
      "exchange-rate",
      "normalized",
      "collector-manifest",
    ]) {
      expect(PARSERS.filter((parser) => parser.accepts(artifact(dataset)))).toEqual([]);
    }
    expect(
      PARSERS.filter((parser) => parser.accepts(artifact("yen-deposit-account", "sbi-shinsei"))),
    ).toEqual([]);
    for (const mime of ["application/json; charset=utf-8", "text/json", "APPLICATION/JSON"]) {
      expect(
        PARSERS.filter((parser) => parser.accepts({ ...artifact("yen-deposit-account"), mime })),
      ).toEqual([]);
    }
  });

  test("direct calls reject non-success and failure-bearing parent runs", () => {
    for (const meta of [
      {
        ...artifact("top-accounts-balance-and-activity"),
        runStatus: "partial" as const,
        runFailureCount: 1,
      },
      {
        ...artifact("top-accounts-balance-and-activity"),
        runStatus: "failed" as const,
        runFailureCount: 1,
      },
      { ...artifact("top-accounts-balance-and-activity"), runFailureCount: 1 },
    ]) {
      expect(() =>
        sbiShinseiTopBalancesAndActivity.parse(fixture("top-accounts-balance-and-activity"), meta),
      ).toThrow(/successful failure-free/u);
    }
  });
});

describe("SBI Shinsei top balances and activity", () => {
  test("preserves source separation, exact values, provider identity, and debit/credit sign provenance", () => {
    const result = sbiShinseiTopBalancesAndActivity.parse(
      fixture("top-accounts-balance-and-activity"),
      artifact("top-accounts-balance-and-activity"),
    );
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(7);
    expect(result.observations.map((entry) => entry.kind)).toEqual([
      "balance",
      "valuation",
      "balance",
      "valuation",
      "balance",
      "transaction",
      "transaction",
    ]);
    const foreign = result.observations[2]!;
    expect(foreign).toMatchObject({
      kind: "balance",
      amountMinor: 1234,
      amountText: "12.3400",
      amountScale: 4,
      instrument: "USD",
    });
    const debit = result.observations[5]!;
    expect(debit).toMatchObject({
      kind: "transaction",
      externalId: "SYNTHETIC-TXN-001",
      amountMinor: -1200,
      amountText: "-1200",
      asOf: "2026-09-06",
    });
    expect((debit.extra["_kogane"] as Record<string, unknown>)["amountSignSource"]).toBe("debit");
    expect(debit.extra["balance"]).toBe("122256");
  });

  test("fails closed on schema, identity, side, decimal, and cardinality drift", () => {
    const mutations: ((input: Record<string, unknown>) => void)[] = [
      (input) => {
        input["unknown"] = true;
      },
      (input) => {
        (
          (input["responseParam"] as Record<string, unknown>)["overview"] as Record<string, unknown>
        )["responseParam"] = {
          savingsDetails: Array.from({ length: 101 }, () => ({
            accountNo: "X",
            balance: "0",
            currency: "JPY",
            productCode: "601",
          })),
        };
      },
      (input) => {
        const rows = (
          (
            (input["responseParam"] as Record<string, unknown>)["activity"] as Record<
              string,
              unknown
            >
          )["responseParam"] as Record<string, unknown>
        )["activityDetails"] as Record<string, unknown>[];
        rows[0]!["credit"] = "1";
      },
      (input) => {
        const rows = (
          (
            (input["responseParam"] as Record<string, unknown>)["activity"] as Record<
              string,
              unknown
            >
          )["responseParam"] as Record<string, unknown>
        )["activityDetails"] as Record<string, unknown>[];
        rows[0]!["debit"] = "1.5";
      },
      (input) => {
        const rows = (
          (
            (input["responseParam"] as Record<string, unknown>)["activity"] as Record<
              string,
              unknown
            >
          )["responseParam"] as Record<string, unknown>
        )["activityDetails"] as Record<string, unknown>[];
        rows[1]!["txnReferenceNo"] = rows[0]!["txnReferenceNo"];
      },
    ];
    for (const mutate of mutations) {
      const input = value("top-accounts-balance-and-activity");
      mutate(input);
      expect(() =>
        sbiShinseiTopBalancesAndActivity.parse(
          encode(input),
          artifact("top-accounts-balance-and-activity"),
        ),
      ).toThrow();
    }
  });

  test("fails closed on successful wrappers carrying provider errors", () => {
    for (const errorInfo of [{ statusID: "E001" }, { statusMessage: "synthetic failure" }]) {
      const input = value("top-accounts-balance-and-activity");
      const response = input["responseParam"] as Record<string, unknown>;
      (response["overview"] as Record<string, unknown>)["errorInfo"] = errorInfo;
      expect(() =>
        sbiShinseiTopBalancesAndActivity.parse(
          encode(input),
          artifact("top-accounts-balance-and-activity"),
        ),
      ).toThrow(/successful wrapper contains an error/u);
    }
  });

  test("requires exact Layer A currency codes and preserves valid unknown currency decimals", () => {
    for (const invalidCurrency of ["JP1", "USDX", "jpy", "JP"]) {
      const input = value("top-accounts-balance-and-activity");
      const rows = topSavings(input);
      rows[0]!["currency"] = invalidCurrency;
      expect(() =>
        sbiShinseiTopBalancesAndActivity.parse(
          encode(input),
          artifact("top-accounts-balance-and-activity"),
        ),
      ).toThrow(/invalid provider currency/u);
    }
    const unknown = value("top-accounts-balance-and-activity");
    const row = topSavings(unknown)[0]!;
    row["currency"] = "ZZZ";
    row["balance"] = "1.2345";
    row["yenEqui"] = null;
    const result = sbiShinseiTopBalancesAndActivity.parse(
      encode(unknown),
      artifact("top-accounts-balance-and-activity"),
    );
    expect(result.observations[0]).toMatchObject({
      kind: "balance",
      instrument: "ZZZ",
      amountText: "1.2345",
      amountScale: 4,
    });
    expect(result.observations[0]).not.toHaveProperty("amountMinor");
  });

  test("rejects normalized-looking provider timestamps that are not exact calendar instants", () => {
    for (const invalidTimestamp of ["20260230090000", "20260907240000", "20260907096000"]) {
      const input = value("top-accounts-balance-and-activity");
      (input["responseParam"] as Record<string, unknown>)["systemResponseTime"] = invalidTimestamp;
      expect(() =>
        sbiShinseiTopBalancesAndActivity.parse(
          encode(input),
          artifact("top-accounts-balance-and-activity"),
        ),
      ).toThrow(/provider timestamp is invalid/u);
    }
  });

  test("validates the declared activity window and preserves unmodelled balance context", () => {
    const valid = value("top-accounts-balance-and-activity");
    const response = valid["responseParam"] as Record<string, unknown>;
    const overview = (response["overview"] as Record<string, unknown>)["responseParam"] as Record<
      string,
      unknown
    >;
    overview["totalCreditBalance"] = "SYNTHETIC-AGGREGATE";
    const parsed = sbiShinseiTopBalancesAndActivity.parse(
      encode(valid),
      artifact("top-accounts-balance-and-activity"),
    );
    const overviewBalance = parsed.observations[0]!;
    expect(
      (overviewBalance.extra["_kogane"] as Record<string, unknown>)["providerContext"],
    ).toMatchObject({ totalCreditBalance: "SYNTHETIC-AGGREGATE" });
    const transaction = parsed.observations.find((entry) => entry.kind === "transaction")!;
    expect(transaction.extra).toHaveProperty("balance");
    expect((transaction.extra["_kogane"] as Record<string, unknown>)["rowBalanceDisposition"]).toBe(
      "preserved_provider_value_semantics_unverified",
    );

    const mutations: ((activity: Record<string, unknown>) => void)[] = [
      (activity) => {
        activity["fromDate"] = "20260230";
      },
      (activity) => {
        activity["fromDate"] = "20260908";
      },
      (activity) => {
        activity["toDate"] = "";
      },
      (activity) => {
        (activity["activityDetails"] as Record<string, unknown>[])[0]!["postingDate"] = "20260831";
      },
    ];
    for (const mutate of mutations) {
      const input = value("top-accounts-balance-and-activity");
      mutate(topActivity(input));
      expect(() =>
        sbiShinseiTopBalancesAndActivity.parse(
          encode(input),
          artifact("top-accounts-balance-and-activity"),
        ),
      ).toThrow();
    }
  });
});

describe("SBI Shinsei yen deposit", () => {
  test("emits independent account and savings views without inventing product classification", () => {
    const result = sbiShinseiYenDepositAccount.parse(
      fixture("yen-deposit-account"),
      artifact("yen-deposit-account"),
    );
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(2);
    expect(
      result.observations.map((entry) => (entry.kind === "balance" ? entry.metric : "")),
    ).toEqual(["yen_deposit_account_balance", "yen_deposit_savings_balance"]);
    const first = result.observations[0]!;
    expect((first.extra["_kogane"] as Record<string, unknown>)["productCode"]).toBe("601");
  });

  test("fails closed on unknown rows and unsupported non-empty detail arrays", () => {
    const unknown = value("yen-deposit-account");
    ((
      (unknown["responseParam"] as Record<string, unknown>)["debitAccountDetails"] as Record<
        string,
        unknown
      >[]
    )[0] ?? {})["newField"] = "drift";
    expect(() =>
      sbiShinseiYenDepositAccount.parse(encode(unknown), artifact("yen-deposit-account")),
    ).toThrow(/unknown field/u);
    const unsupported = value("yen-deposit-account");
    (unsupported["responseParam"] as Record<string, unknown>)["tdDetails"] = [{}];
    expect(() =>
      sbiShinseiYenDepositAccount.parse(encode(unsupported), artifact("yen-deposit-account")),
    ).toThrow(/cardinality/u);
  });

  test("validates the exact merged Layer A product-detail tree", () => {
    const valid = value("yen-deposit-account");
    const product = yenProduct(valid);
    product["tdProductDetail"] = {
      productCode: "SYNTHETIC-TD",
      currency: "JPY",
      customerCategoryDetails: [
        {
          customerCategory: "SYNTHETIC",
          term: [{ months: "12", days: "0", interest: "0.01" }],
        },
      ],
    };
    expect(() =>
      sbiShinseiYenDepositAccount.parse(encode(valid), artifact("yen-deposit-account")),
    ).not.toThrow();

    const mutations: ((product: Record<string, unknown>) => void)[] = [
      (row) => {
        row["pdProductDetail"] = { unknown: true };
      },
      (row) => {
        row["tdProductDetail"] = { unknown: true };
      },
      (row) => {
        row["tdProductDetail"] = {
          customerCategoryDetails: [
            {
              customerCategory: "SYNTHETIC",
              term: [{ months: "1", days: "0", interest: "0", unknown: true }],
            },
          ],
        };
      },
    ];
    for (const mutate of mutations) {
      const input = value("yen-deposit-account");
      mutate(yenProduct(input));
      expect(() =>
        sbiShinseiYenDepositAccount.parse(encode(input), artifact("yen-deposit-account")),
      ).toThrow(/unknown field/u);
    }
  });

  test("rejects invalid transactionTime calendar components", () => {
    const input = value("yen-deposit-account");
    (input["responseParam"] as Record<string, unknown>)["transactionTime"] = "20260230090100";
    expect(() =>
      sbiShinseiYenDepositAccount.parse(encode(input), artifact("yen-deposit-account")),
    ).toThrow(/provider timestamp is invalid/u);
  });

  test("preserves validated product, module, and detail sections as provider context", () => {
    const result = sbiShinseiYenDepositAccount.parse(
      fixture("yen-deposit-account"),
      artifact("yen-deposit-account"),
    );
    const kogane = result.observations[0]!.extra["_kogane"] as Record<string, unknown>;
    const context = kogane["providerContext"] as Record<string, unknown>;
    expect(context["productDetails"]).toBeArray();
    expect(context["moduleDetails"]).toBeArray();
    expect(context["tdDetails"]).toEqual([]);
    expect(kogane["preservedContextSections"]).toEqual([
      "productDetails",
      "moduleDetails",
      "tdDetails",
      "sdDetails",
      "debuntureDetails",
      "loanDetails",
    ]);
  });
});

function topSavings(input: Record<string, unknown>): Record<string, unknown>[] {
  const response = input["responseParam"] as Record<string, unknown>;
  const overview = response["overview"] as Record<string, unknown>;
  const detail = overview["responseParam"] as Record<string, unknown>;
  return detail["savingsDetails"] as Record<string, unknown>[];
}

function yenProduct(input: Record<string, unknown>): Record<string, unknown> {
  const response = input["responseParam"] as Record<string, unknown>;
  return (response["productDetails"] as Record<string, unknown>[])[0]!;
}

function topActivity(input: Record<string, unknown>): Record<string, unknown> {
  const response = input["responseParam"] as Record<string, unknown>;
  const activity = response["activity"] as Record<string, unknown>;
  return activity["responseParam"] as Record<string, unknown>;
}
