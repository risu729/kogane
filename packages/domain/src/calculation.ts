// Valuation, rounding and P&L decomposition as versioned inputs (architecture
// addendum 09; findings AR03, AR12).
//
// Three rules shape everything here.
//
//   1. A price is an amount per an explicit base quantity. A fund quoted at
//      8,000 JPY per 10,000 units values 12,500 units at 10,000 JPY, not at
//      100,000,000 (SYN22). Nothing multiplies a quantity by a bare number.
//   2. "Not valued" is a typed reason, never a zero and never an omission.
//      A missing price, an unresolved account and an unsupported instrument
//      are different facts (INV05, addendum 09 section 3).
//   3. Rounding position and P&L attribution are policies. Both decompositions
//      in `pnlDecomposition` total the same change; neither is the observed
//      fact, so both carry `factual: false` and their policy id.
import { isOneOf, isRecord, isSafeInt, isText } from "./guards.ts";
import { valueAtPrice, type PriceObservation } from "./metrics.ts";
import { compareTemporal, type TemporalValue } from "./time.ts";
import {
  addDecimals,
  compareDecimals,
  exactQuantity,
  integerDecimal,
  multiplyByRatio,
  multiplyDecimals,
  normalizeDecimal,
  ROUNDING_MODES,
  subtractDecimals,
  sumDecimals,
  type ExactDecimal,
  type ExactRatio,
  type Quantity,
  type Rounding,
  type RoundingMode,
  type ValueError,
} from "./values.ts";

export const CALCULATION_CONTRACT_VERSION = "calculation-v1";

/**
 * Why a cell has no value. These are not interchangeable: "we have no price"
 * and "we do not know which account this is" lead to different repairs, and
 * neither is a zero (addendum 09 section 3).
 */
export const UNVALUED_REASONS = [
  "missing-quantity",
  "unresolved-identity",
  "overlap",
  "stale-price",
  "missing-price",
  "unsupported-instrument",
  "incomplete-liabilities",
] as const;
export type UnvaluedReason = (typeof UNVALUED_REASONS)[number];

/**
 * The valuation order of addendum 09 section 3. It is a fixed sequence, not a
 * set of independent checks: a scope overlap is decided before a price is
 * looked for, so an overlapping holding is never reported as merely unpriced.
 */
export const VALUATION_STEPS = [
  "permitted-perimeter",
  "claim-adoption",
  "identity-ownership-scope",
  "quantity-by-unit",
  "instrument-valuation-method",
  "fx-conversion",
  "rounding-and-aggregation",
  "coverage-and-explanation",
] as const;
export type ValuationStep = (typeof VALUATION_STEPS)[number];

/** Where a result sits relative to the question asked. There is no "at least" subtotal. */
export const RESULT_PARTITIONS = ["complete", "partial-verified-scope", "not-computable"] as const;
export type ResultPartition = (typeof RESULT_PARTITIONS)[number];

/**
 * How an instrument may be valued at all. `quantity-times-price` is the only
 * arithmetic this module performs; derivative notional, margin requirement and
 * contract nominal are separate metrics that a bare `quantity × price` would
 * misstate, so they are unsupported until a policy defines them.
 */
export const INSTRUMENT_CLASSES = [
  "cash",
  "deposit",
  "listed-equity",
  "fund-unit",
  "crypto-asset",
  "derivative",
  "margin-position",
  "nominal-contract",
  "unknown",
] as const;
export type InstrumentClass = (typeof INSTRUMENT_CLASSES)[number];

export const VALUATION_METHODS = [
  "quantity-times-price",
  "provider-reported-only",
  "unsupported",
] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

export interface InstrumentValuationPolicy {
  policyId: string;
  methods: Readonly<Partial<Record<InstrumentClass, ValuationMethod>>>;
}

/**
 * The default: price-based valuation only for instruments whose value really
 * is quantity × unit price. Everything else shows the quantity and whatever
 * the provider reported, and says `unsupported-instrument` rather than
 * inventing a number (addendum 09 section 2).
 */
