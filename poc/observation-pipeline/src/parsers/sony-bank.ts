import type { ArtifactMeta, Observation, Parser } from "../types.ts";
import { amountToMinorUnits, decodeUtf8, parseCsv } from "./util.ts";
import {
  exactDecimal,
  exactKeys,
  exactMoney,
  normalizedDate,
  stableFingerprint,
  strictObject,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";

const CURRENCIES = [
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNH",
  "EUR",
  "GBP",
  "HKD",
  "JPY",
  "NZD",
  "SEK",
  "USD",
  "ZAR",
] as const;
const HISTORY_ENVELOPE = [
  "countCnt",
  "errors",
  "responseBizCommon",
  "returnCnt",
  "transactionHistInfo",
] as const;
const FIRST_PAGE_ENVELOPE = [...HISTORY_ENVELOPE, "currencyMst", "ordinaryDepAcInfo"] as const;
const ROW_BASE = [
  "abridgmentObj",
  "additionAndSubtractionSegment",
  "currencyCd",
  "transactionAftBal",
  "transactionAmt",
  "transactionDt",
] as const;
const ROW_EXCHANGE = [...ROW_BASE, "applicationExchRt"] as const;
const ROW_FOREIGN_EXCHANGE = [
  ...ROW_EXCHANGE,
  "currencyCdSpndl",
  "currencyCdStl",
  "otherPrtyCcyCd",
] as const;
const PAGE_SIZE = 3;
const CUSTOMER_DISPLAY_ORDER = "customerDispOrdr";

export const sonyBankGrossBalance: Parser = {
  name: "sony-bank-gross-balance",
  version: "1.0.0",
  accepts: (artifact) => artifact.sourceId === "sony-bank" && artifact.dataset === "gross-balance",
  parse(bytes, artifact) {
    requireJson(artifact);
    const body = strictObject(JSON.parse(decodeUtf8(bytes)), "gross balance");
    exactKeys(
      body,
      [
        "assetBalAcTypTyp",
        "assetTtl",
        "errors",
        "loanBalAcTypTyp",
        "loanTtl",
        "responseBizCommon",
        "updateDttm",
      ],
      "gross balance",
    );
    commonSuccess(body);
    const assets = exactArray(body.assetBalAcTypTyp, 11, "asset balances");
    const loans = exactArray(body.loanBalAcTypTyp, 4, "loan balances");
    const asOf = providerInstant(body.updateDttm, "updateDttm");
    const observations: Observation[] = [];
    const seen = new Set<string>();
    for (const [index, value] of assets.entries()) {
      const row = strictObject(value, `asset balances[${index}]`);
      exactKeys(
        row,
        ["assetAcqRsltFlg", "assetBalance", "assetGrsBalanceAccountType", "assetItmDispFlg"],
        `asset balances[${index}]`,
      );
      const accountType = enumText(
        row.assetGrsBalanceAccountType,
        Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(3, "0")),
        "asset account type",
      );
      unique(seen, accountType, "asset account type");
      enumText(row.assetAcqRsltFlg, ["0", "1"], "asset acquisition flag");
      enumText(row.assetItmDispFlg, ["0", "1"], "asset display flag");
      const money = exactMoney(row.assetBalance, "JPY", "asset balance");
      observations.push(
        balance(
          `sony-bank:gross:asset:${accountType}`,
          "gross_asset_balance",
          money,
          "JPY",
          `json:$.assetBalAcTypTyp[${index}]`,
          row,
          asOf,
        ),
      );
    }
    for (const [index, value] of loans.entries()) {
      const row = strictObject(value, `loan balances[${index}]`);
      exactKeys(
        row,
        ["loanAcqRsltFlg", "loanBalance", "loanGrsBalanceAccountType", "loanItmDispFlg"],
        `loan balances[${index}]`,
      );
      const accountType = enumText(
        row.loanGrsBalanceAccountType,
        ["012", "013", "014", "015"],
        "loan account type",
      );
      unique(seen, accountType, "loan account type");
      enumText(row.loanAcqRsltFlg, ["1"], "loan acquisition flag");
      enumText(row.loanItmDispFlg, ["0"], "loan display flag");
      const money = exactMoney(row.loanBalance, "JPY", "loan balance");
      observations.push(
        balance(
          `sony-bank:gross:loan:${accountType}`,
          "gross_loan_balance",
          money,
          "JPY",
          `json:$.loanBalAcTypTyp[${index}]`,
          row,
          asOf,
        ),
      );
    }
    for (const [field, subject, metric] of [
      ["assetTtl", "assets", "gross_asset_total"],
      ["loanTtl", "loans", "gross_loan_total"],
    ] as const) {
      const money = exactMoney(body[field], "JPY", field);
      observations.push({
        kind: "valuation",
        sourceAccount: "sony-bank:gross",
        subject,
        metric,
        amountMinor: money.minor,
        amountText: money.text,
        amountScale: money.scale,
        currency: "JPY",
        asOf,
        rawLocator: `json:$.${field}`,
        extra: { updateDttm: body.updateDttm },
      });
    }
    return { observations, warnings: [] };
  },
};

