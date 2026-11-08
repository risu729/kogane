// The request rules of the reported state on a date, shared by
// `GET /api/v2/reported-state` and the agent tool `kogane.reported-state.read`
// (ADR 0081 point 2): both adapters hand this service the same request body
// (the route turns its query string into one) and answer its refusal with
// the same status and closed code. The read is `queryDatedState`
// (./dated-state.ts); a refusal is decided before the store is read, except
// the row bound, which only the read can know.
import { isRecord } from "../../../domain/src/guards.ts";
import type { ReportedState } from "../../../domain/src/reported-state.ts";
import { parseLocalDate } from "../../../domain/src/time.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { type DatedStateInput, DatedStateLimitError, queryDatedState } from "./dated-state.ts";

export const REPORTED_STATE_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
export const REPORTED_STATE_SOURCE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const REPORTED_STATE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/u;
/** Every key a request may carry; any other key is refused, never ignored. */
export const REPORTED_STATE_KEYS = ["date", "source", "account"] as const;

/** The closed refusal codes, with the status both adapters answer. */
export const REPORTED_STATE_REFUSALS = {
  /** Another, repeated or empty key, or a malformed source or account. */
  invalid_query: 400,
  /** A missing date, or one that is not a `YYYY-MM-DD` calendar day. */
  invalid_date: 400,
  /** A date after today in Asia/Tokyo: no state is reported for it yet. */
  date_in_future: 400,
  /** More rows than the read's bound: refused, never cut into a partial answer. */
  result_limit_exceeded: 413,
} as const;
export type ReportedStateRefusal = keyof typeof REPORTED_STATE_REFUSALS;

export type ReportedStateReadOutcome =
  | { ok: true; state: ReportedState }
  | { ok: false; refusal: ReportedStateRefusal; status: number };

const refuse = (refusal: ReportedStateRefusal) =>
  ({ ok: false, refusal, status: REPORTED_STATE_REFUSALS[refusal] }) as const;

/** Today's civil date in Asia/Tokyo at `now` (epoch milliseconds). */
function tokyoToday(now: number): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Validate an untrusted request body. In order: a non-object body, an unknown
 * key or an empty value is `invalid_query`; a missing or malformed date
 * `invalid_date`; a date after today in Tokyo `date_in_future`; a malformed
 * source or account `invalid_query`. A value of the wrong type is malformed.
 */
export function parseReportedStateRequest(
  value: unknown,
  now: number,
): { ok: true; value: DatedStateInput } | ReturnType<typeof refuse> {
  if (!isRecord(value)) return refuse("invalid_query");
  for (const [key, item] of Object.entries(value))
    if (!(REPORTED_STATE_KEYS as readonly string[]).includes(key) || item === "")
      return refuse("invalid_query");
  const { date, source, account } = value;
  if (typeof date !== "string" || !REPORTED_STATE_DATE.test(date) || parseLocalDate(date) === null)
    return refuse("invalid_date");
  if (date > tokyoToday(now)) return refuse("date_in_future");
  if (source !== undefined && (typeof source !== "string" || !REPORTED_STATE_SOURCE.test(source)))
    return refuse("invalid_query");
  if (
    account !== undefined &&
    (typeof account !== "string" || !REPORTED_STATE_ACCOUNT.test(account))
  )
    return refuse("invalid_query");
  return {
    ok: true,
    value: {
      date,
      ...(source === undefined ? {} : { source: source as string }),
      ...(account === undefined ? {} : { account: account as string }),
    },
  };
}

/**
 * The GET route's query string as a request body, or the refusal: each
 * parameter at most once. The body is then validated like any other, so an
 * unknown (`__proto__` included) or empty parameter is the body's
 * `invalid_query`.
 */
export function reportedStateBodyFromQuery(
  params: URLSearchParams,
): { ok: true; body: Record<string, string> } | ReturnType<typeof refuse> {
  for (const key of params.keys())
    if (params.getAll(key).length !== 1) return refuse("invalid_query");
  // Own data properties: `__proto__` stays a key the body refuses, where an
  // assignment would set the prototype and drop the parameter unseen.
  return { ok: true, body: Object.fromEntries(params) };
}

/** The reported state for one untrusted request body, or its closed refusal. */
export async function readReportedStateRequest(input: {
  sql: SqlExecutor;
  body: unknown;
  /** The caller's clock, epoch milliseconds: a date after its Tokyo day is refused. */
  now: number;
}): Promise<ReportedStateReadOutcome> {
  const parsed = parseReportedStateRequest(input.body, input.now);
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, state: await queryDatedState(input.sql, parsed.value) };
  } catch (error) {
    if (error instanceof DatedStateLimitError) return refuse("result_limit_exceeded");
    throw error;
  }
}
