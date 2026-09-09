// A metric is more than a provider's column name. The registry below moves the
// current classifyBalance / classifyActivity rules into a versioned, typed
// contract without changing them: every entry records the legacy classification
// it was seeded from, and tests compare the two. Unknown metrics resolve to an
// explicit non-additive definition; they are stored, never summed.
import { hasExactKeys, isOneOf, isRecord, isText, isTextOrNull } from "./guards.ts";
import { validTemporalValue, type TemporalValue } from "./time.ts";
import {
  exactQuantity,
  multiplyByRatio,
  validExactDecimal,
  type ExactDecimal,
  type Quantity,
  type QuantityResult,
  type Rounding,
} from "./values.ts";

export const METRIC_REGISTRY_RELEASE = "metric-registry-v1";

export const MEASUREMENT_KINDS = [
  "stock",
  "flow",
  "obligation",
  "capacity",
  "price",
  "valuation",
  "period-total",
  "qualification",
] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];
export const SUBJECT_KINDS = [
  "account",
  "product",
  "pocket",
  "position",
  "instrument",
  "statement",
  "program",
  "connection",
  "unknown",
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const UNIT_DIMENSIONS = ["currency", "quantity", "reward", "ratio", "unknown"] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];
export const SIGN_MEANINGS = [
  "provider-sign",
  "asset-positive",
  "liability-positive",
  "unsigned",
  "unknown",
] as const;
export type SignMeaning = (typeof SIGN_MEANINGS)[number];
export const TIME_BASES = [
  "point-in-time",
  "event-reported",
  "period",
  "statement-month",
  "previous-calendar-month",
  "unknown",
] as const;
export type MetricTimeBasis = (typeof TIME_BASES)[number];
export const AGGREGATION_RULES = [
  "sum-disjoint",
  "select-one",
  "non-additive",
  "domain-specific",
] as const;
export type AggregationRule = (typeof AGGREGATION_RULES)[number];
export const SOURCE_AUTHORITIES = ["provider-reported", "derived", "unknown"] as const;
export type SourceAuthority = (typeof SOURCE_AUTHORITIES)[number];
export const CLAIM_FAMILIES = ["balance", "transaction", "position", "valuation"] as const;
export type ClaimFamily = (typeof CLAIM_FAMILIES)[number];

/** Legacy classification a registry entry was seeded from; compared against the PoC rules in tests. */
export interface LegacyBalanceSemantic {
  kind: "asset" | "liability" | "statement" | "aggregate" | "period_total" | "other";
  measurementKind:
    | "balance"
    | "aggregate_balance"
    | "period_total"
    | "statement_amount"
    | "capacity"
    | "unknown";
  assetClass: "cash" | "prepaid" | "reward" | "mixed" | "unknown";
  timeBasis:
    | "reported_snapshot"
    | "event_report"
    | "previous_calendar_month"
    | "statement_month"
    | "unknown";
}
export interface LegacyActivitySemantic {
  kind: "cash_movement" | "card_activity" | "statement_item" | "trade" | "notification" | "unknown";
}

export interface ProviderMetric {
  family: ClaimFamily;
  sourceId: string;
  parserName: string | null;
  metric: string | null;
}

export interface MetricDefinition {
  metricId: string;
  providerMetric: ProviderMetric | null;
  measurementKind: MeasurementKind;
  subjectKind: SubjectKind;
  unitDimension: UnitDimension;
  signMeaning: SignMeaning;
  timeBasis: MetricTimeBasis;
  aggregationRule: AggregationRule;
  /** Measures sharing a group describe overlapping sets (total vs breakdown, statement vs line). */
  overlapGroup: string | null;
  sourceAuthority: SourceAuthority;
  definitionRelease: string;
  /** Kept false for every entry, exactly as today; adoption decides eligibility, not the metric. */
  netAssetEligible: false;
  legacyBalance: LegacyBalanceSemantic | null;
  legacyActivity: LegacyActivitySemantic | null;
}

export interface MetricLookup {
  family: ClaimFamily;
  sourceId: string;
  parserName: string | null;
  metric: string | null;
  sourceAccount: string | null;
  /** `extra._kogane.amountBasis` for transaction rows, when the parser records one. */
  amountBasis: string | null;
}