export const sonyBankHistoryJson: Parser = {
  name: "sony-bank-history-json",
  version: "1.0.0",
  accepts: (artifact) =>
    artifact.sourceId === "sony-bank" &&
    /^(yen-history|foreign-history-[a-z]{3})-page-\d{4}$/u.test(artifact.dataset ?? ""),
  parse(bytes, artifact) {
    requireJson(artifact);
    const match = /^(yen-history|foreign-history-([a-z]{3}))-page-(\d{4})$/u.exec(
      artifact.dataset ?? "",
    );
    if (!match) throw new Error("Sony history dataset is invalid");
    const page = Number(match[3]);
    if (page < 1 || page > 1000) throw new Error("Sony history page is out of range");
    const body = strictObject(JSON.parse(decodeUtf8(bytes)), "Sony history page");
    exactKeys(body, page === 1 ? FIRST_PAGE_ENVELOPE : HISTORY_ENVELOPE, "Sony history page");
    commonSuccess(body);
    if (page === 1) validateMasterData(body);
    const total = strictSafeInteger(body.countCnt, "countCnt", { minimum: 0, maximum: 3000 });
    const returned = strictSafeInteger(body.returnCnt, "returnCnt", {
      minimum: 0,
      maximum: PAGE_SIZE,
    });
    const rows = exactArray(body.transactionHistInfo, returned, "transactionHistInfo");
    const expected = Math.max(0, Math.min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE));
    if (returned !== expected || (total === 0 && page !== 1))
      throw new Error("Sony history pagination is incomplete");
    const observations: Observation[] = [];
    for (const [index, value] of rows.entries()) {
      const row = strictObject(value, `transactionHistInfo[${index}]`);
      const keys = Object.keys(row).sort();
      if (![ROW_BASE, ROW_EXCHANGE, ROW_FOREIGN_EXCHANGE].some((shape) => sameKeys(keys, shape)))
        throw new Error("Sony history row schema drift");
      const currency = enumText(row.currencyCd, CURRENCIES, "currencyCd");
      const direction = enumText(
        row.additionAndSubtractionSegment,
        ["1", "2"],
        "additionAndSubtractionSegment",
      );
      const amount = exactMoney(row.transactionAmt, currency, "transactionAmt");
      const after = exactMoney(row.transactionAftBal, currency, "transactionAftBal");
      const asOf = normalizedDate(row.transactionDt, "transactionDt");
      const description = strictString(row.abridgmentObj, "abridgmentObj", { max: 512 });
      if (Object.hasOwn(row, "applicationExchRt"))
        exactDecimal(row.applicationExchRt, "applicationExchRt");
      for (const field of ["currencyCdSpndl", "currencyCdStl", "otherPrtyCcyCd"] as const)
        if (Object.hasOwn(row, field)) enumText(row[field], CURRENCIES, field);
      const locator = `json:$.transactionHistInfo[${index}]`;
      observations.push({
        kind: "transaction",
        sourceAccount: `sony-bank:deposit:${currency}`,
        externalId: `sony-bank-history:${stableFingerprint(row)}`,
        status: "posted",
        amountMinor: direction === "1" ? amount.minor : -amount.minor,
        amountText: direction === "1" ? amount.text : `-${amount.text}`,
        amountScale: amount.scale,
        currency,
        description,
        asOf,
        rawLocator: locator,
        extra: {
          ...row,
          _kogane: { page, totalCount: total, direction: direction === "1" ? "credit" : "debit" },
        },
      });
      observations.push(
        balance(
          `sony-bank:deposit:${currency}`,
          "available_after_transaction",
          after,
          currency,
          `${locator}.transactionAftBal`,
          { transaction: row, page, totalCount: total },
          asOf,
        ),
      );
    }
    return { observations, warnings: [] };
  },
};

