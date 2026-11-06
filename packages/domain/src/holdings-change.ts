// Reported holdings changes between two dates (ADR 0075, docs/reported-state.md
// "Holdings changes between two dates"). Two reported states on two dates, each
// the latest complete capture of every position container before the end of
// its date, are set side by side per provider holding key, and the change of a
// holding listed on both is stated as an exact difference of the two provider
// quantities. Pure: no I/O, no clock.
//
// What it never does: add two holdings, convert or value anything, guess why a
// holding is missing. A holding that the other date's capture of the same
// container and fetch unit does not list is its own status, without a figure
// (not a zero); no such capture on a date, a key listed in captures of
// several fetch units, one key listed twice, the same capture chosen on both
// dates, an identity that differs between the dates, an inverted capture order
// and an inexact quantity are reasons, and the holding then has no change
// figure.
import { canonicalDigest } from "./context.ts";
import {
  FRESHNESS_STATES,
  IDENTITY_STATUSES,
  REPORTED_STATE_ZONE,
  type Freshness,
  type IdentityStatus,
  type ReportedInstrument,
} from "./reported-state.ts";
import { parseLocalDate } from "./time.ts";
import { subtractQuantities, validQuantity, type Quantity } from "./values.ts";

export const HOLDINGS_CHANGE_SCHEMA = "reported-holdings-change-v1";
/** The comparison rules below; a new rule is a new id. */
export const HOLDINGS_CHANGE_POLICY = "holdings-change-v1";
/** More holdings than this on one date is refused, never cut. */
export const HOLDINGS_CHANGE_SIDE_BOUND = 500;

export const HOLDING_CHANGE_STATUSES = [
  "compared",
  "listed_at_start_only",
  "listed_at_end_only",
  "not_comparable",
] as const;
export type HoldingChangeStatus = (typeof HOLDING_CHANGE_STATUSES)[number];

/** Why a holding has no change figure, in this order. */
export const HOLDING_CHANGE_REASONS = [
  "no_snapshot_at_start",
  "no_snapshot_at_end",
  "snapshot_scope_ambiguous_at_start",
  "snapshot_scope_ambiguous_at_end",
  "holding_key_ambiguous_at_start",
  "holding_key_ambiguous_at_end",
  "same_capture_both_dates",
  "capture_order_inverted",
  "account_differs",
  "instrument_differs",
  "quantity_not_exact_at_start",
  "quantity_not_exact_at_end",
] as const;
export type HoldingChangeReason = (typeof HOLDING_CHANGE_REASONS)[number];

/** A container dataset of the snapshot registry. */
export interface HoldingsChangeContainer {
  sourceId: string;
  parserName: string;
  dataset: string;
}

/** A snapshot the reported state chose on the date. */
export interface HoldingsChangeSnapshot extends HoldingsChangeContainer {
  ref: string;
  /**
   * The fetch unit the snapshot is of (a dataset snapshot is one fetch run's
   * unit), or null for a run without units. Matched only, never returned.
   */
  unitKey: string | null;
  capturedAt: string;
  captureDate: string;
  ageDays: number;
  freshness: Freshness;
}

/** One position the reported state lists on the date, with its decimal-v1 quantity. */
export interface HoldingsChangeObservation {
  positionRef: string;
  snapshotRef: string;
  sourceAccount: string;
  /** The resolved account the reported state names (today's mapping), or null. */
  accountId: string | null;
  accountIdentity: IdentityStatus;
  market: string | null;
  securityCode: string;
  instrument: ReportedInstrument;
  /** The provider's text, as the reported state shows it. */
  quantityText: string;
  /** The stored decimal-v1 quantity, or its absence; its unit names the provider key. */
  quantity: Quantity;
}

/** One date's reported holdings, unfiltered by account. */
export interface HoldingsChangeSide {
  date: string;
  /** The reported state's `contextId` on this date. */
  reportedContextId: string;
  /** Every snapshot chosen on the date. */
  snapshots: HoldingsChangeSnapshot[];
  /** Position containers of the perimeter with no snapshot before the date's cutoff. */
  containersWithoutSnapshot: HoldingsChangeContainer[];
  holdings: HoldingsChangeObservation[];
}

