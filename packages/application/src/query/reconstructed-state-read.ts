// The reconstructed state of one account over one range, for every caller:
// the HTTP route (`GET /api/v2/reconstructed-state`, the page's read) and the
// agent tool (`kogane.reconstructed-state.read`, over `/api/agent/v1` and
// `/mcp`) both call `readReconstructedState`, so the request rules, the
// bounds, the refusal codes and the answer are one implementation
// (docs/reconstructed-state.md, ADR 0058 amendment of 2026-10-09).
//
// It is `queryReconstructedState` behind three things decided here:
//
// - The request. An untrusted body is validated into the query's input:
//   one account, a `from`/`to` range of at most 366 days not after today in
//   Tokyo, the cash basis, an optional cut (`{coreEpoch, commitSeq}` or
//   `{coreEpoch, instant}`) and an optional `setVersion` the answer must
//   still have. A scope the query cannot answer (several accounts, an
//   instrument) is refused by name, never narrowed.
// - The grant. `records.read` over the whole store: the answer reads the
//   account's reported state through every source its mappings name and its
//   events through every claim holder, so a perimeter narrowed on either axis
//   cannot be honoured and is refused before anything is read (as
//   `kogane.purchases.explain` refuses it). The browser's reader authority
//   (`readerGrant`) passes; an agent grant passes when it holds the same.
// - The refusals. Every one is a closed code with one HTTP status; an answer
//   past a bound is refused, never cut.
//
// It reads, and nothing else: nothing here writes, adopts or approves, and a
// refusal decided from the request reads nothing.
import type { KnowledgeCut } from "../../../domain/src/economic-contract.ts";
import { isRecord } from "../../../domain/src/guards.ts";
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import { daysFromCivil, parseLocalDate, validInstantText } from "../../../domain/src/time.ts";
import { EconomicSelectorError } from "../../../read-model/src/economic-selector.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type AgentCapability, type Grant, grantAllows } from "../grants.ts";
import { DatedStateLimitError } from "./dated-state.ts";
import {
  queryReconstructedState,
  RECONSTRUCTION_RANGE_MAX_DAYS,
  ReconstructedStateInputError,
  type ReconstructedStateResult,
} from "./reconstructed-state.ts";

/** The capability the read needs. */
export const RECONSTRUCTED_STATE_CAPABILITY: AgentCapability = "records.read";
/** Every key a request may carry. */
export const RECONSTRUCTED_STATE_KEYS = [
  "account",
  "from",
  "to",
  "basis",
  "cut",
  "setVersion",
] as const;
/** Scope keys the query does not answer: refused by name, never ignored. */
export const RECONSTRUCTED_STATE_UNSUPPORTED_SCOPES = [
  "accounts",
  "instrument",
  "instruments",
] as const;
/** The forms the HTTP route and the tool schema publish. */
export const RECONSTRUCTED_STATE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/u;
export const RECONSTRUCTED_STATE_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
export const RECONSTRUCTED_STATE_EPOCH = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/u;
export const RECONSTRUCTED_STATE_INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
export const RECONSTRUCTED_STATE_SET_VERSION = /^[0-9a-f]{64}$/u;
/** The largest commit sequence a request may name (a safe integer). */
export const RECONSTRUCTED_STATE_MAX_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * Every refusal, its HTTP status and the agent API's error category. The code
 * itself is what both transports carry: the route as `error`, the agent tool
 * as the first ref (`refusal:<code>`) of a `financial-error-v1`.
 */
