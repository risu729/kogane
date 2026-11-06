// Fail-closed pins for the shared SBI VC Trade envelope, page and decimal
// rules (ADR 0004: refuse rather than guess). Inputs are synthetic mutations
// of the collector-shaped fixtures under
// tests/fixtures/observation-pipeline/sbi-vc-trade; nothing is a provider value.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sbiVcCashBalances } from "../src/parsers/sbi-vc-cash-balances.ts";
import { sbiVcCashflows } from "../src/parsers/sbi-vc-cashflows.ts";
import { sbiVcExecutions } from "../src/parsers/sbi-vc-executions.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const RUN = join(FIXTURES_ROOT, "sbi-vc-trade", "2026-09-07", "run-20260907-synthetic01");

type Envelope = {
  meta: Record<string, unknown>;
  body: Record<string, unknown> & { list: Record<string, unknown>[] };
};

const fixture = (dataset: string): Envelope =>
  JSON.parse(readFileSync(join(RUN, `${dataset}.json`), "utf8")) as Envelope;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function artifact(dataset: string): ArtifactMeta {
  return {
    id: 1,
    sourceId: "sbi-vc-trade",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:00:06.000Z",
    sha256: "0".repeat(64),
  };
}

const CASH = "cash-balances";
const CASHFLOWS = "cashflows-historical-page-0001";
const RECENT = "executions-recent-page-0001";
const cash = (value: unknown) => sbiVcCashBalances.parse(encode(value), artifact(CASH));
const cashflows = (value: unknown, dataset = CASHFLOWS) =>
  sbiVcCashflows.parse(encode(value), artifact(dataset));
const executions = (value: unknown) => sbiVcExecutions.parse(encode(value), artifact(RECENT));

describe("sbi-vc gateway envelope", () => {
  test("meta and body must both be objects and meta must be the sanitized OK form", () => {
    const valid = fixture(CASH);
    expect(() => cash([])).toThrow("expected a gateway envelope object");
    expect(() => cash({ ...valid, meta: [] })).toThrow("body and meta must be objects");
    expect(() => cash({ ...valid, body: null })).toThrow("body and meta must be objects");
    for (const meta of [
      { ...valid.meta, status: "NG" },
      { ...valid.meta, status: undefined },
      { ...valid.meta, sessUpdTime: 1 },
      { ...valid.meta, timestamp: null },
    ]) {
      expect(() => cash({ ...valid, meta })).toThrow(
        "gateway meta values do not match the sanitized contract",
      );
    }
  });

  test("an unrecognized meta timestamp is dropped, never guessed", () => {
    const valid = fixture(CASH);
    for (const timestamp of ["2026/02/30 09:00:00", "2026/09/07 24:00:00", "2026-09-07"]) {
      const result = cash({ ...valid, meta: { ...valid.meta, timestamp } });
      expect(result.observations.every((o) => o.observedAt === undefined)).toBe(true);
    }
    const iso = cash({ ...valid, meta: { ...valid.meta, timestamp: "2026-09-07T00:00:01Z" } });
    expect(iso.observations[0]?.observedAt).toBe("2026-09-07T00:00:01Z");
    // The slash form is JST display time; the offset is the parser's stated step.
    expect(cash(valid).observations[0]?.observedAt).toBe("2026-09-07T09:00:01+09:00");
  });
});

describe("sbi-vc cash balances", () => {
  test("fiat values must be exact in minor units; crypto keeps its full scale", () => {
    const valid = fixture(CASH);
    const jpy = { ...valid.body.list[0]!, settlingAmount: "3456.5" };
    expect(() => cash({ ...valid, body: { ...valid.body, list: [jpy] } })).toThrow(
      "settlingAmount: decimal is not exactly representable in JPY minor units",
    );
    const btc = cash(valid).observations.find(
      (o) => o.kind === "balance" && o.instrument === "BTC" && o.metric !== undefined,
    );
    expect(btc).toMatchObject({ amountText: "0.12345678", amountScale: 8 });
    expect(btc?.kind === "balance" && btc.amountMinor).toBeUndefined();
  });

  test("a non-string fxAccountId or a non-array list is refused", () => {
    const valid = fixture(CASH);
    expect(() =>
      cash({
        ...valid,
        body: { ...valid.body, list: [{ ...valid.body.list[0]!, fxAccountId: 0 }] },
      }),
    ).toThrow("fxAccountId: expected a string");
    expect(() => cash({ ...valid, body: { ...valid.body, list: {} } })).toThrow(
      "body fields do not match the provider contract",
    );
  });

  test("a provider field named _kogane is preserved without colliding with parser metadata", () => {
    const valid = fixture(CASH);
    const row = { ...valid.body.list[0]!, _kogane: "provider-value" };
    const result = cash({ ...valid, body: { ...valid.body, list: [row] } });
    expect(result.warnings.some((warning) => warning.includes("_kogane"))).toBe(true);
    expect(result.observations[0]?.extra["_kogane"]).toMatchObject({
      providerFieldNamedKogane: "provider-value",
      sourceField: "amount",
    });
  });
});

