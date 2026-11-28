// The wire shape of `GET /api/v2/reported-holdings-change` (ADR 0075,
// docs/reported-state.md "Holdings changes between two dates"). Shape and
// consistency only: the client recalculates nothing. Every object has exactly
// the fields the query returns, so an answer that carries a figure the
// contract does not name (a total, a valuation, a sum of changes) is refused
// rather than displayed; every status, reason and side state is a closed code;
// a change figure exists exactly for `compared`, as an exact decimal in the
// holding's own unit, and never for a holding one date lists only or one that
// is not comparable; and an answer must say it computed no total or valuation.
// The summary (`detail=summary`, the default; ADR 0075 amendment 2026-11-19)
// has its own validator below: changed lines only, the same closed codes and
// the same refusal of a total.
import { pagedFieldsAbsentOrValid, pagedFieldsSay } from "./paging-contract.ts";
import {
  HOLDINGS_CHANGE_DETAILS,
  HOLDINGS_CHANGE_SUMMARY_PAGE_SIZES,
  HOLDINGS_CHANGE_SUMMARY_SCHEMA,
} from "../../domain/src/holdings-change-summary.ts";
import {
  HOLDING_CHANGE_REASONS,
  HOLDING_CHANGE_STATUSES,
  HOLDINGS_CHANGE_POLICY,
  HOLDINGS_CHANGE_SCHEMA,
  HOLDINGS_CHANGE_SIDE_BOUND,
} from "../../domain/src/holdings-change.ts";
import {
  FRESHNESS_STATES,
  IDENTITY_STATUSES,
  REPORTED_STATE_ZONE,
} from "../../domain/src/reported-state.ts";
import { validInstantText, validLocalDateText } from "../../domain/src/time.ts";
import { validQuantity, VALUE_STATUSES } from "../../domain/src/values.ts";

export const REPORTED_HOLDINGS_CHANGE_PATH = "/api/v2/reported-holdings-change";
/** Every query parameter the route (and so its agent read) takes; any other is refused. */
export const HOLDINGS_CHANGE_PARAMETERS = [
  "from",
  "to",
  "source",
  "account",
  "detail",
  "limit",
  "cursor",
] as const;
// The reported state's own parameter shapes.
export const HOLDINGS_CHANGE_SOURCE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const HOLDINGS_CHANGE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/u;
/** A summary cursor: base64url, as `paging.ts` writes it. */
const HOLDINGS_CHANGE_CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;

/**
 * A request the route takes: two dates and, optionally, one source, one
 * account and the detail (`summary` when absent; the page asks for `full`).
 */
export interface HoldingsChangeRequest {
  from: string;
  to: string;
  source?: string;
  account?: string;
  detail?: (typeof HOLDINGS_CHANGE_DETAILS)[number];
}

/**
 * The route's refusal of a query string's shape, decided before the store is
 * read: `invalid_query` for another, repeated or empty parameter, a
 * malformed source, account or cursor, a `detail` other than `summary` or
 * `full`, a `limit` that is not an offered page size, and a `limit` or
 * `cursor` with `detail=full` (the full answer is not paged); `invalid_date`
 * for a missing, malformed or impossible date; null when the shape is
 * accepted. The route and the page both apply it, so the page never sends a
 * shape the route refuses.
 */
export function holdingsChangeQueryRefusal(
  params: URLSearchParams,
): "invalid_query" | "invalid_date" | null {
  for (const [key, value] of params)
    if (
      !(HOLDINGS_CHANGE_PARAMETERS as readonly string[]).includes(key) ||
      params.getAll(key).length !== 1 ||
      !value
    )
      return "invalid_query";
  if (!validLocalDateText(params.get("from")) || !validLocalDateText(params.get("to")))
    return "invalid_date";
  const source = params.get("source");
  if (source !== null && !HOLDINGS_CHANGE_SOURCE.test(source)) return "invalid_query";
  const account = params.get("account");
  if (account !== null && !HOLDINGS_CHANGE_ACCOUNT.test(account)) return "invalid_query";
  const detail = params.get("detail");
  if (detail !== null && !(HOLDINGS_CHANGE_DETAILS as readonly string[]).includes(detail))
    return "invalid_query";
  const limit = params.get("limit");
  if (
    limit !== null &&
    !(HOLDINGS_CHANGE_SUMMARY_PAGE_SIZES as readonly number[]).some((size) => `${size}` === limit)
  )
    return "invalid_query";
  const cursor = params.get("cursor");
  if (cursor !== null && !HOLDINGS_CHANGE_CURSOR.test(cursor)) return "invalid_query";
  if (detail === "full" && (limit !== null || cursor !== null)) return "invalid_query";
  return null;
}

