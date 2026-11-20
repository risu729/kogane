// The summary of a reported holdings change between two dates (ADR 0075,
// amendment 2026-11-19: "a summary that lists changed lines only"). Pure: it
// reshapes one `compareReportedHoldings` answer and reads nothing else.
//
// What a summary lists: every holding whose change is not an exact zero. A
// `compared` holding with an exact zero change is counted (`unchanged`), not
// listed; a holding one date lists only (added or removed) is listed; a
// `not_comparable` holding is listed with its reasons and counted per reason,
// so a missing, non-exact or conflicting quantity, an ambiguous key or scope,
// or no capture on a date is never read as "unchanged" (INV05). Nothing is
// added across holdings: each line keeps its own unit, and the summary states
// `total: "not-computed"` as the full answer does.
//
// What a summary drops: each side's capture time, capture date, age and
// freshness (the stale snapshots stay in `coverage`), the resolved account and
// instrument ids and their identity statuses (an identity that differs between
// the dates stays as `account_differs` or `instrument_differs`), the provider's
// quantity text and the manifest. Every line keeps the position and artifact
// refs that read it in full (`kogane.observations.get`) or as evidence.
//
// Paging: lines are listed in the closed status order, key order within, and
// paged with the keyset cursor format of `paging.ts`, bound to the comparison
// (`contextId`, which digests every key's refs, status and reasons and both
// reported contexts) and to the request's dates and filters, never to the page
// size or the detail.
import { canonicalDigest } from "./context.ts";
import {
  HOLDING_CHANGE_REASONS,
  HOLDING_CHANGE_STATUSES,
  HOLDINGS_CHANGE_POLICY,
  type HoldingChange,
  type HoldingChangeReason,
  type HoldingChangeStatus,
  type HoldingSide,
  type HoldingsChange,
  type HoldingsChangeContainer,
} from "./holdings-change.ts";
import { decodeKeysetCursor, encodeKeysetCursor } from "./paging.ts";
import { pagedFields, type PagedFields } from "../../observation-shared/src/paging-contract.ts";
import type { REPORTED_STATE_ZONE } from "./reported-state.ts";
import { decimalToString, isZeroDecimal, type ValueStatus } from "./values.ts";

export const HOLDINGS_CHANGE_SUMMARY_SCHEMA = "reported-holdings-change-summary-v1";
/** `summary` (the default) lists changed lines only; `full` is the comparison as it is. */
export const HOLDINGS_CHANGE_DETAILS = ["summary", "full"] as const;
/** The page sizes a summary offers; any other is refused. */
export const HOLDINGS_CHANGE_SUMMARY_PAGE_SIZES = [10, 25, 50, 100] as const;
/** Ten lines: under 8 KB with every line at the longest key shape (25 such lines are not). */
export const HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT = 10;

/** One date's side of a listed line, without its capture's provenance. */
type HoldingSummarySide =
  | {
      state: "listed";
      positionRef: string;
      /** The exact decimal, or null when the stored quantity is not exact. */
      quantity: string | null;
      quantityStatus: ValueStatus;
    }
  | { state: "listed_more_than_once"; positionRefs: string[] }
  /** The capture that does not list the key: the evidence of the absence. */
  | { state: "not_listed"; snapshotRef: string }
  | { state: "snapshot_scope_ambiguous"; snapshotRefs: string[] }
  | { state: "no_snapshot" };

export interface HoldingSummaryLine {
  /** A page-local ref into `containers` (`c1`, `c2`, … in order of first appearance). */
  container: string;
  sourceAccount: string;
  market: string | null;
  securityCode: string;
  unitRef: string;
  status: HoldingChangeStatus;
  reasons: HoldingChangeReason[];
  start: HoldingSummarySide;
  end: HoldingSummarySide;
  /** End minus start, exact and never zero, only for `compared`. */
  change: string | null;
}