describe("sbi-vc page metadata", () => {
  const page = (change: Record<string, unknown>) => {
    const valid = fixture(CASHFLOWS);
    return { ...valid, body: { ...valid.body, ...change } };
  };

  test("unknown body fields, non-integer and negative counts are refused", () => {
    expect(() => cashflows(page({ cursor: "next" }))).toThrow(
      "page body fields do not match the provider contract",
    );
    for (const change of [
      { pageNumber: -1 },
      { pageSize: "30.0" },
      { totalSize: 2.5 },
      { totalNumOfPages: null },
    ]) {
      expect(() => cashflows(page(change))).toThrow(
        "page metadata must contain non-negative safe integers",
      );
    }
    expect(() => cashflows(page({ list: "none" }))).toThrow("page list must be an array");
  });

  test("page counts above the collector limit and inconsistent totals are refused", () => {
    expect(() => cashflows(page({ totalSize: 3_030, totalNumOfPages: 101 }))).toThrow(
      "page metadata exceeds the collector limit",
    );
    expect(() => cashflows(page({ totalNumOfPages: 2 }))).toThrow(
      "totalNumOfPages does not match totalSize",
    );
    // A later page with fewer rows than its metadata implies is truncated.
    const last = fixture(CASHFLOWS);
    expect(() =>
      cashflows(
        { ...last, body: { ...last.body, pageNumber: 1, totalSize: 33, totalNumOfPages: 2 } },
        "cashflows-historical-page-0002",
      ),
    ).toThrow("list cardinality does not match page metadata");
    expect(() => cashflows(fixture(CASHFLOWS), "cashflows-historical-page-0000")).toThrow(
      "historical page suffix is invalid",
    );
  });
});

describe("sbi-vc cashflows", () => {
  const row = (change: Record<string, unknown>) => {
    const valid = fixture(CASHFLOWS);
    const list = [{ ...valid.body.list[0]!, ...change }];
    return { ...valid, body: { ...valid.body, list, totalSize: 1 } };
  };

  test("enums, amounts, balances and timestamps are refused when unrecognized", () => {
    expect(() => cashflows(row({ cashflowType: "TRADE" }))).toThrow(
      "cashflowType: outside the audited transfer filter",
    );
    expect(() => cashflows(row({ cashflowAmount: "1,00" }))).toThrow(
      "cashflowAmount: expected an exact signed decimal",
    );
    expect(() => cashflows(row({ cashflowAmount: "1000.5" }))).toThrow(
      "cashflowAmount: not exactly representable in JPY",
    );
    expect(() => cashflows(row({ cashbalance: "101000.5" }))).toThrow(
      "cashbalance: expected an exact JPY balance",
    );
    expect(() => cashflows(row({ cashbalance: "" }))).toThrow(
      "cashbalance: expected an exact JPY balance",
    );
    for (const eventDatetime of ["2026/02/30 04:05:06", "2026/01/03", "03/01/2026 04:05:06", 1]) {
      expect(() => cashflows(row({ eventDatetime }))).toThrow(
        "eventDatetime: timestamp format is not recognized",
      );
    }
    expect(() => cashflows(row({ processStatusType: "" }))).toThrow(
      "processStatusType: expected a non-empty string",
    );
  });

  test("a zero amount states no direction; a JSON-number amount is warned about", () => {
    const zero = cashflows(row({ cashflowAmount: "0" })).observations[0]!;
    expect(zero.extra["_kogane"]).not.toHaveProperty("direction");
    const numeric = cashflows(row({ cashflowAmount: 1000 }));
    expect(numeric.observations[0]).toMatchObject({ amountMinor: 1000 });
    expect(numeric.warnings).toEqual([
      "json:$.body.list[0].cashflowAmount: expected a string; raw value preserved",
    ]);
  });
});

describe("sbi-vc executions", () => {
  const row = (change: Record<string, unknown>) => {
    const valid = fixture(RECENT);
    return { ...valid, body: { ...valid.body, list: [{ ...valid.body.list[0]!, ...change }] } };
  };

  test("unknown direction codes, malformed decimals and timestamps are refused", () => {
    for (const buySellType of [
      { attribute: "買", value: "2" },
      { attribute: "買", value: 3 },
      "3",
    ]) {
      expect(() => executions(row({ buySellType }))).toThrow(
        "buySellType.value: unknown execution direction",
      );
    }
    expect(() => executions(row({ executionAmount: "0.01.0" }))).toThrow(
      "executionAmount: expected an exact decimal",
    );
    expect(() => executions(row({ executionPrice: 8e6 + 0.5 }))).toThrow(
      "executionPrice: expected an exact decimal",
    );
    expect(() => executions(row({ executionDatetime: "2026/09/06 12:34:60" }))).toThrow(
      "executionDatetime: timestamp format is not recognized",
    );
    expect(() => executions(row({ currencyPair: "btc/jpy" }))).toThrow(
      "currencyPair: expected the audited BASE/QUOTE form",
    );
  });

  test("a recent view that spans more than its single collected page is truncated", () => {
    const valid = fixture(RECENT);
    const list = Array.from({ length: 30 }, (_, index) => ({
      ...valid.body.list[0]!,
      CExecutionIdSubNo: String(index + 1),
    }));
    expect(() =>
      executions({ ...valid, body: { ...valid.body, list, totalSize: 31, totalNumOfPages: 2 } }),
    ).toThrow("recent view exceeds its single collected page");
    expect(
      executions({ ...valid, body: { ...valid.body, list, totalSize: 30 } }).observations,
    ).toHaveLength(30);
  });

  test("leaf type drift is warned about and preserved, never coerced", () => {
    const result = executions(row({ isAuction: "false", markup: 0, executionNotifyId: 7 }));
    expect(result.observations).toHaveLength(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "json:$.body.list[0].isAuction: expected a boolean; raw value preserved",
        "json:$.body.list[0].markup: expected a string or null; raw value preserved",
        "json:$.body.list[0].executionNotifyId: expected a string or null; raw value preserved",
      ]),
    );
    expect(result.observations[0]?.extra["isAuction"]).toBe("false");
    const notObject = executions(row({ isExOrder: "true" }));
    expect(notObject.warnings).toContain(
      "json:$.body.list[0].isExOrder: expected an object; raw value preserved",
    );
  });
});