export const DEFAULT_INSTRUMENT_VALUATION_POLICY: InstrumentValuationPolicy = {
  policyId: "instrument-valuation-v1",
  methods: {
    cash: "quantity-times-price",
    deposit: "quantity-times-price",
    "listed-equity": "quantity-times-price",
    "fund-unit": "quantity-times-price",
    "crypto-asset": "quantity-times-price",
    derivative: "unsupported",
    "margin-position": "unsupported",
    "nominal-contract": "unsupported",
    unknown: "unsupported",
  },
};

export function valuationMethodFor(
  instrumentClass: InstrumentClass,
  policy: InstrumentValuationPolicy = DEFAULT_INSTRUMENT_VALUATION_POLICY,
): ValuationMethod {
  return policy.methods[instrumentClass] ?? "unsupported";
}

/** Where a rounding policy is applied. Rounding each leg and rounding the total are different policies. */
export const ROUNDING_POINTS = ["leg", "execution", "statement", "aggregate"] as const;
export type RoundingPoint = (typeof ROUNDING_POINTS)[number];
/** What happens to the difference between the rounded parts and the rounded whole. */
export const RESIDUAL_HANDLINGS = ["carry", "largest-remainder", "leave", "refuse"] as const;
export type ResidualHandling = (typeof RESIDUAL_HANDLINGS)[number];

export interface RoundingPolicy {
  policyId: string;
  where: RoundingPoint;
  mode: RoundingMode;
  /** Decimal places of the unit or instrument this policy applies to. */
  precision: number;
  residual: ResidualHandling;
}

export function validRoundingPolicy(value: unknown): value is RoundingPolicy {
  return (
    isRecord(value) &&
    isText(value.policyId, 256) &&
    isOneOf(ROUNDING_POINTS)(value.where) &&
    isOneOf(ROUNDING_MODES)(value.mode) &&
    isSafeInt(value.precision, 0, 4096) &&
    isOneOf(RESIDUAL_HANDLINGS)(value.residual)
  );
}

function rounding(policy: RoundingPolicy): Rounding {
  return { scale: policy.precision, mode: policy.mode };
}

/**
 * What a rounded number was made from. Keeping only the rounded value makes a
 * different policy impossible to apply later, so every rounded result carries
 * its operands and the policy that produced it (addendum 09 section 4).
 */
export interface RoundingInputs {
  policyId: string;
  where: RoundingPoint;
  mode: RoundingMode;
  precision: number;
  residual: ResidualHandling;
  /** Exact, unrounded operands in the order they were combined. */
  operands: ExactDecimal[];
  /** The exact value before rounding was applied, if one was computed. */
  preRounding: ExactDecimal | null;
}

export type HoldingValuation =
  | {
      valued: true;
      step: "fx-conversion" | "rounding-and-aggregation";
      value: Quantity;
      /** The exact value before the rounding policy was applied. */
      preRounding: Quantity;
      priceRef: string;
      roundingInputs: RoundingInputs | null;
    }
  | { valued: false; step: ValuationStep; reason: UnvaluedReason; refs: string[] };

export interface HoldingValuationOptions {
  instrumentClass?: InstrumentClass;
  instrumentPolicy?: InstrumentValuationPolicy;
  rounding?: RoundingPolicy;
  /**
   * Set when the scope of this holding overlaps another adopted measure, or
   * when its account identity is unresolved. Both are decided before pricing.
   */
  scopeOverlap?: boolean;
  identityUnresolved?: boolean;
  /** Evaluated against the price's `effectiveTime`; a price older than this is stale. */
  freshnessFloor?: TemporalValue;
}

function unvalued(step: ValuationStep, reason: UnvaluedReason, refs: string[]): HoldingValuation {
  return { valued: false, step, reason, refs };
}

/**
 * Value one holding at one price, in the order of addendum 09 section 3. The
 * price basis (`baseQuantity`) is applied, so 12,500 fund units at 8,000 per
 * 10,000 units is 10,000, and the quantity unit must be the instrument the
 * price is quoted for — a currency mismatch is `unresolved-identity`, never a
 * silent 1:1 conversion (AT24).
 */