/** The route's query string for a request, in the route's parameter order. */
export function holdingsChangeSearch(request: HoldingsChangeRequest): URLSearchParams {
  const params = new URLSearchParams({ from: request.from, to: request.to });
  if (request.source !== undefined) params.set("source", request.source);
  if (request.account !== undefined) params.set("account", request.account);
  if (request.detail !== undefined) params.set("detail", request.detail);
  return params;
}

/** Every key of two dates, each bounded by the query on its own date. */
const BOUND = 2 * HOLDINGS_CHANGE_SIDE_BOUND;
const POSITION_REF = /^position:[1-9][0-9]*$/u;
const ARTIFACT_REF = /^artifact:[1-9][0-9]*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SIDES = ["start", "end"] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Exactly these fields: a figure the contract does not name is refused, not ignored. */
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;
const nullableText = (value: unknown): boolean => value === null || text(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const member =
  (choices: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === "string" && choices.includes(value);
const list = <T>(value: unknown, each: (entry: unknown) => boolean): value is T[] =>
  Array.isArray(value) && value.length <= BOUND && value.every(each);
const matches =
  (pattern: RegExp) =>
  (value: unknown): boolean =>
    typeof value === "string" && pattern.test(value);
const digest = matches(DIGEST);
const date = (value: unknown): value is string => validLocalDateText(value);
const nonEmptyList = (value: unknown, each: (entry: unknown) => boolean): boolean =>
  list(value, each) && value.length > 0;

const CONTAINER_KEYS = ["sourceId", "parserName", "dataset"] as const;
const SNAPSHOT_VIEW_KEYS = [
  "snapshotRef",
  "capturedAt",
  "captureDate",
  "ageDays",
  "freshness",
] as const;

function validSnapshotView(value: Record<string, unknown>): boolean {
  return (
    matches(ARTIFACT_REF)(value.snapshotRef) &&
    validInstantText(value.capturedAt) &&
    date(value.captureDate) &&
    count(value.ageDays) &&
    member(FRESHNESS_STATES)(value.freshness)
  );
}

function validKey(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [...CONTAINER_KEYS, "sourceAccount", "market", "securityCode"]) &&
    text(value.sourceId) &&
    text(value.parserName) &&
    text(value.dataset) &&
    text(value.sourceAccount) &&
    nullableText(value.market) &&
    text(value.securityCode)
  );
}

/** One date's side of a holding, in the holding's unit. */
function validSide(value: unknown, unitRef: string): value is Record<string, unknown> {
  if (!record(value)) return false;
  switch (value.state) {
    case "listed":
      return (
        exactKeys(value, [
          "state",
          "positionRef",
          ...SNAPSHOT_VIEW_KEYS,
          "accountId",
          "accountIdentity",
          "instrument",
          "quantityText",
          "quantity",
        ]) &&
        matches(POSITION_REF)(value.positionRef) &&
        validSnapshotView(value) &&
        nullableText(value.accountId) &&
        member(IDENTITY_STATUSES)(value.accountIdentity) &&
        record(value.instrument) &&
        exactKeys(value.instrument, ["instrumentId", "status"]) &&
        nullableText(value.instrument.instrumentId) &&
        member(IDENTITY_STATUSES)(value.instrument.status) &&
        text(value.quantityText) &&
        validQuantity(value.quantity) &&
        value.quantity.unitRef === unitRef
      );
    case "listed_more_than_once":
      return (
        exactKeys(value, ["state", "positionRefs", "snapshotRefs"]) &&
        list(value.positionRefs, matches(POSITION_REF)) &&
        value.positionRefs.length > 1 &&
        nonEmptyList(value.snapshotRefs, matches(ARTIFACT_REF))
      );
    case "not_listed":
      return exactKeys(value, ["state", ...SNAPSHOT_VIEW_KEYS]) && validSnapshotView(value);
    case "snapshot_scope_ambiguous":
      return (
        exactKeys(value, ["state", "snapshotRefs"]) &&
        list(value.snapshotRefs, matches(ARTIFACT_REF))
      );
    case "no_snapshot":
      return exactKeys(value, ["state"]);
    default:
      return false;
  }
}

