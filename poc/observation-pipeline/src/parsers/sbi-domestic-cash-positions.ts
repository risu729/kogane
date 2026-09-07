import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { decimalText, decimalToMinorUnits, decodeUtf8 } from "./util.ts";
import {
  exactDecimal,
  exactKeys,
  exactMoney,
  strictObject,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";

const SOURCE_ACCOUNT = "sbi-securities:domestic";
const WRAPPER_KEYS = [
  "accountHash",
  "format",
  "httpStatus",
  "payloadBase64",
  "resultCode",
  "trCode",
] as const;
const MARKET: Readonly<Record<string, string>> = {
  TKY: "XTKS",
  NGY: "XNGO",
  FKO: "XFKA",
  SPR: "XSAP",
};
const DEPOSIT_TYPES: Readonly<Record<string, string>> = {
  "0": "specific",
  "1": "general",
  "-": "general",
  H: "growth-investment",
  "4": "nisa",
  "5": "junior-nisa",
  "6": "junior-nisa",
  "7": "junior-nisa",
  J: "junior-nisa",
};
const RECORD_BYTES = 423;
const PREFIX_BYTES = 34;
const SUMMARY_BYTES = 29;
const ERROR_BYTES = 207;
const EMPTY_RESULT_BYTES = 660;
const OBSERVED_SUCCESS_TRAILER_BYTES = 631;

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("payloadBase64 is not canonical base64");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (btoa(binary) !== value) throw new Error("payloadBase64 is not canonical base64");
  return bytes;
}

class FixedReader {
  private offset = 0;
  private readonly decoder = new TextDecoder("shift_jis", { fatal: true });

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  text(width: number, label: string): string {
    if (this.offset + width > this.bytes.length) throw new Error(`${label} is truncated`);
    let value: string;
    try {
      value = this.decoder.decode(this.bytes.subarray(this.offset, this.offset + width));
    } catch {
      throw new Error(`${label} is not valid Shift-JIS`);
    }
    this.offset += width;
    return value.replaceAll("\0", "").trim();
  }

  skip(width: number, label: string): void {
    this.text(width, label);
  }

  integer(width: number, label: string): number {
    const value = this.text(width, label);
    if (!/^\d+$/u.test(value)) throw new Error(`${label} is not an integer field`);
    return Number(value);
  }
}

function displayTrend(value: string, label: string): "U" | "D" | "F" {
  if (value !== "U" && value !== "D" && value !== "F") {
    throw new Error(`${label} has an unsupported display-trend flag`);
  }
  return value;
}

function signedMoney(value: string, label: string) {
  let unitless = value.replace(/円$/u, "").trim();
  let negative = false;
  if (/^\(.*\)$/u.test(unitless)) {
    negative = true;
    unitless = unitless.slice(1, -1).trim();
  }
  if (unitless.startsWith("△") || unitless.startsWith("▲")) {
    if (negative) throw new Error(`${label} has conflicting sign data`);
    negative = true;
    unitless = unitless.slice(1).trim();
  } else if (unitless.startsWith("-")) {
    if (negative) throw new Error(`${label} has conflicting sign data`);
    negative = true;
    unitless = unitless.slice(1).trim();
  } else if (unitless.startsWith("+")) {
    unitless = unitless.slice(1).trim();
  }
  if (/^(?:[+\-△▲]|\(|\))/u.test(unitless)) {
    throw new Error(`${label} has conflicting sign data`);
  }
  return exactMoney(`${negative ? "-" : ""}${unitless}`, "JPY", label);
}

function yenMoney(value: string, label: string, requireMinor = true) {
  const decimal = exactDecimal(value.replace(/円$/u, "").trim(), label);
  const minor = decimalToMinorUnits(decimal.text, "JPY");
  if (requireMinor && minor === undefined) {
    throw new Error(`${label} is not exactly representable in JPY minor units`);
  }
  return { ...decimal, minor };
}

function unitPrice(value: string, label: string) {
  // The provider uses `--` in the eleven-byte field when no unit price is
  // currently displayable. Preserve the source text in `extra`, but do not
  // manufacture a zero-valued observation.
  if (value === "--") return undefined;
  return yenMoney(value, label, false);
}

function displayNumber(value: string, label: string): void {
  if (!/^(?:[+\-△▲])?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?%?$/u.test(value)) {
    throw new Error(`${label} is not a supported display number`);
  }
}

function issueName(value: string): string {
  const parts = value.trim().split(/\s+/u);
  return parts.length > 1 ? parts.slice(1).join(" ") : value.trim();
}

