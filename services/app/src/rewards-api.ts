// Reward programme reads and a pure conversion simulation (A11).
//
// Everything under /api/v2/rewards is GET-only, behind the `rewardsV2`
// capability, and off by default. The simulation route in particular is a
// query: it takes an offer, a quantity and a goal and returns a plan. It
// writes nothing, contacts no provider and performs no exchange. There is no
// command route here and no route that would create one.
//
// Every quantity is reported in the programme's own unit. No reward quantity
// is converted into an asset subtotal, and a value estimate only appears when
// the caller named an offer (addendum 08 §7).
import {
  availableForOffer,
  estimateExpiry,
  findConversionPaths,
  cashLikeRedemptionEstimate,
  simulateConversion,
  summarizeHolding,
  REWARD_POLICY_RELEASE,
  CONVERSION_SEARCH_RELEASE,
  type ActivityHistory,
  type ConversionOffer,
  type ExpiryEstimate,
  type MembershipState,
  type Quantity,
  type RewardBucket,
} from "../../../packages/domain/src/index.ts";
import {
  createRewardReader,
  REWARD_PAGE_LIMIT,
  UNCLASSIFIED_REWARD_HISTORY,
  type Page,
  type RewardHoldingView,
} from "../../../packages/read-model/src/index";
import { d1Executor } from "../../../packages/read-model/src/d1";
import {
  CENTRAL_STORE_CAPABILITIES,
  isRewardPath,
  rewardQueryParameters,
} from "../../../packages/observation-shared/src/api-schema";
import { rewardsV2Enabled } from "./capabilities";
import {
  rewardExpiryFromRead,
  rewardReadContext,
  rewardReadFlagOn,
  rewardSimulationsFromRead,
} from "./rewards-read";
import { HttpError, json } from "./http";

export const REWARDS_PREFIX = "/api/v2/rewards";

/**
 * The reward activity history a real V Point holding has today: none that can
 * be classified (docs/sources/v-point.md §4.2, SC12). It lives in
 * `packages/read-model` since U16, because the READ build has to evaluate the
 * rules under exactly the same history this route does.
 */
const UNCLASSIFIED_HISTORY: ActivityHistory = UNCLASSIFIED_REWARD_HISTORY;

interface BucketDto {
  bucketRef: string;
  kind: string;
  restrictionRefs: string[];
  unitRef: string;
  quantity: Quantity;
  /** Exactly what the provider displayed, or null when it displayed nothing. */
  observedExpiry: unknown;
  observedAt: unknown;
  sourceFactRefs: string[];
}

function bucketDto(bucket: RewardBucket): BucketDto {
  return {
    bucketRef: bucket.bucketRef,
    kind: bucket.kind,
    restrictionRefs: bucket.restrictionRefs,
    unitRef: bucket.quantity.unitRef,
    quantity: bucket.quantity,
    observedExpiry: bucket.observedExpiry,
    observedAt: bucket.observedAt,
    sourceFactRefs: bucket.sourceFactRefs,
  };
}

function holdingDto(view: RewardHoldingView, membership: readonly MembershipState[]) {
  const summary = summarizeHolding(view.holding, view.qualification);
  return {
    programId: view.program.programId,
    programRef: view.program.programRef,
    institutionRef: view.program.institutionRef,
    sourceId: view.sourceId,
    holdingRef: view.holding.holdingRef,
    holdingKind: view.holdingKind,
    unitRef: view.holding.unitRef,
    termsEvidenceRefs: view.program.termsEvidenceRefs,
    // The consumable quantity is in the programme's own unit and is never a
    // yen figure, even for a prepaid balance whose unit happens to be JPY.
    consumable: summary.consumable,
    byKind: summary.byKind,
    excluded: summary.excluded,
    buckets: view.holding.buckets.map(bucketDto),
    qualificationMeasures: view.qualification.map((measure) => ({
      measureRef: measure.measureRef,
      metricRef: measure.metricRef,
      quantity: measure.quantity,
      period: measure.period,
      consumable: measure.consumable,
    })),
    membership: membership
      .filter((state) => state.holdingRef === view.holding.holdingRef)
      .map((state) => ({
        tier: state.tier,
        valid: state.valid,
        source: state.source,
        evidenceRefs: state.evidenceRefs,
      })),
    valueModel: {
      // No reward quantity joins an asset subtotal; a cash-like estimate needs
      // a named offer, which this route deliberately does not choose.
      netAssetEligible: false,
      cashLikeRedemptionEstimate: null,
      reasonCode: "no_offer_named",
    },
    release: REWARD_POLICY_RELEASE,
  };
}

