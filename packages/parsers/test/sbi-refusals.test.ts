// Fail-closed pins for the SBI Securities parsers (ADR 0004: refuse or flag
// rather than guess). Every input is a synthetic mutation of the anonymous
// fixtures under tests/fixtures/observation-pipeline/; nothing here is a
// provider value.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sbiDomesticCashPositions } from "../src/parsers/sbi-domestic-cash-positions.ts";
import { sbiDomesticTradeRecords } from "../src/parsers/sbi-domestic-trade-records.ts";
import { sbiForeignCashBalances } from "../src/parsers/sbi-foreign-cash-balances.ts";
import { sbiForeignCashPositions } from "../src/parsers/sbi-foreign-cash-positions.ts";
import { sbiYenDetailHistory } from "../src/parsers/sbi-yen-detail-history.ts";
import type { ArtifactMeta, Observation } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const BOUNDARIES = join(FIXTURES_ROOT, "sbi-parser-boundaries");

function artifact(dataset: string): ArtifactMeta {
  return {
    id: 1,
    sourceId: "sbi-securities",
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-08-20T21:01:42Z",
    sha256: "0".repeat(64),
  };
}

const encoded = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const boundary = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(BOUNDARIES, `${name}.json`), "utf8")) as Record<string, unknown>;
const transaction = (observation: Observation | undefined) => {
  if (observation?.kind !== "transaction") throw new Error("expected a transaction");
  return observation;
};

describe("sbi-domestic-trade-records keeps evidence but never guesses an amount", () => {
  const meta = artifact("domestic-trade-records");
  const parse = (records: unknown[], hasMore = false) =>
    sbiDomesticTradeRecords.parse(encoded({ records, hasMore }), meta);
  const record = (amount: unknown) => ({
    id: "synthetic:1",
    tradeDate: "2026-08-12",
    amount,
    rawCells: ["", "synthetic issue", "", "", "", "", ""],
  });

  test("a non-object record is recorded verbatim with a warning", () => {
    const result = parse([7, null]);
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toEqual({
      kind: "transaction",
      sourceAccount: "sbi-securities:domestic",
      currency: "JPY",
      rawLocator: "json:$.records[0]",
      extra: { _kogane: { unparsedElement: 7 } },
    });
    expect(result.warnings).toEqual([
      "records[0]: expected an object, got number; recorded verbatim",
      "records[1]: expected an object, got object; recorded verbatim",
    ]);
  });

  test("a safe-integer JSON amount resolves; fractional or unsafe numbers do not", () => {
    const integer = transaction(parse([record(-1200)]).observations[0]);
    expect(integer).toMatchObject({ amountMinor: -1200, amountText: "-1200", amountScale: 0 });
    for (const amount of [12.5, 2 ** 53, null, true]) {
      const result = parse([record(amount)]);
      const observation = transaction(result.observations[0]);
      expect(observation.amountMinor).toBeUndefined();
      expect(observation.amountText).toBeUndefined();
      expect(observation.extra["amount"]).toEqual(amount);
      expect(result.warnings).toEqual([
        `records[0]: amount ${JSON.stringify(amount)} did not resolve to JPY minor units`,
      ]);
    }
  });

  test("sub-yen, malformed grouping and marker-signed display amounts", () => {
    // A JPY amount with a fraction is not representable: the text is kept.
    const fraction = parse([record("100.5")]);
    expect(transaction(fraction.observations[0])).toMatchObject({
      amountText: "100.5",
      amountScale: 1,
    });
    expect(transaction(fraction.observations[0]).amountMinor).toBeUndefined();
    expect(fraction.warnings).toHaveLength(1);
    // "1,00" is not a thousands grouping; it is refused, not read as 100.
    const grouping = parse([record("1,00")]);
    expect(transaction(grouping.observations[0]).amountMinor).toBeUndefined();
    expect(transaction(grouping.observations[0]).amountText).toBe("1,00");
    expect(grouping.warnings).toHaveLength(1);
    // Two negative markers are ambiguous.
    expect(transaction(parse([record("△-100")]).observations[0]).amountMinor).toBeUndefined();
    // A △ marker resolves the sign but keeps the provider display text.
    const marker = transaction(parse([record("△100")]).observations[0]);
    expect(marker).toMatchObject({ amountMinor: -100, amountText: "△100" });
    expect(marker.amountScale).toBeUndefined();
  });

  test("no id, date or description is invented for a sparse record", () => {
    const sparse = transaction(
      parse([{ amount: "1", issueName: "fallback issue", rawCells: "not-an-array" }])
        .observations[0],
    );
    expect(sparse.externalId).toBeUndefined();
    expect(sparse.asOf).toBeUndefined();
    expect(sparse.description).toBe("fallback issue");
    expect(transaction(parse([{ amount: "1" }]).observations[0]).description).toBe("");
  });

  test("a truncated window is flagged and a wrong body is refused", () => {
    expect(parse([], true).warnings).toEqual([
      "hasMore=true: the source truncated this window; artifact covers a partial page",
    ]);
    for (const body of [[], { records: {} }, "records"]) {
      expect(() => sbiDomesticTradeRecords.parse(encoded(body), meta)).toThrow(
        "is not a domestic-trade-records body",
      );
    }
    expect(() => sbiDomesticTradeRecords.parse(new Uint8Array([0xff]), meta)).toThrow(
      "not valid UTF-8",
    );
  });
});

