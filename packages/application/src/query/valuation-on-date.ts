// Valuation of the reported holdings on a date (ADR 0056, amendment
// "Valuation on a date as implemented"; docs/calculation-and-reports.md §2).
// It composes four reads and the domain, and nothing else:
//
//   1. `queryDatedState`: the positions the reported state lists on D under
//      the requested perimeter, with each instrument's identity status;
//   2. `DATED_POSITION_QUANTITIES_SQL`: each position's parse run and
//      decimal-v1 quantity, by key;
//   3. `selectMarketData`: one price per distinct (instrument, unit[, snapshot])
//      and one rate per currency the path to the base unit crosses, at the
//      end of D, under the caller's policy;
//   4. `valueHoldingsOnDate`: one closed outcome per holding, a total only when
//      every holding is valued, and the manifest whose digest is the context.
//
// It never writes, never fetches, has no clock (the caller states today's
// date) and no default policy: a request without one is refused
// `policy_missing` before anything is read. Too many holdings or selections
// are refused, never cut. It is not the report job: that job values a holding
// only at a price claimed from the holding's own snapshot (ADR 0020), this
// query at a policy-selected as-of price, and the manifest says which.
import { isText } from "../../../domain/src/guards.ts";
import {
  isCurrencyCode,
  PROPOSAL_POLICY_PREFIX,
  validKnownAtInstant,
  validSelectionBound,
  type KnowledgeMode,
  type SelectionBound,
} from "../../../domain/src/market-data.ts";
import { instrumentRef } from "../../../domain/src/price-sources.ts";
import { reportedStateCutoff, type ReportedState } from "../../../domain/src/reported-state.ts";
import { parseLocalDate } from "../../../domain/src/time.ts";
import {
  fxCurrenciesFor,
  holdingPriceWant,
  validValuationOnDatePolicy,
  valueHoldingsOnDate,
  type HoldingOnDate,
  type ValuationOnDate,
} from "../../../domain/src/valuation-on-date.ts";
import {
  absentQuantity,
  exactQuantity,
  normalizeDecimal,
  type Quantity,
} from "../../../domain/src/values.ts";
import {
  DATED_POSITION_QUANTITIES_SQL,
  DATED_POSITION_QUANTITY_POLICY,
  type DatedPositionQuantityRow,
} from "../../../read-model/src/dated-state.ts";
import {
  PRICE_SELECTION_BOUND,
  PriceCandidateError,
} from "../../../read-model/src/price-selection.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { DatedStateLimitError, queryDatedState } from "./dated-state.ts";
import {
  MarketDataRequestError,
  selectMarketData,
  type MarketDataPolicies,
} from "./market-data.ts";

/** More holdings than this on one date is refused, never cut. */
export const VALUATION_HOLDING_BOUND = 500;
/** More price keys and currencies than this is refused (the candidate read's own bound). */
export const VALUATION_SELECTION_BOUND = PRICE_SELECTION_BOUND;

/** Whether a resolved account exists; `?1` is its id. */
export const ACCOUNT_EXISTS_SQL = "SELECT 1 AS found FROM accounts WHERE id=?1";

export const VALUATION_ON_DATE_REFUSALS = [
  "policy_missing",
  "invalid_policy",
  "invalid_request",
  "date_in_future",
  "unknown_account",
  "holding_limit_exceeded",
  "selection_limit_exceeded",
  "candidate_limit_exceeded",
  "dated_state_limit_exceeded",
] as const;
export type ValuationOnDateRefusal = (typeof VALUATION_ON_DATE_REFUSALS)[number];

/** A request that cannot be answered is refused with a closed code, never repaired. */
export class ValuationOnDateError extends Error {
  readonly code: ValuationOnDateRefusal;
  constructor(code: ValuationOnDateRefusal) {
    super(code);
    this.name = "ValuationOnDateError";
    this.code = code;
  }
}

export interface ValuationOnDateRequest {
  /** `YYYY-MM-DD`, a civil date in Asia/Tokyo (the reported state's zone). */
  date: string;
  /** The caller's own civil date in Asia/Tokyo; a later `date` is refused. */
  today: string;
  /** The unit every value and the total are stated in. */
  baseUnit: string;
  /** Which price and rate publications count: the current ones, or those known at an instant. */
  knowledge: KnowledgeMode;
  /** Only this provider source. */
  source?: string;
  /** Only this resolved account id; one that does not exist is refused. */
  account?: string;
}

export type ValuationOnDateResult = Extract<ValuationOnDate, { status: "computed" }> & {
  /** The reported state the holdings came from, and what it says it does not show. */
  reportedState: {
    contextId: string;
    coverage: Pick<ReportedState["coverage"], "containersWithoutSnapshot" | "staleSnapshots">;
  };
};

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const validDate = (value: unknown): value is string =>
  typeof value === "string" && DATE.test(value) && parseLocalDate(value) !== null;

/** A stored decimal-v1 quantity, or the reason there is none; never a zero. */
function storedQuantity(unitRef: string, row: DatedPositionQuantityRow): Quantity {
  if (row.value_status === "exact" && row.coefficient !== null && row.scale !== null)
    return exactQuantity(
      unitRef,
      normalizeDecimal(BigInt(row.coefficient), row.scale),
      DATED_POSITION_QUANTITY_POLICY,
    );
  if (
    row.value_status === "missing" ||
    row.value_status === "unparsed" ||
    row.value_status === "conflict"
  )
    return absentQuantity(unitRef, row.value_status, `stored:${row.value_status}`);
  return absentQuantity(unitRef, "missing", "decimal_not_recorded");
}

function refuse(code: ValuationOnDateRefusal): never {
  throw new ValuationOnDateError(code);
}