/** The reason a side's own state gives, which the holding must carry. */
const SIDE_REASON: Record<string, string> = {
  no_snapshot: "no_snapshot_at",
  snapshot_scope_ambiguous: "snapshot_scope_ambiguous_at",
  listed_more_than_once: "holding_key_ambiguous_at",
};

/** Reasons are closed codes, each once and in the query's order. */
function validReasons(value: unknown): value is string[] {
  if (!list(value, member(HOLDING_CHANGE_REASONS))) return false;
  const order = (value as string[]).map((reason) =>
    (HOLDING_CHANGE_REASONS as readonly string[]).indexOf(reason),
  );
  return order.every((index, at) => at === 0 || index > order[at - 1]!);
}

function validHolding(value: unknown): boolean {
  if (
    !record(value) ||
    !exactKeys(value, ["key", "unitRef", "start", "end", "status", "reasons", "change"])
  )
    return false;
  const { unitRef, start, end, reasons, change } = value;
  if (
    !validKey(value.key) ||
    !text(unitRef) ||
    !validSide(start, unitRef) ||
    !validSide(end, unitRef) ||
    !member(HOLDING_CHANGE_STATUSES)(value.status) ||
    !validReasons(reasons)
  )
    return false;
  // Each side's own reason is present exactly when its state gives one.
  for (const [name, side] of [
    ["start", start],
    ["end", end],
  ] as const) {
    for (const [state, prefix] of Object.entries(SIDE_REASON))
      if ((side.state === state) !== reasons.includes(`${prefix}_${name}`)) return false;
  }
  switch (value.status) {
    case "compared":
      return (
        reasons.length === 0 &&
        start.state === "listed" &&
        end.state === "listed" &&
        validQuantity(change) &&
        change.unitRef === unitRef &&
        change.value.status === "exact"
      );
    case "listed_at_start_only":
      return (
        reasons.length === 0 &&
        start.state === "listed" &&
        end.state === "not_listed" &&
        change === null
      );
    case "listed_at_end_only":
      return (
        reasons.length === 0 &&
        start.state === "not_listed" &&
        end.state === "listed" &&
        change === null
      );
    default:
      // `not_comparable`: at least one reason and never a figure.
      return reasons.length > 0 && change === null;
  }
}

function validCounts(value: unknown, holdings: Record<string, unknown>[]): boolean {
  return (
    record(value) &&
    exactKeys(value, HOLDING_CHANGE_STATUSES) &&
    HOLDING_CHANGE_STATUSES.every(
      (status) =>
        count(value[status]) &&
        value[status] === holdings.filter((holding) => holding.status === status).length,
    )
  );
}

function validCoverage(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["containersWithoutSnapshot", "staleSnapshots", "total", "valuation"]) &&
    list(
      value.containersWithoutSnapshot,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["side", ...CONTAINER_KEYS]) &&
        member(SIDES)(entry.side) &&
        text(entry.sourceId) &&
        text(entry.parserName) &&
        text(entry.dataset),
    ) &&
    list(
      value.staleSnapshots,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["side", "ref", "sourceId", "parserName", "ageDays"]) &&
        member(SIDES)(entry.side) &&
        matches(ARTIFACT_REF)(entry.ref) &&
        text(entry.sourceId) &&
        text(entry.parserName) &&
        count(entry.ageDays),
    ) &&
    // Holdings of different instruments are never added or valued.
    value.total === "not-computed" &&
    value.valuation === "not-computed"
  );
}

function validFilters(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["source", "account"]) &&
    nullableText(value.source) &&
    nullableText(value.account)
  );
}

/** The manifest's reference to one side, as the domain writes it. */
function sideRef(side: Record<string, unknown>): unknown {
  if (side.state === "listed") return side.positionRef;
  if (side.state === "listed_more_than_once") return (side.positionRefs as string[]).join(",");
  return side.state;
}