describe("sbi-foreign-cash-balances demotes membership instead of skipping silently", () => {
  const meta = artifact("foreign-cash-balances");
  const parse = (currencyCashBalances: unknown) =>
    sbiForeignCashBalances.parse(
      encoded({
        listForeignScheduleCashBalances: {
          foreignCashBalances: [{ accountKind: "GENERAL", currencyCashBalances }],
        },
      }),
      meta,
    );
  const usd = (rows: unknown, currencyCode: unknown = "USD") => [
    { currencyCode, foreignScheduleCashBalances: rows },
  ];

  test("unreadable currency entries, schedules and rows are membership errors", () => {
    for (const [entries, code, locator] of [
      [[null], "container_unreadable", "currencyCashBalances[0]"],
      [usd([], 840), "container_unreadable", "currencyCashBalances[0]"],
      [usd({}), "container_unreadable", "foreignScheduleCashBalances"],
      [usd(["row"]), "row_unreadable", "foreignScheduleCashBalances[0]"],
    ] as const) {
      const result = parse(entries);
      expect(result.observations).toEqual([]);
      expect(result.issues).toHaveLength(1);
      expect(result.issues![0]).toMatchObject({ code, severity: "error", impact: "membership" });
      expect(result.issues![0]!.locator.endsWith(locator)).toBe(true);
      expect(result.coverage![0]).toMatchObject({
        completeness: "partial",
        membershipComplete: false,
        failureCause: code,
        absenceMeaning: "not-observed",
      });
    }
  });

  test("an inexact metric value is refused; the rest of the row still emits", () => {
    const result = parse(
      usd([{ businessDate: "2026-08-20", buyPossibleAmount: 1.5, keepCash: "10.00" }]),
    );
    expect(result.observations.map((o) => o.kind === "balance" && o.metric)).toEqual(["keep_cash"]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "row_unreadable",
        impact: "membership",
        locator: expect.stringMatching(/\.buyPossibleAmount$/u) as unknown as string,
      }),
    ]);
    expect(result.coverage![0]).toMatchObject({
      completeness: "partial",
      failureCause: "row_unreadable",
      absenceMeaning: "not-applicable",
    });
  });

  test("precision beyond the currency scale is kept as text, never rounded", () => {
    const result = parse(usd([{ businessDate: "2026-08-20", buyPossibleAmount: "1.005" }]));
    const balance = result.observations[0];
    if (balance?.kind !== "balance") throw new Error("expected balance");
    expect(balance.amountMinor).toBeUndefined();
    expect(balance).toMatchObject({ amountText: "1.005", amountScale: 3 });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "exact_decimal_without_minor_units", impact: "none" }),
    ]);
    // An unknown currency has no minor-unit table entry: text only.
    const unknown = parse(usd([{ buyPossibleAmount: "1" }], "XZZ")).observations[0];
    if (unknown?.kind !== "balance") throw new Error("expected balance");
    expect(unknown.amountMinor).toBeUndefined();
    expect(unknown.asOf).toBeUndefined();
    expect(result.coverage![0]).toMatchObject({ completeness: "complete" });
  });

  test("a missing list is refused as a whole artifact", () => {
    for (const body of [{}, { listForeignScheduleCashBalances: {} }, []]) {
      expect(() => sbiForeignCashBalances.parse(encoded(body), meta)).toThrow(
        "is not a GetForeignCashBalance data object",
      );
    }
  });
});

