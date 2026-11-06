// The wire shape of `GET /api/v2/reported-holdings-change` (ADR 0075,
// docs/reported-state.md "Holdings changes between two dates"). Shape and
// consistency only: the client recalculates nothing. Every object has exactly
// the fields the query returns, so an answer that carries a figure the
// contract does not name (a total, a valuation, a sum of changes) is refused
// rather than displayed; every status, reason and side state is a closed code;
// a change figure exists exactly for `compared`, as an exact decimal in the
// holding's own unit, and never for a holding one date lists only or one that
// is not comparable; and an answer must say it computed no total or valuation.
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
import { validQuantity } from "../../domain/src/values.ts";

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
    value.holdings.length === body.holdings.length
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
