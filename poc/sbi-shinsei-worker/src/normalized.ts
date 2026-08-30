import type {
  NormalizedBalance,
  NormalizedSnapshot,
  NormalizedTransaction,
} from "./types";

export function parseNormalizedSnapshot(value: unknown): NormalizedSnapshot {
  const root = exactRecord(value, [
    "schemaVersion",
    "capturedAt",
    "balances",
    "transactions",
  ]);
  if (root.schemaVersion !== "sbi-shinsei-synthetic-v1") {
    throw new Error("Unknown SBI Shinsei normalized schema version");
  }
  const capturedAt = isoInstant(root.capturedAt, "capturedAt");
  if (!Array.isArray(root.balances) || !Array.isArray(root.transactions)) {
    throw new Error("SBI Shinsei normalized arrays are missing");
  }
  return {
    schemaVersion: root.schemaVersion,
    capturedAt,
    balances: root.balances.map(parseBalance),
    transactions: root.transactions.map(parseTransaction),
  };
}

function parseBalance(value: unknown): NormalizedBalance {
  const record = exactRecord(value, [
    "accountKey",
    "product",
    "currency",
    "balance",
    "yenEquivalent",
    "asOf",
  ]);
  if (
    record.product !== "yen-savings" &&
    record.product !== "hyper-yokin" &&
    record.product !== "foreign-savings" &&
    record.product !== "term-deposit"
  ) {
    throw new Error("Unknown SBI Shinsei product type");
  }
  return {
    accountKey: nonEmptyString(record.accountKey, "accountKey"),
    product: record.product,
    currency: currency(record.currency),
    balance: decimal(record.balance, "balance"),
    yenEquivalent:
      record.yenEquivalent === null
        ? null
        : decimal(record.yenEquivalent, "yenEquivalent"),
    asOf: isoInstant(record.asOf, "asOf"),
  };
}

function parseTransaction(value: unknown): NormalizedTransaction {
  const record = exactRecord(value, [
    "accountKey",
    "transactionDate",
    "description",
    "debit",
    "credit",
    "balance",
    "currency",
  ]);
  const debit = nullableDecimal(record.debit, "debit");
  const credit = nullableDecimal(record.credit, "credit");
  if ((debit === null) === (credit === null)) {
    throw new Error("A transaction must have exactly one of debit or credit");
  }
  return {
    accountKey: nonEmptyString(record.accountKey, "accountKey"),
    transactionDate: date(record.transactionDate, "transactionDate"),
    description: nonEmptyString(record.description, "description"),
    debit,
    credit,
    balance: decimal(record.balance, "balance"),
    currency: currency(record.currency),
  };
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw new Error("Object keys do not match the known schema");
  }
  return record;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function decimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${field} must be a decimal string`);
  }
  return value;
}

function nullableDecimal(value: unknown, field: string): string | null {
  return value === null ? null : decimal(value, field);
}

function currency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)) {
    throw new Error("currency must be an ISO-style three-letter code");
  }
  return value;
}

function date(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function isoInstant(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  return value;
}