describe("sbi-foreign-cash-positions refuses truncated pages and inexact valuations", () => {
  const meta = artifact("foreign-cash-positions");
  const page = { hasNextPage: false, pageNum: 1, pageSize: 2 };
  const parse = (securitiesBalances: unknown[], pagination: unknown = page) =>
    sbiForeignCashPositions.parse(
      encoded({ listSecuritiesBalances: { page: pagination, securitiesBalances } }),
      meta,
    );
  const holding = (evaluationProfitLoss: unknown) => ({
    securitiesQuantity: "3",
    currencyCode: "USD",
    securities: { securitiesCode: "SYN" },
    evaluationProfitLoss,
  });

  test("more rows than the declared page size is row-count drift", () => {
    expect(() => parse([holding({}), holding({}), holding({})])).toThrow("pagination metadata");
    expect(parse([holding({}), holding({})]).observations).toHaveLength(2);
  });

  test("an inexact valuation is a membership error; extra precision is kept as text", () => {
    const result = parse([holding({ evaluationAmount: "1,2", frnEvaluationAmount: "1.005" })]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "row_unreadable", impact: "membership" }),
      expect.objectContaining({ code: "exact_decimal_without_minor_units", impact: "none" }),
    ]);
    const valuations = result.observations.filter((o) => o.kind === "valuation");
    expect(valuations).toHaveLength(1);
    expect(valuations[0]).toMatchObject({ metric: "frn_evaluation_amount", amountText: "1.005" });
    expect(valuations[0]!.kind === "valuation" && valuations[0]!.amountMinor).toBeUndefined();
    expect(result.coverage![0]).toMatchObject({ membershipComplete: false });
  });

  test("a non-object profit-loss block emits no valuation", () => {
    const result = parse([holding("n/a")]);
    expect(result.observations.map((o) => o.kind)).toEqual(["position"]);
  });

  test("a missing balance list is refused as a whole artifact", () => {
    for (const body of [{}, { listSecuritiesBalances: { securitiesBalances: {} } }]) {
      expect(() => sbiForeignCashPositions.parse(encoded(body), meta)).toThrow(
        "is not a GetSecuritiesBalanceList data object",
      );
    }
  });
});

