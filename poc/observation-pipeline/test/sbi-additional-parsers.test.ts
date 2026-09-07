import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactMeta, Parser } from "../src/types.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import { sbiAccountAssetsCurrent } from "../src/parsers/sbi-account-assets-current.ts";
import { sbiDomesticCashPositions } from "../src/parsers/sbi-domestic-cash-positions.ts";
import { sbiForeignTradeRecords } from "../src/parsers/sbi-foreign-trade-records.ts";
import { sbiYenDetailHistory } from "../src/parsers/sbi-yen-detail-history.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "sbi-parser-boundaries");

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

function fixture(name: string): Uint8Array {
  return readFileSync(join(FIXTURES, `${name}.json`));
}

function parsedFixture(name: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixture(name))) as Record<string, unknown>;
}

function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const CASES: readonly [string, Parser][] = [
  ["domestic-cash-positions", sbiDomesticCashPositions],
  ["account-assets-current", sbiAccountAssetsCurrent],
  ["yen-detail-history", sbiYenDetailHistory],
  ["foreign-trade-records", sbiForeignTradeRecords],
];

describe("SBI additional parser registry and determinism", () => {
  test("all four source-specific parsers are registered exactly once", () => {
    for (const [dataset, parser] of CASES) {
      expect(PARSERS.filter((candidate) => candidate === parser)).toHaveLength(1);
      expect(parser.accepts(artifact(dataset))).toBe(true);
      expect(parser.accepts(artifact("not-this-dataset"))).toBe(false);
    }
  });

  test("the same bytes and metadata always produce identical results", () => {
    for (const [dataset, parser] of CASES) {
      const bytes = fixture(dataset);
      expect(parser.parse(bytes, artifact(dataset))).toEqual(
        parser.parse(bytes, artifact(dataset)),
      );
    }
  });
});