export async function queryValuationOnDate(
  sql: SqlExecutor,
  request: ValuationOnDateRequest,
  policies: MarketDataPolicies | null,
): Promise<ValuationOnDateResult> {
  // No policy, no reads: the owner has not chosen one (ADR 0056, open questions).
  if (policies === null) refuse("policy_missing");
  if (
    !validValuationOnDatePolicy(policies) ||
    // A proposal is a recommendation, not a decision (ADR 0056).
    [policies.price, policies.fx.selection, policies.fx].some((policy) =>
      policy.policyId.startsWith(PROPOSAL_POLICY_PREFIX),
    )
  )
    refuse("invalid_policy");
  if (
    !validDate(request.date) ||
    !validDate(request.today) ||
    !isCurrencyCode(request.baseUnit) ||
    !(
      (request.knowledge.mode === "current" && Object.keys(request.knowledge).length === 1) ||
      (request.knowledge.mode === "known-at" && validKnownAtInstant(request.knowledge.knownAt))
    ) ||
    (request.source !== undefined && !isText(request.source, 128)) ||
    (request.account !== undefined && !isText(request.account, 256))
  )
    refuse("invalid_request");
  if (request.date > request.today) refuse("date_in_future");
  const bound: SelectionBound = {
    effectiveBefore: reportedStateCutoff(request.date),
    asOfDate: request.date,
    knowledge: request.knowledge,
  };
  // The date is a Tokyo date: a policy whose zone ends it at another instant cannot apply.
  if (
    !validSelectionBound(bound, policies.price.zone) ||
    !validSelectionBound(bound, policies.fx.selection.zone)
  )
    refuse("invalid_policy");
  if (request.account !== undefined) {
    const found = await sql.first<{ found: number }>(ACCOUNT_EXISTS_SQL, [request.account]);
    if (found === null) refuse("unknown_account");
  }

  let state: ReportedState;
  try {
    state = await queryDatedState(sql, {
      date: request.date,
      ...(request.source === undefined ? {} : { source: request.source }),
      ...(request.account === undefined ? {} : { account: request.account }),
    });
  } catch (error) {
    if (error instanceof DatedStateLimitError) refuse("dated_state_limit_exceeded");
    throw error;
  }
  const positions = state.accounts.flatMap((account) =>
    account.positions.map((position) => ({ account, position })),
  );
  if (positions.length > VALUATION_HOLDING_BOUND) refuse("holding_limit_exceeded");

  const ids = positions.map(({ position }) => Number(position.ref.slice("position:".length)));
  const quantities =
    ids.length === 0
      ? []
      : await sql.all<DatedPositionQuantityRow>(DATED_POSITION_QUANTITIES_SQL, [
          JSON.stringify(ids),
        ]);
  const byId = new Map(quantities.map((row) => [row.id, row]));
  const holdings: HoldingOnDate[] = positions.map(({ account, position }, index) => {
    const row = byId.get(ids[index]!);
    if (row === undefined) throw new Error("dated_position_not_found");
    const ref = instrumentRef(account.sourceId, position.market, position.securityCode);
    return {
      ref: position.ref,
      snapshotRef: position.snapshotRef,
      parseRunId: row.parse_run_id,
      instrumentRef: ref,
      instrument: { ...position.instrument },
      quoteUnit: isCurrencyCode(position.currency) ? position.currency : null,
      quantity: storedQuantity(ref, row),
    };
  });

  // Exactly what the valuation will read: one price per distinct want, one
  // rate per currency a wanted price's path to the base crosses.
  const wants = new Map<string, NonNullable<ReturnType<typeof holdingPriceWant>>>();
  const currencies = new Set<string>();
  for (const holding of holdings) {
    const want = holdingPriceWant(holding, policies.price);
    if (want === null) continue;
    wants.set(JSON.stringify(want), want);
    for (const code of fxCurrenciesFor(want.key.quoteUnitRef, request.baseUnit, policies.fx))
      currencies.add(code);
  }
  if (wants.size + currencies.size > VALUATION_SELECTION_BOUND) refuse("selection_limit_exceeded");
  const prices = [...wants.values()];
  const fxCurrencies = [...currencies].sort();

  let selection: Awaited<ReturnType<typeof selectMarketData>>;
  try {
    selection = await selectMarketData(sql, { bound, prices, fxCurrencies }, policies);
  } catch (error) {
    if (error instanceof MarketDataRequestError) refuse(error.code);
    if (error instanceof PriceCandidateError)
      refuse(
        error.code === "too_many_candidates"
          ? "candidate_limit_exceeded"
          : error.code === "too_many_keys"
            ? "selection_limit_exceeded"
            : "invalid_request",
      );
    throw error;
  }

  const valuation = await valueHoldingsOnDate({
    policy: policies,
    baseUnit: request.baseUnit,
    bound,
    reportedState: {
      date: state.date,
      cutoff: state.cutoff,
      filters: { ...state.filters },
      quantityPolicy: DATED_POSITION_QUANTITY_POLICY,
    },
    holdings,
    prices: prices.map((want, index) => ({
      snapshotParseRunId: want.snapshotParseRunId,
      selection: selection.prices[index]!,
    })),
    fx: selection.fx,
  });
  // Validated above, so the gate cannot answer needs-policy here.
  if (valuation.status !== "computed") throw new Error("valuation_not_computed");
  return {
    ...valuation,
    reportedState: {
      contextId: state.contextId,
      coverage: {
        containersWithoutSnapshot: state.coverage.containersWithoutSnapshot,
        staleSnapshots: state.coverage.staleSnapshots,
      },
    },
  };
}
