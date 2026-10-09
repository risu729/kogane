// Valuation of reported holdings on a date, at prices and rates selected for
// that date under an explicit policy (ADR 0056, amendment "Valuation on a date
// as implemented"; docs/calculation-and-reports.md §2). Pure: no I/O, no clock
// and no default policy. A null policy is the gate `costBasis()` has: the
// answer is `needs-policy`, never a value under an assumed one.
//
// Each holding is decided in the valuation order of addendum 09 §3 with one
// exception: the claim-adoption step is not applied (ADR 0019 applies no
// adoption across sources; see the ADR 0056 amendment), so a holding two
// sources report is valued once per listing, and only the total is withheld.
// Each holding ends in exactly one closed outcome:
//
//   1. the reported state does not resolve its instrument → `instrument_unresolved`;
//   2. its snapshot is `stale` under the reported state's own freshness policy
//      (`dated-state-freshness-v1`): its quantity is not known on the date
//                                                          → `snapshot_stale`;
//   3. its quantity is not an exact decimal                → `quantity_unknown`;
//   4. its price selection was made under another policy, or (same-snapshot)
//      from another snapshot                               → `policy_mismatch`;
//   5. no price is selected (missing, stale, disagreeing …) → `unpriced`, with
//      the selection's refusal code; a stale price is never used;
//   6. the value cannot be stated in the base unit         → `unconverted`, with
//      the FX refusal code; nothing is converted 1:1;
//   7. otherwise                                           → `valued`, exactly,
//      in the price's unit and in the base unit, with both legs.
//
// A total is stated only when every holding is valued and all of them come
// from one source; otherwise it is absent with its reason and the counts by
// outcome (INV05; INV06, since adoption across sources is not applied). When
// a position container of the perimeter has no snapshot on the date, or its
// stale snapshot listed no holding, the total is labelled
// `partial-verified-scope` with the counts, never `exact` (§2: a partial
// result is never a whole total). Amounts are
// added with `sumQuantities` (INV03). There is no gain, no cost basis and no tax
// here, and a provider's own valuation of a holding is never its value.
import type { RoundingInputs } from "./calculation.ts";
import { canonicalDigest } from "./context.ts";
import {
  fxKey,
  fxPath,
  isCurrencyCode,
  PROPOSAL_POLICY_PREFIX,
  selectionManifest,
  validFxConversionPolicy,
  validMarketCalendar,
  validPriceSelectionPolicy,
  valueInBase,
  type ConversionLeg,
  type ConversionRefusal,
  type FxConversionPolicy,
  type MarketCalendar,
  type PriceKey,
  type PriceSelection,
  type PriceSelectionPolicy,
  type PriceSelectionRefusal,
  type SelectionBound,
  type SelectionManifest,
} from "./market-data.ts";
import { valueAtPrice } from "./metrics.ts";
import type { Freshness as SnapshotFreshness, IdentityStatus } from "./reported-state.ts";
import { sumQuantities, type Quantity } from "./values.ts";

export const VALUATION_ON_DATE_SCHEMA = "valuation-on-date-v1";
/** Bumped whenever a rule of this module changes what a holding's outcome is. */
export const VALUATION_ON_DATE_ENGINE = "valuation-on-date-engine-v1";

/** One per holding. Closed. */
export const HOLDING_VALUE_OUTCOMES = [
  "valued",
  "unpriced",
  "unconverted",
  "quantity_unknown",
  "snapshot_stale",
  "instrument_unresolved",
  "policy_mismatch",
] as const;
export type HoldingValueOutcome = (typeof HOLDING_VALUE_OUTCOMES)[number];

/** Why a selection handed in for a holding is not the policy's own. Closed. */
export const VALUATION_POLICY_MISMATCHES = [
  "price_selection_policy",
  "price_selection_scope",
  "fx_selection_policy",
  "fx_selection_key",
] as const;
export type ValuationPolicyMismatch = (typeof VALUATION_POLICY_MISMATCHES)[number];

/**
 * Why there is no total. Closed; a total is never a partial sum, and never a
 * sum across sources: adoption across sources is not applied (ADR 0019), so
 * two sources could list one holding and a cross-source sum could count it
 * twice (INV06).
 */
export const TOTAL_ABSENCE_REASONS = [
  "no_holdings",
  "holding_not_valued",
  "adoption_not_applied",
] as const;
export type TotalAbsenceReason = (typeof TOTAL_ABSENCE_REASONS)[number];

