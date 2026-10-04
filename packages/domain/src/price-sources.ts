// Which provider claims become price observations, and how (ADR 0020,
// docs/calculation-and-reports.md §1). A price is an observation promoted by a
// rule from this closed list, never a number a reader picks up: the rule names
// the claim it reads, the basis check that must pass on the same provider row,
// and how the price's effective time is chosen.
//
//   fx-sbi-shinsei-board-v1         SBI Shinsei's FX board: `bank_mid_rate` is
//                                   `reference`, `bank_buy_rate` `bid`,
//                                   `bank_sell_rate` `ask`; base the currency,
//                                   quote JPY, per 1 unit. A row is admitted
//                                   by an entry of the manual table
//                                   SBI_SHINSEI_FX_QUOTE_BASIS (currency, tier,
//                                   basis; empty), or else when its currency
//                                   is one the provider's public pages quote
//                                   per 1 unit and its `customerCategory` is
//                                   strictly equal to the stage category the
//                                   same collection run states (ADR 0031).
//   sbi-domestic-current-price-v1   SBI Securities' domestic `current_price`,
//                                   paired with its position and `market_value`
//                                   in the same provider record by the
//                                   POSITION_VALUATIONS_SQL locator rule; per 1
//                                   share, quote JPY.
//   sbi-foreign-stock-price-last-v1 SBI Securities' foreign position
//                                   `$.stockPrice.last`, per 1 share, quote the
//                                   position's `currencyCode`.
//
// A position price is promoted only when quantity × price equals the
// provider's own market value on the same row, exactly: that is what shows the
// price is per 1 share. An execution price is never a valuation price, so no
// rule here reads one. Everything is exact decimal arithmetic; nothing is
// rounded, and a value that does not parse is a refusal, never a zero.
import { canonicalDigest } from "./context.ts";
import type { PriceKind, PriceObservation } from "./metrics.ts";
import { validInstantText, type TemporalValue } from "./time.ts";
import {
  compareDecimals,
  decimalEquals,
  decimalFromString,
  multiplyDecimals,
  type ExactDecimal,
} from "./values.ts";

export const PRICE_RULE_IDS = [
  "fx-sbi-shinsei-board-v1",
  "sbi-domestic-current-price-v1",
  "sbi-foreign-stock-price-last-v1",
] as const;
export type PriceRuleId = (typeof PRICE_RULE_IDS)[number];

export const PRICE_CLAIM_KINDS = ["valuation", "position"] as const;
export type PriceClaimKind = (typeof PRICE_CLAIM_KINDS)[number];

/** The claim kind each rule reads; the promotion lane keeps one cursor per kind. */
export const PRICE_RULE_CLAIM_KIND: Readonly<Record<PriceRuleId, PriceClaimKind>> = {
  "fx-sbi-shinsei-board-v1": "valuation",
  "sbi-domestic-current-price-v1": "valuation",
  "sbi-foreign-stock-price-last-v1": "position",
};

/** What happened to one claim. Only `promoted` writes anything. */
export const PRICE_PROMOTION_OUTCOMES = [
  "promoted",
  "basis_unverified",
  "unsupported_currency",
  "tier_unmatched",
  "stage_unstated",
] as const;
export type PricePromotionOutcome = (typeof PRICE_PROMOTION_OUTCOMES)[number];

/** The FX policy that will value with this board (P2-3); named here so the caveat travels. */
export const FX_POLICY_SBI_SHINSEI_MID = "fx-sbi-shinsei-mid-v1";

/**
 * One admission on the SBI Shinsei board: a currency, the `customerCategory`
 * tier whose rows are read, and the quantity of the currency one rate is
 * quoted for. The board lists a currency once per tier and the payload states
 * neither which tier applies to the owner nor the basis, so each entry needs
 * evidence (an aggregate survey of the stored boards and the owner's
 * confirmation, as ADR 0004 asks), and the rule admits only `"1"`. The tier is
 * matched against the stored row's category exactly as the provider sent it; a
 * row of any other tier, or with none, stays `unsupported_currency`
 * (ADR 0020 amendment, ADR 0028).
 */
