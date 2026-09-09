// The typed request one query takes, and the server-resolved `QuerySpec` it
// becomes. Both the human UI and an agent send this shape; neither can send a
// column name, a table name, an ordering, SQL text, or a URL.
//
// Filters are allow-listed per intent and the allow-list is exactly the read
// model's `CollectionScope` keys, so a filter that reaches here is one the
// explicit read repository already accepts. An unknown key is refused as
// `unsupported_semantics` rather than ignored: silently dropping a filter
// would answer a different question from the one that was asked.
import { isRecord } from "../../../domain/src/guards.ts";
import type { FinancialErrorCode, QuerySpec } from "../../../domain/src/result.ts";
import { canonicalDigest } from "../../../domain/src/context.ts";
import type { TemporalValue } from "../../../domain/src/time.ts";
import { MEASURE_VIEWS } from "../../../../poc/observation-pipeline/shared/api-schema.ts";
import { DEFAULT_QUERY_LIMIT, GRANT_LIMITS } from "../grants.ts";

/**
 * The intents this service answers today. `net-worth`, `liquidity`,
 * `cash-flow`, `obligations`, `income`, `performance` and `reward-forecast`
 * are named in the domain contract but have no adopted semantics yet; asking
 * for one is `unsupported_semantics`, never a guess.
 */
export const SUPPORTED_QUERY_INTENTS = [
  "holdings",
  "reported-state",
  "activity",
  "coverage",
] as const;
export type SupportedQueryIntent = (typeof SUPPORTED_QUERY_INTENTS)[number];

export const QUERY_FILTER_KEYS = [
  "source",
  "account",
  "instrument",
  "metric",
  "from",
  "to",
  "q",
  "view",
] as const;
export type QueryFilterKey = (typeof QUERY_FILTER_KEYS)[number];

/** Filters each intent accepts; a key outside its list is refused. */
export const INTENT_FILTERS: Record<SupportedQueryIntent, readonly QueryFilterKey[]> = {
  holdings: ["source", "account"],
  "reported-state": ["source", "account", "instrument", "metric", "view"],
  activity: ["source", "account", "from", "to", "q"],
  coverage: ["source"],
};

/** The capability an intent needs before it runs. */
export const INTENT_CAPABILITY = {
  holdings: "summary.read",
  "reported-state": "records.read",
  activity: "records.read",
  coverage: "summary.read",
} as const satisfies Record<SupportedQueryIntent, string>;

export interface QueryRequest {
  intent: SupportedQueryIntent;
  filters: Partial<Record<QueryFilterKey, string>>;
  /** Opaque cursor from a previous result of the same context and spec. */
  cursor: string | null;
  /** Page size; null takes the default. Never larger than the grant's budget. */
  limit: number | null;
}

export interface SpecRejection {
  ok: false;
  code: FinancialErrorCode;
  refs: string[];
}
export type SpecOutcome<T> = { ok: true; value: T } | SpecRejection;

const REQUEST_KEYS = ["intent", "filters", "cursor", "limit"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function reject(code: FinancialErrorCode, refs: string[]): SpecRejection {
  return { ok: false, code, refs };
}

/**
 * Validate an untrusted request body. Unknown top-level keys and unknown
 * filter keys are both `unsupported_semantics`; malformed values of known
 * keys are `invalid_query`.
 */
export function parseQueryRequest(value: unknown): SpecOutcome<QueryRequest> {
  if (!isRecord(value)) return reject("invalid_query", []);
  const unknown = Object.keys(value).filter(
    (key) => !(REQUEST_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) return reject("unsupported_semantics", unknown.slice(0, 10));
  const intent = value.intent;
  if (typeof intent !== "string") return reject("invalid_query", ["intent"]);
  if (!(SUPPORTED_QUERY_INTENTS as readonly string[]).includes(intent))
    return reject("unsupported_semantics", [`intent:${intent.slice(0, 64)}`]);
  const supported = intent as SupportedQueryIntent;
  const rawFilters: unknown = value.filters ?? {};
  if (!isRecord(rawFilters)) return reject("invalid_query", ["filters"]);
  const allowed = INTENT_FILTERS[supported];
  const unknownFilters = Object.keys(rawFilters).filter(
    (key) => !(allowed as readonly string[]).includes(key),
  );
  if (unknownFilters.length > 0)
    return reject(
      "unsupported_semantics",
      unknownFilters.slice(0, 10).map((key) => `filter:${key.slice(0, 64)}`),
    );
  const filters: Partial<Record<QueryFilterKey, string>> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(rawFilters, key)) continue;
    const item: unknown = rawFilters[key];
    if (typeof item !== "string" || item === "" || item.length > 512 || CONTROL.test(item))
      return reject("invalid_query", [`filter:${key}`]);
    if ((key === "from" || key === "to") && !DATE.test(item))
      return reject("invalid_query", [`filter:${key}`]);
    if (key === "view" && !(MEASURE_VIEWS as readonly string[]).includes(item))
      return reject("invalid_query", ["filter:view"]);
    filters[key] = item;
  }
  const cursor: unknown = value.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 2048))
    return reject("invalid_query", ["cursor"]);
  const limit: unknown = value.limit ?? null;
  if (
    limit !== null &&
    (typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > GRANT_LIMITS.maxRows)
  )
    return reject("invalid_query", ["limit"]);
  return { ok: true, value: { intent: supported, filters, cursor, limit } };
}

/** The page size this request runs with, before the budget check. */
export function requestedLimit(request: QueryRequest): number {
  return request.limit ?? DEFAULT_QUERY_LIMIT;
}

/**
 * The server-resolved spec a result reports. It is built from the validated
 * request and the context, never from caller prose, and it is what a client
 * must echo to get the same page again.
 */
export function resolveQuerySpec(input: {
  request: QueryRequest;
  perimeterRef: string;
  effectiveTime: TemporalValue;
  basisRefs: Record<string, string>;
  limit: number;
}): QuerySpec {
  return {
    schemaVersion: "query-spec-v1",
    intent: input.request.intent,
    perimeterRef: input.perimeterRef,
    effectiveTime: input.effectiveTime,
    basisRefs: { ...input.basisRefs },
    filters: { ...input.request.filters },
    limit: input.limit,
  };
}

/**
 * Digest of everything that decides the input set of a page: the intent, the
 * perimeter, the bases and the filters. The page size is excluded so a client
 * may not change the answer by resizing a page; the cursor carries it.
 */
export async function querySpecDigest(spec: QuerySpec): Promise<string> {
  const { limit: _limit, ...pinned } = spec;
  return canonicalDigest(pinned);
}