/**
 * Instrument statuses under which the reported state resolves a holding to an
 * instrument: a current instrument mapping, identified or provider-local. An
 * aggregate, an unresolved identity and an observation without an identity
 * run are not valued. The price itself stays keyed by the provider-scoped
 * reference (ADR 0056, Identity); the status is checked, not used as a key.
 */
export const RESOLVED_INSTRUMENT_STATUSES = ["identified", "provider-local"] as const;

/** The policies a valuation applies, with the calendars a business-day rule may name. */
export interface ValuationOnDatePolicy {
  /** Exactly one price kind: a holding is valued at one kind of price. */
  price: PriceSelectionPolicy;
  fx: FxConversionPolicy;
  calendars: readonly MarketCalendar[];
}

/** One holding of the reported state on the date, as the valuation needs it. */
export interface HoldingOnDate {
  /** `position:<id>`. */
  ref: string;
  /** The provider source that reported it. */
  sourceId: string;
  /** `artifact:<id>`: the snapshot the position was reported in. */
  snapshotRef: string;
  /** The snapshot's freshness on the date under `dated-state-freshness-v1`, and its age in days. */
  snapshotFreshness: SnapshotFreshness;
  snapshotAgeDays: number;
  /** The parse run of that snapshot, which a same-snapshot price must come from. */
  parseRunId: number;
  /** The provider-scoped reference prices are keyed by (`instrument:<source>:<market>:<code>`). */
  instrumentRef: string;
  instrument: { instrumentId: string | null; status: IdentityStatus };
  /** The provider's currency for the position, the unit its price is quoted in; null when it states none. */
  quoteUnit: string | null;
  /** In `instrumentRef` units; exact, or absent with the stored reason. */
  quantity: Quantity;
}

/** A selection handed in for a price key, with the snapshot it was narrowed to. */
export interface HoldingPriceSelection {
  snapshotParseRunId: number | null;
  selection: PriceSelection;
}

export interface ValuationOnDateInput {
  /** Null: no policy was chosen, and the answer is `needs-policy`. */
  policy: ValuationOnDatePolicy | null;
  baseUnit: string;
  /** The as-of the prices and rates were selected for; `asOfDate` is the reported state's date. */
  bound: SelectionBound;
  /** What the holdings are: the reported state's date, cutoff, filters and quantity policy. */
  reportedState: {
    date: string;
    cutoff: string;
    filters: { source: string | null; account: string | null };
    quantityPolicy: string;
    /** The reported state's own context id, so a different dated answer is a different context. */
    contextId: string;
    /**
     * Containers of the perimeter that report positions and have no snapshot
     * on the date: holdings the total cannot include.
     */
    positionContainersWithoutSnapshot: readonly {
      sourceId: string;
      parserName: string;
      dataset: string;
    }[];
    /**
     * Snapshots of those containers that the reported state lists as `stale`
     * (`dated-state-freshness-v1`). One that no holding came from said
     * "nothing" too long ago to read as nothing on the date (INV05).
     */
    stalePositionSnapshots: readonly StalePositionSnapshot[];
  };
  holdings: readonly HoldingOnDate[];
  prices: readonly HoldingPriceSelection[];
  fx: readonly PriceSelection[];
}

export interface StalePositionSnapshot {
  /** `artifact:<id>`. */
  ref: string;
  sourceId: string;
  parserName: string;
  ageDays: number;
}

interface HoldingBase {
  holdingRef: string;
  snapshotRef: string;
  instrumentRef: string;
}

export type HoldingValueOnDate = HoldingBase &
  (
    | {
        outcome: "valued";
        /** Quantity × price, exact, in the price's quote unit. */
        local: Quantity;
        /** In the base unit. */
        value: Quantity;
        /** The price leg first, then each FX leg, with ids, effective times and ages. */
        legs: ConversionLeg[];
        roundingInputs: RoundingInputs | null;
      }
    | {
        outcome: "unpriced";
        priceKey: PriceKey | null;
        /**
         * The selection's refusal, or the price leg's own: a zero or negative
         * price, or one whose basis does not divide the quantity exactly.
         */
        reason: PriceSelectionRefusal | "price_not_positive" | "rounding_policy_missing";
        /** The candidates the refusal is about; their prices are never used. */
        candidateIds: string[];
        ageDays: number | null;
      }
    | {
        outcome: "unconverted";
        priceKey: PriceKey;
        reason: ConversionRefusal;
        pair: { base: string; quote: string } | null;
        local: Quantity;
        priceLeg: ConversionLeg;
      }
    | { outcome: "quantity_unknown"; reason: string }
    | { outcome: "instrument_unresolved"; status: IdentityStatus }
    | { outcome: "snapshot_stale"; ageDays: number }
    | { outcome: "policy_mismatch"; reason: ValuationPolicyMismatch }
  );

