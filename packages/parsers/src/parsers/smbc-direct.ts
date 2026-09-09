import type {
  ArtifactMeta,
  BalanceObservation,
  Parser,
  ParseResult,
  TransactionObservation,
} from "../types.ts";
import { containerClaim } from "./coverage.ts";
import { decodeUtf8, isObject, unitScopeAdmitted } from "./util.ts";

const SOURCE_ID = "smbc-bank";
const SOURCE_ACCOUNT = "smbc-bank:ordinary-yen";
const MIME = "application/json";
const MAX_ROWS = 100_000;
const ROOT_KEYS = ["depositsTotal", "range", "transactions", "withdrawalsTotal"] as const;
const RANGE_KEYS = ["end", "start"] as const;
const ROW_KEYS = ["amount", "balanceAfter", "date", "description", "direction", "id"] as const;

type Direction = "credit" | "debit";

interface DateRange {
  start: string;
  end: string;
}

interface NormalizedTransaction {
  id: string;
  date: string;
  amount: number;
  balanceAfter: number;
  description: string;
  direction: Direction;
}

export const smbcDirectBalance: Parser = {
  name: "smbc-direct-balance",
  version: "1.0.0",

  accepts(artifact: ArtifactMeta): boolean {
    return accepts(artifact, "balance-normalized");
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    requireSuccessfulRun(artifact);
    requireArtifactKey(artifact, "balance.normalized.json");
    const input = parseObject(bytes, "balance-normalized");
    exactKeys(input, ["amount", "currency", "observedAt"], "balance-normalized");
    const amount = safeInteger(input["amount"], "balance-normalized.amount");
    if (input["currency"] !== "JPY") {
      throw new Error("balance-normalized.currency must be JPY");
    }
    const observedAt = utcInstant(input["observedAt"], "balance-normalized.observedAt");
    const observation: BalanceObservation = {
      kind: "balance",
      sourceAccount: SOURCE_ACCOUNT,
      metric: "account_balance",
      amountMinor: amount,
      amountText: String(amount),
      amountScale: 0,
      instrument: "JPY",
      asOf: observedAt,
      observedAt,
      rawLocator: "json:$",
      extra: {
        amount,
        currency: "JPY",
        observedAt,
        _kogane: {
          canonicalDataset: "balance-normalized",
          derivedFromDataset: "balance-raw",
          balanceScope: "ordinary_yen_account",
        },
      },
    };
    // One normalized balance per artifact by contract: the container is the
    // single object, complete whenever it validated.
    return {
      observations: [observation],
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: 1,
          expectedCount: 1,
          evidenceRefs: ["json:$"],
        }),
      ],
    };
  },
};

export const smbcDirectTransactions: Parser = {
  name: "smbc-direct-transactions",
  version: "1.0.0",

  accepts(artifact: ArtifactMeta): boolean {
    return accepts(artifact, "transactions-normalized");
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    requireSuccessfulRun(artifact);
    const input = parseObject(bytes, "transactions-normalized");
    exactKeys(input, ROOT_KEYS, "transactions-normalized");
    const range = parseRange(input["range"]);
    requireArtifactKey(
      artifact,
      `transactions/${range.start.replaceAll("-", "")}-${range.end.replaceAll("-", "")}.normalized.json`,
    );
    const depositsTotal = nonNegativeInteger(
      input["depositsTotal"],
      "transactions-normalized.depositsTotal",
    );
    const withdrawalsTotal = nonNegativeInteger(
      input["withdrawalsTotal"],
      "transactions-normalized.withdrawalsTotal",
    );
    if (!Array.isArray(input["transactions"]) || input["transactions"].length > MAX_ROWS) {
      throw new Error("transactions-normalized.transactions exceeds the strict row boundary");
    }

    const rows: NormalizedTransaction[] = [];
    const ids = new Set<string>();
    let previousDate: string | undefined;
    let observedDeposits = 0;
    let observedWithdrawals = 0;
    input["transactions"].forEach((value, index) => {
      const row = parseRow(value, index, range);
      if (ids.has(row.id)) {
        throw new Error(`transactions-normalized.transactions[${index}].id is duplicated`);
      }
      ids.add(row.id);
      if (previousDate !== undefined && row.date > previousDate) {
        throw new Error(`transactions-normalized.transactions[${index}] is out of provider order`);
      }
      previousDate = row.date;
      if (row.direction === "credit") observedDeposits = checkedAdd(observedDeposits, row.amount);
      else observedWithdrawals = checkedAdd(observedWithdrawals, row.amount);
      rows.push(row);
    });
    if (observedDeposits !== depositsTotal || observedWithdrawals !== withdrawalsTotal) {
      throw new Error("transactions-normalized totals do not match the exact row sums");
    }

    const observedAt = utcInstant(artifact.fetchedAt, "artifact.fetchedAt");
    const observations: TransactionObservation[] = rows.map((row, index) => ({
      kind: "transaction",
      sourceAccount: SOURCE_ACCOUNT,
      externalId: row.id,
      status: "posted",
      amountMinor: row.direction === "debit" && row.amount !== 0 ? -row.amount : row.amount,
      amountText: String(row.direction === "debit" && row.amount !== 0 ? -row.amount : row.amount),
      amountScale: 0,
      currency: "JPY",
      description: row.description,
      asOf: row.date,
      observedAt,
      rawLocator: `json:$.transactions[${index}]`,
      extra: {
        ...row,
        range,
        depositsTotal,
        withdrawalsTotal,
        _kogane: {
          canonicalDataset: "transactions-normalized",
          derivedFromDataset: "transactions-raw",
          direction: row.direction === "credit" ? "inflow" : "outflow",
          amountSignSource: "direction",
          identityOrigin: "provider-id",
          balanceAfterMetric: "ordinary_yen_balance_after_transaction",
        },
      },
    }));
    return { observations, warnings: [] };
  },
};