export interface HoldingsChangeInput {
  start: HoldingsChangeSide;
  end: HoldingsChangeSide;
  /** `source` has already narrowed both sides; `account` is applied here. */
  filters: { source: string | null; account: string | null };
  quantityPolicy: string;
}

/** The provider's own key of a holding: one source, container, account and code. */
export interface HoldingKey extends HoldingsChangeContainer {
  sourceAccount: string;
  market: string | null;
  securityCode: string;
}

interface SnapshotView {
  snapshotRef: string;
  capturedAt: string;
  captureDate: string;
  ageDays: number;
  freshness: Freshness;
}

/** Where a holding stands on one date. */
export type HoldingSide =
  | ({
      state: "listed";
      positionRef: string;
      accountId: string | null;
      accountIdentity: IdentityStatus;
      instrument: ReportedInstrument;
      quantityText: string;
      quantity: Quantity;
    } & SnapshotView)
  /** The key is listed more than once in the date's captures: no one quantity is the holding's. */
  | { state: "listed_more_than_once"; positionRefs: string[]; snapshotRefs: string[] }
  /** The capture of the key's container and fetch unit on the date is complete and does not list it. */
  | ({ state: "not_listed" } & SnapshotView)
  /** The key is listed in captures of several fetch units: which one would list it is unknown. */
  | { state: "snapshot_scope_ambiguous"; snapshotRefs: string[] }
  /** No complete capture of the key's container and fetch unit before the end of the date. */
  | { state: "no_snapshot" };

export interface HoldingChange {
  key: HoldingKey;
  unitRef: string;
  start: HoldingSide;
  end: HoldingSide;
  status: HoldingChangeStatus;
  reasons: HoldingChangeReason[];
  /** End minus start, exact, only for `compared`; never a zero for a missing side. */
  change: Quantity | null;
}

export interface HoldingsChangeManifest {
  schemaVersion: typeof HOLDINGS_CHANGE_SCHEMA;
  policy: typeof HOLDINGS_CHANGE_POLICY;
  zone: typeof REPORTED_STATE_ZONE;
  from: string;
  to: string;
  filters: { source: string | null; account: string | null };
  quantityPolicy: string;
  reportedContextIds: { start: string; end: string };
  holdings: {
    key: HoldingKey;
    start: string;
    end: string;
    status: HoldingChangeStatus;
    reasons: HoldingChangeReason[];
  }[];
}

export interface HoldingsChange {
  schemaVersion: typeof HOLDINGS_CHANGE_SCHEMA;
  policy: typeof HOLDINGS_CHANGE_POLICY;
  zone: typeof REPORTED_STATE_ZONE;
  from: string;
  to: string;
  filters: { source: string | null; account: string | null };
  quantityPolicy: string;
  holdings: HoldingChange[];
  counts: Record<HoldingChangeStatus, number>;
  coverage: {
    /** Position containers without a capture on a date: what they held there is unknown. */
    containersWithoutSnapshot: ({ side: "start" | "end" } & HoldingsChangeContainer)[];
    staleSnapshots: ({ side: "start" | "end"; ref: string; ageDays: number } & Omit<
      HoldingsChangeContainer,
      "dataset"
    >)[];
    /** Holdings of different instruments are never added. */
    total: "not-computed";
    valuation: "not-computed";
  };
  manifest: HoldingsChangeManifest;
  /** `canonicalDigest(manifest)`: the same inputs give the same id. */
  contextId: string;
}

const FRESHNESS = new Set<string>(FRESHNESS_STATES);
const IDENTITY = new Set<string>(IDENTITY_STATUSES);

function containerText(container: HoldingsChangeContainer): string {
  return JSON.stringify([container.sourceId, container.parserName, container.dataset]);
}

