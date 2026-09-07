import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARSERS } from "../src/parsers/registry.ts";
import { sbiVcAccountMargin } from "../src/parsers/sbi-vc-account-margin.ts";
import { sbiVcCashBalances } from "../src/parsers/sbi-vc-cash-balances.ts";
import { sbiVcCashflows } from "../src/parsers/sbi-vc-cashflows.ts";
import { sbiVcExecutions } from "../src/parsers/sbi-vc-executions.ts";
import { sbiVcPositionSummary } from "../src/parsers/sbi-vc-position-summary.ts";
import type { ArtifactMeta, Observation, Parser } from "../src/types.ts";

const RUN = join(
  import.meta.dir,
  "..",
  "fixtures",
  "sbi-vc-trade",
  "2026-09-07",
  "run-20260907-synthetic01",
);
const DATASETS = [
  "cash-balances",
  "account-margin",
  "position-summary",
  "executions-recent-page-0001",
  "executions-historical-page-0001",
  "cashflows-historical-page-0001",
] as const;

function artifact(dataset: string): ArtifactMeta {
  return {
    id: 1,
    sourceId: "sbi-vc-trade",
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:00:06.000Z",
    sha256: "0".repeat(64),
  };
}

function fixture(dataset: string): Uint8Array {
  return readFileSync(join(RUN, `${dataset}.json`));
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parserFor(dataset: string): Parser {
  const matches = PARSERS.filter((parser) => parser.accepts(artifact(dataset)));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function transaction(observation: Observation | undefined) {
  if (observation?.kind !== "transaction") throw new Error("expected transaction");
  return observation;
}

describe("SBI VC Trade parser registry", () => {
  test("has one canonical route for every collected dataset", () => {
    for (const dataset of DATASETS) parserFor(dataset);
    expect(parserFor("executions-recent-page-0001")).toBe(sbiVcExecutions);
    expect(parserFor("executions-historical-page-0001")).toBe(sbiVcExecutions);
  });

  test("never accepts a similarly named source", () => {
    const wrongSource = { ...artifact("cash-balances"), sourceId: "sbi-securities" };
    expect(PARSERS.filter((parser) => parser.accepts(wrongSource))).toHaveLength(0);
  });
});

describe("SBI VC Trade envelope and balance schemas", () => {
  test("cash balances retain exact decimals and keep provider account IDs out of identity", () => {
    const result = sbiVcCashBalances.parse(fixture("cash-balances"), artifact("cash-balances"));
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(6);
    const jpy = result.observations[0]!;
    const btc = result.observations[3]!;
    if (jpy.kind !== "balance" || btc.kind !== "balance") throw new Error("expected balances");
    expect(jpy.amountMinor).toBe(123456);
    expect(btc.amountMinor).toBeUndefined();
    expect(btc.amountText).toBe("0.12345678");
    expect(btc.amountScale).toBe(8);
    expect(btc.sourceAccount).toBe("sbi-vc-trade:main");
    expect(btc.sourceAccount).not.toContain("0000000000");
    expect(btc.rawLocator).toBe("json:$.body.list[1].amount");
    expect(btc.extra["fxAccountId"]).toBe("0000000000");
  });

  test("account margin emits only explicitly denominated child values", () => {
    const result = sbiVcAccountMargin.parse(fixture("account-margin"), artifact("account-margin"));
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(6);
    const first = result.observations[0]!;
    if (first.kind !== "balance") throw new Error("expected balance");
    expect(first.metric).toBe("received_margin");
    expect(first.instrument).toBe("BTC");
    expect(first.asOf).toBe("2026-09-07T09:00:00+09:00");
    const kogane = first.extra["_kogane"] as Record<string, unknown>;
    const context = kogane["providerContext"] as Record<string, unknown>;
    expect(context["cashBalance"]).toBe("123456");
    expect(
      result.observations.some((item) => item.kind === "balance" && item.metric === "cash_balance"),
    ).toBe(false);
  });

  test("rejects unsanitized or extended gateway envelopes", () => {
    const valid = JSON.parse(new TextDecoder().decode(fixture("cash-balances"))) as Record<
      string,
      unknown
    >;
    expect(() =>
      sbiVcCashBalances.parse(
        encode({ ...valid, secureKey: "forbidden" }),
        artifact("cash-balances"),
      ),
    ).toThrow(/exactly body and meta/u);
    const meta = valid["meta"] as Record<string, unknown>;
    expect(() =>
      sbiVcCashBalances.parse(
        encode({ ...valid, meta: { ...meta, secureKey: "forbidden" } }),
        artifact("cash-balances"),
      ),
    ).toThrow(/sanitized contract/u);
  });
});

describe("SBI VC Trade positions", () => {
  test("keeps provider grouping and exact quantity provenance", () => {
    const result = sbiVcPositionSummary.parse(
      fixture("position-summary"),
      artifact("position-summary"),
    );
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(1);
    const position = result.observations[0]!;
    if (position.kind !== "position") throw new Error("expected position");
    expect(position.securityCode).toBe("BTCJPY");
    expect(position.quantityText).toBe("0.12345678");
    expect(position.quantityScale).toBe(8);
    expect(position.rawLocator).toBe('json:$.body["BTC"]["0"]');
    expect(position.extra["evaluationPl"]).toBe("1234");
  });

  test("accepts the audited empty position summary as genuine zero cardinality", () => {
    const empty = {
      meta: {
        sessUpdTime: "2026/09/07 09:00:00",
        status: "OK",
        timestamp: "2026/09/07 09:00:03",
      },
      body: {},
    };
    expect(sbiVcPositionSummary.parse(encode(empty), artifact("position-summary"))).toEqual({
      observations: [],
      warnings: [],
    });
  });
});

describe("SBI VC Trade execution pages", () => {
  test("recent and historical share collision-free composite identities", () => {
    const recent = sbiVcExecutions.parse(
      fixture("executions-recent-page-0001"),
      artifact("executions-recent-page-0001"),
    );
    const historical = sbiVcExecutions.parse(
      fixture("executions-historical-page-0001"),
      artifact("executions-historical-page-0001"),
    );
    expect(recent.warnings).toEqual([]);
    expect(historical.warnings).toEqual([]);
    const buy = transaction(recent.observations[0]);
    const sell = transaction(historical.observations[0]);
    expect(buy.externalId).toBe('["900000000001","1"]');
    expect(sell.externalId).toBe('["900000000000","2"]');
    expect(buy.asOf).toBe("2026-09-06T12:34:56+09:00");
    expect(buy.rawLocator).toBe("json:$.body.list[0]");
    const buyKogane = buy.extra["_kogane"] as Record<string, unknown>;
    const sellKogane = sell.extra["_kogane"] as Record<string, unknown>;
    expect(buyKogane["direction"]).toBe("buy");
    expect(sellKogane["direction"]).toBe("sell");
    expect(buyKogane["quantity"]).toEqual({ text: "0.01000000", scale: 8, currency: "BTC" });
    expect(buyKogane["price"]).toEqual({ text: "8000000", scale: 0, currency: "JPY" });
  });

  test("fails closed on suffix, page cardinality, and recent truncation", () => {
    const page = JSON.parse(new TextDecoder().decode(fixture("executions-recent-page-0001"))) as {
      meta: Record<string, unknown>;
      body: Record<string, unknown>;
    };
    expect(() =>
      sbiVcExecutions.parse(
        encode({ ...page, body: { ...page.body, totalSize: 31, totalNumOfPages: 2 } }),
        artifact("executions-recent-page-0001"),
      ),
    ).toThrow(/cardinality|single collected page/u);
    expect(() =>
      sbiVcExecutions.parse(
        fixture("executions-historical-page-0001"),
        artifact("executions-historical-page-0002"),
      ),
    ).toThrow(/page number or size/u);
    expect(sbiVcExecutions.accepts(artifact("executions-historical-page-0100"))).toBe(true);
    expect(() =>
      sbiVcExecutions.parse(
        fixture("executions-historical-page-0001"),
        artifact("executions-historical-page-0101"),
      ),
    ).toThrow(/suffix is invalid/u);
  });

  test("rejects malformed page metadata and warns without dropping malformed leaf data", () => {
    const original = JSON.parse(
      new TextDecoder().decode(fixture("executions-recent-page-0001")),
    ) as {
      meta: Record<string, unknown>;
      body: Record<string, unknown> & { list: Record<string, unknown>[] };
    };
    for (const body of [
      { ...original.body, list: {} },
      { ...original.body, pageNumber: "0" },
      { ...original.body, pageSize: 29 },
      { ...original.body, totalNumOfPages: 2 },
      { ...original.body, totalSize: 2 },
    ]) {
      expect(() =>
        sbiVcExecutions.parse(
          encode({ ...original, body }),
          artifact("executions-recent-page-0001"),
        ),
      ).toThrow();
    }
    original.body.list[0]!["isCloseOrder"] = { attribute: 7, value: true };
    original.body.list[0]!["executionPrice"] = { malformed: true };
    const result = sbiVcExecutions.parse(encode(original), artifact("executions-recent-page-0001"));
    expect(result.observations).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("isCloseOrder.attribute"))).toBe(
      true,
    );
    expect(result.warnings.some((warning) => warning.includes("executionPrice"))).toBe(true);
    expect(transaction(result.observations[0]).extra["isCloseOrder"]).toEqual({
      attribute: 7,
      value: true,
    });
  });
});