describe("sbi-domestic-cash-positions", () => {
  const meta = artifact("domestic-cash-positions");

  test("decodes fixed-width Shift-JIS positions with byte provenance", () => {
    const result = sbiDomesticCashPositions.parse(fixture(meta.dataset!), meta);
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(7);
    const position = result.observations[0]!;
    expect(position.kind).toBe("position");
    if (position.kind !== "position") throw new Error("expected position");
    expect(position.securityCode).toBe("1234");
    expect(position.securityName).toBe("合成株式会社");
    expect(position.market).toBe("XTKS");
    expect(position.quantityText).toBe("10");
    expect(position.sourceAccount).toBe("sbi-securities:domestic:deposit-type=0");
    expect(position.rawLocator).toBe("mts-shift-jis:payload-byte=34,width=423");
    expect(position.extra).toMatchObject({
      profitLossTrend: "U",
      currentPriceTrend: "F",
      valuationChangeTrend: "D",
    });
    const profitLoss = result.observations.find(
      (entry) => entry.kind === "valuation" && entry.metric === "profit_loss",
    );
    expect(profitLoss?.kind === "valuation" ? profitLoss.amountMinor : undefined).toBe(300);
    const acquisition = result.observations.find(
      (entry) => entry.kind === "valuation" && entry.metric === "acquisition_unit_price",
    );
    expect(acquisition?.kind === "valuation" ? acquisition.amountText : undefined).toBe("900.5");
    expect(acquisition?.kind === "valuation" ? acquisition.amountMinor : undefined).toBeUndefined();
    const current = result.observations.find(
      (entry) => entry.kind === "valuation" && entry.metric === "current_price",
    );
    expect(current?.kind === "valuation" ? current.amountMinor : undefined).toBe(1200);
    expect(current?.rawLocator).toBe("mts-shift-jis:payload-byte=164,width=11");
    const kaitsuke = result.observations.find(
      (entry) => entry.kind === "valuation" && entry.metric === "kaitsuke_price",
    );
    expect(kaitsuke?.kind === "valuation" ? kaitsuke.amountMinor : undefined).toBe(901);
    const change = result.observations.find(
      (entry) => entry.kind === "valuation" && entry.metric === "valuation_change",
    );
    expect(change?.kind === "valuation" ? change.amountMinor : undefined).toBe(-100);
  });

  test("display trends are strict metadata and never invent the amount sign", () => {
    const body = parsedFixture(meta.dataset!);
    const payload = Uint8Array.from(atob(body["payloadBase64"] as string), (value) =>
      value.charCodeAt(0),
    );
    payload.set(new TextEncoder().encode("-300".padEnd(16, " ")), 34 + 91);
    body["payloadBase64"] = btoa(String.fromCharCode(...payload));
    const result = sbiDomesticCashPositions.parse(encoded(body), meta);
    const profitLoss = result.observations.find(
      (entry) => entry.kind === "valuation" && entry.metric === "profit_loss",
    );
    expect(profitLoss?.kind === "valuation" ? profitLoss.amountMinor : undefined).toBe(-300);

    payload[34 + 118] = "1".charCodeAt(0);
    body["payloadBase64"] = btoa(String.fromCharCode(...payload));
    expect(() => sbiDomesticCashPositions.parse(encoded(body), meta)).toThrow(
      "unsupported display-trend flag",
    );
  });

  test("an unavailable current-price display does not become a zero valuation", () => {
    const body = parsedFixture(meta.dataset!);
    const payload = Uint8Array.from(atob(body["payloadBase64"] as string), (value) =>
      value.charCodeAt(0),
    );
    payload.set(new TextEncoder().encode("--".padEnd(11, " ")), 34 + 130);
    body["payloadBase64"] = btoa(String.fromCharCode(...payload));

    const result = sbiDomesticCashPositions.parse(encoded(body), meta);
    expect(
      result.observations.some(
        (entry) => entry.kind === "valuation" && entry.metric === "current_price",
      ),
    ).toBe(false);
    expect(result.observations[0]?.extra).toMatchObject({ currentPriceText: "--" });
  });

  test("deposit type is part of the position/valuation join identity", () => {
    const body = parsedFixture(meta.dataset!);
    const payload = Uint8Array.from(atob(body["payloadBase64"] as string), (value) =>
      value.charCodeAt(0),
    );
    const prefix = payload.slice(0, 34);
    prefix.set(new TextEncoder().encode("002"), 27);
    prefix.set(new TextEncoder().encode("0002"), 30);
    const first = payload.slice(34, 34 + 423);
    const second = first.slice();
    second[48] = "H".charCodeAt(0);
    const summary = payload.slice(34 + 423);
    const combined = new Uint8Array(prefix.length + first.length + second.length + summary.length);
    combined.set(prefix);
    combined.set(first, prefix.length);
    combined.set(second, prefix.length + first.length);
    combined.set(summary, prefix.length + first.length + second.length);
    body["payloadBase64"] = btoa(String.fromCharCode(...combined));

    const result = sbiDomesticCashPositions.parse(encoded(body), meta);
    const positions = result.observations.filter((entry) => entry.kind === "position");
    expect(positions).toHaveLength(2);
    expect(positions[0]?.sourceAccount).not.toBe(positions[1]?.sourceAccount);
    for (const position of positions) {
      expect(
        result.observations.filter(
          (entry) =>
            entry.kind === "valuation" &&
            entry.sourceAccount === position?.sourceAccount &&
            entry.subject === position.securityCode,
        ),
      ).toHaveLength(6);
    }
  });

  test("recordCount/byte-length drift fails the whole artifact", () => {
    const body = parsedFixture(meta.dataset!);
    const binary = atob(body["payloadBase64"] as string);
    const changed = `${binary.slice(0, 30)}0002${binary.slice(34)}`;
    body["payloadBase64"] = btoa(changed);
    expect(() => sbiDomesticCashPositions.parse(encoded(body), meta)).toThrow(
      "payload length disagrees",
    );
  });

  test("a suffix-only positions page cannot masquerade as a complete account state", () => {
    const body = parsedFixture(meta.dataset!);
    const payload = Uint8Array.from(atob(body["payloadBase64"] as string), (value) =>
      value.charCodeAt(0),
    );
    payload.set(new TextEncoder().encode("001"), 24);
    payload.set(new TextEncoder().encode("002"), 27);
    body["payloadBase64"] = btoa(String.fromCharCode(...payload));
    expect(() => sbiDomesticCashPositions.parse(encoded(body), meta)).toThrow(
      "positions payload is incomplete",
    );
  });

  test("wrapper drift is rejected rather than partially parsed", () => {
    const body = { ...parsedFixture(meta.dataset!), futureField: true };
    expect(() => sbiDomesticCashPositions.parse(encoded(body), meta)).toThrow("schema drift");
  });

  test("the observed bounded zero-position message layout is accepted as empty", () => {
    const prefix = `${" ".repeat(24)}0000000000`;
    const body = parsedFixture(meta.dataset!);
    body["payloadBase64"] = btoa(prefix + " ".repeat(660));
    expect(sbiDomesticCashPositions.parse(encoded(body), meta)).toEqual({
      observations: [],
      warnings: [],
    });
    body["payloadBase64"] = btoa(prefix + " ".repeat(659));
    expect(() => sbiDomesticCashPositions.parse(encoded(body), meta)).toThrow(
      "empty-result layout",
    );
  });
});