function keyText(key: HoldingKey): string {
  return JSON.stringify([
    key.sourceId,
    key.parserName,
    key.dataset,
    key.sourceAccount,
    key.market,
    key.securityCode,
  ]);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validSide(side: HoldingsChangeSide, source: string | null): void {
  if (parseLocalDate(side.date) === null) throw new RangeError("invalid_date");
  if (side.holdings.length > HOLDINGS_CHANGE_SIDE_BOUND)
    throw new RangeError("holding_bound_exceeded");
  const refs = new Set<string>();
  for (const snapshot of side.snapshots) {
    if (refs.has(snapshot.ref)) throw new RangeError("snapshot_duplicated");
    if (!FRESHNESS.has(snapshot.freshness)) throw new RangeError("invalid_freshness");
    if (snapshot.unitKey !== null && typeof snapshot.unitKey !== "string")
      throw new RangeError("invalid_unit_key");
    if (source !== null && snapshot.sourceId !== source) throw new RangeError("source_filter");
    refs.add(snapshot.ref);
  }
  const positions = new Set<string>();
  for (const holding of side.holdings) {
    if (positions.has(holding.positionRef)) throw new RangeError("position_duplicated");
    positions.add(holding.positionRef);
    if (!refs.has(holding.snapshotRef)) throw new RangeError("position_snapshot_not_found");
    if (!validQuantity(holding.quantity)) throw new RangeError("invalid_quantity");
    if (!IDENTITY.has(holding.accountIdentity) || !IDENTITY.has(holding.instrument.status))
      throw new RangeError("invalid_identity");
  }
}

interface IndexedSide {
  byKey: Map<string, { key: HoldingKey; holdings: HoldingsChangeObservation[] }>;
  snapshotsOf: Map<string, HoldingsChangeSnapshot[]>;
  snapshotByRef: Map<string, HoldingsChangeSnapshot>;
}

function indexSide(side: HoldingsChangeSide): IndexedSide {
  const snapshotByRef = new Map(side.snapshots.map((snapshot) => [snapshot.ref, snapshot]));
  const snapshotsOf = new Map<string, HoldingsChangeSnapshot[]>();
  for (const snapshot of side.snapshots) {
    const text = containerText(snapshot);
    const list = snapshotsOf.get(text) ?? [];
    list.push(snapshot);
    snapshotsOf.set(text, list);
  }
  const byKey = new Map<string, { key: HoldingKey; holdings: HoldingsChangeObservation[] }>();
  for (const holding of side.holdings) {
    const snapshot = snapshotByRef.get(holding.snapshotRef)!;
    const key: HoldingKey = {
      sourceId: snapshot.sourceId,
      parserName: snapshot.parserName,
      dataset: snapshot.dataset,
      sourceAccount: holding.sourceAccount,
      market: holding.market,
      securityCode: holding.securityCode,
    };
    const text = keyText(key);
    const entry = byKey.get(text) ?? { key, holdings: [] };
    entry.holdings.push(holding);
    byKey.set(text, entry);
  }
  return { byKey, snapshotsOf, snapshotByRef };
}

function snapshotView(snapshot: HoldingsChangeSnapshot): SnapshotView {
  return {
    snapshotRef: snapshot.ref,
    capturedAt: snapshot.capturedAt,
    captureDate: snapshot.captureDate,
    ageDays: snapshot.ageDays,
    freshness: snapshot.freshness,
  };
}

function sideOf(
  index: IndexedSide,
  key: HoldingKey,
  units: ReadonlySet<string | null>,
): HoldingSide {
  const listed = index.byKey.get(keyText(key))?.holdings ?? [];
  if (listed.length > 1) {
    const sorted = [...listed].sort((a, b) => compareText(a.positionRef, b.positionRef));
    return {
      state: "listed_more_than_once",
      positionRefs: sorted.map((holding) => holding.positionRef),
      snapshotRefs: [...new Set(sorted.map((holding) => holding.snapshotRef))].sort(compareText),
    };
  }
  if (listed.length === 1) {
    const holding = listed[0]!;
    return {
      state: "listed",
      positionRef: holding.positionRef,
      ...snapshotView(index.snapshotByRef.get(holding.snapshotRef)!),
      accountId: holding.accountId,
      accountIdentity: holding.accountIdentity,
      instrument: { ...holding.instrument },
      quantityText: holding.quantityText,
      quantity: holding.quantity,
    };
  }
  // The captures of this container that could list the key: those of the
  // fetch unit its listings came from.
  const captures = (index.snapshotsOf.get(containerText(key)) ?? []).filter((snapshot) =>
    units.has(snapshot.unitKey),
  );
  if (units.size > 1 || captures.length > 1)
    return {
      state: "snapshot_scope_ambiguous",
      snapshotRefs: captures.map((snapshot) => snapshot.ref).sort(compareText),
    };
  if (captures.length === 0) return { state: "no_snapshot" };
  return { state: "not_listed", ...snapshotView(captures[0]!) };
}

const SIDE_REASON: Record<
  "start" | "end",
  Partial<Record<HoldingSide["state"], HoldingChangeReason>>
> = {
  start: {
    no_snapshot: "no_snapshot_at_start",
    snapshot_scope_ambiguous: "snapshot_scope_ambiguous_at_start",
    listed_more_than_once: "holding_key_ambiguous_at_start",
  },
  end: {
    no_snapshot: "no_snapshot_at_end",
    snapshot_scope_ambiguous: "snapshot_scope_ambiguous_at_end",
    listed_more_than_once: "holding_key_ambiguous_at_end",
  },
};

function differs(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b;
}

function compareOne(
  key: HoldingKey,
  unitRef: string,
  start: HoldingSide,
  end: HoldingSide,
): HoldingChange {
  const reasons = new Set<HoldingChangeReason>();
  const startReason = SIDE_REASON.start[start.state];
  const endReason = SIDE_REASON.end[end.state];
  if (startReason !== undefined) reasons.add(startReason);
  if (endReason !== undefined) reasons.add(endReason);
  let change: Quantity | null = null;
  if (start.state === "listed" && end.state === "listed") {
    // No capture between the two dates: the change is not observed.
    if (start.snapshotRef === end.snapshotRef) reasons.add("same_capture_both_dates");
    else if (end.capturedAt < start.capturedAt) reasons.add("capture_order_inverted");
    if (differs(start.accountId, end.accountId)) reasons.add("account_differs");
    if (differs(start.instrument.instrumentId, end.instrument.instrumentId))
      reasons.add("instrument_differs");
    if (start.quantity.value.status !== "exact") reasons.add("quantity_not_exact_at_start");
    if (end.quantity.value.status !== "exact") reasons.add("quantity_not_exact_at_end");
    if (reasons.size === 0) {
      const result = subtractQuantities(end.quantity, start.quantity);
      if (!result.ok) throw new RangeError(result.error.code);
      change = result.quantity;
    }
  }
  const status: HoldingChangeStatus =
    reasons.size > 0
      ? "not_comparable"
      : change !== null
        ? "compared"
        : start.state === "listed"
          ? "listed_at_start_only"
          : "listed_at_end_only";
  return {
    key,
    unitRef,
    start,
    end,
    status,
    reasons: HOLDING_CHANGE_REASONS.filter((code) => reasons.has(code)),
    change,
  };
}

function sideRef(side: HoldingSide): string {
  switch (side.state) {
    case "listed":
      return side.positionRef;
    case "listed_more_than_once":
      return side.positionRefs.join(",");
    default:
      return side.state;
  }
}

/**
 * Compare the reported holdings of two dates (`holdings-change-v1`). Keys come
 * from both sides' listings; `filters.account` keeps a key when a listing of
 * it on either date names that account, and the other date's absence is
 * judged on that date's whole listing, so a capture without a recorded
 * identity never reads as "not listed". The output is in key order whatever
 * the input order, and its context id digests every key's refs and outcome.
 */
export async function compareReportedHoldings(input: HoldingsChangeInput): Promise<HoldingsChange> {
  validSide(input.start, input.filters.source);
  validSide(input.end, input.filters.source);
  if (input.start.date >= input.end.date) throw new RangeError("invalid_range");
  const start = indexSide(input.start);
  const end = indexSide(input.end);
  const unitOf = new Map<string, string>();
  const fetchUnits = new Map<string, Set<string | null>>();
  const keys = new Map<string, HoldingKey>();
  for (const index of [start, end])
    for (const [text, entry] of index.byKey) {
      keys.set(text, entry.key);
      const units = fetchUnits.get(text) ?? new Set<string | null>();
      fetchUnits.set(text, units);
      for (const holding of entry.holdings) {
        units.add(index.snapshotByRef.get(holding.snapshotRef)!.unitKey);
        const unit = unitOf.get(text);
        if (unit !== undefined && unit !== holding.quantity.unitRef)
          throw new RangeError("holding_unit_mismatch");
        unitOf.set(text, holding.quantity.unitRef);
      }
    }
  const account = input.filters.account;
  const holdings = [...keys]
    .filter(
      ([text]) =>
        account === null ||
        [start, end].some((index) =>
          (index.byKey.get(text)?.holdings ?? []).some((holding) => holding.accountId === account),
        ),
    )
    .sort(([a], [b]) => compareText(a, b))
    .map(([text, key]) => {
      const units = fetchUnits.get(text)!;
      return compareOne(key, unitOf.get(text)!, sideOf(start, key, units), sideOf(end, key, units));
    });

  const counts = Object.fromEntries(HOLDING_CHANGE_STATUSES.map((status) => [status, 0])) as Record<
    HoldingChangeStatus,
    number
  >;
  for (const holding of holdings) counts[holding.status] += 1;

  const sides = [
    ["start", input.start],
    ["end", input.end],
  ] as const;
  const manifest: HoldingsChangeManifest = {
    schemaVersion: HOLDINGS_CHANGE_SCHEMA,
    policy: HOLDINGS_CHANGE_POLICY,
    zone: REPORTED_STATE_ZONE,
    from: input.start.date,
    to: input.end.date,
    filters: { ...input.filters },
    quantityPolicy: input.quantityPolicy,
    reportedContextIds: {
      start: input.start.reportedContextId,
      end: input.end.reportedContextId,
    },
    holdings: holdings.map((holding) => ({
      key: holding.key,
      start: sideRef(holding.start),
      end: sideRef(holding.end),
      status: holding.status,
      reasons: holding.reasons,
    })),
  };
  return {
    schemaVersion: HOLDINGS_CHANGE_SCHEMA,
    policy: HOLDINGS_CHANGE_POLICY,
    zone: REPORTED_STATE_ZONE,
    from: input.start.date,
    to: input.end.date,
    filters: { ...input.filters },
    quantityPolicy: input.quantityPolicy,
    holdings,
    counts,
    coverage: {
      containersWithoutSnapshot: sides
        .flatMap(([side, entry]) =>
          entry.containersWithoutSnapshot.map((container) => ({
            side,
            sourceId: container.sourceId,
            parserName: container.parserName,
            dataset: container.dataset,
          })),
        )
        .sort(
          (a, b) =>
            compareText(a.side === "start" ? "0" : "1", b.side === "start" ? "0" : "1") ||
            compareText(containerText(a), containerText(b)),
        ),
      staleSnapshots: sides
        .flatMap(([side, entry]) =>
          entry.snapshots
            .filter((snapshot) => snapshot.freshness === "stale")
            .map((snapshot) => ({
              side,
              ref: snapshot.ref,
              sourceId: snapshot.sourceId,
              parserName: snapshot.parserName,
              ageDays: snapshot.ageDays,
            })),
        )
        .sort(
          (a, b) =>
            compareText(a.side === "start" ? "0" : "1", b.side === "start" ? "0" : "1") ||
            compareText(a.ref, b.ref),
        ),
      total: "not-computed",
      valuation: "not-computed",
    },
    manifest,
    contextId: await canonicalDigest(manifest),
  };
}
