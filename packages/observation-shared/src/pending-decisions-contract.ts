// The wire shape of `GET /api/v2/decisions/pending` (ADR 0126,
// packages/application/src/query/pending-decisions.ts), checked by the browser
// before the ホーム page renders it. Every kind, reason, handler and bound is
// checked against the domain's closed lists, so the page never shows a line
// the summary cannot produce; the client counts nothing itself.
import {
  PENDING_DECISION_HANDLERS,
  PENDING_DECISION_KINDS,
  PENDING_DECISION_TIME_BASES,
  PENDING_DECISION_UNAVAILABLE,
  PENDING_DECISIONS_COUNT_BOUND,
  PENDING_DECISIONS_ID_BYTES,
  PENDING_DECISIONS_IDS_SHOWN,
  PENDING_DECISIONS_MAX_BYTES,
  PENDING_DECISIONS_NOT_COVERED,
} from "../../domain/src/pending-decisions.ts";

/** The path the browser reads the summary from. */
export const PENDING_DECISIONS_PATH = "/api/v2/decisions/pending";

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): boolean =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

function validLine(value: unknown, kind: (typeof PENDING_DECISION_KINDS)[number]): boolean {
  if (
    !record(value) ||
    value.kind !== kind ||
    !same(value.handler, PENDING_DECISION_HANDLERS[kind]) ||
    !(PENDING_DECISION_TIME_BASES as readonly unknown[]).includes(value.timeBasis) ||
    !Array.isArray(value.ids) ||
    value.ids.length > PENDING_DECISIONS_IDS_SHOWN ||
    !value.ids.every((id: unknown) => typeof id === "string" && id.length > 0) ||
    new TextEncoder().encode(value.ids.join("")).length > PENDING_DECISIONS_ID_BYTES
  )
    return false;
  if (value.state === "unavailable")
    return (
      (PENDING_DECISION_UNAVAILABLE as readonly unknown[]).includes(value.reason) &&
      value.count === null &&
      value.complete === false &&
      value.ids.length === 0 &&
      value.oldestAt === null
    );
  if (value.state !== "counted" || value.reason !== null || !count(value.count)) return false;
  if (typeof value.complete !== "boolean") return false;
  // A count the bound cut is exactly the bound.
  if (!value.complete && value.count !== PENDING_DECISIONS_COUNT_BOUND) return false;
  if (value.ids.length > value.count) return false;
  // A time only where one is recorded and something waits.
  if (value.timeBasis === "not_recorded" || value.count === 0) return value.oldestAt === null;
  return instant(value.oldestAt);
}

export function validPendingDecisions(value: unknown): boolean {
  return (
    record(value) &&
    value.apiVersion === 2 &&
    value.schemaVersion === "kogane-pending-decisions-v1" &&
    instant(value.asOf) &&
    same(value.bounds, {
      idsShown: PENDING_DECISIONS_IDS_SHOWN,
      idBytes: PENDING_DECISIONS_ID_BYTES,
      countBound: PENDING_DECISIONS_COUNT_BOUND,
      maxBytes: PENDING_DECISIONS_MAX_BYTES,
    }) &&
    Array.isArray(value.kinds) &&
    value.kinds.length === PENDING_DECISION_KINDS.length &&
    PENDING_DECISION_KINDS.every((kind, index) => validLine(value.kinds[index], kind)) &&
    same(value.notCovered, PENDING_DECISIONS_NOT_COVERED) &&
    value.decisions === "elsewhere"
  );
}