export function valueHolding(
  quantity: Quantity,
  price: PriceObservation | null,
  options: HoldingValuationOptions = {},
): HoldingValuation {
  if (options.identityUnresolved === true)
    return unvalued("identity-ownership-scope", "unresolved-identity", [quantity.unitRef]);
  if (options.scopeOverlap === true)
    return unvalued("identity-ownership-scope", "overlap", [quantity.unitRef]);
  if (quantity.value.status !== "exact")
    return unvalued("quantity-by-unit", "missing-quantity", [
      `${quantity.value.status}:${quantity.value.reasonCode}`,
    ]);
  const method = valuationMethodFor(
    options.instrumentClass ?? "unknown",
    options.instrumentPolicy ?? DEFAULT_INSTRUMENT_VALUATION_POLICY,
  );
  if (method !== "quantity-times-price")
    return unvalued("instrument-valuation-method", "unsupported-instrument", [
      options.instrumentClass ?? "unknown",
      method,
    ]);
  if (price === null) return unvalued("fx-conversion", "missing-price", [quantity.unitRef]);
  if (price.baseInstrumentRef !== quantity.unitRef)
    return unvalued("identity-ownership-scope", "unresolved-identity", [
      quantity.unitRef,
      price.baseInstrumentRef,
    ]);
  if (options.freshnessFloor !== undefined) {
    const order = compareTemporal(price.effectiveTime, options.freshnessFloor);
    // Incomparable is not "fresh enough": an unknown or overlapping price time
    // cannot establish that the price is current.
    if (order.kind !== "ordered" || order.order < 0)
      return unvalued("fx-conversion", "stale-price", [price.id]);
  }
  const exact = valueAtPrice(quantity, price);
  if (!exact.ok) return unvalued("fx-conversion", "missing-price", exact.error.refs);
  if (!options.rounding)
    return {
      valued: true,
      step: "fx-conversion",
      value: exact.quantity,
      preRounding: exact.quantity,
      priceRef: price.id,
      roundingInputs: null,
    };
  const policy = options.rounding;
  const rounded = valueAtPrice(quantity, price, rounding(policy));
  if (!rounded.ok) return unvalued("rounding-and-aggregation", "missing-price", rounded.error.refs);
  const preRounding =
    exact.quantity.value.status === "exact" ? exact.quantity.value.value : integerDecimal(0);
  return {
    valued: true,
    step: "rounding-and-aggregation",
    value: rounded.quantity,
    preRounding: exact.quantity,
    priceRef: price.id,
    roundingInputs: {
      policyId: policy.policyId,
      where: policy.where,
      mode: policy.mode,
      precision: policy.precision,
      residual: policy.residual,
      operands: [quantity.value.value, price.quoteAmount, price.baseQuantity],
      preRounding,
    },
  };
}

export interface RoundedAggregate {
  total: Quantity;
  /** The exact sum before any rounding; kept so another policy can start over. */
  preRounding: Quantity;
  /** The rounded parts actually reported, after the residual rule was applied. */
  parts: ExactDecimal[];
  /** `total − exact sum`. Rounding always loses something; this says how much. */
  residual: ExactDecimal;
  roundingInputs: RoundingInputs;
}

const UNIT_RATIO: ExactRatio = { numerator: "1", denominator: "1" };

/** Round an exact decimal to a scale with an explicit mode; display formatting is a separate concern. */
export function roundDecimal(value: ExactDecimal, mode: Rounding): ExactDecimal {
  const rounded = multiplyByRatio(value, UNIT_RATIO, mode);
  // A 1/1 ratio with an explicit rounding cannot fail for a valid decimal.
  return rounded.ok ? rounded.value : value;
}

/** Signed integer count of 10^-precision units; exact for any decimal of that scale or coarser. */
function units(value: ExactDecimal, precision: number): bigint {
  return BigInt(value.coefficient) * 10n ** BigInt(precision - value.scale);
}