export type ValuationTotal =
  | { status: "exact"; value: Quantity }
  /**
   * Every listed holding is valued, but the perimeter has position containers
   * without a snapshot, or whose stale snapshot listed no holding: what they
   * hold on the date is unknown, so this is the sum of a verified part, never
   * the whole and not a lower bound of it (§2).
   */
  | {
      status: "partial-verified-scope";
      value: Quantity;
      positionContainersWithoutSnapshot: number;
      stalePositionContainersWithoutHoldings: number;
    }
  | { status: "absent"; reason: TotalAbsenceReason };

export interface ValuationOnDateManifest {
  schema: typeof VALUATION_ON_DATE_SCHEMA;
  engine: typeof VALUATION_ON_DATE_ENGINE;
  asOf: { date: string; effectiveBefore: string; knowledge: SelectionBound["knowledge"]["mode"] };
  baseUnit: string;
  policies: { policyId: string; digest: string }[];
  reportedState: Omit<ValuationOnDateInput["reportedState"], "stalePositionSnapshots"> & {
    /** Stale position snapshots no holding came from, which make the total partial. */
    stalePositionSnapshotsWithoutHoldings: StalePositionSnapshot[];
  };
  /** Every snapshot a holding came from, with its parse run. */
  snapshots: { snapshotRef: string; parseRunId: number }[];
  /** Ids and codes only, sorted by ref: no amount is held here. */
  holdings: {
    ref: string;
    snapshotRef: string;
    outcome: HoldingValueOutcome;
    reason: string | null;
    priceId: string | null;
    fxPriceIds: string[];
  }[];
  /** The price and rate selection, as `selectionManifest` builds it, and its digest. */
  selection: SelectionManifest;
  selectionContextId: string;
}

export type ValuationOnDate =
  | {
      status: "needs-policy";
      reasonCode: "policy_missing" | "policy_proposal";
      holdings: null;
      total: null;
    }
  | {
      status: "computed";
      baseUnit: string;
      holdings: HoldingValueOnDate[];
      counts: Record<HoldingValueOutcome, number>;
      total: ValuationTotal;
      manifest: ValuationOnDateManifest;
      /** `canonicalDigest(manifest)`. */
      contextId: string;
    };

/** A policy a valuation can apply: valid parts, one price kind, unambiguous calendars. */
export function validValuationOnDatePolicy(value: ValuationOnDatePolicy): boolean {
  return (
    validPriceSelectionPolicy(value.price) &&
    value.price.priceKinds.length === 1 &&
    validFxConversionPolicy(value.fx) &&
    Array.isArray(value.calendars) &&
    value.calendars.every(validMarketCalendar) &&
    new Set(value.calendars.map((calendar) => calendar.calendarRef)).size === value.calendars.length
  );
}

/** Whether the reported state resolves the holding's instrument. */
function instrumentResolved(holding: HoldingOnDate): boolean {
  return (
    holding.instrument.instrumentId !== null &&
    (RESOLVED_INSTRUMENT_STATUSES as readonly string[]).includes(holding.instrument.status)
  );
}

/**
 * The price a holding needs selected under `policy`: its key and, under a
 * same-snapshot scope, its own parse run. Null when the holding ends before a
 * price is looked for (unresolved instrument, stale snapshot, unknown quantity, no quote
 * unit), so a caller selects exactly what the valuation will read.
 */
export function holdingPriceWant(
  holding: HoldingOnDate,
  policy: PriceSelectionPolicy,
): { key: PriceKey; snapshotParseRunId: number | null } | null {
  if (
    !instrumentResolved(holding) ||
    holding.snapshotFreshness === "stale" ||
    holding.quantity.value.status !== "exact"
  )
    return null;
  if (holding.quoteUnit === null || !isCurrencyCode(holding.quoteUnit)) return null;
  return {
    key: {
      baseInstrumentRef: holding.instrumentRef,
      quoteUnitRef: holding.quoteUnit,
      priceKind: policy.priceKinds[0]!,
    },
    snapshotParseRunId: policy.candidateScope === "same-snapshot" ? holding.parseRunId : null,
  };
}