export const RECONSTRUCTED_STATE_REFUSALS = {
  invalid_query: { status: 400, category: "invalid_query" },
  scope_unsupported: { status: 400, category: "unsupported_semantics" },
  invalid_account: { status: 400, category: "invalid_query" },
  invalid_date: { status: 400, category: "invalid_query" },
  invalid_range: { status: 400, category: "invalid_query" },
  range_too_long: { status: 400, category: "budget_exceeded" },
  range_in_future: { status: 400, category: "invalid_query" },
  basis_unsupported: { status: 400, category: "unsupported_semantics" },
  invalid_cut: { status: 400, category: "invalid_query" },
  cut_in_future: { status: 400, category: "invalid_query" },
  cut_after_log_end: { status: 400, category: "invalid_query" },
  cut_epoch_not_current: { status: 409, category: "stale_context" },
  set_version_changed: { status: 409, category: "stale_context" },
  unknown_account: { status: 404, category: "evidence_restricted" },
  scope_restricted: { status: 403, category: "evidence_restricted" },
  capability_missing: { status: 403, category: "unauthorized" },
  result_limit_exceeded: { status: 413, category: "budget_exceeded" },
} as const satisfies Record<string, { status: number; category: FinancialErrorCode }>;
export type ReconstructedStateRefusal = keyof typeof RECONSTRUCTED_STATE_REFUSALS;
export const RECONSTRUCTED_STATE_REFUSAL_CODES = Object.keys(
  RECONSTRUCTED_STATE_REFUSALS,
) as ReconstructedStateRefusal[];

/** A validated request: the query's input without the clock. */
export interface ReconstructedStateRequest {
  account: string;
  from: string;
  to: string;
  basis: "cash";
  cut: KnowledgeCut | null;
  /** The set version the answer must still have, or null. */
  setVersion: string | null;
}

/** The answer both transports return: the query's result as it computed it. */
export type ReconstructedStateBody = ReconstructedStateResult & { apiVersion: 2 };

export type ReconstructedStateOutcome =
  | { ok: true; body: ReconstructedStateBody }
  | { ok: false; refusal: ReconstructedStateRefusal; refs: string[] };

type Parsed =
  | { ok: true; value: ReconstructedStateRequest }
  | { ok: false; refusal: ReconstructedStateRefusal; refs: string[] };

const refuse = (refusal: ReconstructedStateRefusal, refs: string[] = []): Parsed => ({
  ok: false,
  refusal,
  refs,
});

/** Today's civil date in Asia/Tokyo for the caller's clock. */
function tokyoDate(now: string): string {
  return new Date(Date.parse(now) + 9 * 3_600_000).toISOString().slice(0, 10);
}

function parseCut(value: unknown): KnowledgeCut | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return "invalid";
  const keys = Object.keys(value).sort().join(",");
  const { coreEpoch } = value;
  if (typeof coreEpoch !== "string" || !RECONSTRUCTED_STATE_EPOCH.test(coreEpoch)) return "invalid";
  if (keys === "commitSeq,coreEpoch") {
    const { commitSeq } = value;
    if (
      typeof commitSeq !== "number" ||
      !Number.isSafeInteger(commitSeq) ||
      commitSeq < 1 ||
      commitSeq > RECONSTRUCTED_STATE_MAX_SEQ
    )
      return "invalid";
    return { coreEpoch, commitSeq };
  }
  if (keys === "coreEpoch,instant") {
    const { instant } = value;
    if (
      typeof instant !== "string" ||
      !RECONSTRUCTED_STATE_INSTANT.test(instant) ||
      !validInstantText(instant)
    )
      return "invalid";
    return { coreEpoch, instant };
  }
  return "invalid";
}

/**
 * Validate an untrusted body against the caller's clock. Every check the
 * query would make on its input is made here first, so a refusal reads
 * nothing; the query checks again.
 */
