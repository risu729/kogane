// Pure reward conversion arithmetic and bounded route traversal.
// Contracts remain exported from rewards.ts for existing callers.
import type { ConversionOffer, ConversionPlan, MembershipState } from "./rewards.ts";
import { CONVERSION_SEARCH_RELEASE, REWARD_POLICY_RELEASE } from "./reward-releases.ts";
import {
  civilFromDays,
  daysFromCivil,
  formatLocalDate,
  parseLocalDate,
  type CivilDate,
  type TemporalValue,
} from "./time.ts";
import {
  compareDecimals,
  divideDecimals,
  exactQuantity,
  integerDecimal,
  multiplyByRatio,
  multiplyDecimals,
  subtractDecimals,
  type Quantity,
} from "./values.ts";

function infeasible(
  offer: ConversionOffer,
  eligible: Quantity,
  fees: readonly Quantity[],
  reasonCodes: string[],
): ConversionPlan {
  const zero = exactQuantity(offer.fromUnitRef, integerDecimal(0));
  return {
    offerRef: `${offer.offerId}@${offer.version}`,
    offerVersion: offer.version,
    use: zero,
    receive: exactQuantity(offer.toUnitRef, integerDecimal(0)),
    remainder: eligible.value.status === "exact" ? eligible : zero,
    fees: [...fees],
    feasible: false,
    reasonCodes,
    basis: "policy-estimated",
    conditionRefs: conditionRefs(offer),
    release: REWARD_POLICY_RELEASE,
  };
}

function conditionRefs(offer: ConversionOffer): string[] {
  return [
    offer.eligibilityPolicyRef,
    offer.processingPolicyRef,
    offer.roundingPolicyRef,
    ...(offer.cancellationPolicyRef ? [offer.cancellationPolicyRef] : []),
    ...(offer.variableFeePolicyRef ? [offer.variableFeePolicyRef] : []),
  ];
}

/**
 * One offer applied to an eligible quantity: cap first, then whole increments,
 * then the minimum. The received amount is `use × ratio` under the offer's own
 * rounding, never `eligible × ratio`: SC14's 2,500 at 1:2 yields 1,000 from
 * 2,000 used, not 1,250. The plan is an estimate; the fees and the conditions
 * that still need checking travel with it.
 */
export function simulateConversion(
  offer: ConversionOffer,
  eligibleQuantity: Quantity,
  fees: readonly Quantity[] = offer.fixedFees,
): ConversionPlan {
  if (eligibleQuantity.unitRef !== offer.fromUnitRef)
    return infeasible(offer, eligibleQuantity, fees, ["unit_mismatch"]);
  if (eligibleQuantity.value.status !== "exact")
    return infeasible(offer, eligibleQuantity, fees, ["quantity_not_exact"]);
  const reasonCodes: string[] = [];
  if (offer.verification !== "verified") reasonCodes.push("offer_not_verified");
  const balance = eligibleQuantity.value.value;
  let capped = balance;
  if (offer.maximumPerRequest && compareDecimals(capped, offer.maximumPerRequest) > 0) {
    capped = offer.maximumPerRequest;
    reasonCodes.push("capped_by_maximum");
  }
  // Whole increments only: `down` truncates towards zero, so a partial step is
  // never rounded up into a quantity the member does not hold.
  const steps = divideDecimals(capped, offer.increment, { scale: 0, mode: "down" });
  if (!steps.ok)
    return infeasible(offer, eligibleQuantity, fees, [...reasonCodes, steps.error.code]);
  const use = multiplyDecimals(steps.value, offer.increment);
  if (compareDecimals(use, capped) < 0) reasonCodes.push("rounded_down_to_increment");
  if (compareDecimals(use, offer.minimum) < 0)
    return infeasible(offer, eligibleQuantity, fees, [...reasonCodes, "below_minimum"]);
  const received = multiplyByRatio(use, offer.ratio, offer.rounding);
  if (!received.ok)
    return infeasible(offer, eligibleQuantity, fees, [...reasonCodes, "invalid_ratio"]);
  // An application is not a credit: the destination quantity is what the plan
  // predicts, and only a later observation makes it a holding.
  reasonCodes.push("credit_is_not_the_application");
  return {
    offerRef: `${offer.offerId}@${offer.version}`,
    offerVersion: offer.version,
    use: exactQuantity(offer.fromUnitRef, use),
    receive: exactQuantity(offer.toUnitRef, received.value),
    remainder: exactQuantity(offer.fromUnitRef, subtractDecimals(balance, use)),
    fees: [...fees],
    feasible: offer.verification === "verified",
    reasonCodes,
    basis: "policy-estimated",
    conditionRefs: conditionRefs(offer),
    release: REWARD_POLICY_RELEASE,
  };
}

