import type { ArtifactMeta, Observation, Parser, ParseResult } from "../types.ts";
import { decimalText, decodeUtf8 } from "./util.ts";
import { exactKeys, exactMoney, strictObject, strictSafeInteger, strictString } from "./sbi-strict.ts";

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

function signedMoney(value: string, flag: string, label: string) {
  if (!new Set(["", "0", "1", "2", "+", "-"]).has(flag)) {
    throw new Error(`${label} has an unsupported sign flag`);
  }
  const explicitNegative = /^(?:-|△|▲|\()/u.test(value.trim());
  const negativeFlag = flag === "2" || flag === "-";
  const positiveFlag = flag === "1" || flag === "+";
  if (positiveFlag && explicitNegative) throw new Error(`${label} has conflicting sign data`);
  const unitless = value.replace(/円$/u, "").trim();
  return exactMoney(negativeFlag && !explicitNegative ? `-${unitless}` : unitless, "JPY", label);
}

function yenMoney(value: string, label: string) {
  return exactMoney(value.replace(/円$/u, "").trim(), "JPY", label);
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
    if (body["format"] !== "sbi-mts-fixed-width-shift-jis") throw new Error("unsupported MTS format");
    if (body["trCode"] !== "F2631") throw new Error("unexpected MTS transaction code");
    if (body["resultCode"] !== "000000") throw new Error("MTS result is not successful");
    if (strictSafeInteger(body["httpStatus"], "httpStatus") !== 200) throw new Error("MTS HTTP status is not successful");
    strictString(body["accountHash"], "accountHash", { max: 64, pattern: /^[a-f0-9]{20,64}$/u });
    const payload = decodeBase64(strictString(body["payloadBase64"], "payloadBase64", { max: 10_000_000 }));
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
    if (pageIndex + recordCount < totalCount) throw new Error("MTS positions payload is incomplete");

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
      const profitLossFlag = reader.text(1, `${label}.profitLossFlag`);
      const priceText = reader.text(11, `${label}.price`);
      reader.skip(11, `${label}.reservedPrice`);
      const presentValueFlag = reader.text(1, `${label}.presentValueFlag`);
      if (!new Set(["", "0", "1", "2", "+", "-"]).has(presentValueFlag)) {
        throw new Error(`${label}.presentValueFlag is unsupported`);
      }
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
      const purchasePriceText = reader.text(16, `${label}.purchasePrice`);
      const valuationPriceText = reader.text(15, `${label}.valuationPrice`);
      reader.skip(30, `${label}.reserved13`);
      const valuationChangeText = reader.text(30, `${label}.valuationChange`);
      const valuationChangeFlag = reader.text(1, `${label}.valuationChangeFlag`);
      reader.skip(1, `${label}.reserved14`);
      reader.skip(1, `${label}.reserved15`);
      const holdingCategory = reader.text(4, `${label}.holdingCategory`);
      reader.skip(6, `${label}.reserved16`);
      const accountInformation = reader.text(20, `${label}.accountInformation`);
      if (reader.position !== recordOffset + RECORD_BYTES) throw new Error(`${label} width invariant failed`);

      const locator = `mts-shift-jis:payload-byte=${recordOffset}`;
      const context = {
        depositTypeCode,
        depositTypeText,
        unexecutedQuantity,
        profitLossRateText,
        profitLossFlag,
        presentValueFlag,
        valuationChangeText,
        valuationChangeFlag,
        holdingCategory,
        accountInformation,
        _kogane: { accountType, marketCode },
      };
      observations.push({
        kind: "position",
        sourceAccount: SOURCE_ACCOUNT,
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
        ["profit_loss", signedMoney(profitLossText, profitLossFlag, `${label}.profitLoss`)],
        ["current_price", yenMoney(priceText, `${label}.price`)],
        ["acquisition_price", yenMoney(purchasePriceText, `${label}.purchasePrice`)],
        ["market_value", yenMoney(valuationPriceText, `${label}.valuationPrice`)],
        [
          "valuation_change",
          signedMoney(
            valuationChangeText.split("(")[0] ?? valuationChangeText,
            valuationChangeFlag,
            `${label}.valuationChange`,
          ),
        ],
      ] as const;
      for (const [metric, amount] of valuations) {
        observations.push({
          kind: "valuation",
          sourceAccount: SOURCE_ACCOUNT,
          subject: code,
          metric,
          amountMinor: amount.minor,
          amountText: amount.text,
          amountScale: amount.scale,
          currency: "JPY",
          rawLocator: locator,
          extra: context,
        });
      }
    }
    const totalProfitLoss = reader.text(17, "totalProfitLoss");
    const totalProfitLossRate = reader.text(11, "totalProfitLossRate");
    const totalProfitLossFlag = reader.text(1, "totalProfitLossFlag");
    signedMoney(totalProfitLoss, totalProfitLossFlag, "totalProfitLoss");
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