export const sonyBankHistoryCsv: Parser = {
  name: "sony-bank-history-csv",
  version: "1.0.0",
  accepts: (artifact) =>
    artifact.sourceId === "sony-bank" &&
    /^(yen-history|foreign-history-[a-z]{3})-csv$/u.test(artifact.dataset ?? ""),
  parse(bytes, artifact) {
    if (
      !new Set([
        "text/csv",
        "application/csv",
        "application/x-csv",
        "text/plain",
        "application/octet-stream",
      ]).has(artifact.mime)
    )
      throw new Error("Sony history CSV media type drift");
    const rows = parseCsv(decodeSonyCsv(bytes));
    const foreign = artifact.dataset !== "yen-history-csv";
    const header = foreign
      ? ["取引日", "摘要", "参考情報", "通貨", "預入額", "引出額", "差引残高", "為替レート"]
      : ["取引日", "摘要", "参考情報", "通貨", "預入額", "引出額", "差引残高"];
    if (rows.length < 1 || !sameSequence(rows[0]!, header))
      throw new Error("Sony history CSV header drift");
    const observations: Observation[] = [];
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.length !== header.length) throw new Error("Sony history CSV cardinality drift");
      const [date, description, reference, rawCurrency, deposit, withdrawal, after, rate] = row;
      const currency = enumText(rawCurrency, CURRENCIES, "CSV currency");
      const credit = deposit !== "";
      if (credit === (withdrawal !== ""))
        throw new Error("Sony history CSV direction is ambiguous");
      const money = exactMoney(credit ? deposit : withdrawal, currency, "CSV amount");
      const balanceMoney = exactMoney(after, currency, "CSV balance");
      const asOf = normalizedDate(date, "CSV date");
      if (foreign) exactDecimal(rate, "CSV exchange rate");
      const extra = Object.fromEntries(header.map((name, offset) => [name, row[offset]]));
      observations.push({
        kind: "transaction",
        sourceAccount: `sony-bank:deposit:${currency}`,
        externalId: `sony-bank-history-csv:${stableFingerprint(row)}`,
        status: "posted",
        amountMinor: credit ? money.minor : -money.minor,
        amountText: credit ? money.text : `-${money.text}`,
        amountScale: money.scale,
        currency,
        description: strictString(description, "CSV description", { max: 512 }),
        asOf,
        rawLocator: `csv:row=${index + 1}`,
        extra: { ...extra, _kogane: { reference, direction: credit ? "credit" : "debit" } },
      });
      observations.push(
        balance(
          `sony-bank:deposit:${currency}`,
          "available_after_transaction",
          balanceMoney,
          currency,
          `csv:row=${index + 1},column=差引残高`,
          extra,
          asOf,
        ),
      );
    }
    return { observations, warnings: [] };
  },
};

const WALLET_HEADERS = [
  "お取引日",
  "お取引内容",
  "お取引通貨 金額",
  "現地手数料",
  "ATM手数料",
  "海外取引経費",
  "確定日",
  "承認番号",
  "備考",
  "ご利用通貨 金額",
  "現地手数料",
  "換算レート",
] as const;