interface ExpiryDto {
  holdingRef: string;
  programId: string;
  ruleRef: string;
  family: string;
  verification: string;
  state: ExpiryEstimate["state"];
  uncertaintyCodes: string[];
  deadlineZone: string;
  deadlineZoneBasis: string;
  rows: {
    bucketRef: string;
    quantity: Quantity;
    deadline: unknown;
    basis: string;
    providerObserved: unknown;
    policyEstimated: unknown;
    reasonCodes: string[];
  }[];
  sourceExpiryRefs: string[];
  release: string;
}

function offsetOf(url: URL): number {
  const text = url.searchParams.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  return offset;
}

const QUANTITY = /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/u;

function reference(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (!REFERENCE.test(value)) throw new HttpError(400, "invalid_query");
  return value;
}

function pageEnvelope<T, U>(source: Page<T>, map: (row: T) => U): Page<U> {
  return { rows: source.rows.map(map), coverage: source.coverage };
}

/**
 * Call only after the Access gate and the read-only method check. Returns null
 * when the path is not a reward route, so the caller falls through.
 */
export async function rewardsApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path !== REWARDS_PREFIX && !path.startsWith(`${REWARDS_PREFIX}/`)) return null;
  // An unadvertised capability is a missing route, not a forbidden one: the
  // deployment simply does not serve rewards. The same flag decides this and
  // what /api/meta advertises (src/capabilities.ts).
  const capabilities = { ...CENTRAL_STORE_CAPABILITIES, rewardsV2: rewardsV2Enabled(env) };
  if (!capabilities.rewardsV2) throw new HttpError(404, "not_found");
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!isRewardPath(path)) throw new HttpError(404, "not_found");
  const allowed = rewardQueryParameters(path, capabilities);
  for (const key of url.searchParams.keys()) {
    const value = url.searchParams.get(key)!;
    if (
      !allowed.includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      // A cursor is an opaque encoding of the snapshot, the instance and the
      // position (U16), so it is longer than a reference; everything else
      // keeps the reference-sized bound.
      value.length > (key === "cursor" ? 512 : 128) ||
      /[\u0000-\u001f]/u.test(value)
    )
      throw new HttpError(400, "invalid_query");
  }
  const reader = createRewardReader(d1Executor(env.DB));
  const program = reference(url, "program");

  if (path === `${REWARDS_PREFIX}/holdings`) {
    const membership = await reader.membership(program);
    const holdings = await reader.holdings({
      ...(program === undefined ? {} : { programId: program }),
      offset: offsetOf(url),
    });
    return json({
      ...pageEnvelope(holdings, (view) => holdingDto(view, membership)),
      interpretation: {
        release: REWARD_POLICY_RELEASE,
        basis: "provider-observed",
        note: "quantities are reported in each programme's own unit",
      },
    });
  }

  // U16: with a reward snapshot published, the deadlines come from it —
  // every row carrying the instant it was evaluated at — instead of being
  // recomputed from "now" on each request (04 §2, G2-19).
  if (path === `${REWARDS_PREFIX}/expiry` || path === `${REWARDS_PREFIX}/simulations`) {
    const context = rewardReadFlagOn(env) ? await rewardReadContext(env) : null;
    if (context !== null && !("unavailable" in context)) {
      return path === `${REWARDS_PREFIX}/expiry`
        ? await rewardExpiryFromRead(context, url, program)
        : await rewardSimulationsFromRead(context, url);
    }
    // A saved simulation exists only inside a snapshot: without one there is
    // nothing to report, and "being rebuilt" is never an empty success.
    if (path === `${REWARDS_PREFIX}/simulations`)
      throw new HttpError(503, context?.unavailable ?? "reward_read_model_unavailable");
    if (context !== null) throw new HttpError(503, context.unavailable);
    // Without the read model a cursor names a snapshot this deployment does
    // not have; it is refused rather than reinterpreted as an offset.
    if (url.searchParams.get("cursor") !== null) throw new HttpError(400, "cursor_unsupported");
  }

  if (path === `${REWARDS_PREFIX}/expiry`) {
    const offset = offsetOf(url);
    const rules = await reader.expiryRules(program);
    const membership = await reader.membership(program);
    const holdings = await reader.holdings({
      ...(program === undefined ? {} : { programId: program }),
      offset,
    });
    const now = new Date().toISOString().slice(0, 10);
    const clock = {
      kind: "local-date" as const,
      value: now,
      zone: null,
      basis: "derived" as const,
    };
    const rows: ExpiryDto[] = [];
    for (const view of holdings.rows) {
      const applicable = rules.filter((rule) => rule.programId === view.program.programId);
      for (const rule of applicable) {
        const estimate = estimateExpiry(
          rule,
          view.holding,
          UNCLASSIFIED_HISTORY,
          membership,
          clock,
          `context:rewards:${REWARD_POLICY_RELEASE}`,
        );
        rows.push({
          holdingRef: estimate.holdingRef,
          programId: view.program.programId,
          ruleRef: estimate.ruleRef,
          family: rule.family,
          verification: rule.verification,
          state: estimate.state,
          uncertaintyCodes: estimate.uncertaintyCodes,
          deadlineZone: rule.deadlineCalendar.zone,
          deadlineZoneBasis: rule.deadlineCalendar.zoneBasis,
          // Every bucket keeps a row, including one with no confirmed
          // deadline: a deadline-ordered list never drops the unknowns.
          rows: estimate.expiringBuckets,
          sourceExpiryRefs: estimate.sourceExpiryRefs,
          release: estimate.release,
        });
      }
    }
    return json({
      rows,
      coverage: holdings.coverage,
      interpretation: { release: REWARD_POLICY_RELEASE, limit: REWARD_PAGE_LIMIT },
    });
  }

  // /offers/simulate — a pure query. No exchange is performed anywhere in this
  // service; the response is a plan plus the conditions that still need
  // checking (addendum 08 §6).
  const offerId = reference(url, "offer");
  const quantityText = url.searchParams.get("quantity");
  const unitRef = reference(url, "unit");
  const goal = reference(url, "goal");
  const depthText = url.searchParams.get("depth");
  if (!offerId && !goal) throw new HttpError(400, "invalid_query");
  if (quantityText === null || !QUANTITY.test(quantityText))
    throw new HttpError(400, "invalid_quantity");
  const depth = depthText === null ? 2 : Number(depthText);
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 2)
    throw new HttpError(400, "invalid_query");
  const offers = await reader.offers({ ...(offerId ? { offerId } : {}), offset: 0 });
  if (offers.rows.length === 0)
    return json({
      simulation: null,
      searchCoverage: "bounded",
      // Nothing to simulate is not "impossible": no verified offer is stored.
      reasonCodes: ["no_stored_offer"],
      release: CONVERSION_SEARCH_RELEASE,
    });
  const quantity = decimalQuantity(unitRef ?? offers.rows[0]!.fromUnitRef, quantityText);
  if (goal) {
    const result = findConversionPaths(
      offers.rows,
      {
        quantity,
        clock: {
          kind: "local-date",
          value: new Date().toISOString().slice(0, 10),
          zone: null,
          basis: "derived",
        },
      },
      goal,
      { maxDepth: depth, maxCandidates: 8, maxExpansions: 500, requiredCompletionBy: null },
    );
    return json({
      paths: result.paths,
      // The search is bounded by depth and candidate caps, so no path is
      // described as optimal and an unknown condition stays a candidate.
      searchCoverage: result.searchCoverage,
      rejected: result.rejected,
      budget: result.budget,
      basis: "policy-estimated",
      release: result.release,
    });
  }
  const offer = offers.rows[0]!;
  return json({ simulation: simulationDto(offer, quantity), release: CONVERSION_SEARCH_RELEASE });
}

