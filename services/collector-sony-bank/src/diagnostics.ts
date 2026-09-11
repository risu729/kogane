import type { CollectionFailure } from "./types";

const OPERATIONS: Record<string, string> = {
  "login-page": "login-page",
  "revision-db": "revision",
  "revision-da": "revision",
  "revision-ea": "revision",
  "revision-ja": "revision",
  csrf: "csrf",
  login: "login",
  DBCA5700C1fE99: "csrf",
  DBCA0100I1fE15: "login",
  DAYA010AM1fE13: "gross-balance",
  EABA0600S1fE10: "history",
  EABA0600S1fE11: "history-pagination",
  EABA0600S1fE12: "history-csv",
  JADA160AC5fE01: "wallet-sso",
  "wallet-gateway": "wallet-gateway",
  "wallet-statement": "wallet-statement",
};
const CURRENCIES = new Set([
  "JPY",
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "NZD",
  "CAD",
  "CHF",
  "HKD",
  "ZAR",
  "SEK",
]);
const STAGES = new Set([
  ...Object.values(OPERATIONS),
  "credential",
  "wallet",
  "collect",
  "staging-write",
  "manifest-write",
  "raw-evidence-import",
]);
const REASONS = new Set([
  "http_error",
  "network_error",
  "provider_business_error",
  "response_invalid",
  "unexpected_error",
]);

export class SonyBankError extends Error {
  constructor(
    readonly providerOperation: string,
    readonly httpStatus?: number,
    readonly providerErrorCount = 0,
    readonly reason = "http_error",
  ) {
    // Never retain the provider's free-text codes, response body or request URL.
    super("Sony Bank request failed");
    this.name = "SonyBankError";
  }
}

export class SonyBankStageError extends Error {
  constructor(readonly stage: string) {
    super("Sony Bank collection stage failed");
    this.name = "SonyBankStageError";
  }
}

export async function atStage<T>(stage: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof SonyBankError || error instanceof SonyBankStageError) throw error;
    throw new SonyBankStageError(stage);
  }
}

export function failure(operation: string, error: unknown): CollectionFailure {
  const staging = operation.startsWith("r2:");
  const details: NonNullable<CollectionFailure["diagnostics"]> = {
    stage: staging ? "staging-write" : "collect",
    reason: "unexpected_error",
  };
  let errorType = error instanceof Error ? "Error" : "UnknownError";
  if (error instanceof SonyBankStageError) {
    errorType = "SonyBankStageError";
    if (STAGES.has(error.stage)) details.stage = error.stage;
  }
  if (error instanceof SonyBankError) {
    errorType = "SonyBankError";
    const [event, currency] = error.providerOperation.split(":");
    if (event && Object.hasOwn(OPERATIONS, event)) {
      details.stage = OPERATIONS[event]!;
      details.providerOperation = event;
      if (currency && CURRENCIES.has(currency)) details.currency = currency;
    }
    if (
      Number.isInteger(error.httpStatus) &&
      error.httpStatus! >= 100 &&
      error.httpStatus! <= 599
    ) {
      details.httpStatus = error.httpStatus!;
    }
    if (REASONS.has(error.reason)) details.reason = error.reason;
    if (Number.isSafeInteger(error.providerErrorCount) && error.providerErrorCount > 0) {
      details.providerErrorCount = Math.min(error.providerErrorCount, 100);
    }
  }
  return {
    operation,
    errorType,
    message: staging ? "staging_write_failed" : "collector_request_failed",
    diagnostics: details,
  };
}

// The importer strictly accepts only these three keys. Keep its schema stable;
// retain allowlisted diagnostic values in the existing bounded source message.
export function manifestFailure(entry: CollectionFailure): CollectionFailure {
  const { operation, errorType, message, diagnostics } = entry;
  const suffix = diagnostics
    ? Object.entries(diagnostics)
        .map(([key, value]) => `${key}=${value}`)
        .join("; ")
    : "";
  return {
    operation,
    errorType,
    message: suffix ? `${message}; ${suffix}`.slice(0, 300) : message,
  };
}

/** Observability must not abort collection, state persistence, or cleanup. */
export function emitDiagnostic(
  level: "log" | "warn" | "error",
  record: Record<string, unknown>,
): void {
  try {
    console[level](JSON.stringify(record));
  } catch {
    /* Best effort, including serialization and logger failures. */
  }
}

interface ProgressFields {
  phase?: "collection" | "request";
  currency?: string;
  page?: number;
  pageCount?: number;
  rowCount?: number;
  transactionCount?: number;
  httpStatus?: number;
  durationMs?: number;
  reason?: string;
}

/** Only bounded metadata enters logs; never serialize a request, response or error. */
export class SonyBankDiagnostics {
  constructor(private readonly runId?: string) {}

  record(
    operation: string,
    outcome: "started" | "completed" | "failed" | "skipped",
    fields: ProgressFields = {},
  ): void {
    try {
      const [event, currency] = operation.split(":");
      const stage =
        event && Object.hasOwn(OPERATIONS, event)
          ? OPERATIONS[event]
          : STAGES.has(operation)
            ? operation
            : "collect";
      const record: Record<string, unknown> = {
        event: "sony-bank-progress",
        phase: fields.phase === "request" ? "request" : "collection",
        stage,
        outcome,
      };
      if (
        this.runId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(this.runId)
      )
        record.runId = this.runId;
      if (event && Object.hasOwn(OPERATIONS, event)) record.providerOperation = event;
      const selectedCurrency = fields.currency ?? currency;
      if (selectedCurrency && CURRENCIES.has(selectedCurrency)) record.currency = selectedCurrency;
      for (const key of [
        "page",
        "pageCount",
        "rowCount",
        "transactionCount",
        "durationMs",
      ] as const) {
        const value = fields[key];
        if (Number.isSafeInteger(value) && value! >= 0) record[key] = value;
      }
      const status = fields.httpStatus;
      if (Number.isInteger(status) && status! >= 100 && status! <= 599) record.httpStatus = status;
      const reason = fields.reason;
      if (reason && (REASONS.has(reason) || reason === "zero_transactions")) record.reason = reason;
      emitDiagnostic(outcome === "failed" ? "error" : "log", record);
    } catch {
      /* Metadata inspection and logging are best effort. */
    }
  }

  async stage<T>(stage: string, task: () => Promise<T>, fields: ProgressFields = {}): Promise<T> {
    const started = Date.now();
    this.record(stage, "started", fields);
    try {
      const result = await atStage(stage, task);
      this.record(stage, "completed", { ...fields, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      try {
        const details = failure("collect", error).diagnostics;
        this.record(stage, "failed", { ...fields, ...details, durationMs: Date.now() - started });
      } catch {
        /* Never replace the original collection failure. */
      }
      throw error;
    }
  }
}
