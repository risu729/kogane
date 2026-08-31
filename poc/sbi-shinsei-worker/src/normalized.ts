import type {
  JsonObject,
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
  if (root.schemaVersion !== "sbi-shinsei-v1") {
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

export function normalizeCoreResponses(options: {
  capturedAt: string;
  topBalances: JsonObject;
}): NormalizedSnapshot {
  const capturedAt = isoInstant(options.capturedAt, "capturedAt");
  const responseParam = requiredObject(
    options.topBalances.responseParam,
    "topBalances.responseParam",
  );
  const overview = requiredObject(responseParam.overview, "topBalances.overview");
  const overviewResponse = requiredObject(
    overview.responseParam,
    "topBalances.overview.responseParam",
  );
  const savings = requiredArray(
    overviewResponse.savingsDetails,
    "topBalances.overview.responseParam.savingsDetails",
  );
  const balances = savings.map((value, index): NormalizedBalance => {
    const item = requiredObject(value, `savingsDetails[${index}]`);
    const accountKey = nonEmptyString(item.accountNo, "accountNo");
    const nativeCurrency = currency(item.currency);
    const productCode = nonEmptyString(item.productCode, "productCode");
    return {
      accountKey,
      product: nativeCurrency !== "JPY"
        ? "foreign-savings"
        : productCode === "603"
          ? "hyper-yokin"
          : "yen-savings",
      currency: nativeCurrency,
      balance: decimalFromScalar(item.balance, "balance"),
      yenEquivalent: nullableDecimalFromScalar(item.yenEqui, "yenEqui"),
      asOf: capturedAt,
    };
  });

  const activity = requiredObject(responseParam.activity, "topBalances.activity");
  const activityResponse = requiredObject(
    activity.responseParam,
    "topBalances.activity.responseParam",
  );
  const activityCurrency = currency(activityResponse.currency);
  const activityAccount = nonEmptyString(activityResponse.accountNo, "accountNo");
  const details = requiredArray(
    activityResponse.activityDetails,
    "topBalances.activity.responseParam.activityDetails",
  );
  const transactions = details.map((value, index): NormalizedTransaction => {
    const item = requiredObject(value, `activityDetails[${index}]`);
    const debit = nullableDecimalFromScalar(item.debit, "debit");
    const credit = nullableDecimalFromScalar(item.credit, "credit");
    if ((debit === null) === (credit === null)) {
      throw new Error(
        `activityDetails[${index}] must contain exactly one debit or credit`,
      );
    }
    return {
      accountKey: activityAccount,
      transactionDate: compactDate(item.postingDate, "postingDate"),
      description: nonEmptyString(item.description, "description"),
      debit,
      credit,
      balance: decimalFromScalar(item.balance, "balance"),
      currency: activityCurrency,
    };
  });

  return parseNormalizedSnapshot({
    schemaVersion: "sbi-shinsei-v1",
    capturedAt,
    balances,
    transactions,
  });
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

function decimalFromScalar(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return decimal(String(value), field);
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string or finite number`);
  }
  return decimal(value.replaceAll(",", "").trim(), field);
}

function nullableDecimalFromScalar(
  value: unknown,
  field: string,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return decimalFromScalar(value, field);
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

function compactDate(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a date string`);
  }
  const trimmed = value.trim();
  if (/^\d{8}$/u.test(trimmed)) {
    return date(
      `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`,
      field,
    );
  }
  return date(trimmed.replaceAll("/", "-"), field);
}

function requiredObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonObject;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
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