function simulationDto(offer: ConversionOffer, quantity: Quantity) {
  const eligibility = availableForOffer(
    [
      {
        bucketRef: "bucket:requested",
        programId: offer.sourceProgramRef,
        holdingRef: "holding:requested",
        kind: "regular",
        restrictionRefs: [],
        quantity,
        observedExpiry: null,
        observedAt: { kind: "unknown", reasonCode: "caller_supplied" },
        sourceFactRefs: [],
      },
    ],
    offer,
  );
  const plan = simulateConversion(offer, quantity);
  const estimate = cashLikeRedemptionEstimate(offer, plan);
  return {
    offerRef: plan.offerRef,
    eligibilityState: eligibility.state,
    eligibilityCodes: eligibility.uncertaintyCodes,
    use: plan.use,
    receive: plan.receive,
    remainder: plan.remainder,
    fees: plan.fees,
    feasible: plan.feasible,
    reasonCodes: plan.reasonCodes,
    basis: plan.basis,
    conditionRefs: plan.conditionRefs,
    // A value estimate exists only because the caller named this offer, and it
    // carries that offer's conditions with it.
    cashLikeRedemptionEstimate: estimate,
    performsExchange: false,
  };
}

function decimalQuantity(unitRef: string, text: string): Quantity {
  const [whole, fraction = ""] = text.split(".");
  const digits = `${whole ?? "0"}${fraction}`.replace(/^0+(?=\d)/u, "");
  const trimmed = fraction.replace(/0+$/u, "");
  const scale = trimmed.length;
  const coefficient = `${whole ?? "0"}${trimmed}`.replace(/^0+(?=\d)/u, "");
  return {
    unitRef,
    value:
      digits === ""
        ? { status: "unparsed", reasonCode: "quantity_unparsed" }
        : {
            status: "exact",
            value: coefficient === "0" ? { coefficient: "0", scale: 0 } : { coefficient, scale },
            normalizationVersion: "decimal-v1",
          },
  };
}