describe("SBI VC Trade cashflow pages", () => {
  test("uses signed cashflowAmount and emits the post-flow balance separately", () => {
    const result = sbiVcCashflows.parse(
      fixture("cashflows-historical-page-0001"),
      artifact("cashflows-historical-page-0001"),
    );
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(4);
    const transactions = result.observations.filter((item) => item.kind === "transaction");
    const balances = result.observations.filter((item) => item.kind === "balance");
    expect(transactions.map((item) => item.amountMinor)).toEqual([1000, -500]);
    expect(balances.map((item) => item.amountMinor)).toEqual([101000, 100500]);
    expect(transactions.map((item) => item.externalId)).toEqual(["800000000001", "800000000002"]);
    expect(balances.map((item) => item.metric)).toEqual([
      "cash_balance_after_cashflow",
      "cash_balance_after_cashflow",
    ]);
  });

  test("retains the amount sign when the provider label disagrees", () => {
    const page = JSON.parse(
      new TextDecoder().decode(fixture("cashflows-historical-page-0001")),
    ) as { body: { list: Record<string, unknown>[] } };
    page.body.list[0]!["cashflowType"] = "REMITTANCE_WITHDRAW";
    const result = sbiVcCashflows.parse(encode(page), artifact("cashflows-historical-page-0001"));
    expect(transaction(result.observations[0]).amountMinor).toBe(1000);
    expect(result.warnings.some((warning) => warning.includes("amount sign retained"))).toBe(true);
  });
});

describe("SBI VC Trade determinism", () => {
  test("the complete synthetic collector run produces the audited Layer B cardinality", () => {
    const results = DATASETS.map((dataset) =>
      parserFor(dataset).parse(fixture(dataset), artifact(dataset)),
    );
    expect(results.reduce((count, result) => count + result.observations.length, 0)).toBe(19);
    expect(results.flatMap((result) => result.warnings)).toEqual([]);
  });

  test("every fixture is byte-identical across repeated parses", () => {
    for (const dataset of DATASETS) {
      const parser = parserFor(dataset);
      const bytes = fixture(dataset);
      expect(parser.parse(bytes, artifact(dataset))).toEqual(
        parser.parse(bytes, artifact(dataset)),
      );
    }
  });
});