describe("sbi-account-assets-current", () => {
  const meta = artifact("account-assets-current");

  test("emits provider valuations for each distinct view and category", () => {
    const result = sbiAccountAssetsCurrent.parse(fixture(meta.dataset!), meta);
    expect(result.warnings).toEqual([]);
    expect(result.observations.every((entry) => entry.kind === "valuation")).toBe(true);
    expect(
      result.observations.some(
        (entry) =>
          entry.kind === "valuation" &&
          entry.subject === "portfolio:summaryDetails:DOMESTIC_STOCK" &&
          entry.metric === "valuation" &&
          entry.amountMinor === 111000,
      ),
    ).toBe(true);
  });

  test("duplicate categories do not create ambiguous semantic identities", () => {
    const body = parsedFixture(meta.dataset!);
    const rows = body["summaryDetails"] as unknown[];
    rows.push(structuredClone(rows[0]));
    expect(() => sbiAccountAssetsCurrent.parse(encoded(body), meta)).toThrow("repeats category");
  });

  test("unknown fields and fractional JPY values fail closed", () => {
    const unknown = parsedFixture(meta.dataset!);
    (unknown["summary"] as Record<string, unknown>)["futureField"] = 1;
    expect(() => sbiAccountAssetsCurrent.parse(encoded(unknown), meta)).toThrow("schema drift");
    const fractional = parsedFixture(meta.dataset!);
    (fractional["summary"] as Record<string, unknown>)["valuation"] = 1.5;
    expect(() => sbiAccountAssetsCurrent.parse(encoded(fractional), meta)).toThrow(
      "must be an exact decimal",
    );
  });
});

