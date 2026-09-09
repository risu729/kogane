import type {
  ArtifactMeta,
  BalanceObservation,
  Observation,
  Parser,
  ParseResult,
  TransactionObservation,
} from "../types.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
import {
  exactKeys,
  normalizedDate,
  stableFingerprint,
  strictBoolean,
  strictObject,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";

const SOURCE_ACCOUNT = "mobile-suica:sf";
const CURRENT_ROOT_KEYS = [
  "asOfDateJst",
  "pageCount",
  "transactionCount",
  "complete",
  "rows",
] as const;
const LEGACY_ROOT_KEYS = ["asOfDateJst", "pageCount", "transactionCount", "rows"] as const;
const ROW_KEYS = [
  "date",
  "typeFrom",
  "placeFrom",
  "typeTo",
  "placeTo",
  "balanceText",
  "amountText",
  "balance",
  "amount",
  "kind",
] as const;
const ROW_KINDS = new Set(["rail", "bus", "payment", "charge", "carryover", "other"]);
const MAX_HISTORY_ROWS = 100;
const OFFICIAL_WINDOW_DAYS = 26 * 7;

interface HistoryRow {
  date: string;
  typeFrom: string;
  placeFrom: string;
  typeTo: string;
  placeTo: string;
  balanceText: string;
  amountText: string;
  balance: number | null;
  amount: number | null;
  kind: string;
}

interface IndexedRow {
  index: number;
  row: HistoryRow;
  occurrence: number;
  fingerprint: string;
}

export const mobileSuicaSfHistory: Parser = {
  name: "mobile-suica-sf-history",
  version: "1.0.0",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === "mobile-suica" &&
      artifact.dataset === "sf-history" &&
      artifact.mime === "application/json"
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    if (artifact.runStatus !== "success" && !unitScopeAdmitted(artifact)) {
      throw new Error("mobile-suica observations require a successful fetch run");
    }
    const body = strictObject(JSON.parse(decodeUtf8(bytes)), "sf-history");
    const current = Object.hasOwn(body, "complete");
    exactKeys(body, current ? CURRENT_ROOT_KEYS : LEGACY_ROOT_KEYS, "sf-history");

    const asOfDateJst = normalizedDate(body["asOfDateJst"], "sf-history.asOfDateJst");
    const pageCount = strictSafeInteger(body["pageCount"], "sf-history.pageCount", {
      minimum: 1,
      maximum: 1,
    });
    if (pageCount !== 1) throw new Error("sf-history.pageCount must be 1");
    const rowsValue = body["rows"];
    if (!Array.isArray(rowsValue) || rowsValue.length > MAX_HISTORY_ROWS) {
      throw new Error("sf-history.rows must be an array with at most 100 entries");
    }
    const transactionCount = strictSafeInteger(
      body["transactionCount"],
      "sf-history.transactionCount",
      { minimum: 0, maximum: MAX_HISTORY_ROWS },
    );
    if (transactionCount !== rowsValue.length) {
      throw new Error("sf-history.transactionCount does not match rows.length");
    }
    if (current) {
      const complete = strictBoolean(body["complete"], "sf-history.complete");
      if (complete !== rowsValue.length < MAX_HISTORY_ROWS) {
        throw new Error("sf-history.complete contradicts the 100-row boundary");
      }
      if (!complete) throw new Error("sf-history is not a complete provider snapshot");
    } else if (rowsValue.length === MAX_HISTORY_ROWS) {
      throw new Error("legacy sf-history cannot prove completeness at the 100-row boundary");
    }

    const warnings: string[] = [];
    if (!current) warnings.push("sf-history: legacy payload has no explicit completeness flag");
    const occurrences = new Map<string, number>();
    const indexedRows: IndexedRow[] = [];
    let previousDate = asOfDateJst;
    rowsValue.forEach((value, index) => {
      const row = parseRow(value, index);
      if (row.date >= asOfDateJst) {
        throw new Error(`sf-history.rows[${index}].date must be before asOfDateJst`);
      }
      if (row.date > previousDate) {
        throw new Error(`sf-history.rows[${index}] is out of provider date order`);
      }
      previousDate = row.date;
      if (daysBetween(row.date, asOfDateJst) > OFFICIAL_WINDOW_DAYS) {
        warnings.push(
          `json:$.rows[${index}]: date exceeds the documented 26-week history window; preserved`,
        );
      }
      const fingerprint = stableFingerprint(row);
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      indexedRows.push({ index, row, occurrence, fingerprint });
    });

    // The provider orders newest first. Emit oldest first so an append-only
    // latest-balance query can use the highest observation id as a tie-breaker
    // for multiple rows on the same date.
    const observations: Observation[] = [];
    for (const indexed of [...indexedRows].reverse()) {
      observations.push(...observationsForRow(indexed, asOfDateJst, warnings));
    }
    return { observations, warnings };
  },
};