function localDate(value: TemporalValue): CivilDate | null {
  if (value.kind === "local-date") return parseLocalDate(value.value);
  if (value.kind === "instant") return parseLocalDate(value.value.slice(0, 10));
  return null;
}

// ── bounded route search ─────────────────────────────────────────────

export interface SearchBudget {
  /** At most this many hops in one plan; the first implementation compares 1-2. */
  maxDepth: number;
  /** At most this many candidate plans are kept; the search stops when exceeded. */
  maxCandidates: number;
  /** Offers examined; the search stops when this is exhausted. */
  maxExpansions: number;
  /** Deadline every hop must have completed by, if the caller has one. */
  requiredCompletionBy: TemporalValue | null;
}

export interface ConversionHop {
  offerRef: string;
  plan: ConversionPlan;
  /** Calendar day the application is made and the day the credit is expected. */
  appliedOn: string;
  creditExpectedOn: string;
}

export interface ConversionPath {
  hops: ConversionHop[];
  received: Quantity;
  fees: Quantity[];
  /** Deliberately not called "best": the search is bounded, not exhaustive. */
  optimality: "not-determined";
  reasonCodes: string[];
}

/**
 * A budget cap that left part of the bounded search unexamined: an offer not
 * examined (`max_expansions`) or a candidate or state dropped because the
 * candidate list was full (`max_candidates`). The depth cap is the search's
 * definition, not a stop, and is reported through `budget.maxDepth`.
 */
export const SEARCH_STOPS = ["max_expansions", "max_candidates"] as const;
export type SearchStop = (typeof SEARCH_STOPS)[number];

export interface ConversionSearchResult {
  paths: ConversionPath[];
  /** Always `bounded` while depth and candidate caps apply. */
  searchCoverage: "bounded" | "complete";
  rejected: { offerRef: string; reasonCode: string }[];
  /** Offer examinations used, across every hop; at most `budget.maxExpansions`. */
  expansions: number;
  /**
   * The caps that stopped the search early, in `SEARCH_STOPS` order; empty
   * when every offer was examined at every reachable state within the depth.
   * A non-empty list means "no path" or a short list may be the cap, not the
   * offers.
   */
  stoppedBy: SearchStop[];
  budget: SearchBudget;
  release: string;
}

interface SearchState {
  unitRef: string;
  quantity: Quantity;
  day: number;
  hops: ConversionHop[];
  usedOfferIds: string[];
  usedQuotaRefs: string[];
  fees: Quantity[];
}

function dayNumber(value: TemporalValue): number | null {
  const date = localDate(value);
  return date ? daysFromCivil(date) : null;
}

function dayText(day: number): string {
  return formatLocalDate(civilFromDays(day));
}

/**
 * Bounded search for 1..maxDepth chains of offers from a start quantity to a
 * goal unit. Remaining balance and time are part of the state, so this is not
 * a shortest-path over rates: a hop is only taken if its minimum, increment,
 * cap, rounding, eligibility and deadline all hold at the day it would be
 * applied, and the next hop cannot be applied before the previous credit is
 * expected. Re-using one offer or two offers behind the same quota inside one
 * plan is rejected, as is returning to a unit already visited, so a positive
 * cycle cannot manufacture value. The result is always `bounded`; no path is
 * called optimal. `expansions` and `stoppedBy` say whether a cap, rather than
 * the offers, ended the search.
 */