export interface FxQuoteBasis {
  customerCategory: string | number;
  baseQuantity: "1" | "100";
  evidence: string;
}
export type FxQuoteBasisTable = Readonly<Record<string, FxQuoteBasis>>;

/**
 * Currencies admitted on the SBI Shinsei board, keyed by currency. Empty: the
 * stored boards' shape is observed (ADR 0028) but nobody has confirmed a quote
 * basis or which `customerCategory` tier applies to the owner, so no FX row is
 * promoted yet (ADR 0020). A currency is added here with its tier, basis and
 * evidence, in a change that amends the ADR.
 */
export const SBI_SHINSEI_FX_QUOTE_BASIS: FxQuoteBasisTable = Object.freeze({});

/**
 * The currencies the provider's public pages quote in yen per 1 unit: the 13
 * its rate page lists, whose fees are stated per 1 base currency unit
 * (https://www.sbishinseibank.co.jp/retail/gaika/exchange_rate_fx.html,
 * https://www.sbishinseibank.co.jp/retail/gaika/feature/beginner/; surveyed
 * 2026-09-27, ADR 0020 amendment, ADR 0031). CHF is on no page and JPY is not
 * a quote, so neither is here. This is the provider's documentation, not a
 * per-currency confirmation by the owner; a board row of one of these
 * currencies is admitted only in the owner's own tier (`fxBoardPrice`).
 */
export const SBI_SHINSEI_FX_PER_UNIT_CURRENCIES: readonly string[] = Object.freeze([
  "USD",
  "EUR",
  "CAD",
  "AUD",
  "GBP",
  "NZD",
  "SGD",
  "HKD",
  "ZAR",
  "NOK",
  "CNY",
  "TRY",
  "BRL",
]);

/**
 * The owner's stage category for one board row: what the balance summary of
 * the row's own collection run states (ADR 0031). `stated` carries the JSON
 * text of the one category the run's published stage observations hold;
 * `absent` means the run has none (no page, no published parse, or a parse
 * that refused the page); `disagreeing` means the run's stage observations
 * name more than one category. Only `stated` can admit a row.
 */
export type FxStageCategory =
  | { state: "stated"; categoryJson: string }
  | { state: "absent" }
  | { state: "disagreeing" };

/** JSON text of a non-empty string or a finite number: the only category a stage match accepts. */
function stageCategoryText(text: string | null): string | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const accepted =
    typeof value === "string" ? value !== "" : typeof value === "number" && Number.isFinite(value);
  return accepted ? JSON.stringify(value) : null;
}

/**
 * Whether a board row's category is strictly the run's stated stage: same JSON
 * type and same value, compared as JSON text, so `"3"` never equals `3` and
 * nothing is trimmed, case-folded or mapped.
 */
export function stageMatches(rowCategoryJson: string | null, stage: FxStageCategory): boolean {
  if (stage.state !== "stated") return false;
  const row = stageCategoryText(rowCategoryJson);
  return row !== null && row === stageCategoryText(stage.categoryJson);
}

/** The claim a price was promoted from: an observation, its parse run and a path inside it. */
export interface PriceClaim {
  claimKind: PriceClaimKind;
  observationId: number;
  parseRunId: number;
  jsonPath: string;
}

/** `valuation_observations/12#$.amount_text`: the stored `source_claim_ref` of a price. */
export function priceClaimRef(claim: PriceClaim): string {
  return `${claim.claimKind}_observations/${claim.observationId}#${claim.jsonPath}`;
}

/** `price_<sha256(rule, claimRef)>`: the same claim under the same rule is the same price. */
export async function priceId(rule: PriceRuleId, claim: PriceClaim): Promise<string> {
  return `price_${await canonicalDigest({ rule, claimRef: priceClaimRef(claim) })}`;
}

/**
 * The provider's own instant when the claim states one; otherwise the fetch
 * instant, marked as the collector's. A provider date is not an instant and is
 * not promoted to one.
 */