interface Selector {
  family: ClaimFamily;
  sourceId: string;
  parserName: string;
  metrics?: readonly string[];
  sourceAccountEquals?: string;
  sourceAccountPrefix?: string;
  amountBasis?: string;
}

interface RegistryEntry {
  selectors: readonly Selector[];
  definition: MetricDefinition;
}

type Shape = Omit<
  MetricDefinition,
  "providerMetric" | "definitionRelease" | "netAssetEligible" | "legacyBalance" | "legacyActivity"
> & {
  legacyBalance?: LegacyBalanceSemantic;
  legacyActivity?: LegacyActivitySemantic;
};

const LEGACY_UNKNOWN: LegacyBalanceSemantic = {
  kind: "other",
  measurementKind: "unknown",
  assetClass: "unknown",
  timeBasis: "unknown",
};
const LEGACY_DEPOSIT: LegacyBalanceSemantic = {
  kind: "asset",
  measurementKind: "balance",
  assetClass: "cash",
  timeBasis: "reported_snapshot",
};
const LEGACY_CAPACITY: LegacyBalanceSemantic = {
  ...LEGACY_UNKNOWN,
  measurementKind: "capacity",
};

function entry(selectors: readonly Selector[], shape: Shape): RegistryEntry {
  const first = selectors[0]!;
  const metrics = first.metrics ?? null;
  return {
    selectors,
    definition: {
      metricId: shape.metricId,
      providerMetric: {
        family: first.family,
        sourceId: first.sourceId,
        parserName: first.parserName,
        metric: metrics && metrics.length === 1 ? metrics[0]! : null,
      },
      measurementKind: shape.measurementKind,
      subjectKind: shape.subjectKind,
      unitDimension: shape.unitDimension,
      signMeaning: shape.signMeaning,
      timeBasis: shape.timeBasis,
      aggregationRule: shape.aggregationRule,
      overlapGroup: shape.overlapGroup,
      sourceAuthority: shape.sourceAuthority,
      definitionRelease: METRIC_REGISTRY_RELEASE,
      netAssetEligible: false,
      legacyBalance: shape.legacyBalance ?? null,
      legacyActivity: shape.legacyActivity ?? null,
    },
  };
}

const balance = (sourceId: string, parserName: string, metrics: readonly string[]): Selector => ({
  family: "balance",
  sourceId,
  parserName,
  metrics,
});
const transaction = (sourceId: string, parserName: string, amountBasis?: string): Selector => ({
  family: "transaction",
  sourceId,
  parserName,
  ...(amountBasis === undefined ? {} : { amountBasis }),
});

/** Explicit definition for anything the registry does not know: kept, displayed, never summed. */
export const UNKNOWN_METRIC: MetricDefinition = {
  metricId: "unknown",
  providerMetric: null,
  measurementKind: "stock",
  subjectKind: "unknown",
  unitDimension: "unknown",
  signMeaning: "unknown",
  timeBasis: "unknown",
  aggregationRule: "non-additive",
  overlapGroup: null,
  sourceAuthority: "unknown",
  definitionRelease: METRIC_REGISTRY_RELEASE,
  netAssetEligible: false,
  legacyBalance: LEGACY_UNKNOWN,
  legacyActivity: { kind: "unknown" },
};