/**
 * Apply the policy once, at the point it declares. `aggregate` adds exactly
 * and rounds the total; `leg` / `execution` / `statement` round each part and
 * then decide what to do with the difference between the rounded parts and the
 * rounded whole: `carry` puts it on the last part, `largest-remainder` gives it
 * to the parts that lost the most, `leave` keeps the plain sum of the rounded
 * parts, and `refuse` reports rather than absorbing it. The exact sum is
 * always returned so a different policy can recompute (addendum 09 section 4).
 */
export function applyRoundingPolicy(
  unitRef: string,
  parts: readonly ExactDecimal[],
  policy: RoundingPolicy,
): { ok: true; aggregate: RoundedAggregate } | { ok: false; error: ValueError } {
  const precision = policy.precision;
  const exactTotal = sumDecimals(parts);
  const roundOne = (value: ExactDecimal): ExactDecimal => roundDecimal(value, rounding(policy));
  const inputs: RoundingInputs = {
    policyId: policy.policyId,
    where: policy.where,
    mode: policy.mode,
    precision,
    residual: policy.residual,
    operands: [...parts],
    preRounding: exactTotal,
  };
  const done = (total: ExactDecimal, reported: ExactDecimal[]) => ({
    ok: true as const,
    aggregate: {
      total: exactQuantity(unitRef, total),
      preRounding: exactQuantity(unitRef, exactTotal),
      parts: reported,
      residual: subtractDecimals(total, exactTotal),
      roundingInputs: inputs,
    },
  });
  if (policy.where === "aggregate") return done(roundOne(exactTotal), [...parts]);
  const rounded = parts.map(roundOne);
  const target = units(roundOne(exactTotal), precision);
  const allocated = rounded.map((value) => units(value, precision));
  let drift = target - allocated.reduce((sum, value) => sum + value, 0n);
  if (drift !== 0n && policy.residual === "refuse")
    return {
      ok: false,
      error: {
        code: "inexact_result",
        message: "rounded parts do not sum to the rounded total and this policy refuses to adjust",
        refs: [policy.policyId, policy.where],
      },
    };
  const last = allocated.length - 1;
  if (drift !== 0n && policy.residual === "carry" && last >= 0) {
    allocated[last] = allocated[last]! + drift;
    drift = 0n;
  }
  if (drift !== 0n && policy.residual === "largest-remainder" && allocated.length > 0) {
    // Each unit of drift goes to the part whose exact value lost the most.
    const step = drift > 0n ? 1n : -1n;
    const ranked = parts
      .map((part, index) => ({ index, remainder: subtractDecimals(part, rounded[index]!) }))
      .sort((a, b) => {
        const order = compareDecimals(a.remainder, b.remainder);
        return order === 0 ? a.index - b.index : step > 0n ? -order : order;
      });
    const total = drift > 0n ? drift : -drift;
    for (let taken = 0n; taken < total; taken += 1n) {
      const slot = ranked[Number(taken % BigInt(ranked.length))]!;
      allocated[slot.index] = allocated[slot.index]! + step;
    }
    drift = 0n;
  }
  const reported = allocated.map((count) => normalizeDecimal(count, precision));
  return done(sumDecimals(reported), reported);
}

/** The two attributions of addendum 09 section 5. Neither is the observed fact. */
export const PNL_DECOMPOSITION_POLICIES = ["policy-a", "policy-b"] as const;
export type PnlDecompositionPolicy = (typeof PNL_DECOMPOSITION_POLICIES)[number];

export interface PnlInputs {
  /** Constant over the period; a quantity change is a separate flow, not price or FX. */
  quantity: ExactDecimal;
  openingPrice: ExactDecimal;
  closingPrice: ExactDecimal;
  openingRate: ExactDecimal;
  closingRate: ExactDecimal;
  baseUnitRef: string;
}

export interface PnlDecomposition {
  policyId: PnlDecompositionPolicy;
  total: Quantity;
  market: Quantity;
  fx: Quantity;
  /**
   * Always false. The split of the cross term between market and FX is a
   * choice; only the total is observation-derived (addendum 09 section 5).
   */
  factual: false;
}

