import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactMeta } from "../src/types.ts";
import {
  amountToMinorUnits,
  decimalText,
  decimalToMinorUnits,
  parseCsv,
} from "../src/parsers/util.ts";
import { sbiDomesticTradeRecords } from "../src/parsers/sbi-domestic-trade-records.ts";
import { sbiForeignCashPositions } from "../src/parsers/sbi-foreign-cash-positions.ts";
import { sbiForeignCashBalances } from "../src/parsers/sbi-foreign-cash-balances.ts";
import { paypayCsv } from "../src/parsers/paypay-csv.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const SBI_RUN = join(
  FIXTURES,
  "sbi-securities",
  "2026-08-20",
  "run-20260820-210000-poc01",
);

function artifact(overrides: Partial<ArtifactMeta>): ArtifactMeta {
  return {
    id: 1,
    sourceId: "sbi-securities",
    dataset: null,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-08-20T21:01:42Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

describe("value helpers", () => {
  test("amountToMinorUnits handles JP display formats", () => {
    expect(amountToMinorUnits("1,802", "JPY")).toBe(1802);
    expect(amountToMinorUnits("△100,000", "JPY")).toBe(-100000);
    expect(amountToMinorUnits("(1,000)", "JPY")).toBe(-1000);
    expect(amountToMinorUnits("+300", "JPY")).toBe(300);
    expect(amountToMinorUnits("1,024.53", "USD")).toBe(102453);
    expect(amountToMinorUnits("1.5", "JPY")).toBeUndefined(); // precision loss
    expect(amountToMinorUnits("12.345", "USD")).toBeUndefined();
    expect(amountToMinorUnits("", "JPY")).toBeUndefined();
    expect(amountToMinorUnits("N/A", "JPY")).toBeUndefined();
    expect(amountToMinorUnits("100", "XYZ")).toBeUndefined(); // unknown currency
  });

  test("decimalText refuses float-derived values", () => {
    expect(decimalText("1,234.56")).toEqual({ text: "1234.56", scale: 2 });
    expect(decimalText(12)).toEqual({ text: "12", scale: 0 });
    expect(decimalText(12.5)).toBeUndefined();
    expect(decimalText("abc")).toBeUndefined();
    expect(decimalText(null)).toBeUndefined();
  });

  test("decimalToMinorUnits scales exactly", () => {
    expect(decimalToMinorUnits("1024.53", "USD")).toBe(102453);
    expect(decimalToMinorUnits("-1234.5", "USD")).toBe(-123450);
    expect(decimalToMinorUnits("0.00", "USD")).toBe(0);
    expect(decimalToMinorUnits("231847", "JPY")).toBe(231847);
    expect(decimalToMinorUnits("1.234", "USD")).toBeUndefined();
  });

  test("parseCsv handles quoted fields", () => {
    expect(parseCsv('a,"b,1",c\r\nd,"e""f",')).toEqual([
      ["a", "b,1", "c"],
      ["d", 'e"f', ""],
    ]);
  });
});

describe("sbi-domestic-trade-records", () => {
  const bytes = readFileSync(join(SBI_RUN, "domestic-trade-records.json"));
  const meta = artifact({ dataset: "domestic-trade-records" });

  test("accepts only its dataset", () => {
    expect(sbiDomesticTradeRecords.accepts(meta)).toBe(true);
    expect(
      sbiDomesticTradeRecords.accepts(artifact({ dataset: "foreign-cash-positions" })),
    ).toBe(false);
  });

  test("golden parse of the fixture", () => {
    const result = sbiDomesticTradeRecords.parse(bytes, meta);
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(3);
    const amounts = result.observations.map((observation) =>
      observation.kind === "transaction" ? observation.amountMinor : undefined,
    );
    expect(amounts).toEqual([180200, 252000, -100000]);
    const first = result.observations[0]!;
    if (first.kind !== "transaction") throw new Error("expected transaction");
    expect(first.description).toBe("三菱ＵＦＪフィナンシャル・グループ 8306 東証");
    expect(first.asOf).toBe("2026-08-12");
    expect(first.rawLocator).toBe("json:$.records[0]");
    // never-drop rule: the full record is retained
    expect(first.extra["rawCells"]).toHaveLength(7);
    expect(first.extra["accountLabel"]).toBe("特定");
  });

  test("unparseable amount produces a warning, not a dropped row", () => {
    const body = {
      records: [{ id: "x:1", amount: "unknown", rawCells: ["", "issue", "", "", "", "", ""] }],
      hasMore: true,
    };
    const result = sbiDomesticTradeRecords.parse(
      new TextEncoder().encode(JSON.stringify(body)),
      meta,
    );
    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0]!;
    if (observation.kind !== "transaction") throw new Error("expected transaction");
    expect(observation.amountMinor).toBeUndefined();
    expect(observation.extra["amount"]).toBe("unknown");
    expect(result.warnings.some((warning) => warning.includes("amount"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("hasMore"))).toBe(true);
  });

  test("wrong shape throws (parse run becomes an error)", () => {
    expect(() =>
      sbiDomesticTradeRecords.parse(new TextEncoder().encode("{}"), meta),
    ).toThrow();
  });
});

describe("sbi-foreign-cash-positions", () => {
  const bytes = readFileSync(join(SBI_RUN, "foreign-cash-positions.json"));
  const meta = artifact({ dataset: "foreign-cash-positions" });

  test("golden parse of the fixture", () => {
    const result = sbiForeignCashPositions.parse(bytes, meta);
    expect(result.warnings).toEqual([]);
    const positions = result.observations.filter((o) => o.kind === "position");
    const valuations = result.observations.filter((o) => o.kind === "valuation");
    expect(positions).toHaveLength(2);
    expect(valuations).toHaveLength(8);
    const vt = positions[0]!;
    if (vt.kind !== "position") throw new Error("expected position");
    expect(vt.securityCode).toBe("VT");
    expect(vt.quantityText).toBe("12");
    expect(vt.quantityScale).toBe(0);
    const frn = valuations.find(
      (o) => o.kind === "valuation" && o.subject === "VT" && o.metric === "frn_evaluation_amount",
    );
    if (!frn || frn.kind !== "valuation") throw new Error("expected valuation");
    expect(frn.amountMinor).toBe(156840); // 1568.40 USD in cents
    expect(frn.currency).toBe("USD");
    const jpy = valuations.find(
      (o) => o.kind === "valuation" && o.subject === "VT" && o.metric === "evaluation_amount",
    );
    if (!jpy || jpy.kind !== "valuation") throw new Error("expected valuation");
    expect(jpy.amountMinor).toBe(231847);
    expect(jpy.currency).toBe("JPY");
  });

  test("float quantity is refused with a warning", () => {
    const body = {
      listSecuritiesBalances: {
        securitiesBalances: [
          {
            securitiesQuantity: 1.5,
            currencyCode: "USD",
            securities: { securitiesCode: "FRAC" },
            evaluationProfitLoss: {},
          },
        ],
      },
    };
    const result = sbiForeignCashPositions.parse(
      new TextEncoder().encode(JSON.stringify(body)),
      meta,
    );
    expect(result.observations.filter((o) => o.kind === "position")).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("securitiesQuantity"))).toBe(true);
  });
});