// Order matters and mirrors the branch order of classifyBalance / classifyActivity.
export const METRIC_REGISTRY: readonly RegistryEntry[] = [
  entry(
    [balance("myjcb", "myjcb-credit-past-month-balances", ["credit_statement_payment_amount"])],
    {
      metricId: "card.statement-payment-amount",
      measurementKind: "period-total",
      subjectKind: "statement",
      unitDimension: "currency",
      signMeaning: "provider-sign",
      timeBasis: "statement-month",
      aggregationRule: "non-additive",
      overlapGroup: "myjcb:statement",
      sourceAuthority: "provider-reported",
      legacyBalance: {
        kind: "statement",
        measurementKind: "statement_amount",
        assetClass: "unknown",
        timeBasis: "statement_month",
      },
    },
  ),
  entry([balance("sony-bank", "sony-bank-gross-balance", ["gross_asset_balance"])], {
    metricId: "bank.gross-asset-aggregate",
    measurementKind: "stock",
    subjectKind: "connection",
    unitDimension: "currency",
    signMeaning: "asset-positive",
    timeBasis: "point-in-time",
    aggregationRule: "non-additive",
    overlapGroup: "sony-bank:gross-vs-product",
    sourceAuthority: "provider-reported",
    legacyBalance: {
      kind: "aggregate",
      measurementKind: "aggregate_balance",
      assetClass: "unknown",
      timeBasis: "unknown",
    },
  }),
  entry([balance("sony-bank", "sony-bank-gross-balance", ["gross_loan_balance"])], {
    metricId: "bank.gross-loan-aggregate",
    measurementKind: "stock",
    subjectKind: "connection",
    unitDimension: "currency",
    signMeaning: "liability-positive",
    timeBasis: "point-in-time",
    aggregationRule: "non-additive",
    overlapGroup: "sony-bank:gross-vs-product",
    sourceAuthority: "provider-reported",
    legacyBalance: {
      kind: "aggregate",
      measurementKind: "aggregate_balance",
      assetClass: "unknown",
      timeBasis: "unknown",
    },
  }),
  entry([balance("v-point", "v-point-smfg-point", ["displayed_point_balance"])], {
    metricId: "reward.previous-month-earned",
    measurementKind: "period-total",
    subjectKind: "program",
    unitDimension: "reward",
    signMeaning: "provider-sign",
    timeBasis: "previous-calendar-month",
    aggregationRule: "non-additive",
    overlapGroup: null,
    sourceAuthority: "provider-reported",
    legacyBalance: {
      kind: "period_total",
      measurementKind: "period_total",
      assetClass: "reward",
      timeBasis: "previous_calendar_month",
    },
  }),
  entry(
    [
      {
        ...balance("v-point", "v-point-balance-info", ["available_point_bucket"]),
        sourceAccountPrefix: "v-point:store-limited:",
      },
    ],
    {
      metricId: "reward.store-limited-bucket-balance",
      measurementKind: "stock",
      subjectKind: "pocket",
      unitDimension: "reward",
      signMeaning: "asset-positive",
      timeBasis: "point-in-time",
      aggregationRule: "domain-specific",
      overlapGroup: null,
      sourceAuthority: "provider-reported",
      legacyBalance: {
        kind: "asset",
        measurementKind: "balance",
        assetClass: "reward",
        timeBasis: "reported_snapshot",
      },
    },
  ),
  entry([balance("v-point", "v-point-balance-info", ["available_point_bucket"])], {
    metricId: "reward.bucket-balance",
    measurementKind: "stock",
    subjectKind: "pocket",
    unitDimension: "reward",
    signMeaning: "asset-positive",
    timeBasis: "point-in-time",
    aggregationRule: "domain-specific",
    overlapGroup: null,
    sourceAuthority: "provider-reported",
    legacyBalance: {
      kind: "asset",
      measurementKind: "balance",
      assetClass: "reward",
      timeBasis: "reported_snapshot",
    },
  }),
  entry(
    [balance("v-point-pay", "v-point-pay-notification-event", ["prepaid_balance_after_event"])],
    {
      metricId: "prepaid.balance-after-notification",
      measurementKind: "stock",
      subjectKind: "account",
      unitDimension: "currency",
      signMeaning: "asset-positive",
      timeBasis: "event-reported",
      aggregationRule: "select-one",
      overlapGroup: null,
      sourceAuthority: "provider-reported",
      legacyBalance: {
        kind: "asset",
        measurementKind: "balance",
        assetClass: "prepaid",
        timeBasis: "event_report",
      },
    },
  ),
  entry(
    [
      balance("sbi-shinsei-bank", "sbi-shinsei-yen-deposit-account", [
        "yen_deposit_account_balance",
        "yen_deposit_savings_balance",
      ]),
      balance("sbi-shinsei-bank", "sbi-shinsei-top-balances-and-activity", ["account_balance"]),
      balance("smbc-bank", "smbc-direct-balance", ["account_balance"]),
    ],
    {
      metricId: "deposit.balance",
      measurementKind: "stock",
      subjectKind: "account",
      unitDimension: "currency",
      signMeaning: "asset-positive",
      timeBasis: "point-in-time",
      aggregationRule: "sum-disjoint",
      overlapGroup: null,
      sourceAuthority: "provider-reported",
      legacyBalance: LEGACY_DEPOSIT,
    },
  ),
  entry(
    [
      balance("sbi-shinsei-bank", "sbi-shinsei-top-balances-and-activity", [
        "activity_current_balance",
      ]),
      balance("sony-bank", "sony-bank-history-json", ["available_after_transaction"]),
      balance("sony-bank", "sony-bank-history-csv", ["available_after_transaction"]),
    ],
    {
      metricId: "deposit.balance-after-transaction",
      measurementKind: "stock",
      subjectKind: "account",
      unitDimension: "currency",
      signMeaning: "asset-positive",
      timeBasis: "event-reported",
      aggregationRule: "select-one",
      overlapGroup: null,
      sourceAuthority: "provider-reported",
      legacyBalance: LEGACY_DEPOSIT,
    },
  ),
  entry(
    [
      {
        ...balance("mobile-suica", "mobile-suica-sf-history", ["sf_balance_after_transaction"]),
        sourceAccountEquals: "mobile-suica:sf",
      },
    ],
    {
      metricId: "prepaid.sf-balance-after-transaction",
      measurementKind: "stock",
      subjectKind: "account",
      unitDimension: "currency",
      signMeaning: "asset-positive",
      timeBasis: "event-reported",
      aggregationRule: "select-one",
      overlapGroup: null,
      sourceAuthority: "provider-reported",
      legacyBalance: {
        kind: "asset",
        measurementKind: "balance",
        assetClass: "prepaid",
        timeBasis: "event_report",
      },
    },
  ),
  entry([balance("sbi-vc-trade", "sbi-vc-cash-balances", ["cash_balance"])], {
    metricId: "exchange.cash-balance",
    measurementKind: "stock",
    subjectKind: "account",
    unitDimension: "currency",
    signMeaning: "asset-positive",
    timeBasis: "point-in-time",
    aggregationRule: "sum-disjoint",
    overlapGroup: null,
    sourceAuthority: "provider-reported",
    legacyBalance: LEGACY_DEPOSIT,
  }),
  entry([balance("sbi-vc-trade", "sbi-vc-cashflows", ["cash_balance_after_cashflow"])], {
    metricId: "exchange.cash-balance-after-cashflow",
    measurementKind: "stock",
    subjectKind: "account",
    unitDimension: "currency",
    signMeaning: "asset-positive",
    timeBasis: "event-reported",
    aggregationRule: "select-one",
    overlapGroup: null,
    sourceAuthority: "provider-reported",
    legacyBalance: LEGACY_DEPOSIT,
  }),
  entry([balance("sbi-securities", "sbi-foreign-cash-balances", ["keep_cash"])], {
    metricId: "broker.foreign-cash-deposit",
    measurementKind: "stock",
    subjectKind: "account",
    unitDimension: "currency",
    signMeaning: "asset-positive",
    timeBasis: "point-in-time",
    aggregationRule: "sum-disjoint",
    overlapGroup: null,
    sourceAuthority: "provider-reported",
    legacyBalance: LEGACY_DEPOSIT,
  }),
  entry(
    [
      balance("sbi-securities", "sbi-foreign-cash-balances", [
        "buy_possible_amount",
        "transfer_possible_amount",
        "remaining_buy_possible_amount",
      ]),
    ],
    {
      metricId: "broker.buying-power",
      measurementKind: "capacity",
      subjectKind: "account",
      unitDimension: "currency",
      signMeaning: "unsigned",
      timeBasis: "point-in-time",
      aggregationRule: "non-additive",
      overlapGroup: "sbi-securities:foreign-cash-vs-capacity",
      sourceAuthority: "provider-reported",
      legacyBalance: LEGACY_CAPACITY,
    },
  ),
  entry([balance("sbi-vc-trade", "sbi-vc-account-margin", ["withdrawal_limit"])], {
    metricId: "exchange.withdrawal-limit",
    measurementKind: "capacity",
    subjectKind: "account",
    unitDimension: "currency",
    signMeaning: "unsigned",
    timeBasis: "point-in-time",
    aggregationRule: "non-additive",
    overlapGroup: "sbi-vc-trade:cash-vs-capacity",
    sourceAuthority: "provider-reported",
    legacyBalance: LEGACY_CAPACITY,
  }),
  entry([transaction("myjcb", "myjcb-credit-ledger", "current-statement-payment")], {
    metricId: "card.statement-line-payment",
    measurementKind: "obligation",
    subjectKind: "statement",
    unitDimension: "currency",
    signMeaning: "provider-sign",
    timeBasis: "statement-month",
    aggregationRule: "non-additive",
    overlapGroup: "myjcb:statement",
    sourceAuthority: "provider-reported",
    legacyActivity: { kind: "statement_item" },
  }),
  entry([transaction("myjcb", "myjcb-credit-ledger", "unconfirmed-usage")], {
    metricId: "card.unconfirmed-usage",
    measurementKind: "flow",
    subjectKind: "statement",
    unitDimension: "currency",
    signMeaning: "provider-sign",
    timeBasis: "event-reported",
    aggregationRule: "non-additive",
    overlapGroup: "myjcb:statement",
    sourceAuthority: "provider-reported",
    legacyActivity: { kind: "statement_item" },
  }),
  entry([transaction("myjcb", "myjcb-credit-ledger")], {
    metricId: "card.statement-line",
    measurementKind: "flow",
    subjectKind: "statement",
    unitDimension: "currency",
    signMeaning: "provider-sign",
    timeBasis: "event-reported",
    aggregationRule: "non-additive",
    overlapGroup: "myjcb:statement",
    sourceAuthority: "provider-reported",
    legacyActivity: { kind: "statement_item" },
  }),
  entry([transaction("sbi-securities", "sbi-yen-detail-history")], {
    metricId: "broker.cash-movement",
    measurementKind: "flow",
    subjectKind: "account",
    unitDimension: "currency",
    signMeaning: "unsigned",
    timeBasis: "event-reported",
    aggregationRule: "domain-specific",
    overlapGroup: null,
    sourceAuthority: "provider-reported",
    legacyActivity: { kind: "cash_movement" },
  }),
  entry(
    [
      transaction("sbi-securities", "sbi-foreign-trade-records"),
      transaction("sbi-securities", "sbi-domestic-trade-records"),
      transaction("sbi-vc-trade", "sbi-vc-executions"),
    ],
    {
      metricId: "trade.execution-amount",
      measurementKind: "flow",
      subjectKind: "position",
      unitDimension: "currency",
      signMeaning: "provider-sign",
      timeBasis: "event-reported",
      aggregationRule: "non-additive",
      overlapGroup: null,
      sourceAuthority: "provider-reported",
      legacyActivity: { kind: "trade" },
    },
  ),
  entry([transaction("v-point-pay", "v-point-pay-notification-event")], {
    metricId: "prepaid.notified-amount",
    measurementKind: "flow",
    subjectKind: "account",
    unitDimension: "currency",
    signMeaning: "provider-sign",
    timeBasis: "event-reported",
    aggregationRule: "non-additive",
    overlapGroup: null,
    sourceAuthority: "provider-reported",
    legacyActivity: { kind: "notification" },
  }),
  entry(
    [
      transaction("vpass", "vpass-statement-page"),
      transaction("global-pass", "global-pass-activity"),
      transaction("sony-bank", "sony-bank-wallet-history"),
    ],
    {
      metricId: "card.activity-amount",
      measurementKind: "flow",
      subjectKind: "account",
      unitDimension: "currency",
      signMeaning: "provider-sign",
      timeBasis: "event-reported",
      aggregationRule: "non-additive",
      overlapGroup: null,
      sourceAuthority: "provider-reported",
      legacyActivity: { kind: "card_activity" },
    },
  ),
  entry(
    [
      transaction("sony-bank", "sony-bank-history-json"),
      transaction("sony-bank", "sony-bank-history-csv"),
      transaction("smbc-bank", "smbc-direct-transactions"),
      transaction("sbi-shinsei-bank", "sbi-shinsei-top-balances-and-activity"),
      transaction("sbi-vc-trade", "sbi-vc-cashflows"),
      transaction("mobile-suica", "mobile-suica-sf-history"),
    ],
    {
      metricId: "account.cash-movement",
      measurementKind: "flow",
      subjectKind: "account",
      unitDimension: "currency",
      signMeaning: "provider-sign",
      timeBasis: "event-reported",
      aggregationRule: "domain-specific",
      overlapGroup: null,
      sourceAuthority: "provider-reported",
      legacyActivity: { kind: "cash_movement" },
    },
  ),
];