/** The currencies whose rate against the pivot a quote unit needs to reach `base`. */
export function fxCurrenciesFor(
  quoteUnit: string,
  base: string,
  policy: FxConversionPolicy,
): string[] {
  return (fxPath(quoteUnit, base, policy.pivot) ?? []).map((step) => step.base);
}

const wantText = (key: PriceKey, snapshotParseRunId: number | null): string =>
  JSON.stringify([key.baseInstrumentRef, key.quoteUnitRef, key.priceKind, snapshotParseRunId]);

function sameKey(a: PriceKey, b: PriceKey): boolean {
  return (
    a.baseInstrumentRef === b.baseInstrumentRef &&
    a.quoteUnitRef === b.quoteUnitRef &&
    a.priceKind === b.priceKind
  );
}

/** The calendars a selection under these policies used: the one each business-day rule names. */
function usedCalendars(policy: ValuationOnDatePolicy): MarketCalendar[] {
  const used: MarketCalendar[] = [];
  for (const selection of [policy.price, policy.fx.selection]) {
    if (selection.freshness.unit !== "business-days") continue;
    const ref = selection.freshness.calendarRef;
    const calendar = policy.calendars.find((entry) => entry.calendarRef === ref);
    if (calendar !== undefined) used.push(calendar);
  }
  return used;
}

function valueOne(
  holding: HoldingOnDate,
  input: ValuationOnDateInput,
  policy: ValuationOnDatePolicy,
  prices: ReadonlyMap<string, PriceSelection>,
  fx: ReadonlyMap<string, PriceSelection>,
): HoldingValueOnDate {
  const base: HoldingBase = {
    holdingRef: holding.ref,
    snapshotRef: holding.snapshotRef,
    instrumentRef: holding.instrumentRef,
  };
  // 1. Identity, 2. quantity: decided before a price is looked for.
  if (!instrumentResolved(holding))
    return { ...base, outcome: "instrument_unresolved", status: holding.instrument.status };
  if (holding.snapshotFreshness === "stale")
    return { ...base, outcome: "snapshot_stale", ageDays: holding.snapshotAgeDays };
  if (holding.quantity.value.status !== "exact")
    return {
      ...base,
      outcome: "quantity_unknown",
      reason: `${holding.quantity.value.status}:${holding.quantity.value.reasonCode}`,
    };
  if (holding.quantity.unitRef !== holding.instrumentRef)
    throw new RangeError("holding_quantity_unit_mismatch");
  const want = holdingPriceWant(holding, policy.price);
  // No currency stated: no admitted rule can quote this holding's price.
  if (want === null)
    return {
      ...base,
      outcome: "unpriced",
      priceKey: null,
      reason: "unsupported_pair",
      candidateIds: [],
      ageDays: null,
    };
  const selection = prices.get(wantText(want.key, want.snapshotParseRunId));
  if (selection === undefined) throw new RangeError("price_selection_absent");
  // 3. The selection must be this policy's, and of this holding's snapshot.
  if (selection.policyId !== policy.price.policyId)
    return { ...base, outcome: "policy_mismatch", reason: "price_selection_policy" };
  if (
    selection.status === "selected" &&
    want.snapshotParseRunId !== null &&
    selection.candidate.claim.parseRunId !== want.snapshotParseRunId
  )
    return { ...base, outcome: "policy_mismatch", reason: "price_selection_scope" };
  for (const currency of fxCurrenciesFor(want.key.quoteUnitRef, input.baseUnit, policy.fx)) {
    const rate = fx.get(currency);
    if (rate === undefined) continue; // convertToBase answers `missing` for the leg
    if (!sameKey(rate.key, fxKey(currency, policy.fx)))
      return { ...base, outcome: "policy_mismatch", reason: "fx_selection_key" };
    if (rate.policyId !== policy.fx.selection.policyId)
      return { ...base, outcome: "policy_mismatch", reason: "fx_selection_policy" };
  }
  // 4. Price.
  if (selection.status === "refused")
    return {
      ...base,
      outcome: "unpriced",
      priceKey: want.key,
      reason: selection.reason,
      candidateIds: [...selection.candidateIds],
      ageDays: selection.ageDays,
    };
  // 5–6. Price leg, then FX into the base unit.
  const result = valueInBase(holding.quantity, selection, input.baseUnit, fx, policy.fx);
  if (result.ok)
    return {
      ...base,
      outcome: "valued",
      local: valueAtLocal(holding.quantity, selection),
      value: result.value,
      legs: result.legs,
      roundingInputs: result.roundingInputs,
    };
  if (result.leg !== "fx") {
    // The quantity is exact and of the price's instrument, so the price leg
    // refuses only a non-positive price or a basis that does not divide it.
    if (result.reason !== "price_not_positive" && result.reason !== "rounding_policy_missing")
      throw new RangeError("price_leg_refusal_unexpected");
    return {
      ...base,
      outcome: "unpriced",
      priceKey: want.key,
      reason: result.reason,
      candidateIds: [selection.candidate.price.id],
      ageDays: selection.ageDays,
    };
  }
  return {
    ...base,
    outcome: "unconverted",
    priceKey: want.key,
    reason: result.reason,
    pair: result.pair,
    local: valueAtLocal(holding.quantity, selection),
    priceLeg: {
      leg: "price",
      base: want.key.baseInstrumentRef,
      quote: want.key.quoteUnitRef,
      direction: "direct",
      priceId: selection.candidate.price.id,
      effectiveTime: selection.candidate.price.effectiveTime,
      ageDays: selection.ageDays,
      policyId: selection.policyId,
    },
  };
}