const KEY_FIELDS = [...CONTAINER_KEYS, "sourceAccount", "market", "securityCode"] as const;
const sameList = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((entry, index) => entry === b[index]);

const sameFilters = (a: unknown, b: unknown): boolean =>
  record(a) && record(b) && a.source === b.source && a.account === b.account;

/** Each manifest entry describes the body's holding at the same index. */
function manifestEntryAgrees(entry: Record<string, unknown>, holding: unknown): boolean {
  if (!record(holding)) return false;
  const key = entry.key as Record<string, unknown>;
  const holdingKey = holding.key as Record<string, unknown>;
  return (
    KEY_FIELDS.every((field) => key[field] === holdingKey[field]) &&
    entry.status === holding.status &&
    sameList(entry.reasons, holding.reasons) &&
    entry.start === sideRef(holding.start as Record<string, unknown>) &&
    entry.end === sideRef(holding.end as Record<string, unknown>)
  );
}

function validManifest(value: unknown, body: Record<string, unknown>): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "schemaVersion",
      "policy",
      "zone",
      "from",
      "to",
      "filters",
      "quantityPolicy",
      "reportedContextIds",
      "holdings",
    ]) &&
    value.schemaVersion === HOLDINGS_CHANGE_SCHEMA &&
    value.policy === HOLDINGS_CHANGE_POLICY &&
    value.zone === REPORTED_STATE_ZONE &&
    value.from === body.from &&
    value.to === body.to &&
    validFilters(value.filters) &&
    sameFilters(value.filters, body.filters) &&
    value.quantityPolicy === body.quantityPolicy &&
    record(value.reportedContextIds) &&
    exactKeys(value.reportedContextIds, ["start", "end"]) &&
    digest(value.reportedContextIds.start) &&
    digest(value.reportedContextIds.end) &&
    list(
      value.holdings,
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["key", "start", "end", "status", "reasons"]) &&
        validKey(entry.key) &&
        text(entry.start) &&
        text(entry.end) &&
        member(HOLDING_CHANGE_STATUSES)(entry.status) &&
        validReasons(entry.reasons),
    ) &&
    Array.isArray(body.holdings) &&
    value.holdings.length === body.holdings.length &&
    value.holdings.every((entry, index) =>
      manifestEntryAgrees(entry as Record<string, unknown>, (body.holdings as unknown[])[index]),
    )
  );
}

/** The API body: `apiVersion` 2 and the holdings change, nothing else. */
export function validReportedHoldingsChange(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      "apiVersion",
      "schemaVersion",
      "policy",
      "zone",
      "from",
      "to",
      "filters",
      "quantityPolicy",
      "holdings",
      "counts",
      "coverage",
      "manifest",
      "contextId",
    ]) &&
    value.apiVersion === 2 &&
    value.schemaVersion === HOLDINGS_CHANGE_SCHEMA &&
    value.policy === HOLDINGS_CHANGE_POLICY &&
    value.zone === REPORTED_STATE_ZONE &&
    date(value.from) &&
    date(value.to) &&
    value.from < value.to &&
    validFilters(value.filters) &&
    text(value.quantityPolicy) &&
    list<Record<string, unknown>>(value.holdings, validHolding) &&
    validCounts(value.counts, value.holdings) &&
    validCoverage(value.coverage) &&
    validManifest(value.manifest, value) &&
    digest(value.contextId)
  );
}

// ── the summary (`detail=summary`) ────────────────────────────────────────

/** An exact decimal as `decimalToString` writes it: no exponent, no trailing zero. */
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
const decimal = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 4200 && DECIMAL.test(value) && value !== "-0";
const CONTAINER_REF = /^c[1-9][0-9]*$/u;