function matches(selector: Selector, lookup: MetricLookup): boolean {
  if (selector.family !== lookup.family || selector.sourceId !== lookup.sourceId) return false;
  if (selector.parserName !== lookup.parserName) return false;
  if (selector.metrics && (lookup.metric === null || !selector.metrics.includes(lookup.metric)))
    return false;
  if (
    selector.sourceAccountEquals !== undefined &&
    lookup.sourceAccount !== selector.sourceAccountEquals
  )
    return false;
  if (
    selector.sourceAccountPrefix !== undefined &&
    !(lookup.sourceAccount ?? "").startsWith(selector.sourceAccountPrefix)
  )
    return false;
  if (selector.amountBasis !== undefined && lookup.amountBasis !== selector.amountBasis)
    return false;
  return true;
}

/** First matching registry entry in declaration order; otherwise the explicit unknown definition. */
export function resolveMetric(lookup: MetricLookup): MetricDefinition {
  for (const candidate of METRIC_REGISTRY)
    if (candidate.selectors.some((selector) => matches(selector, lookup)))
      return candidate.definition;
  return UNKNOWN_METRIC;
}

export function metricById(metricId: string): MetricDefinition | null {
  if (metricId === UNKNOWN_METRIC.metricId) return UNKNOWN_METRIC;
  return (
    METRIC_REGISTRY.find((candidate) => candidate.definition.metricId === metricId)?.definition ??
    null
  );
}