export function parseReconstructedStateRequest(value: unknown, now: string): Parsed {
  if (!isRecord(value)) return refuse("invalid_query");
  const keys = Object.keys(value);
  const scopes = keys.filter((key) =>
    (RECONSTRUCTED_STATE_UNSUPPORTED_SCOPES as readonly string[]).includes(key),
  );
  if (scopes.length > 0) return refuse("scope_unsupported", scopes);
  const unknown = keys.filter(
    (key) => !(RECONSTRUCTED_STATE_KEYS as readonly string[]).includes(key),
  );
  // An unknown key is not echoed: it is the caller's text, not a field of ours.
  if (unknown.length > 0) return refuse("invalid_query");
  const { account, from, to, basis, cut, setVersion } = value;
  if (Array.isArray(account)) return refuse("scope_unsupported", ["account"]);
  if (typeof account !== "string" || !RECONSTRUCTED_STATE_ACCOUNT.test(account))
    return refuse("invalid_account", ["account"]);
  for (const [name, date] of [
    ["from", from],
    ["to", to],
  ] as const)
    if (
      typeof date !== "string" ||
      !RECONSTRUCTED_STATE_DATE.test(date) ||
      parseLocalDate(date) === null
    )
      return refuse("invalid_date", [name]);
  const start = parseLocalDate(from as string)!;
  const end = parseLocalDate(to as string)!;
  if ((from as string) >= (to as string)) return refuse("invalid_range", ["from", "to"]);
  if (daysFromCivil(end) - daysFromCivil(start) > RECONSTRUCTION_RANGE_MAX_DAYS)
    return refuse("range_too_long", [`maxDays:${String(RECONSTRUCTION_RANGE_MAX_DAYS)}`]);
  if (!validInstantText(now)) return refuse("invalid_query", ["now"]);
  if ((to as string) > tokyoDate(now)) return refuse("range_in_future", ["to"]);
  if (basis !== undefined && basis !== "cash") return refuse("basis_unsupported", ["basis"]);
  const parsedCut = parseCut(cut);
  if (parsedCut === "invalid") return refuse("invalid_cut", ["cut"]);
  if (
    parsedCut !== null &&
    "instant" in parsedCut &&
    Date.parse(parsedCut.instant) > Date.parse(now)
  )
    return refuse("cut_in_future", ["cut.instant"]);
  if (
    setVersion !== undefined &&
    (typeof setVersion !== "string" || !RECONSTRUCTED_STATE_SET_VERSION.test(setVersion))
  )
    return refuse("invalid_query", ["setVersion"]);
  return {
    ok: true,
    value: {
      account,
      from: from as string,
      to: to as string,
      basis: "cash",
      cut: parsedCut,
      setVersion: (setVersion as string | undefined) ?? null,
    },
  };
}

/** The query parameters of the GET route, in the order its docs give them. */
export const RECONSTRUCTED_STATE_PARAMETERS = [
  "account",
  "from",
  "to",
  "basis",
  "coreEpoch",
  "commitSeq",
  "instant",
  "setVersion",
] as const;
/** A commit sequence names a commit, so it starts at 1 (the cut before the log is an instant). */
const SEQ_TEXT = /^[1-9][0-9]{0,15}$/u;

/**
 * The GET route's query string as a request body, or the refusal. Each
 * parameter once and non-empty; the cut is `coreEpoch` with exactly one of
 * `commitSeq` and `instant`. The body is then validated like any other.
 */
export function reconstructedStateBodyFromQuery(
  params: URLSearchParams,
):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; refusal: ReconstructedStateRefusal; refs: string[] } {
  const keys = [...new Set(params.keys())];
  const scopes = keys.filter((key) =>
    (RECONSTRUCTED_STATE_UNSUPPORTED_SCOPES as readonly string[]).includes(key),
  );
  if (scopes.length > 0) return { ok: false, refusal: "scope_unsupported", refs: scopes };
  for (const key of keys) {
    if (!(RECONSTRUCTED_STATE_PARAMETERS as readonly string[]).includes(key))
      return { ok: false, refusal: "invalid_query", refs: [] };
    const values = params.getAll(key);
    if (values.length !== 1)
      return {
        ok: false,
        refusal: key === "account" ? "scope_unsupported" : "invalid_query",
        refs: [key],
      };
    if (values[0] === "") return { ok: false, refusal: "invalid_query", refs: [key] };
  }
  const body: Record<string, unknown> = {};
  for (const key of ["account", "from", "to", "basis", "setVersion"]) {
    const value = params.get(key);
    if (value !== null) body[key] = value;
  }
  const coreEpoch = params.get("coreEpoch");
  const commitSeq = params.get("commitSeq");
  const instant = params.get("instant");
  if (coreEpoch !== null || commitSeq !== null || instant !== null) {
    if (coreEpoch === null || (commitSeq === null) === (instant === null))
      return { ok: false, refusal: "invalid_cut", refs: ["cut"] };
    if (commitSeq !== null) {
      if (!SEQ_TEXT.test(commitSeq)) return { ok: false, refusal: "invalid_cut", refs: ["cut"] };
      body["cut"] = { coreEpoch, commitSeq: Number(commitSeq) };
    } else body["cut"] = { coreEpoch, instant };
  }
  return { ok: true, body };
}