/**
 * `ΔV = q(P₁R₁ − P₀R₀)`, attributed two ways.
 *
 *   policy-a: market = q(P₁−P₀)R₀, fx = qP₁(R₁−R₀)
 *   policy-b: market = q(P₁−P₀)R₁, fx = qP₀(R₁−R₀)
 *
 * Both total the same; the cross term `q(P₁−P₀)(R₁−R₀)` lands in a different
 * component (SYN23).
 */
export function pnlDecomposition(
  inputs: PnlInputs,
  policyId: PnlDecompositionPolicy,
): PnlDecomposition {
  const { quantity, openingPrice, closingPrice, openingRate, closingRate, baseUnitRef } = inputs;
  const total = multiplyDecimals(
    quantity,
    subtractDecimals(
      multiplyDecimals(closingPrice, closingRate),
      multiplyDecimals(openingPrice, openingRate),
    ),
  );
  const priceChange = subtractDecimals(closingPrice, openingPrice);
  const rateChange = subtractDecimals(closingRate, openingRate);
  const market = multiplyDecimals(
    multiplyDecimals(quantity, priceChange),
    policyId === "policy-a" ? openingRate : closingRate,
  );
  const fx = multiplyDecimals(
    multiplyDecimals(quantity, policyId === "policy-a" ? closingPrice : openingPrice),
    rateChange,
  );
  return {
    policyId,
    total: exactQuantity(baseUnitRef, total),
    market: exactQuantity(baseUnitRef, market),
    fx: exactQuantity(baseUnitRef, fx),
    factual: false,
  };
}

/** Both policies applied to the same inputs, for a caller that must show that the split is a choice. */
export function pnlDecompositions(inputs: PnlInputs): Record<
  PnlDecompositionPolicy,
  PnlDecomposition
> & {
  totalsAgree: boolean;
} {
  const a = pnlDecomposition(inputs, "policy-a");
  const b = pnlDecomposition(inputs, "policy-b");
  const sum = (d: PnlDecomposition): ExactDecimal =>
    addDecimals(
      d.market.value.status === "exact" ? d.market.value.value : integerDecimal(0),
      d.fx.value.status === "exact" ? d.fx.value.value : integerDecimal(0),
    );
  const totalOf = (d: PnlDecomposition): ExactDecimal =>
    d.total.value.status === "exact" ? d.total.value.value : integerDecimal(0);
  const totals = [totalOf(a), sum(a), sum(b)];
  const first = totals[0]!;
  return {
    "policy-a": a,
    "policy-b": b,
    totalsAgree: totals.every(
      (value) => value.coefficient === first.coefficient && value.scale === first.scale,
    ),
  };
}

/** What a cost-basis calculation needs before it can produce a number at all. */
export const COST_BASIS_INPUTS = [
  "jurisdiction",
  "taxPeriod",
  "accountWrapper",
  "residencyOrEntity",
  "method",
  "feeTreatment",
  "carriedCost",
  "lotSelection",
] as const;
export type CostBasisInput = (typeof COST_BASIS_INPUTS)[number];

export interface CostBasisRequest {
  jurisdiction: string | null;
  taxPeriod: string | null;
  accountWrapper: string | null;
  residencyOrEntity: string | null;
  method: string | null;
  feeTreatment: string | null;
  carriedCost: string | null;
  lotSelection: string | null;
  /** A rule package that a person verified for this jurisdiction and period. */
  rulePackage: { policyId: string; verification: "verified" | "unverified" } | null;
}

export type CostBasisOutcome = {
  status: "needs-policy";
  reasonCode: "no_verified_rule_package" | "missing_inputs";
  missing: CostBasisInput[];
  /** Never a tax conclusion; this module has no jurisdiction rules at all. */
  taxConclusion: null;
};

/**
 * The contract and the gate, nothing else. This repository does not hold a
 * verified JP or AU rule package, so every request returns `needs-policy`
 * (AT59). Provider-reported cost is stored beside an own calculation; it is
 * not promoted to the single truth (UC30).
 */