export type AdditivityVerdict =
  | { additive: true }
  | {
      additive: false;
      reasonCode:
        | "metric_mismatch"
        | "unit_dimension_mismatch"
        | "not_sum_disjoint"
        | "shared_overlap_group";
    };

/** Whether two measures of the same metric may ever be summed; scope disjointness is checked separately. */
export function additivityVerdict(a: MetricDefinition, b: MetricDefinition): AdditivityVerdict {
  if (a.metricId !== b.metricId) return { additive: false, reasonCode: "metric_mismatch" };
  if (a.unitDimension !== b.unitDimension)
    return { additive: false, reasonCode: "unit_dimension_mismatch" };
  if (a.aggregationRule !== "sum-disjoint" || b.aggregationRule !== "sum-disjoint")
    return { additive: false, reasonCode: "not_sum_disjoint" };
  if (a.overlapGroup !== null && a.overlapGroup === b.overlapGroup)
    return { additive: false, reasonCode: "shared_overlap_group" };
  return { additive: true };
}

export const PRICE_KINDS = [
  "execution",
  "bid",
  "ask",
  "reference",
  "nav",
  "provider-value",
] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/** A price is `quoteAmount` per `baseQuantity` of the base instrument, never a bare number. */
export interface PriceObservation {
  id: string;
  baseInstrumentRef: string;
  baseQuantity: ExactDecimal;
  quoteUnitRef: string;
  quoteAmount: ExactDecimal;
  priceKind: PriceKind;
  effectiveTime: TemporalValue;
  sourceClaimRef: string;
  marketRef: string | null;
  adjustmentPolicyRef: string | null;
}