export const sonyBankWalletHistory: Parser = {
  name: "sony-bank-wallet-history",
  version: "1.0.0",
  accepts: (artifact) =>
    artifact.sourceId === "sony-bank" && /^wallet-history-\d{6}$/u.test(artifact.dataset ?? ""),
  parse(bytes, artifact) {
    if (artifact.mime !== "text/html; charset=UTF-8") {
      throw new Error("Sony WALLET media type drift");
    }
    const html = decodeUtf8(bytes);
    const selects = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/giu)];
    if (selects.length !== 1 || attribute(selects[0]![1] ?? "", "id") !== "select-month") {
      throw new Error("Sony WALLET month selector drift");
    }
    const selectorName = attribute(selects[0]![1] ?? "", "name");
    if (!selectorName || !/^W\d+\.referenceDate$/u.test(selectorName)) {
      throw new Error("Sony WALLET selector name drift");
    }
    const selected = [...(selects[0]![2] ?? "").matchAll(/<option\b([^>]*)>/giu)]
      .filter((match) => /\bselected(?:\s*=|\s|$)/iu.test(match[1] ?? ""))
      .map((match) => attribute(match[1] ?? "", "value"));
    if (selected.length !== 1 || selected[0] !== artifact.dataset!.slice(-6)) {
      throw new Error("Sony WALLET selected month drift");
    }
    const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)];
    const observations: Observation[] = [];
    const seen = new Set<string>();
    let primaryTableCount = 0;
    for (const table of tables) {
      const headers = [...(table[1] ?? "").matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/giu)].map(
        (match) => visibleText(match[1] ?? ""),
      );
      if (!sameSequence(headers.slice(0, WALLET_HEADERS.length), WALLET_HEADERS)) continue;
      primaryTableCount += 1;
      const rows = [...(table[1] ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map((match) =>
        [...(match[1] ?? "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((cell) =>
          visibleText(cell[1] ?? ""),
        ),
      );
      if (
        rows.filter((row) => row.length === 9).length !==
        rows.filter((row) => row.length === 4).length
      ) {
        throw new Error("Sony WALLET transaction cardinality drift");
      }
      for (let index = 0; index < rows.length; index += 1) {
        const main = rows[index]!;
        if (main.length !== 9) continue;
        const supplement = rows.slice(index + 1).find((row) => row.length === 4);
        if (!supplement) throw new Error("Sony WALLET transaction supplement is missing");
        const asOf = normalizedDate(main[0], "WALLET transaction date");
        const transactionMoney = walletMoney(main[2]!, "WALLET transaction amount");
        const usageMoney = walletMoney(supplement[0]!, "WALLET usage amount");
        for (const [value, label] of [
          [main[3], "local fee"],
          [main[4], "ATM fee"],
          [main[5], "overseas expense"],
          [supplement[1], "usage local fee"],
        ] as const)
          if (value !== "" && value !== "-") walletMoney(value!, `WALLET ${label}`);
        if (supplement[2] !== "" && supplement[2] !== "-")
          exactDecimal(supplement[2]!.replaceAll(",", ""), "WALLET exchange rate");
        if (main[6] !== "" && main[6] !== "-") normalizedDate(main[6], "WALLET settlement date");
        const source = {
          primary: Object.fromEntries(
            WALLET_HEADERS.slice(0, 9).map((header, offset) => [header, main[offset]]),
          ),
          supplement: Object.fromEntries(
            WALLET_HEADERS.slice(9).map((header, offset) => [header, supplement[offset]]),
          ),
        };
        const fingerprint = stableFingerprint(source);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        observations.push({
          kind: "transaction",
          sourceAccount: "sony-bank:wallet",
          externalId:
            main[7] && main[7] !== "-"
              ? `sony-bank-wallet:${main[7]}`
              : `sony-bank-wallet:${fingerprint}`,
          status: "posted",
          amountMinor: transactionMoney.minor,
          amountText: transactionMoney.text,
          amountScale: transactionMoney.scale,
          currency: transactionMoney.currency,
          description: strictString(main[1], "WALLET description", { max: 512 }),
          asOf,
          rawLocator: `html:table=${tables.indexOf(table)},row=${index}`,
          extra: { ...source, _kogane: { usageAmount: usageMoney } },
        });
      }
    }
    if (primaryTableCount === 0 && html.includes("お取引日")) {
      throw new Error("Sony WALLET table schema drift");
    }
    return { observations, warnings: [] };
  },
};

function commonSuccess(body: Record<string, unknown>): void {
  const errors = exactArray(body.errors, 0, "errors");
  if (errors.length !== 0) throw new Error("Sony provider returned errors");
  const common = strictObject(body.responseBizCommon, "responseBizCommon");
  exactKeys(common, ["bizResult", "exceptionRsn"], "responseBizCommon");
  enumText(common.bizResult, ["0"], "bizResult");
  exactArray(common.exceptionRsn, 0, "exceptionRsn");
}

