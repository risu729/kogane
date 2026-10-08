// Prices and FX rates at an as-of, under policies the caller names (ADR 0056,
// docs/calculation-and-reports.md §1–§2). One bounded candidate read
// (`selectPriceCandidates`), then the domain's `selectPrice` per key, then the
// selection manifest and its digest. It never writes, never fetches a price,
// never converts anything and has no default policy (and refuses a proposed
// one, whose id starts with `proposal:`): a caller passes the
// price policy, the FX conversion policy and any calendars, and the manifest
// records each by digest, so the same inputs give the same context id and a
// new price or a changed policy gives a new one (INV04, INV09).
import { canonicalDigest, canonicalJson } from "../../../domain/src/context.ts";
import { isOneOf, isText } from "../../../domain/src/guards.ts";
import {
  PROPOSAL_POLICY_PREFIX,
  selectFxRate,
  selectionManifest,
  selectionReadWindow,
  selectPrice,
  validFxConversionPolicy,
  validMarketCalendar,
  validPriceSelectionPolicy,
  validSelectionBound,
  fxKey,
  type FxConversionPolicy,
  type MarketCalendar,
  type PriceKey,
  type PriceSelection,
  type PriceSelectionPolicy,
  type SelectionBound,
  type SelectionManifest,
} from "../../../domain/src/market-data.ts";
import { PRICE_KINDS } from "../../../domain/src/metrics.ts";
import {
  PRICE_SELECTION_BOUND,
  selectPriceCandidates,
  type PriceCandidateWant,
} from "../../../read-model/src/price-selection.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

/** A request or a policy that cannot be applied is refused (400), never repaired. */
export class MarketDataRequestError extends Error {
  readonly code: "invalid_request" | "invalid_policy";
  constructor(code: MarketDataRequestError["code"]) {
    super(code);
    this.name = "MarketDataRequestError";
    this.code = code;
  }
}

export interface MarketDataRequest {
  bound: SelectionBound;
  /**
   * Instrument prices to select. Under a `same-snapshot` price policy each
   * names the parse run of the holding's own snapshot; otherwise none does.
   */
  prices: readonly { key: PriceKey; snapshotParseRunId: number | null }[];
  /**
   * Currencies whose rate against the FX policy's pivot is selected; one no
   * admitted rule quotes is answered `unsupported_pair` without a read.
   */
  fxCurrencies: readonly string[];
}

export interface MarketDataPolicies {
  price: PriceSelectionPolicy;
  fx: FxConversionPolicy;
  /** Calendars a business-day freshness rule may name; none is shipped. */
  calendars: readonly MarketCalendar[];
}

export interface MarketDataSelection {
  /** One selection per requested price, in request order. */
  prices: PriceSelection[];
  /** One selection per requested currency, in request order. */
  fx: PriceSelection[];
  manifest: SelectionManifest;
  /** `canonicalDigest(manifest)`. */
  contextId: string;
}

const CURRENCY = /^[A-Z]{3}$/u;

function calendarFor(
  policy: PriceSelectionPolicy,
  calendars: readonly MarketCalendar[],
): MarketCalendar | null {
  if (policy.freshness.unit !== "business-days") return null;
  const ref = policy.freshness.calendarRef;
  return calendars.find((calendar) => calendar.calendarRef === ref) ?? null;
}

/** Two different policies under one id would be indistinguishable in a selection. */
function idsAreUnambiguous(
  policies: readonly (PriceSelectionPolicy | FxConversionPolicy)[],
): boolean {
  const seen = new Map<string, string>();
  for (const policy of policies) {
    const text = canonicalJson(policy);
    const earlier = seen.get(policy.policyId);
    if (earlier !== undefined && earlier !== text) return false;
    seen.set(policy.policyId, text);
  }
  return true;
}

export async function selectMarketData(
  sql: SqlExecutor,
  request: MarketDataRequest,
  policies: MarketDataPolicies,
): Promise<MarketDataSelection> {
  if (
    !validPriceSelectionPolicy(policies.price) ||
    !validFxConversionPolicy(policies.fx) ||
    policies.fx.selection.candidateScope !== "latest-in-window" ||
    !idsAreUnambiguous([policies.price, policies.fx.selection, policies.fx]) ||
    // A proposal is a recommendation, not a decision (ADR 0056).
    [policies.price, policies.fx.selection, policies.fx].some((policy) =>
      policy.policyId.startsWith(PROPOSAL_POLICY_PREFIX),
    ) ||
    !policies.calendars.every(validMarketCalendar) ||
    new Set(policies.calendars.map((calendar) => calendar.calendarRef)).size !==
      policies.calendars.length
  )
    throw new MarketDataRequestError("invalid_policy");
  const sameSnapshot = policies.price.candidateScope === "same-snapshot";
  // Currencies no admitted rule quotes are answered without a read.
  const quoted = request.fxCurrencies.filter((code) => policies.fx.currencies.includes(code));
  if (
    !validSelectionBound(request.bound) ||
    !request.prices.every(
      (entry) =>
        isText(entry.key.baseInstrumentRef, 256) &&
        isText(entry.key.quoteUnitRef, 128) &&
        isOneOf(PRICE_KINDS)(entry.key.priceKind) &&
        (sameSnapshot
          ? Number.isSafeInteger(entry.snapshotParseRunId)
          : entry.snapshotParseRunId === null),
    ) ||
    !request.fxCurrencies.every((code) => CURRENCY.test(code) && code !== policies.fx.pivot) ||
    new Set(request.fxCurrencies).size !== request.fxCurrencies.length ||
    request.prices.length + quoted.length > PRICE_SELECTION_BOUND
  )
    throw new MarketDataRequestError("invalid_request");

  const bound = request.bound;
  const priceCalendar = calendarFor(policies.price, policies.calendars);
  const fxCalendar = calendarFor(policies.fx.selection, policies.calendars);
  const priceWindow = selectionReadWindow(policies.price, bound, priceCalendar);
  const fxWindow = selectionReadWindow(policies.fx.selection, bound, fxCalendar);
  const fxKeys = quoted.map((code) => fxKey(code, policies.fx));
  const wants: PriceCandidateWant[] = [
    ...request.prices.map((entry) => ({
      key: entry.key,
      snapshotParseRunId: entry.snapshotParseRunId,
      window: priceWindow,
    })),
    ...fxKeys.map((key) => ({ key, snapshotParseRunId: null, window: fxWindow })),
  ];
  const read = await selectPriceCandidates(sql, { wants, knowledge: bound.knowledge });
  const candidatesOf = (index: number) => read[index]!.map((row) => row.candidate);

  const prices = request.prices.map((entry, index) =>
    selectPrice(entry.key, candidatesOf(index), bound, policies.price, priceCalendar),
  );
  const fx = request.fxCurrencies.map((code) => {
    const index = quoted.indexOf(code);
    return selectFxRate(
      code,
      index < 0 ? [] : candidatesOf(request.prices.length + index),
      bound,
      policies.fx,
      fxCalendar,
    );
  });
  const calendars = [priceCalendar, fxCalendar].filter(
    (calendar): calendar is MarketCalendar => calendar !== null,
  );
  const manifest = await selectionManifest({
    policies: [policies.price, policies.fx.selection, policies.fx],
    calendars,
    bound,
    selections: [...prices, ...fx],
  });
  return { prices, fx, manifest, contextId: await canonicalDigest(manifest) };
}