/** Whether a resolved account id names an `accounts` row (by primary key). */
export const RECONSTRUCTED_STATE_ACCOUNT_SQL = "SELECT 1 AS present FROM accounts WHERE id=?1";

/** The refusal codes the query's own errors become. */
function refusalOf(error: unknown): { refusal: ReconstructedStateRefusal; refs: string[] } | null {
  if (error instanceof ReconstructedStateInputError)
    return {
      refusal: error.code === "invalid_query" ? "invalid_query" : error.code,
      refs: [],
    };
  if (error instanceof EconomicSelectorError)
    return error.code === "selector_bound_exceeded"
      ? { refusal: "result_limit_exceeded", refs: error.refs.slice(0, 10) }
      : // Field names only: the rejected value is never echoed.
        { refusal: error.code, refs: ["cut"] };
  if (error instanceof DatedStateLimitError)
    return { refusal: "result_limit_exceeded", refs: ["reportedState"] };
  // The pure selector's and the fold's own bounds (module-private class).
  if (
    error instanceof Error &&
    error.name === "ReconstructedStateRefusedError" &&
    /(?:_budget_exceeded|_bound_exceeded)$/u.test(error.message)
  )
    return { refusal: "result_limit_exceeded", refs: [error.message] };
  return null;
}

/**
 * The answer for one request under one grant, or the closed refusal. The
 * grant is checked before the request is read; the account before the query.
 */
export async function readReconstructedState(input: {
  grant: Grant;
  sql: SqlExecutor;
  body: unknown;
  /** The caller's clock, a UTC instant. */
  now: string;
}): Promise<ReconstructedStateOutcome> {
  const { grant, sql, body, now } = input;
  if (!grantAllows(grant, RECONSTRUCTED_STATE_CAPABILITY))
    return {
      ok: false,
      refusal: "capability_missing",
      refs: [`capability:${RECONSTRUCTED_STATE_CAPABILITY}`],
    };
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return { ok: false, refusal: "scope_restricted", refs: narrowed };
  const parsed = parseReconstructedStateRequest(body, now);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const known = await sql.first<{ present: number }>(RECONSTRUCTED_STATE_ACCOUNT_SQL, [
    request.account,
  ]);
  if (known === null) return { ok: false, refusal: "unknown_account", refs: ["account"] };
  let result: ReconstructedStateResult;
  try {
    result = await queryReconstructedState(sql, {
      account: request.account,
      from: request.from,
      to: request.to,
      basis: request.basis,
      cut: request.cut,
      now,
    });
  } catch (error) {
    const refused = refusalOf(error);
    if (refused === null) throw error;
    return { ok: false, ...refused };
  }
  // A pinned set version that no longer holds: the answer would be another one.
  if (request.setVersion !== null && result.knowledge?.setVersion !== request.setVersion)
    return { ok: false, refusal: "set_version_changed", refs: ["setVersion"] };
  return { ok: true, body: { apiVersion: 2, ...result } };
}

/** The agent API's error for a refusal; the code is its first ref. */
export function reconstructedStateError(
  refusal: ReconstructedStateRefusal,
  requestId: string,
  refs: readonly string[],
): FinancialError {
  return financialError(RECONSTRUCTED_STATE_REFUSALS[refusal].category, requestId, [
    `refusal:${refusal}`,
    ...refs,
  ]);
}