/** Quantity × price in the price's quote unit; exact by construction once valueInBase took the price leg. */
function valueAtLocal(
  quantity: Quantity,
  selection: Extract<PriceSelection, { status: "selected" }>,
): Quantity {
  const local = valueAtPrice(quantity, selection.candidate.price);
  if (!local.ok) throw new RangeError("price_leg_not_exact");
  return local.quantity;
}

function reasonOf(holding: HoldingValueOnDate): string | null {
  switch (holding.outcome) {
    case "valued":
      return null;
    case "instrument_unresolved":
      return holding.status;
    case "snapshot_stale":
      return "stale";
    default:
      return holding.reason;
  }
}

/**
 * Value every holding at the prices and rates selected for the as-of, under
 * `input.policy`. The selections are `selectMarketData`'s (or `selectPrice`'s)
 * for exactly the wants `holdingPriceWant` and `fxCurrenciesFor` name; one a
 * holding needs and was not handed is a caller error and throws. The manifest
 * holds the policies by digest, the engine, the as-of, the reported state's
 * date, cutoff, filters and quantity policy, every snapshot and holding by id
 * with its outcome, and the selection manifest; its digest is the context id,
 * so equal inputs give the same id and a corrected price a new one.
 */
export async function valueHoldingsOnDate(input: ValuationOnDateInput): Promise<ValuationOnDate> {
  const policy = input.policy;
  if (policy === null)
    return { status: "needs-policy", reasonCode: "policy_missing", holdings: null, total: null };
  // A proposal is a recommendation, not a decision (ADR 0056).
  if (
    [policy.price, policy.fx.selection, policy.fx].some((part) =>
      part.policyId.startsWith(PROPOSAL_POLICY_PREFIX),
    )
  )
    return { status: "needs-policy", reasonCode: "policy_proposal", holdings: null, total: null };
  if (!validValuationOnDatePolicy(policy)) throw new RangeError("invalid_policy");
  if (!isCurrencyCode(input.baseUnit)) throw new RangeError("invalid_base_unit");
  if (input.bound.asOfDate !== input.reportedState.date)
    throw new RangeError("as_of_date_mismatch");

  const prices = new Map<string, PriceSelection>();
  for (const entry of input.prices) {
    const text = wantText(entry.selection.key, entry.snapshotParseRunId);
    if (prices.has(text)) throw new RangeError("price_selection_duplicated");
    prices.set(text, entry.selection);
  }
  const fx = new Map<string, PriceSelection>();
  for (const rate of input.fx) {
    if (fx.has(rate.key.baseInstrumentRef)) throw new RangeError("fx_selection_duplicated");
    fx.set(rate.key.baseInstrumentRef, rate);
  }

  const holdings = input.holdings.map((holding) => valueOne(holding, input, policy, prices, fx));
  const counts = Object.fromEntries(HOLDING_VALUE_OUTCOMES.map((code) => [code, 0])) as Record<
    HoldingValueOutcome,
    number
  >;
  for (const holding of holdings) counts[holding.outcome] += 1;

  // A stale snapshot that holdings came from has made each of them
  // `snapshot_stale`; one no holding came from is counted here.
  const held = new Set(input.holdings.map((holding) => holding.snapshotRef));
  const staleEmpty = input.reportedState.stalePositionSnapshots.filter(
    (snapshot) => !held.has(snapshot.ref),
  );
  let total: ValuationTotal;
  if (holdings.length === 0) total = { status: "absent", reason: "no_holdings" };
  else if (counts.valued !== holdings.length)
    total = { status: "absent", reason: "holding_not_valued" };
  else if (new Set(input.holdings.map((holding) => holding.sourceId)).size > 1)
    total = { status: "absent", reason: "adoption_not_applied" };
  else {
    const sum = sumQuantities(
      input.baseUnit,
      holdings.map(
        (holding) => (holding as Extract<HoldingValueOnDate, { outcome: "valued" }>).value,
      ),
    );
    if (!sum.ok) throw new RangeError("total_not_exact");
    const lacking = input.reportedState.positionContainersWithoutSnapshot.length;
    total =
      lacking === 0 && staleEmpty.length === 0
        ? { status: "exact", value: sum.quantity }
        : {
            status: "partial-verified-scope",
            value: sum.quantity,
            positionContainersWithoutSnapshot: lacking,
            stalePositionContainersWithoutHoldings: staleEmpty.length,
          };
  }

  const selection = await selectionManifest({
    policies: [policy.price, policy.fx.selection, policy.fx],
    calendars: usedCalendars(policy),
    bound: input.bound,
    selections: [...input.prices.map((entry) => entry.selection), ...input.fx],
  });
  const policies = await Promise.all(
    [policy.price, policy.fx.selection, policy.fx].map(async (part) => ({
      policyId: part.policyId,
      digest: await canonicalDigest(part),
    })),
  );
  const snapshots = new Map<string, { snapshotRef: string; parseRunId: number }>();
  for (const holding of input.holdings)
    snapshots.set(JSON.stringify([holding.snapshotRef, holding.parseRunId]), {
      snapshotRef: holding.snapshotRef,
      parseRunId: holding.parseRunId,
    });
  const byText = <T>(entries: Iterable<[string, T]>): T[] =>
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
  const manifest: ValuationOnDateManifest = {
    schema: VALUATION_ON_DATE_SCHEMA,
    engine: VALUATION_ON_DATE_ENGINE,
    asOf: {
      date: input.bound.asOfDate,
      effectiveBefore: input.bound.effectiveBefore,
      knowledge: input.bound.knowledge.mode,
    },
    baseUnit: input.baseUnit,
    policies: byText(
      policies.map((entry) => [JSON.stringify([entry.policyId, entry.digest]), entry]),
    ),
    reportedState: {
      date: input.reportedState.date,
      cutoff: input.reportedState.cutoff,
      filters: { ...input.reportedState.filters },
      quantityPolicy: input.reportedState.quantityPolicy,
      contextId: input.reportedState.contextId,
      positionContainersWithoutSnapshot: byText(
        input.reportedState.positionContainersWithoutSnapshot.map((entry) => [
          JSON.stringify([entry.sourceId, entry.parserName, entry.dataset]),
          { sourceId: entry.sourceId, parserName: entry.parserName, dataset: entry.dataset },
        ]),
      ),
      stalePositionSnapshotsWithoutHoldings: byText(
        staleEmpty.map((entry) => [
          entry.ref,
          {
            ref: entry.ref,
            sourceId: entry.sourceId,
            parserName: entry.parserName,
            ageDays: entry.ageDays,
          },
        ]),
      ),
    },
    snapshots: byText(snapshots),
    holdings: byText(
      holdings.map((holding) => [
        JSON.stringify([holding.holdingRef, holding.snapshotRef]),
        {
          ref: holding.holdingRef,
          snapshotRef: holding.snapshotRef,
          outcome: holding.outcome,
          reason: reasonOf(holding),
          priceId:
            holding.outcome === "valued"
              ? holding.legs[0]!.priceId
              : holding.outcome === "unconverted"
                ? holding.priceLeg.priceId
                : null,
          fxPriceIds:
            holding.outcome === "valued"
              ? holding.legs.filter((leg) => leg.leg === "fx").map((leg) => leg.priceId)
              : [],
        },
      ]),
    ),
    selection,
    selectionContextId: await canonicalDigest(selection),
  };
  return {
    status: "computed",
    baseUnit: input.baseUnit,
    holdings,
    counts,
    total,
    manifest,
    contextId: await canonicalDigest(manifest),
  };
}