function validSummarySide(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  switch (value.state) {
    case "listed":
      return (
        exactKeys(value, ["state", "positionRef", "quantity", "quantityStatus"]) &&
        matches(POSITION_REF)(value.positionRef) &&
        member(VALUE_STATUSES)(value.quantityStatus) &&
        // A quantity that is not exact is its status, never a number (INV05).
        (value.quantityStatus === "exact" ? decimal(value.quantity) : value.quantity === null)
      );
    case "listed_more_than_once":
      return (
        exactKeys(value, ["state", "positionRefs"]) &&
        list(value.positionRefs, matches(POSITION_REF)) &&
        value.positionRefs.length > 1
      );
    case "not_listed":
      return exactKeys(value, ["state", "snapshotRef"]) && matches(ARTIFACT_REF)(value.snapshotRef);
    case "snapshot_scope_ambiguous":
      return (
        exactKeys(value, ["state", "snapshotRefs"]) &&
        list(value.snapshotRefs, matches(ARTIFACT_REF))
      );
    case "no_snapshot":
      return exactKeys(value, ["state"]);
    default:
      return false;
  }
}

/** One listed line: the full answer's rules of its status, and never an unchanged holding. */
function validSummaryLine(value: unknown, containers: Record<string, unknown>): boolean {
  if (
    !record(value) ||
    !exactKeys(value, [
      "container",
      "sourceAccount",
      "market",
      "securityCode",
      "unitRef",
      "status",
      "reasons",
      "start",
      "end",
      "change",
    ])
  )
    return false;
  const { start, end, reasons, change } = value;
  if (
    typeof value.container !== "string" ||
    !Object.hasOwn(containers, value.container) ||
    !text(value.sourceAccount) ||
    !nullableText(value.market) ||
    !text(value.securityCode) ||
    !text(value.unitRef) ||
    !member(HOLDING_CHANGE_STATUSES)(value.status) ||
    !validReasons(reasons) ||
    !validSummarySide(start) ||
    !validSummarySide(end)
  )
    return false;
  for (const [name, side] of [
    ["start", start],
    ["end", end],
  ] as const) {
    for (const [state, prefix] of Object.entries(SIDE_REASON))
      if ((side.state === state) !== reasons.includes(`${prefix}_${name}`)) return false;
    // Both dates listed: a quantity that is not exact is its reason.
    if (
      start.state === "listed" &&
      end.state === "listed" &&
      (side.quantityStatus !== "exact") !== reasons.includes(`quantity_not_exact_at_${name}`)
    )
      return false;
  }
  switch (value.status) {
    case "compared":
      // An exact zero change is counted as unchanged, never listed.
      return (
        reasons.length === 0 &&
        start.state === "listed" &&
        end.state === "listed" &&
        decimal(change) &&
        change !== "0"
      );
    case "listed_at_start_only":
      return (
        reasons.length === 0 &&
        start.state === "listed" &&
        end.state === "not_listed" &&
        change === null
      );
    case "listed_at_end_only":
      return (
        reasons.length === 0 &&
        start.state === "not_listed" &&
        end.state === "listed" &&
        change === null
      );
    default:
      // `not_comparable`: at least one reason and never a figure.
      return reasons.length > 0 && change === null;
  }
}

/** `c1`, `c2`, … each named by a line, in the order the lines first name them. */
function validContainers(value: unknown, items: Record<string, unknown>[]): boolean {
  if (!record(value)) return false;
  const firstSeen: string[] = [];
  for (const item of items)
    if (!firstSeen.includes(item.container as string)) firstSeen.push(item.container as string);
  return (
    sameList(Object.keys(value), firstSeen) &&
    firstSeen.every((ref, index) => ref === `c${index + 1}` && CONTAINER_REF.test(ref)) &&
    Object.values(value).every(
      (entry) =>
        record(entry) &&
        exactKeys(entry, CONTAINER_KEYS) &&
        text(entry.sourceId) &&
        text(entry.parserName) &&
        text(entry.dataset),
    ) &&
    // Two refs never name one container.
    new Set(
      Object.values(value).map((entry) => {
        const container = entry as Record<string, unknown>;
        return JSON.stringify([container.sourceId, container.parserName, container.dataset]);
      }),
    ).size === firstSeen.length
  );
}

/** Each reason a `not_comparable` holding carries, counted once per holding. */
function validReasonCounts(value: unknown, notComparable: number): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return (
    validReasons(keys) &&
    keys.every((key) => count(value[key]) && value[key] > 0 && value[key] <= notComparable) &&
    // Every holding without a figure carries at least one reason.
    (notComparable === 0) === (keys.length === 0)
  );
}