function accepts(artifact: ArtifactMeta, dataset: string): boolean {
  const keyMatches =
    dataset === "balance-normalized"
      ? artifact.artifactKey === "balance.normalized.json"
      : typeof artifact.artifactKey === "string" &&
        /^transactions\/\d{8}-\d{8}\.normalized\.json$/u.test(artifact.artifactKey);
  return (
    artifact.sourceId === SOURCE_ID &&
    artifact.dataset === dataset &&
    artifact.mime === MIME &&
    keyMatches
  );
}

function requireArtifactKey(artifact: ArtifactMeta, expected: string): void {
  if (artifact.artifactKey !== expected) {
    throw new Error("SMBC Direct artifact key does not match its canonical dataset shape");
  }
}

function requireSuccessfulRun(artifact: ArtifactMeta): void {
  if (
    (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
    !unitScopeAdmitted(artifact)
  ) {
    throw new Error("SMBC Direct observations require a successful failure-free fetch run");
  }
}

function parseObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} must be valid JSON`, { cause: error });
    }
    throw error;
  }
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function parseRange(value: unknown): DateRange {
  if (!isObject(value)) throw new Error("transactions-normalized.range must be an object");
  exactKeys(value, RANGE_KEYS, "transactions-normalized.range");
  const start = calendarDate(value["start"], "transactions-normalized.range.start");
  const end = calendarDate(value["end"], "transactions-normalized.range.end");
  if (start > end) throw new Error("transactions-normalized.range is reversed");
  return { start, end };
}

function parseRow(value: unknown, index: number, range: DateRange): NormalizedTransaction {
  const label = `transactions-normalized.transactions[${index}]`;
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ROW_KEYS, label);
  const id = strictString(value["id"], `${label}.id`, 512);
  const date = tokyoMidnight(value["date"], `${label}.date`);
  const calendar = date.slice(0, 10);
  if (calendar < range.start || calendar > range.end) {
    throw new Error(`${label}.date is outside the declared range`);
  }
  const amount = nonNegativeInteger(value["amount"], `${label}.amount`);
  const balanceAfter = safeInteger(value["balanceAfter"], `${label}.balanceAfter`);
  const description = stringAllowEmpty(value["description"], `${label}.description`, 100_000);
  const direction = value["direction"];
  if (direction !== "credit" && direction !== "debit") {
    throw new Error(`${label}.direction is not a supported provider value`);
  }
  return { id, date, amount, balanceAfter, description, direction };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has schema drift`);
  }
}

function strictString(value: unknown, label: string, maximum: number): string {
  const result = stringAllowEmpty(value, label, maximum);
  if (result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function stringAllowEmpty(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = safeInteger(value, label);
  if (result < 0) throw new Error(`${label} must not be negative`);
  return result;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("transactions-normalized totals overflow");
  return result;
}

function calendarDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${label} must be an ISO calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date`);
  }
  return value;
}

function tokyoMidnight(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00\+09:00$/u.test(value)) {
    throw new Error(`${label} must be a Tokyo-midnight timestamp`);
  }
  calendarDate(value.slice(0, 10), label);
  return value;
}

function utcInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 35) {
    throw new Error(`${label} must be a canonical UTC instant`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC instant`);
  }
  return value;
}