export function validPriceObservation(value: unknown): value is PriceObservation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "baseInstrumentRef",
      "baseQuantity",
      "quoteUnitRef",
      "quoteAmount",
      "priceKind",
      "effectiveTime",
      "sourceClaimRef",
      "marketRef",
      "adjustmentPolicyRef",
    ]) &&
    isText(value.id, 256) &&
    isText(value.baseInstrumentRef, 256) &&
    validExactDecimal(value.baseQuantity) &&
    !value.baseQuantity.coefficient.startsWith("-") &&
    value.baseQuantity.coefficient !== "0" &&
    isText(value.quoteUnitRef, 128) &&
    validExactDecimal(value.quoteAmount) &&
    isOneOf(PRICE_KINDS)(value.priceKind) &&
    validTemporalValue(value.effectiveTime) &&
    isText(value.sourceClaimRef, 512) &&
    isTextOrNull(value.marketRef, 256) &&
    isTextOrNull(value.adjustmentPolicyRef, 256)
  );
}

/** `quantity × quoteAmount / baseQuantity` in the quote unit; the unit and price basis are checked, not assumed. */
export function valueAtPrice(
  quantity: Quantity,
  price: PriceObservation,
  rounding?: Rounding,
): QuantityResult {
  if (quantity.unitRef !== price.baseInstrumentRef)
    return {
      ok: false,
      error: {
        code: "unit_mismatch",
        message: "price base instrument differs from the quantity unit",
        refs: [quantity.unitRef, price.baseInstrumentRef],
      },
    };
  if (quantity.value.status !== "exact")
    return {
      ok: false,
      error: {
        code: "value_not_exact",
        message: "only exact quantities are valued",
        refs: [`${quantity.value.status}:${quantity.value.reasonCode}`],
      },
    };
  const scaled = multiplyByRatio(
    quantity.value.value,
    {
      numerator: (
        BigInt(price.quoteAmount.coefficient) *
        10n ** BigInt(price.baseQuantity.scale)
      ).toString(),
      denominator: (
        BigInt(price.baseQuantity.coefficient) *
        10n ** BigInt(price.quoteAmount.scale)
      ).toString(),
    },
    rounding,
  );
  if (!scaled.ok) return scaled;
  return { ok: true, quantity: exactQuantity(price.quoteUnitRef, scaled.value) };
}