describe("sbi-yen-detail-history", () => {
  const meta = artifact("yen-detail-history");

  test("maps exact provider ids, dates, directions, and transaction types", () => {
    const result = sbiYenDetailHistory.parse(fixture(meta.dataset!), meta);
    expect(result.observations).toHaveLength(2);
    const [credit, debit] = result.observations;
    expect(credit?.kind === "transaction" ? credit.externalId : undefined).toBe(
      "sbi-yen-detail:10001",
    );
    expect(credit?.kind === "transaction" ? credit.asOf : undefined).toBe("2026-08-18");
    expect(credit?.extra["_kogane"]).toEqual({
      direction: "credit",
      transactionType: "transfer",
      bundlePageIndex: 0,
      providerPageNumber: 1,
    });
    expect(debit?.extra["_kogane"]).toEqual({
      direction: "debit",
      transactionType: "withdrawal",
      bundlePageIndex: 0,
      providerPageNumber: 1,
    });
  });

  test("duplicate provider ids, truncation, unknown enums, and row count drift fail closed", () => {
    const duplicate = parsedFixture(meta.dataset!);
    const duplicatePage = (duplicate["pages"] as Array<Record<string, unknown>>)[0]!;
    const records = duplicatePage["depositRecordList"] as Array<Record<string, unknown>>;
    records[1]!["did"] = records[0]!["did"];
    expect(() => sbiYenDetailHistory.parse(encoded(duplicate), meta)).toThrow("duplicate");

    const truncated = parsedFixture(meta.dataset!);
    truncated["complete"] = false;
    expect(() => sbiYenDetailHistory.parse(encoded(truncated), meta)).toThrow("incomplete");

    const enumDrift = parsedFixture(meta.dataset!);
    const enumPage = (enumDrift["pages"] as Array<Record<string, unknown>>)[0]!;
    (enumPage["depositRecordList"] as Array<Record<string, unknown>>)[0]!["payDepKbn"] = "他";
    expect(() => sbiYenDetailHistory.parse(encoded(enumDrift), meta)).toThrow("unsupported value");

    const countDrift = parsedFixture(meta.dataset!);
    countDrift["totalCount"] = 3;
    expect(() => sbiYenDetailHistory.parse(encoded(countDrift), meta)).toThrow(
      "pagination metadata",
    );
  });
});

describe("sbi-foreign-trade-records", () => {
  const meta = artifact("foreign-trade-records");

  test("records amount currency, dates, security identity, and stable occurrence ids", () => {
    const body = parsedFixture(meta.dataset!);
    const page = (body["pages"] as Array<Record<string, unknown>>)[0]!;
    const list = page["listTradeRecords"] as Record<string, unknown>;
    const rows = list["tradeRecords"] as unknown[];
    rows.push(structuredClone(rows[0]));
    const result = sbiForeignTradeRecords.parse(encoded(body), meta);
    expect(result.observations).toHaveLength(2);
    const [first, second] = result.observations;
    if (first?.kind !== "transaction" || second?.kind !== "transaction") {
      throw new Error("expected transactions");
    }
    expect(first.amountMinor).toBe(12050);
    expect(first.currency).toBe("USD");
    expect(first.asOf).toBe("2026-08-18");
    expect(first.externalId).not.toBe(second.externalId);
    expect(first.externalId?.replace(/:0$/u, "")).toBe(second.externalId?.replace(/:1$/u, ""));
    expect(first.extra["_kogane"]).toMatchObject({
      transactionType: "BUY",
      tradeCurrency: "USD",
      quantityText: "10",
    });
  });

  test("missing pages, broken continuation, schema drift, and precision loss fail closed", () => {
    const continuation = parsedFixture(meta.dataset!);
    const page = (continuation["pages"] as Array<Record<string, unknown>>)[0]!;
    const list = page["listTradeRecords"] as Record<string, unknown>;
    (list["page"] as Record<string, unknown>)["hasNextPage"] = true;
    expect(() => sbiForeignTradeRecords.parse(encoded(continuation), meta)).toThrow("pagination");

    const schema = parsedFixture(meta.dataset!);
    const schemaPage = (schema["pages"] as Array<Record<string, unknown>>)[0]!;
    const schemaList = schemaPage["listTradeRecords"] as Record<string, unknown>;
    (schemaList["tradeRecords"] as Array<Record<string, unknown>>)[0]!["futureField"] = true;
    expect(() => sbiForeignTradeRecords.parse(encoded(schema), meta)).toThrow("schema drift");

    const precision = parsedFixture(meta.dataset!);
    const precisionPage = (precision["pages"] as Array<Record<string, unknown>>)[0]!;
    const precisionList = precisionPage["listTradeRecords"] as Record<string, unknown>;
    (precisionList["tradeRecords"] as Array<Record<string, unknown>>)[0]!["amount"] = "1.001";
    expect(() => sbiForeignTradeRecords.parse(encoded(precision), meta)).toThrow(
      "not exactly representable",
    );
  });
});