/**
 * The summary body: changed lines only, in status order, with the counts that
 * say how many holdings were not listed (`unchanged`) and why the others have
 * no figure. A total, a valuation, an unchanged line or a figure for a
 * quantity that is not exact is refused.
 */
export function validReportedHoldingsChangeSummary(value: unknown): boolean {
  if (
    !record(value) ||
    // `next` and `paging` (ADR 0128) beside the deprecated `page`, in the
    // release that keeps both.
    !pagedFieldsAbsentOrValid(value) ||
    !exactKeys(value, [
      ...(Object.hasOwn(value, "paging") ? (["next", "paging"] as const) : []),
      "apiVersion",
      "schemaVersion",
      "detail",
      "policy",
      "zone",
      "from",
      "to",
      "filters",
      "quantityPolicy",
      "counts",
      "unchanged",
      "reasonCounts",
      "containers",
      "items",
      "page",
      "coverage",
      "contextId",
    ]) ||
    value.apiVersion !== 2 ||
    value.schemaVersion !== HOLDINGS_CHANGE_SUMMARY_SCHEMA ||
    value.detail !== "summary" ||
    value.policy !== HOLDINGS_CHANGE_POLICY ||
    value.zone !== REPORTED_STATE_ZONE ||
    !date(value.from) ||
    !date(value.to) ||
    !(value.from < value.to) ||
    !validFilters(value.filters) ||
    !text(value.quantityPolicy) ||
    !digest(value.contextId) ||
    !validCoverage(value.coverage) ||
    !record(value.counts) ||
    !exactKeys(value.counts, HOLDING_CHANGE_STATUSES) ||
    !count(value.unchanged) ||
    !record(value.page) ||
    !exactKeys(value.page, ["offset", "limit", "listed", "hasMore", "nextCursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > BOUND ||
    !value.items.every(record)
  )
    return false;
  const counts = value.counts;
  if (!HOLDING_CHANGE_STATUSES.every((status) => count(counts[status]))) return false;
  const tally = counts as Record<(typeof HOLDING_CHANGE_STATUSES)[number], number>;
  const page = value.page;
  const items = value.items as Record<string, unknown>[];
  const listed =
    tally.compared -
    value.unchanged +
    tally.listed_at_start_only +
    tally.listed_at_end_only +
    tally.not_comparable;
  if (!count(page.offset) || typeof page.limit !== "number") return false;
  const order = items.map((item) =>
    (HOLDING_CHANGE_STATUSES as readonly unknown[]).indexOf(item.status),
  );
  return (
    value.unchanged <= tally.compared &&
    validReasonCounts(value.reasonCounts, tally.not_comparable) &&
    (HOLDINGS_CHANGE_SUMMARY_PAGE_SIZES as readonly number[]).includes(page.limit) &&
    page.listed === listed &&
    (page.offset === 0 || page.offset < listed) &&
    // A page holds every line it can, up to its size.
    items.length === Math.min(page.limit, listed - page.offset) &&
    page.hasMore === page.offset + items.length < listed &&
    (page.hasMore
      ? typeof page.nextCursor === "string" && HOLDINGS_CHANGE_CURSOR.test(page.nextCursor)
      : page.nextCursor === null) &&
    pagedFieldsSay(value, {
      next: typeof page.nextCursor === "string" ? { cursor: page.nextCursor } : null,
      limit: page.limit as number,
      returned: items.length,
    }) &&
    validContainers(value.containers, items) &&
    items.every((item) => validSummaryLine(item, value.containers as Record<string, unknown>)) &&
    order.every((index, at) => at === 0 || index >= order[at - 1]!) &&
    // A page never lists more lines of a status than the comparison holds.
    HOLDING_CHANGE_STATUSES.every(
      (status) => items.filter((item) => item.status === status).length <= tally[status],
    )
  );
}

/** Either detail's body: a summary names itself, the full answer has no `detail`. */
export function validReportedHoldingsChangeAnswer(value: unknown): boolean {
  return record(value) && Object.hasOwn(value, "detail")
    ? validReportedHoldingsChangeSummary(value)
    : validReportedHoldingsChange(value);
}
