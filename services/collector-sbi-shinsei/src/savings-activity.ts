import {
  inspectSavingsPeriod,
  validateSavingsScope,
  type SavingsPeriodScope,
} from "../../../packages/parsers/src/sbi-shinsei-period-contract.ts";
import { validateKnownResponse } from "./response-schemas";
import type { CollectionFailure, JsonObject, RawArtifact } from "./types";

/** Whole observed retention, in the bank's calendar: first day of the same month two years ago. */
export function savingsRetention(now: Date): { fromDate: string; toDate: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .replaceAll("-", "");
  return { fromDate: `${Number(date.slice(0, 4)) - 2}${date.slice(4, 6)}01`, toDate: date };
}

export function parseSavingsHistory(
  value: unknown,
  topBalances: JsonObject,
  capturedAt: Date,
): { artifacts: RawArtifact[]; failures: CollectionFailure[] } {
  const fail = (): never => {
    throw new Error("history_handoff_invalid");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).sort().join(",") !== "accounts,fromDate,toDate" ||
    !Array.isArray(root.accounts)
  )
    return fail();
  const retention = savingsRetention(capturedAt);
  if (root.fromDate !== retention.fromDate || root.toDate !== retention.toDate) return fail();
  const inventory = ((topBalances.responseParam as JsonObject).overview as JsonObject)
    .responseParam as JsonObject;
  const savings = inventory.savingsDetails as JsonObject[];
  if (savings.length !== root.accounts.length || savings.length > 100) return fail();
  const artifacts: RawArtifact[] = [],
    failures: CollectionFailure[] = [],
    seen = new Set<string>();
  for (const [index, entry] of root.accounts.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail();
    const account = entry as Record<string, unknown>;
    const keys = Object.keys(account).sort().join(",");
    if (
      keys !== "accountNo,currency,productCode,raw" &&
      keys !== "accountNo,currency,errorCode,productCode"
    )
      return fail();
    const scope = validateSavingsScope({
      accountNo: account.accountNo,
      currency: account.currency,
      productCode: account.productCode,
      fromDate: root.fromDate,
      toDate: root.toDate,
    });
    if (
      seen.has(scope.accountNo) ||
      !savings.some(
        (row) =>
          row.accountNo === scope.accountNo &&
          row.currency === scope.currency &&
          row.productCode === scope.productCode,
      )
    )
      return fail();
    seen.add(scope.accountNo);
    const ordinal = String(index + 1).padStart(4, "0");
    if (account.errorCode !== undefined) {
      // A read failure and a stop at the shared time/byte budget are both closed per-account failures.
      if (
        account.errorCode !== "history_read_failed" &&
        account.errorCode !== "history_budget_exceeded"
      )
        return fail();
      failures.push({
        historyScope: scope,
        operation: `read:history-${ordinal}`,
        errorType: "ProviderReadError",
        message: "provider_read_failed",
      });
      continue;
    }
    try {
      if (typeof account.raw !== "string") return fail();
      const response = validateKnownResponse(
        "sbi-shinsei-period-activity-v1",
        JSON.parse(account.raw),
      );
      inspectSavingsPeriod(response, scope);
      artifacts.push(...historyArtifacts(scope, response, ordinal));
    } catch {
      failures.push({
        historyScope: scope,
        operation: `read:history-${ordinal}`,
        errorType: "ResponseSchemaError",
        message: "provider_response_invalid",
      });
    }
  }
  return { artifacts, failures };
}

function historyArtifacts(
  scope: SavingsPeriodScope,
  response: JsonObject,
  ordinal: string,
): RawArtifact[] {
  // A same-page handoff removes the rotating token; repeat it at this boundary for local helpers.
  const header = { ...(response.header as JsonObject) };
  delete header.newToken;
  const sanitized = { ...response, header };
  return [
    {
      dataset: "period-activity-capture",
      filename: `raw-period-activity-${ordinal}.json`,
      mediaType: "application/json",
      body: JSON.stringify(sanitized),
      historyScope: scope,
    },
    {
      dataset: "savings-activity",
      filename: `savings-activity-${ordinal}.json`,
      mediaType: "application/json",
      body: JSON.stringify({
        schema: "sbi-shinsei-savings-activity-v1",
        scope,
        response: sanitized,
      }),
      historyScope: scope,
    },
  ];
}