export function costBasis(request: CostBasisRequest): CostBasisOutcome {
  const missing = COST_BASIS_INPUTS.filter((key) => request[key] === null);
  if (request.rulePackage === null || request.rulePackage.verification !== "verified")
    return {
      status: "needs-policy",
      reasonCode: "no_verified_rule_package",
      missing,
      taxConclusion: null,
    };
  return { status: "needs-policy", reasonCode: "missing_inputs", missing, taxConclusion: null };
}

export interface ValuationCell {
  subjectRef: string;
  scopeRef: string;
  metric: string;
  unitRef: string;
  outcome: HoldingValuation;
}

export interface ValuationSummary {
  partition: ResultPartition;
  /** Sum of the valued cells only; it is a subtotal of a named scope, never "the total". */
  subtotal: Quantity | null;
  valued: ValuationCell[];
  unvalued: ValuationCell[];
  reasons: UnvaluedReason[];
}

/**
 * Partition the cells: everything valued is `complete`, a mix is
 * `partial-verified-scope`, nothing valued is `not-computable`. A partial
 * result never gets a whole-portfolio label, and its subtotal is not a lower
 * bound of anything (addendum 09 section 3).
 */
export function summarizeValuation(
  unitRef: string,
  cells: readonly ValuationCell[],
): ValuationSummary {
  const valued: ValuationCell[] = [];
  const unvaluedCells: ValuationCell[] = [];
  const reasons = new Set<UnvaluedReason>();
  const amounts: ExactDecimal[] = [];
  for (const cell of cells) {
    if (!cell.outcome.valued) {
      unvaluedCells.push(cell);
      reasons.add(cell.outcome.reason);
      continue;
    }
    const value = cell.outcome.value;
    // A valued cell in another unit is not summable here; it is reported as
    // valued but keeps the subtotal out of `complete` (INV03).
    if (value.unitRef !== unitRef || value.value.status !== "exact") {
      valued.push(cell);
      reasons.add("unresolved-identity");
      continue;
    }
    valued.push(cell);
    amounts.push(value.value.value);
  }
  const partition: ResultPartition =
    amounts.length === 0
      ? "not-computable"
      : unvaluedCells.length === 0 && amounts.length === valued.length
        ? "complete"
        : "partial-verified-scope";
  return {
    partition,
    subtotal: partition === "not-computable" ? null : exactQuantity(unitRef, sumDecimals(amounts)),
    valued,
    unvalued: unvaluedCells,
    reasons: [...reasons].sort(),
  };
}

export type NetWorthOutcome =
  | {
      metric: "net-worth";
      value: Quantity;
      assets: Quantity;
      liabilities: Quantity;
      partition: ResultPartition;
    }
  | {
      metric: "known-assets-subtotal";
      value: Quantity;
      reason: "incomplete-liabilities";
      partition: ResultPartition;
    };

/**
 * Net worth only when the liability side is complete. Otherwise the answer is
 * a named subtotal of known assets: an assets total minus an incomplete
 * liability set is not a net worth and is not even a lower bound of one
 * (addendum 09 section 3).
 */
export function netWorth(input: {
  unitRef: string;
  assets: ExactDecimal;
  liabilities: ExactDecimal;
  liabilitiesCoverage: "complete" | "partial" | "unknown";
  assetsPartition: ResultPartition;
}): NetWorthOutcome {
  if (input.liabilitiesCoverage !== "complete")
    return {
      metric: "known-assets-subtotal",
      value: exactQuantity(input.unitRef, input.assets),
      reason: "incomplete-liabilities",
      partition:
        input.assetsPartition === "not-computable" ? "not-computable" : "partial-verified-scope",
    };
  return {
    metric: "net-worth",
    value: exactQuantity(input.unitRef, subtractDecimals(input.assets, input.liabilities)),
    assets: exactQuantity(input.unitRef, input.assets),
    liabilities: exactQuantity(input.unitRef, input.liabilities),
    partition: input.assetsPartition,
  };
}