export const sbiDomesticCashPositions: Parser = {
  name: "sbi-domestic-cash-positions",
  version: "1.0.0",

  accepts(artifact: ArtifactMeta): boolean {
    return artifact.sourceId === "sbi-securities" && artifact.dataset === "domestic-cash-positions";
  },

  parse(bytes: Uint8Array): ParseResult {
    const body = strictObject(JSON.parse(decodeUtf8(bytes)), "domestic-cash-positions");
    exactKeys(body, WRAPPER_KEYS, "domestic-cash-positions");
    if (body["format"] !== "sbi-mts-fixed-width-shift-jis")
      throw new Error("unsupported MTS format");
    if (body["trCode"] !== "F2631") throw new Error("unexpected MTS transaction code");
    if (body["resultCode"] !== "000000") throw new Error("MTS result is not successful");
    if (strictSafeInteger(body["httpStatus"], "httpStatus") !== 200)
      throw new Error("MTS HTTP status is not successful");
    strictString(body["accountHash"], "accountHash", { max: 64, pattern: /^[a-f0-9]{20,64}$/u });
    const payload = decodeBase64(
      strictString(body["payloadBase64"], "payloadBase64", { max: 10_000_000 }),
    );
    if (payload.length < PREFIX_BYTES + SUMMARY_BYTES) throw new Error("MTS payload is truncated");
    const reader = new FixedReader(payload);
    reader.skip(12, "account prefix");
    reader.skip(12, "account suffix");
    const pageIndex = reader.integer(3, "index");
    const totalCount = reader.integer(3, "totalCount");
    const recordCount = reader.integer(4, "recordCount");
    if (recordCount > 1_000 || totalCount > 1_000 || pageIndex > totalCount) {
      throw new Error("MTS count fields exceed the parser bound");
    }
    if (recordCount === 0) {
      if (totalCount !== 0 || payload.length !== PREFIX_BYTES + EMPTY_RESULT_BYTES) {
        throw new Error("MTS empty-result layout disagrees with its count fields");
      }
      reader.skip(EMPTY_RESULT_BYTES, "empty-result message block");
      if (reader.remaining !== 0) throw new Error("MTS empty-result payload has trailing bytes");
      return { observations: [], warnings: [] };
    }
    const expectedWithoutError = PREFIX_BYTES + recordCount * RECORD_BYTES + SUMMARY_BYTES;
    if (
      payload.length !== expectedWithoutError &&
      payload.length !== expectedWithoutError + ERROR_BYTES &&
      payload.length !== expectedWithoutError + OBSERVED_SUCCESS_TRAILER_BYTES
    ) {
      throw new Error("MTS payload length disagrees with recordCount");
    }
    if (pageIndex + recordCount < totalCount)
      throw new Error("MTS positions payload is incomplete");

    const observations: Observation[] = [];
    for (let index = 0; index < recordCount; index += 1) {
      const recordOffset = reader.position;
      const label = `record[${index}]`;
      const code = reader.text(5, `${label}.code`);
      if (!/^\d{4,5}$/u.test(code)) throw new Error(`${label}.code is unsupported`);
      const marketCode = reader.text(3, `${label}.market`);
      const market = MARKET[marketCode];
      if (!market) throw new Error(`${label}.market is unsupported`);
      const rawIssueName = reader.text(40, `${label}.issueName`);
      if (!rawIssueName) throw new Error(`${label}.issueName is empty`);
      const depositTypeCode = reader.text(1, `${label}.depositTypeCode`);
      const accountType = DEPOSIT_TYPES[depositTypeCode];
      if (!accountType) throw new Error(`${label}.depositTypeCode is unsupported`);
      const depositTypeText = reader.text(8, `${label}.depositTypeText`);
      const quantityText = reader.text(16, `${label}.quantity`);
      const quantity = decimalText(quantityText.replace(/株$/u, "").trim());
      if (!quantity) throw new Error(`${label}.quantity is not an exact decimal`);
      const unexecutedQuantity = reader.text(18, `${label}.unexecutedQuantity`);
      const profitLossText = reader.text(16, `${label}.profitLoss`);
      const profitLossRateText = reader.text(11, `${label}.profitLossRate`);
      displayNumber(profitLossRateText, `${label}.profitLossRate`);
      const profitLossTrend = displayTrend(
        reader.text(1, `${label}.profitLossTrend`),
        `${label}.profitLossTrend`,
      );
      const acquisitionUnitPriceText = reader.text(11, `${label}.price`);
      const currentPriceText = reader.text(11, `${label}.presentValue`);
      const currentPriceTrend = displayTrend(
        reader.text(1, `${label}.presentValueTrend`),
        `${label}.presentValueTrend`,
      );
      reader.skip(30, `${label}.reserved01`);
      reader.skip(1, `${label}.reserved02`);
      reader.skip(2, `${label}.reserved03`);
      reader.skip(5, `${label}.reserved04`);
      reader.skip(25, `${label}.reserved05`);
      reader.skip(11, `${label}.reserved06`);
      reader.skip(8, `${label}.reserved07`);
      reader.skip(8, `${label}.reserved08`);
      reader.skip(1, `${label}.reserved09`);
      reader.skip(9, `${label}.reserved10`);
      reader.skip(21, `${label}.reserved11`);
      reader.skip(36, `${label}.reserved12`);
      const kaitsukePriceText = reader.text(16, `${label}.kaitsukePrice`);
      const valuationPriceText = reader.text(15, `${label}.valuationPrice`);
      reader.skip(30, `${label}.reserved13`);
      const valuationChangeText = reader.text(30, `${label}.valuationChange`);
      const valuationChangeTrend = displayTrend(
        reader.text(1, `${label}.valuationChangeTrend`),
        `${label}.valuationChangeTrend`,
      );
      reader.skip(1, `${label}.reserved14`);
      reader.skip(1, `${label}.reserved15`);
      const holdingCategory = reader.text(4, `${label}.holdingCategory`);
      reader.skip(6, `${label}.reserved16`);
      const accountInformation = reader.text(20, `${label}.accountInformation`);
      if (reader.position !== recordOffset + RECORD_BYTES)
        throw new Error(`${label} width invariant failed`);

      const sourceAccount = `${SOURCE_ACCOUNT}:deposit-type=${depositTypeCode}`;
      const locator = `mts-shift-jis:payload-byte=${recordOffset},width=${RECORD_BYTES}`;
      const context = {
        depositTypeCode,
        depositTypeText,
        unexecutedQuantity,
        profitLossText,
        profitLossRateText,
        profitLossTrend,
        acquisitionUnitPriceText,
        currentPriceText,
        currentPriceTrend,
        kaitsukePriceText,
        valuationPriceText,
        valuationChangeText,
        valuationChangeTrend,
        holdingCategory,
        accountInformation,
        _kogane: { accountType, marketCode },
      };
      observations.push({
        kind: "position",
        sourceAccount,
        securityCode: code,
        securityName: issueName(rawIssueName),
        market,
        quantityText: quantity.text,
        quantityScale: quantity.scale,
        currency: "JPY",
        rawLocator: locator,
        extra: context,
      });
      const valuations = [
        ["profit_loss", signedMoney(profitLossText, `${label}.profitLoss`), 91, 16],
        ["acquisition_unit_price", unitPrice(acquisitionUnitPriceText, `${label}.price`), 119, 11],
        ["current_price", unitPrice(currentPriceText, `${label}.presentValue`), 130, 11],
        ["kaitsuke_price", yenMoney(kaitsukePriceText, `${label}.kaitsukePrice`, false), 299, 16],
        ["market_value", yenMoney(valuationPriceText, `${label}.valuationPrice`), 315, 15],
        [
          "valuation_change",
          signedMoney(
            valuationChangeText.split("(")[0] ?? valuationChangeText,
            `${label}.valuationChange`,
          ),
          360,
          30,
        ],
      ] as const;
      for (const [metric, amount, relativeOffset, width] of valuations) {
        if (!amount) continue;
        observations.push({
          kind: "valuation",
          sourceAccount,
          subject: code,
          metric,
          ...(amount.minor === undefined ? {} : { amountMinor: amount.minor }),
          amountText: amount.text,
          amountScale: amount.scale,
          currency: "JPY",
          rawLocator: `mts-shift-jis:payload-byte=${recordOffset + relativeOffset},width=${width}`,
          extra: context,
        });
      }
    }
    const totalProfitLoss = reader.text(17, "totalProfitLoss");
    const totalProfitLossRate = reader.text(11, "totalProfitLossRate");
    const totalProfitLossFlag = reader.text(1, "totalProfitLossFlag");
    displayTrend(totalProfitLossFlag, "totalProfitLossTrend");
    signedMoney(totalProfitLoss, "totalProfitLoss");
    displayNumber(totalProfitLossRate, "totalProfitLossRate");
    if (reader.remaining === ERROR_BYTES) {
      reader.text(1, "trailing.status");
      const code = reader.text(6, "trailing.code");
      reader.text(200, "trailing.message");
      if (code !== "" && code !== "000000") throw new Error("MTS trailing error is not successful");
    } else if (reader.remaining === OBSERVED_SUCCESS_TRAILER_BYTES) {
      reader.skip(OBSERVED_SUCCESS_TRAILER_BYTES, "observed success trailer");
    }
    if (reader.remaining !== 0) throw new Error("MTS payload has trailing bytes");
    return { observations, warnings: [] };
  },
};