function validateMasterData(body: Record<string, unknown>): void {
  const currencies = exactArray(body.currencyMst, 13, "currencyMst");
  const seen = new Set<string>();
  for (const [index, value] of currencies.entries()) {
    const row = strictObject(value, `currencyMst[${index}]`);
    exactKeys(row, ["currencyCd", "currencyNm", CUSTOMER_DISPLAY_ORDER], `currencyMst[${index}]`);
    unique(seen, enumText(row.currencyCd, CURRENCIES, "currencyCd"), "currencyCd");
    strictString(row.currencyNm, "currencyNm", { max: 64 });
    const order = exactDecimal(row[CUSTOMER_DISPLAY_ORDER], CUSTOMER_DISPLAY_ORDER);
    if (order.scale !== 0) throw new Error(`${CUSTOMER_DISPLAY_ORDER} is not an integer`);
  }
  const accounts = exactArray(body.ordinaryDepAcInfo, 11, "ordinaryDepAcInfo");
  for (const [index, value] of accounts.entries()) {
    const row = strictObject(value, `ordinaryDepAcInfo[${index}]`);
    exactKeys(
      row,
      ["accountNum", "accountStat", "accountTyp", "branchNum", "currencyCd"],
      `ordinaryDepAcInfo[${index}]`,
    );
    enumText(row.accountStat, ["1"], "accountStat");
    enumText(row.accountTyp, ["01", "02"], "accountTyp");
    enumText(row.currencyCd, CURRENCIES, "currencyCd");
    strictString(row.accountNum, "accountNum", { pattern: /^\d+$/u, max: 16 });
    strictString(row.branchNum, "branchNum", { pattern: /^\d+$/u, max: 8 });
  }
}

function balance(
  sourceAccount: string,
  metric: string,
  money: { minor: number; text: string; scale: number },
  currency: string,
  rawLocator: string,
  extra: Record<string, unknown>,
  asOf?: string,
): Observation {
  return {
    kind: "balance",
    sourceAccount,
    metric,
    amountMinor: money.minor,
    amountText: money.text,
    amountScale: money.scale,
    instrument: currency,
    ...(asOf ? { asOf } : {}),
    rawLocator,
    extra,
  };
}

function decodeSonyCsv(bytes: Uint8Array): string {
  try {
    return decodeUtf8(bytes);
  } catch {
    return new TextDecoder("shift-jis", { fatal: true }).decode(bytes);
  }
}
function exactArray(value: unknown, length: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new Error(`${label} cardinality drift`);
  return value;
}
function enumText(value: unknown, allowed: readonly string[], label: string): string {
  const text = strictString(value, label, { empty: true, max: 16 });
  if (!allowed.includes(text)) throw new Error(`${label} enum drift`);
  return text;
}
function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}
function sameSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}
function unique(seen: Set<string>, value: string, label: string): void {
  if (seen.has(value)) throw new Error(`${label} duplicated`);
  seen.add(value);
}
function requireJson(artifact: ArtifactMeta): void {
  if (artifact.mime !== "application/json") throw new Error("Sony JSON media type drift");
}
function providerInstant(value: unknown, label: string): string {
  const text = strictString(value, label, {
    max: 40,
    pattern: /^\d{4}[/-]\d{2}[/-]\d{2}[ T]\d{2}:\d{2}:\d{2}$/u,
  });
  return text.replaceAll("/", "-").replace(" ", "T");
}

function attribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "iu"));
  return match?.[1] ?? null;
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function walletMoney(
  value: string,
  label: string,
): { currency: string; text: string; scale: number; minor: number } {
  const currencyFirst = value.match(/\b([A-Z]{3})\b[\s:]*([+\-△▲]?[\d,]+(?:\.\d+)?)/u);
  const amountFirst = value.match(/([+\-△▲]?[\d,]+(?:\.\d+)?)[\s:]*\b([A-Z]{3})\b/u);
  const match = currencyFirst
    ? { currency: currencyFirst[1], amount: currencyFirst[2] }
    : amountFirst
      ? { currency: amountFirst[2], amount: amountFirst[1] }
      : null;
  if (!match) throw new Error(`${label} shape drift`);
  const currency = enumText(match.currency, CURRENCIES, `${label} currency`);
  const minor = amountToMinorUnits(match.amount!, currency);
  if (minor === undefined) throw new Error(`${label} is not exact`);
  const decimal = exactDecimal(match.amount!.replace(/^[△▲]/u, "-").replaceAll(",", ""), label);
  return { currency, minor, ...decimal };
}
