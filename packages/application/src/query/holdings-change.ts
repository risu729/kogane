// Reported holdings changes between two dates (ADR 0075; docs/reported-state.md,
// "Holdings changes between two dates"). It composes three reads and the
// domain, and nothing else:
//
//   1. `queryDatedState` on each date, narrowed by source only (never by
//      account: a capture whose identity is not recorded yet must still count
//      as listing its holdings);
//   2. `DATED_POSITION_QUANTITIES_SQL`: each listed position's decimal-v1
//      quantity, by key, for both dates in one statement;
//   3. `DATED_SNAPSHOT_UNITS_SQL`: each chosen snapshot's fetch unit, by key;
//   4. `compareReportedHoldings`: one closed outcome per provider holding key,
//      the exact change where both dates list it, the account filter, and the
//      manifest whose digest is the context.
//
// It never writes, never values, never adds two holdings and has no clock (the
// caller states today's date). Too many holdings are refused, never cut.
import { isText } from "../../../domain/src/guards.ts";
import {
  compareReportedHoldings,
  HOLDINGS_CHANGE_SIDE_BOUND,
  type HoldingsChange,
  type HoldingsChangeSide,
} from "../../../domain/src/holdings-change.ts";
import { instrumentRef } from "../../../domain/src/price-sources.ts";
import type { ReportedState } from "../../../domain/src/reported-state.ts";
import { parseLocalDate } from "../../../domain/src/time.ts";
import {
  DATED_POSITION_CONTAINER_PARSERS,
  DATED_POSITION_QUANTITIES_SQL,
  DATED_POSITION_QUANTITY_POLICY,
  DATED_SNAPSHOT_UNITS_SQL,
  type DatedPositionQuantityRow,
  type DatedSnapshotUnitRow,
} from "../../../read-model/src/dated-state.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { DatedStateLimitError, queryDatedState } from "./dated-state.ts";
import {
  ACCOUNT_EXISTS_SQL,
  SOURCE_EXISTS_SQL,
  storedPositionQuantity,
} from "./valuation-on-date.ts";

export const HOLDINGS_CHANGE_REFUSALS = [
  "invalid_request",
  "invalid_range",
  "date_in_future",
  "unknown_source",
  "unknown_account",
  "holding_limit_exceeded",
  "dated_state_limit_exceeded",
] as const;
export type HoldingsChangeRefusal = (typeof HOLDINGS_CHANGE_REFUSALS)[number];

/** A request that cannot be answered is refused with a closed code, never repaired. */
export class HoldingsChangeError extends Error {
  readonly code: HoldingsChangeRefusal;
  constructor(code: HoldingsChangeRefusal) {
    super(code);
    this.name = "HoldingsChangeError";
    this.code = code;
  }
}

export interface HoldingsChangeRequest {
  /** `YYYY-MM-DD`, a civil date in Asia/Tokyo: the start of the comparison. */
  from: string;
  /** `YYYY-MM-DD`, after `from`, not after `today`. */
  to: string;
  /** The caller's own civil date in Asia/Tokyo. */
  today: string;
  /** Only this provider source; one that does not exist is refused. */
  source?: string;
  /** Only holdings either date names this resolved account for; one that does not exist is refused. */
  account?: string;
}

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const validDate = (value: unknown): value is string =>
  typeof value === "string" && DATE.test(value) && parseLocalDate(value) !== null;
const POSITION_PARSERS = new Set<string>(DATED_POSITION_CONTAINER_PARSERS);

function refuse(code: HoldingsChangeRefusal): never {
  throw new HoldingsChangeError(code);
}

function idOf(ref: string, prefix: "position:" | "artifact:"): number {
  if (!ref.startsWith(prefix)) throw new Error("dated_ref_unexpected");
  return Number(ref.slice(prefix.length));
}