export function validProviderMetric(value: unknown): value is ProviderMetric {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["family", "sourceId", "parserName", "metric"]) &&
    isOneOf(CLAIM_FAMILIES)(value.family) &&
    isText(value.sourceId, 128) &&
    isTextOrNull(value.parserName, 128) &&
    isTextOrNull(value.metric, 128)
  );
}

export function validMetricDefinition(value: unknown): value is MetricDefinition {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "metricId",
      "providerMetric",
      "measurementKind",
      "subjectKind",
      "unitDimension",
      "signMeaning",
      "timeBasis",
      "aggregationRule",
      "overlapGroup",
      "sourceAuthority",
      "definitionRelease",
      "netAssetEligible",
      "legacyBalance",
      "legacyActivity",
    ]) &&
    isText(value.metricId, 128) &&
    (value.providerMetric === null || validProviderMetric(value.providerMetric)) &&
    isOneOf(MEASUREMENT_KINDS)(value.measurementKind) &&
    isOneOf(SUBJECT_KINDS)(value.subjectKind) &&
    isOneOf(UNIT_DIMENSIONS)(value.unitDimension) &&
    isOneOf(SIGN_MEANINGS)(value.signMeaning) &&
    isOneOf(TIME_BASES)(value.timeBasis) &&
    isOneOf(AGGREGATION_RULES)(value.aggregationRule) &&
    isTextOrNull(value.overlapGroup, 128) &&
    isOneOf(SOURCE_AUTHORITIES)(value.sourceAuthority) &&
    isText(value.definitionRelease, 64) &&
    value.netAssetEligible === false &&
    (value.legacyBalance === null || validLegacyBalance(value.legacyBalance)) &&
    (value.legacyActivity === null || validLegacyActivity(value.legacyActivity))
  );
}

function validLegacyBalance(value: unknown): value is LegacyBalanceSemantic {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "measurementKind", "assetClass", "timeBasis"]) &&
    isOneOf(["asset", "liability", "statement", "aggregate", "period_total", "other"] as const)(
      value.kind,
    ) &&
    isOneOf([
      "balance",
      "aggregate_balance",
      "period_total",
      "statement_amount",
      "capacity",
      "unknown",
    ] as const)(value.measurementKind) &&
    isOneOf(["cash", "prepaid", "reward", "mixed", "unknown"] as const)(value.assetClass) &&
    isOneOf([
      "reported_snapshot",
      "event_report",
      "previous_calendar_month",
      "statement_month",
      "unknown",
    ] as const)(value.timeBasis)
  );
}

function validLegacyActivity(value: unknown): value is LegacyActivitySemantic {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind"]) &&
    isOneOf([
      "cash_movement",
      "card_activity",
      "statement_item",
      "trade",
      "notification",
      "unknown",
    ] as const)(value.kind)
  );
}