export function findConversionPaths(
  offers: readonly ConversionOffer[],
  start: { quantity: Quantity; clock: TemporalValue; membership?: readonly MembershipState[] },
  goalUnitRef: string,
  budget: SearchBudget,
): ConversionSearchResult {
  const rejected: ConversionSearchResult["rejected"] = [];
  const paths: ConversionPath[] = [];
  let expansions = 0;
  const startDay = dayNumber(start.clock);
  const requiredBy = budget.requiredCompletionBy ? dayNumber(budget.requiredCompletionBy) : null;
  if (startDay === null)
    return {
      paths,
      searchCoverage: "bounded",
      rejected: [{ offerRef: "-", reasonCode: "clock_not_a_date" }],
      expansions,
      stoppedBy: [],
      budget,
      release: CONVERSION_SEARCH_RELEASE,
    };

  const stops = new Set<SearchStop>();
  const visit = (state: SearchState, visitedUnits: string[]): void => {
    if (state.hops.length >= budget.maxDepth) return;
    if (paths.length >= budget.maxCandidates) {
      stops.add("max_candidates");
      return;
    }
    for (const offer of offers) {
      if (expansions >= budget.maxExpansions) {
        stops.add("max_expansions");
        return;
      }
      expansions += 1;
      const offerRef = `${offer.offerId}@${offer.version}`;
      if (offer.fromUnitRef !== state.unitRef) continue;
      if (state.usedOfferIds.includes(offer.offerId)) {
        rejected.push({ offerRef, reasonCode: "same_offer_reuse" });
        continue;
      }
      if (offer.sharedQuotaRef && state.usedQuotaRefs.includes(offer.sharedQuotaRef)) {
        rejected.push({ offerRef, reasonCode: "shared_quota_reuse" });
        continue;
      }
      if (visitedUnits.includes(offer.toUnitRef)) {
        rejected.push({ offerRef, reasonCode: "cycle_rejected" });
        continue;
      }
      if (offer.verification !== "verified") {
        // Unknown conditions are a separate candidate, never a proven refusal.
        rejected.push({ offerRef, reasonCode: "needs_rule_verification" });
        continue;
      }
      const appliedOn = state.day;
      const deadlineDay =
        offer.applicationDeadline === null ? null : dayNumber(offer.applicationDeadline);
      if (deadlineDay !== null && appliedOn > deadlineDay) {
        rejected.push({
          offerRef,
          reasonCode:
            state.hops.length === 0 ? "application_deadline_passed" : "reuse_before_credit",
        });
        continue;
      }
      const creditOn = appliedOn + offer.processingDays;
      if (requiredBy !== null && creditOn > requiredBy) {
        rejected.push({ offerRef, reasonCode: "completion_after_required_by" });
        continue;
      }
      const plan = simulateConversion(offer, state.quantity, offer.fixedFees);
      if (!plan.feasible) {
        rejected.push({ offerRef, reasonCode: plan.reasonCodes[0] ?? "not_feasible" });
        continue;
      }
      const hop: ConversionHop = {
        offerRef,
        plan,
        appliedOn: dayText(appliedOn),
        creditExpectedOn: dayText(creditOn),
      };
      const next: SearchState = {
        unitRef: offer.toUnitRef,
        quantity: plan.receive,
        day: creditOn,
        hops: [...state.hops, hop],
        usedOfferIds: [...state.usedOfferIds, offer.offerId],
        usedQuotaRefs: offer.sharedQuotaRef
          ? [...state.usedQuotaRefs, offer.sharedQuotaRef]
          : state.usedQuotaRefs,
        fees: [...state.fees, ...plan.fees],
      };
      if (offer.toUnitRef === goalUnitRef) {
        if (paths.length < budget.maxCandidates)
          paths.push({
            hops: next.hops,
            received: next.quantity,
            fees: next.fees,
            optimality: "not-determined",
            reasonCodes: next.hops.flatMap((h) => h.plan.reasonCodes),
          });
        else stops.add("max_candidates");
      }
      visit(next, [...visitedUnits, offer.toUnitRef]);
    }
  };

  visit(
    {
      unitRef: start.quantity.unitRef,
      quantity: start.quantity,
      day: startDay,
      hops: [],
      usedOfferIds: [],
      usedQuotaRefs: [],
      fees: [],
    },
    [start.quantity.unitRef],
  );
  return {
    paths,
    searchCoverage: "bounded",
    rejected,
    expansions,
    stoppedBy: SEARCH_STOPS.filter((stop) => stops.has(stop)),
    budget,
    release: CONVERSION_SEARCH_RELEASE,
  };
}