function sideOf(
  state: ReportedState,
  quantities: ReadonlyMap<number, DatedPositionQuantityRow>,
  units: ReadonlyMap<number, string | null>,
): HoldingsChangeSide {
  const referenced = new Set(
    state.accounts.flatMap((account) => account.positions.map((position) => position.snapshotRef)),
  );
  return {
    date: state.date,
    reportedContextId: state.contextId,
    snapshots: state.snapshots
      .filter(
        (snapshot) => POSITION_PARSERS.has(snapshot.parserName) || referenced.has(snapshot.ref),
      )
      .map((snapshot) => {
        const unitKey = units.get(idOf(snapshot.ref, "artifact:"));
        if (unitKey === undefined) throw new Error("dated_snapshot_not_found");
        return {
          ref: snapshot.ref,
          sourceId: snapshot.sourceId,
          parserName: snapshot.parserName,
          dataset: snapshot.dataset,
          unitKey,
          capturedAt: snapshot.capturedAt,
          captureDate: snapshot.captureDate,
          ageDays: snapshot.ageDays,
          freshness: snapshot.freshness,
        };
      }),
    containersWithoutSnapshot: state.coverage.containersWithoutSnapshot
      .filter((entry) => POSITION_PARSERS.has(entry.parserName))
      .map((entry) => ({
        sourceId: entry.sourceId,
        parserName: entry.parserName,
        dataset: entry.dataset,
      })),
    holdings: state.accounts.flatMap((account) =>
      account.positions.map((position) => {
        const row = quantities.get(idOf(position.ref, "position:"));
        if (row === undefined) throw new Error("dated_position_not_found");
        return {
          positionRef: position.ref,
          snapshotRef: position.snapshotRef,
          sourceAccount: account.sourceAccount,
          accountId: account.accountId,
          accountIdentity: account.identityStatus,
          market: position.market,
          securityCode: position.securityCode,
          instrument: { ...position.instrument },
          quantityText: position.quantityText,
          quantity: storedPositionQuantity(
            instrumentRef(account.sourceId, position.market, position.securityCode),
            row,
          ),
        };
      }),
    ),
  };
}

export async function queryHoldingsChange(
  sql: SqlExecutor,
  request: HoldingsChangeRequest,
): Promise<HoldingsChange> {
  if (
    !validDate(request.from) ||
    !validDate(request.to) ||
    !validDate(request.today) ||
    (request.source !== undefined && !isText(request.source, 128)) ||
    (request.account !== undefined && !isText(request.account, 256))
  )
    refuse("invalid_request");
  if (request.from >= request.to) refuse("invalid_range");
  if (request.to > request.today) refuse("date_in_future");
  if (request.source !== undefined) {
    const found = await sql.first<{ found: number }>(SOURCE_EXISTS_SQL, [request.source]);
    if (found === null) refuse("unknown_source");
  }
  if (request.account !== undefined) {
    const found = await sql.first<{ found: number }>(ACCOUNT_EXISTS_SQL, [request.account]);
    if (found === null) refuse("unknown_account");
  }

  const narrowed = request.source === undefined ? {} : { source: request.source };
  let states: [ReportedState, ReportedState];
  try {
    states = await Promise.all([
      queryDatedState(sql, { date: request.from, ...narrowed }),
      queryDatedState(sql, { date: request.to, ...narrowed }),
    ]);
  } catch (error) {
    if (error instanceof DatedStateLimitError) refuse("dated_state_limit_exceeded");
    throw error;
  }
  const positionIds = states.map((state) =>
    state.accounts.flatMap((account) =>
      account.positions.map((position) => idOf(position.ref, "position:")),
    ),
  );
  if (positionIds.some((ids) => ids.length > HOLDINGS_CHANGE_SIDE_BOUND))
    refuse("holding_limit_exceeded");
  const ids = [...new Set(positionIds.flat())].sort((a, b) => a - b);
  const artifacts = [
    ...new Set(
      states.flatMap((state) => state.snapshots.map((snapshot) => idOf(snapshot.ref, "artifact:"))),
    ),
  ].sort((a, b) => a - b);
  const [quantityRows, unitRows] = await Promise.all([
    ids.length === 0
      ? []
      : sql.all<DatedPositionQuantityRow>(DATED_POSITION_QUANTITIES_SQL, [JSON.stringify(ids)]),
    artifacts.length === 0
      ? []
      : sql.all<DatedSnapshotUnitRow>(DATED_SNAPSHOT_UNITS_SQL, [JSON.stringify(artifacts)]),
  ]);
  const quantities = new Map(quantityRows.map((row) => [row.id, row]));
  const units = new Map(unitRows.map((row) => [row.id, row.unit_key]));

  return compareReportedHoldings({
    start: sideOf(states[0], quantities, units),
    end: sideOf(states[1], quantities, units),
    filters: { source: request.source ?? null, account: request.account ?? null },
    quantityPolicy: DATED_POSITION_QUANTITY_POLICY,
  });
}