export function priceEffectiveTime(
  providerTime: string | null,
  providerZone: string,
  fetchedAt: string,
): TemporalValue {
  if (providerTime !== null && validInstantText(providerTime))
    return { kind: "instant", value: providerTime, zone: providerZone, basis: "provider" };
  return { kind: "instant", value: fetchedAt, zone: "UTC", basis: "collector" };
}

/** A price row before its id: everything `price_observations` stores. */
export type PriceDraft = Omit<PriceObservation, "id">;

export type PriceVerdict =
  | { outcome: "promoted"; rule: PriceRuleId; claim: PriceClaim; price: PriceDraft }
  | {
      outcome: "basis_unverified" | "unsupported_currency" | "tier_unmatched" | "stage_unstated";
      rule: PriceRuleId;
      claim: PriceClaim;
    };

const ONE: ExactDecimal = { coefficient: "1", scale: 0 };
const ZERO: ExactDecimal = { coefficient: "0", scale: 0 };
const CURRENCY = /^[A-Z]{3}$/u;
/** Plain positive decimal text; the stored observations carry exactly this. */
const PLAIN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

/** An exact positive decimal from stored text or a JSON integer, else null. */
export function positiveDecimal(value: unknown): ExactDecimal | null {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
  else return null;
  if (!PLAIN.test(text)) return null;
  const parsed = decimalFromString(text);
  if (!parsed.ok || compareDecimals(parsed.value, ZERO) <= 0) return null;
  return parsed.value;
}

/** Report-job instrument reference: `instrument:<source>:<market>:<code>`. */
export function instrumentRef(sourceId: string, market: string | null, code: string): string {
  return `instrument:${sourceId}:${market ?? "-"}:${code}`;
}

// ---------------------------------------------------------------------------
// FX board
// ---------------------------------------------------------------------------

const FX_KIND: Readonly<Record<string, PriceKind>> = {
  bank_mid_rate: "reference",
  bank_buy_rate: "bid",
  bank_sell_rate: "ask",
};

/** One `sbi-shinsei-exchange-rate` valuation row, as stored. */
export interface FxBoardRow {
  observationId: number;
  parseRunId: number;
  sourceId: string;
  parserName: string;
  sourceAccount: string;
  subject: string;
  metric: string;
  currency: string;
  amountText: string | null;
  asOf: string | null;
  fetchedAt: string;
  /** The row's `customerCategory` as stored in its `extra`, or null when it has none. */
  customerCategory: string | number | null;
  /**
   * The same category as JSON text (`"A"`, `3`), or null when the row has
   * none: the stage match compares types as well as values (ADR 0031).
   * Absent means the stage path finds no match.
   */
  customerCategoryJson?: string | null;
  /** The stage category of the row's own collection run; absent means none. */
  stage?: FxStageCategory;
}

/** Whether a stored valuation row is one this rule reads at all. */
export function isFxBoardRow(
  row: Pick<FxBoardRow, "sourceId" | "parserName" | "sourceAccount" | "metric">,
): boolean {
  return (
    row.sourceId === "sbi-shinsei-bank" &&
    row.parserName === "sbi-shinsei-exchange-rate" &&
    row.sourceAccount === "sbi-shinsei:fx-board" &&
    Object.hasOwn(FX_KIND, row.metric)
  );
}