describe("sbi-yen-detail-history refuses drift at every bundle level", () => {
  const meta = artifact("yen-detail-history");
  const mutate = (
    change: (bundle: Record<string, unknown>, page: Record<string, unknown>) => void,
  ) => {
    const bundle = boundary("yen-detail-history");
    change(bundle, (bundle["pages"] as Record<string, unknown>[])[0]!);
    return () => sbiYenDetailHistory.parse(encoded(bundle), meta);
  };
  const records = (page: Record<string, unknown>) =>
    page["depositRecordList"] as Record<string, unknown>[];

  test("bundle schema, counts and limits", () => {
    expect(
      mutate((bundle) => (bundle["schemaVersion"] = "sbi-yen-detail-history-bundle-v2")),
    ).toThrow("unsupported yen history schema");
    expect(mutate((bundle) => (bundle["pageCount"] = 0))).toThrow(
      "yen history pageCount is invalid",
    );
    expect(mutate((bundle) => (bundle["pageSize"] = 1_001))).toThrow(
      "yen history pageSize is invalid",
    );
    expect(mutate((bundle) => (bundle["totalCount"] = -1))).toThrow("sbi_cash_history_schema");
    expect(mutate((bundle) => (bundle["rowLimitExceeded"] = true))).toThrow(
      "exceeded a collection limit",
    );
  });

  test("page-level provider flags and metadata", () => {
    expect(mutate((_, page) => (page["exceededMaxCount"] = true))).toThrow(
      "provider exceeded flags disagree",
    );
    expect(
      mutate((_, page) => {
        page["exceededMaxCount"] = true;
        page["isExceededMaxCount"] = true;
      }),
    ).toThrow("reports a provider limit exceeded");
    expect(mutate((_, page) => (page["exceededMaxCount"] = "false"))).toThrow("must be boolean");
    expect(mutate((_, page) => (page["detailsConditions"] = [1]))).toThrow(
      "detailsConditions must be a string array",
    );
    expect(mutate((_, page) => (page["nextBusinessDate"] = "2026-08-21"))).toThrow(
      "nextBusinessDate has an unsupported value",
    );
    expect(mutate((_, page) => (page["totalDepositAmount"] = "1200.5"))).toThrow(
      "not exactly representable in JPY minor units",
    );
    expect(mutate((_, page) => (page["totalDepositCount"] = "1.0"))).toThrow(
      "totalDepositCount must be an integer count",
    );
    expect(mutate((_, page) => (page["totalPaymentCount"] = "one"))).toThrow(
      "must be an exact decimal",
    );
    expect(mutate((_, page) => (page["pageNumber"] = -1))).toThrow("sbi_cash_history_schema");
  });

  test("empty bundles must carry one of the two documented empty page forms", () => {
    const empty = (pageCount: number, pageNumber: number) =>
      mutate((bundle, page) => {
        bundle["totalCount"] = 0;
        Object.assign(page, { totalCount: 0, pageCount, pageNumber, depositRecordList: [] });
      });
    expect(empty(0, 0)()).toEqual({ observations: [], warnings: [] });
    expect(empty(1, 1)()).toEqual({ observations: [], warnings: [] });
    expect(empty(1, 0)).toThrow("empty yen history has inconsistent page metadata");
    expect(empty(0, 1)).toThrow("empty yen history has inconsistent page metadata");
  });

  test("a multi-page chain must be contiguous and add up to totalCount", () => {
    const chain = (secondPageNumber: number, secondRecords: number) =>
      mutate((bundle, page) => {
        const [first, second] = records(page);
        bundle["pageCount"] = 2;
        Object.assign(page, { pageCount: 2, depositRecordList: [first] });
        (bundle["pages"] as unknown[]).push({
          ...page,
          pageNumber: secondPageNumber,
          depositRecordList: [second].slice(0, secondRecords),
        });
      });
    expect(chain(2, 1)().observations.map((o) => o.rawLocator)).toEqual([
      "json:$.pages[0].depositRecordList[0]",
      "json:$.pages[1].depositRecordList[0]",
    ]);
    expect(chain(1, 1)).toThrow("is not part of a contiguous complete page chain");
    expect(chain(3, 1)).toThrow("is not part of a contiguous complete page chain");
    // A missing row on the last page is a count disagreement, not a smaller history.
    expect(chain(2, 0)).toThrow("row count does not match totalCount");
  });

  test("record identity, enums, amounts and dates", () => {
    expect(mutate((_, page) => (records(page)[0]!["did"] = 0))).toThrow(
      "did is below its supported range",
    );
    expect(mutate((_, page) => (records(page)[0]!["did"] = "10001"))).toThrow(
      "did must be a safe integer",
    );
    expect(mutate((_, page) => (records(page)[0]!["detailKbn"] = ""))).toThrow(
      "detailKbn is empty",
    );
    expect(mutate((_, page) => (records(page)[0]!["payAmount"] = 1200.5))).toThrow(
      "sbi_cash_history_schema",
    );
    expect(mutate((_, page) => (records(page)[0]!["payAmount"] = "1,20"))).toThrow(
      "payAmount must be an exact decimal",
    );
    expect(mutate((_, page) => (records(page)[0]!["payDepDate"] = "2026/02/30"))).toThrow(
      "payDepDate is not a calendar date",
    );
    expect(mutate((_, page) => (records(page)[0]!["payDepDate"] = "20260818"))).toThrow(
      "payDepDate has an unsupported value",
    );
    expect(mutate((_, page) => (records(page)[0]!["memo"] = ""))).toThrow("fields changed");
  });
});