interface HoldingsChangeSummaryPage {
  /** Lines before this page. */
  offset: number;
  limit: number;
  /** Every listed line of the comparison, on all pages. */
  listed: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/** `next` and `paging` (ADR 0128) beside the deprecated `page.nextCursor`. */
export interface HoldingsChangeSummary extends PagedFields {
  schemaVersion: typeof HOLDINGS_CHANGE_SUMMARY_SCHEMA;
  detail: "summary";
  policy: typeof HOLDINGS_CHANGE_POLICY;
  zone: typeof REPORTED_STATE_ZONE;
  from: string;
  to: string;
  filters: { source: string | null; account: string | null };
  quantityPolicy: string;
  /** The full answer's counts per status, over every holding. */
  counts: Record<HoldingChangeStatus, number>;
  /** `compared` holdings whose exact change is zero: counted here, never listed. */
  unchanged: number;
  /** How many `not_comparable` holdings carry each reason (a holding may carry several). */
  reasonCounts: Partial<Record<HoldingChangeReason, number>>;
  containers: Record<string, HoldingsChangeContainer>;
  items: HoldingSummaryLine[];
  page: HoldingsChangeSummaryPage;
  coverage: HoldingsChange["coverage"];
  /** The comparison's `contextId`: the same as its full answer's. */
  contextId: string;
}

export type HoldingsChangeCursorRefusal = "invalid_cursor" | "cursor_mismatch" | "context_expired";

const STATUS_ORDER = new Map(HOLDING_CHANGE_STATUSES.map((status, index) => [status, index]));

/** Whether a holding is listed by the summary: anything but an exact zero change. */
function holdingChangeListed(holding: HoldingChange): boolean {
  return !(
    holding.status === "compared" &&
    holding.change !== null &&
    holding.change.value.status === "exact" &&
    isZeroDecimal(holding.change.value.value)
  );
}

/** The listed holdings in the summary's order: status order, key order within (stable). */
export function holdingsChangeSummaryLines(change: HoldingsChange): HoldingChange[] {
  return change.holdings
    .filter(holdingChangeListed)
    .map((holding, index) => ({ holding, index }))
    .sort(
      (a, b) =>
        STATUS_ORDER.get(a.holding.status)! - STATUS_ORDER.get(b.holding.status)! ||
        a.index - b.index,
    )
    .map(({ holding }) => holding);
}

function summarySide(side: HoldingSide): HoldingSummarySide {
  switch (side.state) {
    case "listed":
      return {
        state: "listed",
        positionRef: side.positionRef,
        quantity:
          side.quantity.value.status === "exact"
            ? decimalToString(side.quantity.value.value)
            : null,
        quantityStatus: side.quantity.value.status,
      };
    case "listed_more_than_once":
      return { state: side.state, positionRefs: [...side.positionRefs] };
    case "not_listed":
      return { state: side.state, snapshotRef: side.snapshotRef };
    case "snapshot_scope_ambiguous":
      return { state: side.state, snapshotRefs: [...side.snapshotRefs] };
    case "no_snapshot":
      return { state: side.state };
  }
}

function changeText(holding: HoldingChange): string | null {
  if (holding.change === null) return null;
  if (holding.change.value.status !== "exact") throw new RangeError("change_not_exact");
  return decimalToString(holding.change.value.value);
}

/** What a cursor is bound to besides the comparison: the dates and the filters. */
async function cursorFilterDigest(change: HoldingsChange): Promise<string> {
  return canonicalDigest({
    schema: HOLDINGS_CHANGE_SUMMARY_SCHEMA,
    from: change.from,
    to: change.to,
    filters: change.filters,
  });
}

/**
 * Where a page starts: 0 without a cursor, the cursor's position with one. A
 * cursor that does not decode, or names a position past the lines, is
 * `invalid_cursor`; one of other dates or filters `cursor_mismatch`; one of
 * the same request whose comparison has moved (another capture, mapping,
 * parse or reported context) `context_expired`, never a page of the new one.
 */
async function pageOffset(
  change: HoldingsChange,
  listed: number,
  cursor: string | null,
): Promise<{ ok: true; offset: number } | { ok: false; code: HoldingsChangeCursorRefusal }> {
  if (cursor === null) return { ok: true, offset: 0 };
  const decoded = decodeKeysetCursor(cursor);
  if (decoded === null || decoded.r !== undefined || decoded.k !== "")
    return { ok: false, code: "invalid_cursor" };
  if (decoded.f !== (await cursorFilterDigest(change)))
    return { ok: false, code: "cursor_mismatch" };
  if (decoded.s !== change.contextId) return { ok: false, code: "context_expired" };
  if (decoded.t < 1 || decoded.t >= listed) return { ok: false, code: "invalid_cursor" };
  return { ok: true, offset: decoded.t };
}

/**
 * One page of the summary of `change`. `limit` must be an offered page size;
 * `cursor` is a previous page's `nextCursor` for the same dates and filters,
 * at any offered size.
 */
export async function summarizeHoldingsChange(
  change: HoldingsChange,
  request: { limit: number; cursor: string | null },
): Promise<
  { ok: true; summary: HoldingsChangeSummary } | { ok: false; code: HoldingsChangeCursorRefusal }
> {
  if (!(HOLDINGS_CHANGE_SUMMARY_PAGE_SIZES as readonly number[]).includes(request.limit))
    throw new RangeError("invalid_limit");
  const lines = holdingsChangeSummaryLines(change);
  const start = await pageOffset(change, lines.length, request.cursor);
  if (!start.ok) return start;
  const offset = start.offset;
  const shown = lines.slice(offset, offset + request.limit);
  const hasMore = offset + shown.length < lines.length;

  const containers: Record<string, HoldingsChangeContainer> = {};
  const containerRef = new Map<string, string>();
  const items = shown.map((holding): HoldingSummaryLine => {
    const container = {
      sourceId: holding.key.sourceId,
      parserName: holding.key.parserName,
      dataset: holding.key.dataset,
    };
    const text = JSON.stringify([container.sourceId, container.parserName, container.dataset]);
    let ref = containerRef.get(text);
    if (ref === undefined) {
      ref = `c${containerRef.size + 1}`;
      containerRef.set(text, ref);
      containers[ref] = container;
    }
    return {
      container: ref,
      sourceAccount: holding.key.sourceAccount,
      market: holding.key.market,
      securityCode: holding.key.securityCode,
      unitRef: holding.unitRef,
      status: holding.status,
      reasons: [...holding.reasons],
      start: summarySide(holding.start),
      end: summarySide(holding.end),
      change: changeText(holding),
    };
  });

  const nextCursor = hasMore
    ? encodeKeysetCursor({
        s: change.contextId,
        f: await cursorFilterDigest(change),
        k: "",
        t: offset + shown.length,
      })
    : null;

  const reasonCounts: Partial<Record<HoldingChangeReason, number>> = {};
  for (const reason of HOLDING_CHANGE_REASONS) {
    const holdings = change.holdings.filter((holding) => holding.reasons.includes(reason)).length;
    if (holdings > 0) reasonCounts[reason] = holdings;
  }

  return {
    ok: true,
    summary: {
      schemaVersion: HOLDINGS_CHANGE_SUMMARY_SCHEMA,
      detail: "summary",
      policy: change.policy,
      zone: change.zone,
      from: change.from,
      to: change.to,
      filters: { ...change.filters },
      quantityPolicy: change.quantityPolicy,
      counts: { ...change.counts },
      unchanged: change.holdings.length - lines.length,
      reasonCounts,
      containers,
      items,
      page: {
        offset,
        limit: request.limit,
        listed: lines.length,
        hasMore,
        nextCursor,
      },
      ...pagedFields({
        limit: request.limit,
        returned: items.length,
        next: nextCursor === null ? null : { cursor: nextCursor },
      }),
      coverage: {
        containersWithoutSnapshot: change.coverage.containersWithoutSnapshot.map((entry) => ({
          ...entry,
        })),
        staleSnapshots: change.coverage.staleSnapshots.map((entry) => ({ ...entry })),
        total: "not-computed",
        valuation: "not-computed",
      },
      contextId: change.contextId,
    },
  };
}
