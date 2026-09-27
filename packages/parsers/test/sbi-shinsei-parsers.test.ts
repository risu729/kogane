import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PARSERS } from "../src/parsers/registry.ts";
import { sbiShinseiExchangeRate } from "../src/parsers/sbi-shinsei-exchange-rate.ts";
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
  test("routes only the three source artifacts with verified observation semantics", () => {
    expect(parserFor("top-accounts-balance-and-activity")).toBe(sbiShinseiTopBalancesAndActivity);
    expect(parserFor("yen-deposit-account")).toBe(sbiShinseiYenDepositAccount);
    expect(parserFor("exchange-rate")).toBe(sbiShinseiExchangeRate);
    for (const dataset of ["balance-summary-and-stage", "normalized", "collector-manifest"]) {
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
        // An end without a start is a shape nobody has observed.
        activity["fromDate"] = "";
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

describe("SBI Shinsei activity window whose end is not stated (0.1.2)", () => {
  // The stored captures' shape (ADR 0028, observed 2026-09-27): `fromDate` in
  // `YYYY/MM/DD`, `toDate` an empty string, ten rows each with one side.
  const stored = () => value("top-accounts-balance-and-activity-window-end-not-stated");
  const parse = (input: unknown) =>
    sbiShinseiTopBalancesAndActivity.parse(
      encode(input),
      artifact("top-accounts-balance-and-activity"),
    );

  test("the stored shape parses; every activity observation records the end as not stated", () => {
    const result = sbiShinseiTopBalancesAndActivity.parse(
      fixture("top-accounts-balance-and-activity-window-end-not-stated"),
      artifact("top-accounts-balance-and-activity"),
    );
    expect(result.warnings).toEqual([]);
    expect(result.issues).toEqual([]);
    const transactions = result.observations.filter((entry) => entry.kind === "transaction");
    expect(transactions).toHaveLength(10);
    // `compactDate` reads the slash form of a posting date.
    expect(transactions.map((entry) => entry.asOf)).toEqual(
      Array.from({ length: 10 }, (_, index) => `2026-05-${String(index + 2).padStart(2, "0")}`),
    );
    const activity = result.observations.filter(
      (entry) =>
        (entry.extra["_kogane"] as Record<string, unknown>)["sourceView"] === "top_activity",
    );
    expect(activity).toHaveLength(11);
    for (const entry of activity)
      expect((entry.extra["_kogane"] as Record<string, unknown>)["activityWindowEnd"]).toBe(
        "not-stated",
      );
    // The overview is not about the window and carries no marker; no end date
    // is invented anywhere.
    for (const entry of result.observations.filter((row) => !activity.includes(row)))
      expect(entry.extra["_kogane"] as Record<string, unknown>).not.toHaveProperty(
        "activityWindowEnd",
      );
    expect(JSON.stringify(result)).not.toMatch(/toDate":"\d/u);
    expect(result.coverage?.[0]).toMatchObject({ completeness: "complete", observedCount: 13 });
  });

  test("a stated window records no marker and keeps both bounds", () => {
    const result = sbiShinseiTopBalancesAndActivity.parse(
      fixture("top-accounts-balance-and-activity"),
      artifact("top-accounts-balance-and-activity"),
    );
    for (const entry of result.observations)
      expect(entry.extra["_kogane"] as Record<string, unknown>).not.toHaveProperty(
        "activityWindowEnd",
      );
    const late = value("top-accounts-balance-and-activity");
    (topActivity(late)["activityDetails"] as Record<string, unknown>[])[0]!["postingDate"] =
      "20260908";
    expect(() => parse(late)).toThrow(/outside declared activity window/u);
  });

  test("the start still bounds every posting date; a later date is accepted, not bounded", () => {
    const early = stored();
    (topActivity(early)["activityDetails"] as Record<string, unknown>[])[0]!["postingDate"] =
      "2026/04/30";
    expect(() => parse(early)).toThrow(/outside declared activity window/u);
    const late = stored();
    (topActivity(late)["activityDetails"] as Record<string, unknown>[])[9]!["postingDate"] =
      "2026/12/31";
    expect(parse(late).observations.filter((entry) => entry.kind === "transaction")).toHaveLength(
      10,
    );
  });

  test("an unstated start, a malformed start and one-sided rows stay refused", () => {
    for (const mutate of [
      (activity: Record<string, unknown>) => {
        activity["fromDate"] = "";
      },
      (activity: Record<string, unknown>) => {
        activity["fromDate"] = "2026/02/30";
      },
      (activity: Record<string, unknown>) => {
        activity["toDate"] = null;
        activity["fromDate"] = null;
      },
      (activity: Record<string, unknown>) => {
        const row = (activity["activityDetails"] as Record<string, unknown>[])[0]!;
        row["credit"] = "1";
      },
      // Only an empty-string end was observed; an absent or null end beside a
      // stated start is not read as "not stated".
      (activity: Record<string, unknown>) => {
        delete activity["toDate"];
      },
      (activity: Record<string, unknown>) => {
        activity["toDate"] = null;
      },
    ]) {
      const input = stored();
      mutate(topActivity(input));
      expect(() => parse(input)).toThrow();
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

describe("SBI Shinsei exchange-rate board", () => {
  test("parser version 1.0.2 accepts the stored boards' observed shape", () => {
    expect(sbiShinseiExchangeRate.version).toBe("1.0.2");
  });

  const board = () => value("exchange-rate");
  const information = (input: Record<string, unknown>): Record<string, unknown> => {
    const response = input["responseParam"] as Record<string, unknown>;
    const wrapped = response["exchangeRateInformation"] as Record<string, unknown>;
    return wrapped["responseParam"] as Record<string, unknown>;
  };
  const rows = (input: Record<string, unknown>) =>
    information(input)["exchangeRates"] as Record<string, unknown>[];
  const parse = (input: unknown) =>
    sbiShinseiExchangeRate.parse(encode(input), artifact("exchange-rate"));
  const at = "2026-09-07T09:01:00+09:00";

  test("each row gives buy, sell and mid rates as exact JPY text at the provider's time", () => {
    const result = sbiShinseiExchangeRate.parse(
      fixture("exchange-rate"),
      artifact("exchange-rate"),
    );
    expect(
      result.observations.map((row) =>
        row.kind === "valuation"
          ? [row.sourceAccount, row.subject, row.metric, row.amountText, row.currency, row.asOf]
          : null,
      ),
    ).toEqual([
      ["sbi-shinsei:fx-board", "USD", "bank_buy_rate", "145.00", "JPY", at],
      ["sbi-shinsei:fx-board", "USD", "bank_sell_rate", "147.00", "JPY", at],
      ["sbi-shinsei:fx-board", "USD", "bank_mid_rate", "146.00", "JPY", at],
      ["sbi-shinsei:fx-board", "EUR", "bank_buy_rate", "160.25", "JPY", at],
      ["sbi-shinsei:fx-board", "EUR", "bank_sell_rate", "162.75", "JPY", at],
      ["sbi-shinsei:fx-board", "EUR", "bank_mid_rate", "161.5", "JPY", at],
    ]);
    // A rate is a quote, not money: no minor-unit amount is written for it.
    for (const row of result.observations) expect(row).not.toHaveProperty("amountMinor");
    // The payload states no base quantity, and the parser never infers one.
    expect(
      result.observations.every(
        (row) =>
          (row.extra["_kogane"] as Record<string, unknown>)["quoteBasis"] === "not-stated" &&
          row.extra["customerCategory"] === "SYNTHETIC",
      ),
    ).toBe(true);
    expect(result.coverage).toEqual([
      expect.objectContaining({
        scopeKey: "sbi-shinsei-bank/exchange-rate",
        completeness: "complete",
        observedCount: 6,
        expectedCount: 6,
      }),
    ]);
  });

  test("without transactionTime the observations carry no provider time", () => {
    const input = board();
    delete information(input)["transactionTime"];
    const result = parse(input);
    expect(result.observations).toHaveLength(6);
    for (const row of result.observations) expect(row).not.toHaveProperty("asOf");
  });

  test("an unknown field at any level fails like the collector's validator", () => {
    const top = board();
    (top["responseParam"] as Record<string, unknown>)["extra"] = 1;
    expect(() => parse(top)).toThrow(/unknown field extra/u);
    const inner = board();
    information(inner)["extra"] = 1;
    expect(() => parse(inner)).toThrow(/unknown field extra/u);
    const row = board();
    rows(row)[0]!["extra"] = 1;
    expect(() => parse(row)).toThrow(/unknown field extra/u);
    const missing = board();
    delete rows(missing)[0]!["midRate"];
    expect(() => parse(missing)).toThrow(/missing field midRate/u);
    const header = board();
    header["header"] = { adapterResultCode: "1" };
    expect(() => parse(header)).toThrow(/not successful/u);
    // The collector admits a rotated token in the root header, and so does the parser.
    const token = board();
    token["header"] = { adapterResultCode: "0", newToken: "synthetic" };
    expect(parse(token).observations).toHaveLength(6);
  });

  test("an empty board is refused rather than replacing the last one", () => {
    const input = board();
    information(input)["exchangeRates"] = [];
    expect(() => parse(input)).toThrow(/board is empty/u);
  });

  test("a per-100 quote is refused: the board has no field that could state one", () => {
    // A unit marker is a shape nobody has observed; it fails the artifact
    // instead of being read as a basis, and no rate is ever rescaled.
    for (const field of ["unit", "quoteUnit", "per"]) {
      const input = board();
      rows(input)[0]![field] = "100";
      expect(() => parse(input)).toThrow(new RegExp(`unknown field ${field}`, "u"));
    }
  });

  test("a duplicate (currency, tier) or an unreadable cell is never guessed through", () => {
    const duplicate = board();
    rows(duplicate)[1]!["currency"] = "USD";
    expect(() => parse(duplicate)).toThrow(/lists USD twice in one customerCategory/u);
    // Without a category the currency alone is the identity, as in 1.0.0.
    const untiered = board();
    for (const row of rows(untiered)) delete row["customerCategory"];
    rows(untiered)[1]!["currency"] = "USD";
    expect(() => parse(untiered)).toThrow(/lists USD twice/u);
    // A number and the same digits as text are different tiers, never merged.
    const typed = board();
    rows(typed)[0]!["customerCategory"] = 1;
    rows(typed)[1]!["customerCategory"] = "1";
    rows(typed)[1]!["currency"] = "USD";
    expect(parse(typed).observations).toHaveLength(6);
    for (const cell of ["-", "", "0", "0.00", "-1", "1,234.5", "1e2", 146]) {
      const input = board();
      rows(input)[0]!["midRate"] = cell;
      const result = parse(input);
      expect(result.observations).toHaveLength(5);
      expect(result.issues?.map((issue) => issue.code)).toEqual(["row_unreadable"]);
      expect(result.coverage?.[0]).toMatchObject({ completeness: "partial" });
    }
  });
});

describe("SBI Shinsei exchange-rate board: observed shape (1.0.2)", () => {
  // The stored boards' shape (ADR 0028, observed 2026-09-27): 13 currencies
  // in 5 customerCategory tiers, CHF in one, one JPY row, and a 22-character
  // transactionTime ending in a space and two letters (amended for 1.0.2).
  const observed = () => value("exchange-rate-observed-board");
  const information = (input: Record<string, unknown>): Record<string, unknown> => {
    const response = input["responseParam"] as Record<string, unknown>;
    const wrapped = response["exchangeRateInformation"] as Record<string, unknown>;
    return wrapped["responseParam"] as Record<string, unknown>;
  };
  const rows = (input: Record<string, unknown>) =>
    information(input)["exchangeRates"] as Record<string, unknown>[];
  const parse = (input: unknown) =>
    sbiShinseiExchangeRate.parse(encode(input), artifact("exchange-rate"));
  const kogane = (entry: { extra: Record<string, unknown> }) =>
    entry.extra["_kogane"] as Record<string, unknown>;

  test("every tier gives its own observations; the JPY row is skipped; the board is complete", () => {
    const input = observed();
    expect(rows(input)).toHaveLength(67);
    const result = sbiShinseiExchangeRate.parse(
      fixture("exchange-rate-observed-board"),
      artifact("exchange-rate"),
    );
    // 13 × 5 + CHF 1 = 66 quote rows, three cells each.
    expect(result.observations).toHaveLength(198);
    const tiers = new Map<string, Set<unknown>>();
    for (const entry of result.observations) {
      if (entry.kind !== "valuation") throw new Error(entry.kind);
      const set = tiers.get(entry.subject) ?? new Set<unknown>();
      set.add(entry.extra["customerCategory"]);
      tiers.set(entry.subject, set);
    }
    expect(tiers.size).toBe(14);
    expect(tiers.has("JPY")).toBe(false);
    expect(tiers.get("CHF")?.size).toBe(1);
    for (const [code, set] of tiers) if (code !== "CHF") expect(set.size, code).toBe(5);
    expect(result.coverage).toEqual([
      expect.objectContaining({
        completeness: "complete",
        membershipComplete: true,
        observedCount: 198,
        expectedCount: 198,
        failureCause: null,
      }),
    ]);
    expect(result.issues?.map((issue) => [issue.code, issue.severity, issue.impact])).toEqual([
      ["unknown_fields_preserved", "info", "field"],
      ["row_unreadable", "info", "none"],
    ]);
  });

  test("an unrecognised transactionTime leaves the provider time empty and says so, without the value", () => {
    const result = parse(observed());
    const time = information(observed())["transactionTime"] as string;
    expect(time).toHaveLength(22);
    expect(time).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} [A-Za-z]{2}$/u);
    for (const entry of result.observations) {
      expect(entry).not.toHaveProperty("asOf");
      expect(kogane(entry)["providerTimeBasis"]).toBe("unrecognized");
      // Kept verbatim as provider context; no part of it is read.
      expect(kogane(entry)["providerContext"]).toEqual({ transactionTime: time });
    }
    for (const issue of result.issues ?? []) expect(issue.message).not.toContain(time);
    for (const warning of result.warnings) expect(warning).not.toContain(time);
    // The two trailing characters change nothing: no value is read from them.
    const other = observed();
    information(other)["transactionTime"] = `${time.slice(0, 20)}qz`;
    const withoutContext = (entries: typeof result.observations) =>
      entries.map((entry) => ({ ...entry, extra: { ...entry.extra, _kogane: null } }));
    expect(withoutContext(parse(other).observations)).toEqual(withoutContext(result.observations));
  });

  test("a recognised time is still the provider's; an impossible or non-string one still fails", () => {
    const recognised = observed();
    information(recognised)["transactionTime"] = "2026/05/12 09:00:00";
    const result = parse(recognised);
    expect(result.observations[0]).toMatchObject({ asOf: "2026-05-12T09:00:00+09:00" });
    expect(kogane(result.observations[0]!)).not.toHaveProperty("providerTimeBasis");
    expect(result.issues?.map((issue) => issue.code)).toEqual(["row_unreadable"]);
    const impossible = observed();
    information(impossible)["transactionTime"] = "2026/02/30 09:00:00";
    expect(() => parse(impossible)).toThrow(/provider timestamp is invalid/u);
    const numeric = observed();
    information(numeric)["transactionTime"] = 20260512090000;
    expect(() => parse(numeric)).toThrow(/must be a string/u);
  });

  test("the observed letter suffix falls back in either case, at exactly 22 characters", () => {
    const time = information(observed())["transactionTime"] as string;
    for (const suffix of ["AB", "ab", "Ab", "zZ"]) {
      const input = observed();
      const other = `${time.slice(0, 20)}${suffix}`;
      expect(other).toHaveLength(22);
      information(input)["transactionTime"] = other;
      const result = parse(input);
      expect(result.observations, suffix).toHaveLength(198);
      for (const entry of result.observations) {
        expect(entry).not.toHaveProperty("asOf");
        expect(kogane(entry)["providerTimeBasis"]).toBe("unrecognized");
      }
    }
  });

  test("only the observed 22-character shape falls back; any other unrecognised form still fails", () => {
    const time = information(observed())["transactionTime"] as string;
    for (const other of [
      "not a time",
      `${time}X`,
      time.slice(0, 21),
      `${time.slice(0, 20)}A1`,
      `${time.slice(0, 20)}1A`,
      // The two digits 1.0.1 assumed were never observed and are refused again.
      `${time.slice(0, 20)}01`,
      `${time.slice(0, 20)}99`,
      // Letters outside ASCII are not the observed shape.
      `${time.slice(0, 20)}\uFF21\uFF22`,
      `${time.slice(0, 20)}\u00C4B`,
      `${time.slice(0, 19)}_${time.slice(20)}`,
      `${time.slice(0, 19)}${time.slice(20)}`,
      `${time.slice(0, 16)} ${time.slice(20)}`,
      "2026-05-12T09:00:00",
      "2026/05/12 09:00",
    ]) {
      const input = observed();
      information(input)["transactionTime"] = other;
      expect(() => parse(input), other).toThrow(/provider timestamp format is not recognized/u);
    }
  });

  test("a board of JPY rows only has no quote and is refused", () => {
    const input = observed();
    information(input)["exchangeRates"] = rows(input).filter((row) => row["currency"] === "JPY");
    expect(() => parse(input)).toThrow(/no quote row/u);
  });

  test("an unreadable cell in one tier breaks membership for the board, and only that cell is missing", () => {
    const input = observed();
    rows(input)[7]!["sellRate"] = "-";
    const result = parse(input);
    expect(result.observations).toHaveLength(197);
    expect(result.coverage?.[0]).toMatchObject({
      completeness: "partial",
      failureCause: "row_unreadable",
      expectedCount: 198,
    });
  });
});