function parseRow(value: unknown, index: number): HistoryRow {
  const label = `sf-history.rows[${index}]`;
  const input = strictObject(value, label);
  exactKeys(input, ROW_KEYS, label);
  const date = normalizedDate(input["date"], `${label}.date`);
  const typeFrom = strictString(input["typeFrom"], `${label}.typeFrom`, {
    empty: true,
    max: 128,
  });
  const placeFrom = strictString(input["placeFrom"], `${label}.placeFrom`, {
    empty: true,
    max: 256,
  });
  const typeTo = strictString(input["typeTo"], `${label}.typeTo`, { empty: true, max: 128 });
  const placeTo = strictString(input["placeTo"], `${label}.placeTo`, {
    empty: true,
    max: 256,
  });
  const balanceText = strictString(input["balanceText"], `${label}.balanceText`, {
    empty: true,
    max: 64,
  });
  const amountText = strictString(input["amountText"], `${label}.amountText`, {
    empty: true,
    max: 64,
  });
  const balance = nullableSafeInteger(input["balance"], `${label}.balance`);
  const amount = nullableSafeInteger(input["amount"], `${label}.amount`);
  const kind = strictString(input["kind"], `${label}.kind`, { max: 16 });
  if (!ROW_KINDS.has(kind)) throw new Error(`${label}.kind has an unsupported value`);
  if (balance !== parseDisplayInteger(balanceText) || amount !== parseDisplayInteger(amountText)) {
    throw new Error(`${label} display amounts do not match normalized amounts`);
  }
  if (kind !== classify(typeFrom, placeFrom, typeTo)) {
    throw new Error(`${label}.kind does not match the normalized row fields`);
  }
  return {
    date,
    typeFrom,
    placeFrom,
    typeTo,
    placeTo,
    balanceText,
    amountText,
    balance,
    amount,
    kind,
  };
}

function observationsForRow(
  indexed: IndexedRow,
  collectionAsOfDateJst: string,
  warnings: string[],
): Observation[] {
  const { index, row, occurrence, fingerprint } = indexed;
  const rawLocator = `json:$.rows[${index}]`;
  const direction = row.amount === null ? "unknown" : row.amount < 0 ? "outflow" : "inflow";
  const lineage = {
    canonicalDataset: "sf-history",
    derivedFromDataset: "sf-history-html",
    sourceView: "mobile-suica-pc-history-through-previous-day",
    collectionAsOfDateJst,
    rowKind: row.kind,
    direction,
    identityOrigin: "canonical-normalized-row+occurrence",
    officialHistoryLimit: { weeks: 26, rows: 100 },
    currentBalanceCandidate: index === 0,
  };
  const extra = { ...row, _kogane: lineage };
  const observations: Observation[] = [];
  if (row.amount === null) {
    if (row.kind !== "carryover") {
      warnings.push(`${rawLocator}: amount is unavailable; transaction observation omitted`);
    }
  } else {
    const description = [row.typeFrom, row.typeTo].filter(Boolean).join(" → ") || row.kind;
    const counterparty = [row.placeFrom, row.placeTo].filter(Boolean).join(" → ") || undefined;
    const transaction: TransactionObservation = {
      kind: "transaction",
      sourceAccount: SOURCE_ACCOUNT,
      externalId: `mobile-suica-sf-history:${fingerprint}:${occurrence}`,
      status: "posted",
      amountMinor: row.amount,
      amountText: String(row.amount),
      amountScale: 0,
      currency: "JPY",
      description,
      ...(counterparty ? { counterparty } : {}),
      asOf: row.date,
      rawLocator,
      extra,
    };
    observations.push(transaction);
  }
  if (row.balance === null) {
    warnings.push(`${rawLocator}: post-transaction balance is unavailable; balance omitted`);
  } else {
    const balance: BalanceObservation = {
      kind: "balance",
      sourceAccount: SOURCE_ACCOUNT,
      metric: "sf_balance_after_transaction",
      amountMinor: row.balance,
      amountText: String(row.balance),
      amountScale: 0,
      instrument: "JPY",
      asOf: row.date,
      rawLocator,
      extra,
    };
    observations.push(balance);
  }
  return observations;
}

function nullableSafeInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return strictSafeInteger(value, label);
}

function parseDisplayInteger(value: string): number | null {
  const normalized = value.replace(/[￥¥\\円,\s]/gu, "");
  if (!/^[+-]?\d+$/u.test(normalized)) return null;
  const result = Number(normalized);
  return Number.isSafeInteger(result) ? result : null;
}

function classify(typeFrom: string, placeFrom: string, typeTo: string): string {
  const from = typeFrom.normalize("NFKC");
  const place = placeFrom.normalize("NFKC");
  if ((from === "入" || from === "*入") && typeTo === "出") return "rail";
  if (from === "カード" && place === "モバイル") return "charge";
  if (from === "物販") return "payment";
  if (from === "バス等") return "bus";
  if (from === "繰") return "carryover";
  return "other";
}

function daysBetween(earlier: string, later: string): number {
  const earlierTime = Date.parse(`${earlier}T00:00:00Z`);
  const laterTime = Date.parse(`${later}T00:00:00Z`);
  return (laterTime - earlierTime) / 86_400_000;
}