describe("sbi-domestic-cash-positions refuses fixed-width drift", () => {
  const meta = artifact("domestic-cash-positions");
  const RECORD = 34;
  const withPayload = (edit: (payload: Uint8Array) => Uint8Array | void) => {
    const body = boundary("domestic-cash-positions");
    const payload = Uint8Array.from(atob(body["payloadBase64"] as string), (c) => c.charCodeAt(0));
    const next = edit(payload) ?? payload;
    body["payloadBase64"] = btoa(String.fromCharCode(...next));
    return () => sbiDomesticCashPositions.parse(encoded(body), meta);
  };
  // ASCII values only, or explicit Shift-JIS bytes, padded with spaces.
  const field = (relative: number, width: number, value: string | number[]) =>
    withPayload((payload) => {
      const bytes = typeof value === "string" ? [...new TextEncoder().encode(value)] : [...value];
      if (bytes.length > width) throw new Error("field value is wider than its slot");
      payload.set([...bytes, ...Array<number>(width - bytes.length).fill(0x20)], RECORD + relative);
    });
  const valuation = (
    parse: () => ReturnType<typeof sbiDomesticCashPositions.parse>,
    metric: string,
  ) => {
    const found = parse().observations.find((o) => o.kind === "valuation" && o.metric === metric);
    return found?.kind === "valuation" ? found : undefined;
  };
  const append = (tail: Uint8Array) =>
    withPayload((payload) => {
      const next = new Uint8Array(payload.length + tail.length);
      next.set(payload);
      next.set(tail, payload.length);
      return next;
    });

  test("wrapper fields and base64 must be exact", () => {
    for (const [wrapper, message] of [
      [{ format: "sbi-mts-csv" }, "unsupported MTS format"],
      [{ trCode: "F2632" }, "unexpected MTS transaction code"],
      [{ resultCode: "000001" }, "MTS result is not successful"],
      [{ httpStatus: 500 }, "MTS HTTP status is not successful"],
      [{ accountHash: "ABCDEF0123456789ABCD" }, "accountHash has an unsupported value"],
      [{ payloadBase64: "not base64!" }, "payloadBase64 is not canonical base64"],
      [{ payloadBase64: "QR==" }, "payloadBase64 is not canonical base64"],
      [{ payloadBase64: "QUFB" }, "MTS payload is truncated"],
    ] as const) {
      expect(() =>
        sbiDomesticCashPositions.parse(
          encoded({ ...boundary("domestic-cash-positions"), ...wrapper }),
          meta,
        ),
      ).toThrow(message);
    }
  });

  test("count fields are bounded and bytes must decode as Shift-JIS", () => {
    expect(withPayload((payload) => payload.set(new TextEncoder().encode("1001"), 30))).toThrow(
      "MTS count fields exceed the parser bound",
    );
    expect(withPayload((payload) => payload.set(new TextEncoder().encode("00x"), 27))).toThrow(
      "totalCount is not an integer field",
    );
    expect(withPayload((payload) => payload.set([0xfd], RECORD + 8))).toThrow(
      "record[0].issueName is not valid Shift-JIS",
    );
  });

  test("record codes, markets, deposit types and quantities are closed sets", () => {
    expect(field(0, 5, "12a4")).toThrow("record[0].code is unsupported");
    expect(field(5, 3, "ZZZ")).toThrow("record[0].market is unsupported");
    expect(field(8, 40, "")).toThrow("record[0].issueName is empty");
    expect(field(48, 1, "Z")).toThrow("record[0].depositTypeCode is unsupported");
    expect(field(57, 16, "1.2.3")).toThrow("record[0].quantity is not an exact decimal");
    expect(field(107, 11, "n/a")).toThrow(
      "record[0].profitLossRate is not a supported display number",
    );
    expect(field(141, 1, "X")).toThrow("presentValueTrend has an unsupported display-trend flag");
  });

  test("signed money accepts one sign marker and refuses conflicting ones", () => {
    expect(valuation(field(91, 16, "(300)"), "profit_loss")?.amountMinor).toBe(-300);
    const sjis = (text: string) => [...new TextEncoder().encode(text)];
    const BLACK_TRIANGLE = [0x81, 0xa3]; // ▲ in Shift-JIS
    const WHITE_TRIANGLE = [0x81, 0xa2]; // △ in Shift-JIS
    const YEN = [0x89, 0x7e]; // 円 in Shift-JIS
    expect(
      valuation(field(91, 16, [...BLACK_TRIANGLE, ...sjis("300")]), "profit_loss")?.amountMinor,
    ).toBe(-300);
    expect(valuation(field(91, 16, [...sjis("300"), ...YEN]), "profit_loss")?.amountMinor).toBe(
      300,
    );
    for (const value of [
      [...sjis("("), ...WHITE_TRIANGLE, ...sjis("300)")],
      sjis("(-300)"),
      sjis("--300"),
      sjis("+-300"),
      sjis("(300"),
    ]) {
      expect(field(91, 16, value)).toThrow("record[0].profitLoss has conflicting sign data");
    }
    expect(field(91, 16, "300.5")).toThrow(
      "record[0].profitLoss is not exactly representable in JPY minor units",
    );
  });

  test("market value must be whole yen; unit prices keep sub-yen text", () => {
    expect(field(315, 15, "100.5")).toThrow(
      "record[0].valuationPrice is not exactly representable in JPY minor units",
    );
    const kaitsuke = valuation(field(299, 16, "901.25"), "kaitsuke_price");
    expect(kaitsuke).toMatchObject({ amountText: "901.25", amountScale: 2 });
    expect(kaitsuke?.amountMinor).toBeUndefined();
    expect(field(299, 16, "--")).toThrow("record[0].kaitsukePrice must be an exact decimal");
  });

  test("trailers are accepted only in the observed layouts", () => {
    const errorBlock = (code: string) => {
      const block = new Uint8Array(207).fill(0x20);
      block.set(new TextEncoder().encode(`0${code}`));
      return block;
    };
    expect(append(errorBlock("000000"))().observations).toHaveLength(7);
    expect(append(errorBlock("      "))().observations).toHaveLength(7);
    expect(append(errorBlock("000123"))).toThrow("MTS trailing error is not successful");
    expect(append(new Uint8Array(631).fill(0x20))().observations).toHaveLength(7);
    expect(append(new Uint8Array(1).fill(0x20))).toThrow(
      "MTS payload length disagrees with recordCount",
    );
    expect(field(390, 1, "Z")).toThrow(
      "valuationChangeTrend has an unsupported display-trend flag",
    );
  });
});