export function fxBoardPrice(
  row: FxBoardRow,
  quoteBasis: FxQuoteBasisTable = SBI_SHINSEI_FX_QUOTE_BASIS,
): PriceVerdict {
  const rule: PriceRuleId = "fx-sbi-shinsei-board-v1";
  const claim: PriceClaim = {
    claimKind: "valuation",
    observationId: row.observationId,
    parseRunId: row.parseRunId,
    jsonPath: "$.amount_text",
  };
  const kind = FX_KIND[row.metric];
  if (!isFxBoardRow(row) || kind === undefined) return { outcome: "basis_unverified", rule, claim };
  if (!CURRENCY.test(row.subject) || row.subject === "JPY" || row.currency !== "JPY")
    return { outcome: "unsupported_currency", rule, claim };
  const basis = Object.hasOwn(quoteBasis, row.subject) ? quoteBasis[row.subject] : undefined;
  if (basis !== undefined) {
    // The manual table decides its currency alone (ADR 0020 amendment). The
    // board lists the currency once per tier; only the admitted tier's rows
    // are read, so the rule itself never picks a tier.
    if (row.customerCategory !== basis.customerCategory)
      return { outcome: "unsupported_currency", rule, claim };
    // A per-100 quote (or any basis but 1) is refused; nothing is ever rescaled.
    if (basis.baseQuantity !== "1") return { outcome: "basis_unverified", rule, claim };
  } else if (!SBI_SHINSEI_FX_PER_UNIT_CURRENCIES.includes(row.subject)) {
    return { outcome: "unsupported_currency", rule, claim };
  } else if ((row.stage ?? { state: "absent" }).state !== "stated") {
    // ADR 0031: the row's own run states no stage (no page, no published
    // parse, a refused page) or more than one. The owner's tier is unknown
    // for this run, so nothing is picked: no other run, no default tier.
    return { outcome: "stage_unstated", rule, claim };
  } else if (!stageMatches(row.customerCategoryJson ?? null, row.stage!)) {
    // Another tier's row, or a row with no category. A currency listed only
    // once, in a tier that is not the owner's, is not the owner's rate either.
    return { outcome: "tier_unmatched", rule, claim };
  }
  const rate = positiveDecimal(row.amountText);
  if (rate === null) return { outcome: "basis_unverified", rule, claim };
  return {
    outcome: "promoted",
    rule,
    claim,
    price: {
      baseInstrumentRef: row.subject,
      baseQuantity: ONE,
      quoteUnitRef: "JPY",
      quoteAmount: rate,
      priceKind: kind,
      effectiveTime: priceEffectiveTime(row.asOf, "Asia/Tokyo", row.fetchedAt),
      sourceClaimRef: priceClaimRef(claim),
      marketRef: null,
      adjustmentPolicyRef: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Positions: quantity × price must equal the provider's market value
// ---------------------------------------------------------------------------

/** quantity × price = market value, exactly: the price is per 1 share. */
export function perShareBasisHolds(
  quantity: ExactDecimal,
  price: ExactDecimal,
  marketValue: ExactDecimal,
): boolean {
  return decimalEquals(multiplyDecimals(quantity, price), marketValue);
}

/**
 * The payload byte offset of an `sbi-domestic-cash-positions` locator
 * (`mts-shift-jis:payload-byte=<n>,width=<w>`), or null.
 */
export function domesticRecordOffset(locator: string): number | null {
  const match = /^mts-shift-jis:payload-byte=(\d+),width=\d+$/u.exec(locator);
  if (!match) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : null;
}

/** Width of one domestic MTS record: a valuation belongs to the position whose record holds it. */
export const DOMESTIC_RECORD_BYTES = 423;

/** Whether a valuation locator falls inside a position's record (POSITION_VALUATIONS_SQL's rule). */
export function inDomesticRecord(positionLocator: string, valuationLocator: string): boolean {
  const start = domesticRecordOffset(positionLocator);
  const at = domesticRecordOffset(valuationLocator);
  return start !== null && at !== null && at >= start && at <= start + DOMESTIC_RECORD_BYTES - 1;
}

/**
 * One domestic `current_price` valuation and what the same provider record
 * holds: the positions and `market_value` rows that the locator rule pairs
 * with it. More or fewer than exactly one of each is a refusal.
 */
export interface DomesticPriceRow {
  observationId: number;
  parseRunId: number;
  sourceId: string;
  parserName: string;
  metric: string;
  securityCode: string;
  priceText: string | null;
  priceCurrency: string;
  asOf: string | null;
  fetchedAt: string;
  positions: { market: string | null; quantityText: string; asOf: string | null }[];
  marketValues: { amountText: string | null; currency: string }[];
}

export function isDomesticPriceRow(
  row: Pick<DomesticPriceRow, "sourceId" | "parserName" | "metric">,
): boolean {
  return (
    row.sourceId === "sbi-securities" &&
    row.parserName === "sbi-domestic-cash-positions" &&
    row.metric === "current_price"
  );
}

export function domesticCurrentPrice(row: DomesticPriceRow): PriceVerdict {
  const rule: PriceRuleId = "sbi-domestic-current-price-v1";
  const claim: PriceClaim = {
    claimKind: "valuation",
    observationId: row.observationId,
    parseRunId: row.parseRunId,
    jsonPath: "$.amount_text",
  };
  if (!isDomesticPriceRow(row)) return { outcome: "basis_unverified", rule, claim };
  if (row.priceCurrency !== "JPY") return { outcome: "unsupported_currency", rule, claim };
  if (row.positions.length !== 1 || row.marketValues.length !== 1)
    return { outcome: "basis_unverified", rule, claim };
  const position = row.positions[0]!;
  const marketValue = row.marketValues[0]!;
  if (marketValue.currency !== "JPY") return { outcome: "unsupported_currency", rule, claim };
  const quantity = positiveDecimal(position.quantityText);
  const price = positiveDecimal(row.priceText);
  const value = positiveDecimal(marketValue.amountText);
  if (
    quantity === null ||
    price === null ||
    value === null ||
    !perShareBasisHolds(quantity, price, value)
  )
    return { outcome: "basis_unverified", rule, claim };
  return {
    outcome: "promoted",
    rule,
    claim,
    price: {
      baseInstrumentRef: instrumentRef(row.sourceId, position.market, row.securityCode),
      baseQuantity: ONE,
      quoteUnitRef: "JPY",
      quoteAmount: price,
      priceKind: "reference",
      effectiveTime: priceEffectiveTime(row.asOf ?? position.asOf, "Asia/Tokyo", row.fetchedAt),
      sourceClaimRef: priceClaimRef(claim),
      marketRef: position.market,
      adjustmentPolicyRef: null,
    },
  };
}

/** One `sbi-foreign-cash-positions` position row, as stored, with its provider element. */
export interface ForeignPositionRow {
  observationId: number;
  parseRunId: number;
  sourceId: string;
  parserName: string;
  securityCode: string;
  market: string | null;
  quantityText: string;
  currency: string | null;
  asOf: string | null;
  fetchedAt: string;
  extra: unknown;
}

export function isForeignPositionRow(
  row: Pick<ForeignPositionRow, "sourceId" | "parserName">,
): boolean {
  return row.sourceId === "sbi-securities" && row.parserName === "sbi-foreign-cash-positions";
}

function field(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}

export function foreignStockPrice(row: ForeignPositionRow): PriceVerdict {
  const rule: PriceRuleId = "sbi-foreign-stock-price-last-v1";
  const claim: PriceClaim = {
    claimKind: "position",
    observationId: row.observationId,
    parseRunId: row.parseRunId,
    jsonPath: "$.stockPrice.last",
  };
  if (!isForeignPositionRow(row) || row.securityCode === "")
    return { outcome: "basis_unverified", rule, claim };
  const currency = row.currency;
  if (
    currency === null ||
    !CURRENCY.test(currency) ||
    field(row.extra, ["currencyCode"]) !== currency
  )
    return { outcome: "unsupported_currency", rule, claim };
  const quantity = positiveDecimal(row.quantityText);
  const price = positiveDecimal(field(row.extra, ["stockPrice", "last"]));
  const value = positiveDecimal(field(row.extra, ["evaluationProfitLoss", "frnEvaluationAmount"]));
  if (
    quantity === null ||
    price === null ||
    value === null ||
    !perShareBasisHolds(quantity, price, value)
  )
    return { outcome: "basis_unverified", rule, claim };
  return {
    outcome: "promoted",
    rule,
    claim,
    price: {
      baseInstrumentRef: instrumentRef(row.sourceId, row.market, row.securityCode),
      baseQuantity: ONE,
      quoteUnitRef: currency,
      quoteAmount: price,
      priceKind: "reference",
      effectiveTime: priceEffectiveTime(row.asOf, "UTC", row.fetchedAt),
      sourceClaimRef: priceClaimRef(claim),
      marketRef: row.market,
      adjustmentPolicyRef: null,
    },
  };
}