describe("sbi-foreign-cash-balances", () => {
  const bytes = readFileSync(join(SBI_RUN, "foreign-cash-balances.json"));
  const meta = artifact({ dataset: "foreign-cash-balances" });

  test("golden parse of the fixture", () => {
    const result = sbiForeignCashBalances.parse(bytes, meta);
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(10); // 2 schedule rows x 5 metrics
    const first = result.observations[0]!;
    if (first.kind !== "balance") throw new Error("expected balance");
    expect(first.metric).toBe("buy_possible_amount");
    expect(first.amountMinor).toBe(102453);
    expect(first.instrument).toBe("USD");
    expect(first.asOf).toBe("2026-08-20");
    expect(first.extra["accountKind"]).toBe("GENERAL");
  });
});

describe("paypay-csv", () => {
  const bytes = readFileSync(join(FIXTURES, "paypay", "paypay-transactions-202608.csv"));
  const meta = artifact({ sourceId: "paypay", dataset: null, mime: "text/csv" });

  test("golden parse of the fixture", () => {
    const result = paypayCsv.parse(bytes, meta);
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(5);
    const txns = result.observations.map((o) => {
      if (o.kind !== "transaction") throw new Error("expected transaction");
      return o;
    });
    expect(txns.map((t) => t.amountMinor)).toEqual([-1180, 500, -1530, 120, 1180]);
    expect(txns[0]!.asOf).toBe("2026-08-15T12:34:56+09:00");
    expect(txns[3]!.externalId).toBe("lp-0011223344");
    // foreign use stays decomposed, never flattened into the JPY figure
    const overseas = txns[2]!.extra["overseas"] as Record<string, string>;
    expect(overseas["amount"]).toBe("9.99");
    expect(overseas["currency"]).toBe("USD");
    expect(overseas["conversionRateJpy"]).toBe("153.13");
    // refund shares the original payment's transaction number: external ids
    // are evidence, not logical identities
    expect(txns[4]!.externalId).toBe(txns[0]!.externalId);
  });

  test("simultaneous outgoing and incoming amounts are never conflated", () => {
    const csv =
      "取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号\n" +
      "2026/08/01 00:00:00,100,200,,,,,テスト,,,,本人,t-1\n";
    const result = paypayCsv.parse(new TextEncoder().encode(csv), meta);
    const observation = result.observations[0]!;
    if (observation.kind !== "transaction") throw new Error("expected transaction");
    expect(observation.amountMinor).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("not conflated"))).toBe(true);
  });

  test("missing header throws", () => {
    expect(() =>
      paypayCsv.parse(new TextEncoder().encode("a,b,c\n1,2,3\n"), meta),
    ).toThrow();
  });
});
