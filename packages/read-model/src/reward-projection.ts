// The reward projection: expiry estimates and replayed conversion simulations
// from one fixed evaluation input (unified plan 04 §2, 05 §3; U16).
//
// This module is pure. It takes the rows a capture read out of CORE — the
// rules, the current bucket claims, the membership claims, the offers and the
// saved simulations — together with the instant the evaluation is fixed at,
// and returns the rows a build writes into the READ database. It reads no
// clock, touches no database and decides nothing about storage.
//
// Why the instant is an argument rather than a call to `Date.now()`: a
// deadline computed from "now" is a different answer on every request, so it
// cannot be a projection of anything. Chapter 04 §2 admits these two tables
// into READ only once the evaluation time, the original request and the rule
// are fixed, and this signature is where that condition lives (G2-19).
//
// Nothing here converts a reward quantity into an asset subtotal, and nothing
// here predicts a deadline a rule did not authorise: `estimateExpiry` in
// packages/domain is the only source of a computed date, and an unverified or
// unsupported rule still yields rows — under an unknown deadline — instead of
// silently claiming "no expiry".

import { canonicalDigest, sha256Hex } from "../../domain/src/context.ts";
import {
  CONVERSION_SEARCH_RELEASE,
  estimateExpiry,
  REWARD_POLICY_RELEASE,
  simulateConversion,
  type ActivityHistory,
  type BucketKind,
  type ConversionOffer,
  type ExpiryEstimate,
  type ExpiryRule,
  type MembershipState,
  type RewardBucket,
  type RewardHolding,
} from "../../domain/src/rewards.ts";
import type { TemporalValue } from "../../domain/src/time.ts";
import type { Quantity } from "../../domain/src/values.ts";
import {
  conversionOffer,
  expiryRule,
  membershipState,
  rewardBucket,
  REWARD_READ_RELEASE,
  type ConversionOfferSqlRow,
  type ExpiryRuleSqlRow,
  type MembershipSqlRow,
  type RewardBucketSqlRow,
} from "./rewards.ts";

/** The shape of a stored reward input; a change of shape is a new identity. */
export const REWARD_PROJECTION_CONTRACT_VERSION = "reward-projection-input-v1";

/** Bump to rebuild every estimate under new projection rules. */
export const REWARD_PROJECTION_RELEASE = "reward-projection-v1";

/**
 * How the fixed instant becomes the calendar day the rules are evaluated on:
 * the UTC day of `evaluatedAt`, with the zone recorded as assumed because no
 * programme's terms state one for "today" (docs/rewards.md §3). It is
 * deliberately separate from each rule's own `deadlineCalendar`, which decides
 * the day a deadline falls on and travels with the rule.
 */
export const REWARD_EVALUATION_CALENDAR = "UTC:start-of-day:assumed";

/**
 * The reward activity history the store can classify today: none. The
 * provider's own movement enum is not recorded as a value
 * (docs/sources/v-point.md §4.2), so no observed row can be called a
 * qualifying activity, and `estimateExpiry` reports `partial` instead of
 * inventing a deadline from the newest transaction (SC12).
 */
export const UNCLASSIFIED_REWARD_HISTORY: ActivityHistory = {
  windowRef: "window:reward-activity:unclassified",
  completeness: "unknown",
  earliestObserved: null,
  activities: [],
};

/** One saved simulation as CORE stored it (migration 0033). */
export interface SavedSimulationSqlRow {
  input_digest: string;
  plan_json: string;
  search_coverage: string;
  policy_release: string;
  computed_at: string;
}

/**
 * The request a saved simulation retained. Without it the row carries only a
 * digest, and a digest is not an input: the replay reports `not_reproducible`
 * rather than recomputing a plan from today's offers and calling it the same
 * simulation (G2-20).
 */
export interface SavedSimulationRequest {
  offerId: string;
  offerVersion: string;
  quantity: { coefficient: string; scale: number; unitRef: string };
}

/** The operational summary of one capture, copied into the snapshot row. */
export interface RewardProjectionManifest {
  /** The instant every deadline in the build is computed against (05 §3). */
  evaluatedAt: string;
  /** How that instant becomes a calendar day; see `REWARD_EVALUATION_CALENDAR`. */
  evaluationCalendar: string;
  /** The claim promotion release the buckets came from. */
  promotionRelease: string;
  policyRelease: string;
  /** The highest bucket claim id the input carried. */
  claimsHighWater: number;
  ruleCount: number;
  bucketCount: number;
  membershipCount: number;
  offerCount: number;
  simulationCount: number;
}

/** Everything one build is allowed to read, exactly as it was read. */
export interface RewardProjectionInputContent {
  manifest: RewardProjectionManifest;
  rules: ExpiryRuleSqlRow[];
  buckets: RewardBucketSqlRow[];
  membership: MembershipSqlRow[];
  offers: ConversionOfferSqlRow[];
  simulations: SavedSimulationSqlRow[];
}

/** One estimated deadline, in the shape the READ table stores. */
export interface RewardExpiryProjectionRow {
  /** `holdingRef|ruleId@version|bucketRef`; the row identity inside a snapshot. */
  rowKey: string;
  rowSeq: number;
  programId: string;
  holdingRef: string;
  bucketRef: string;
  ruleId: string;
  ruleVersion: string;
  bucketKind: BucketKind;
  state: ExpiryEstimate["state"];
  deadlineBasis: "provider-observed" | "policy-estimated" | "unknown";
  /** A calendar date in the rule's own calendar, or null when none was established. */
  expiresOn: string | null;
  amountCoefficient: string | null;
  amountScale: number | null;
  amountStatus: "exact" | "missing" | "unparsed" | "conflict";
  unitRef: string;
  providerObserved: TemporalValue | null;
  policyEstimated: TemporalValue | null;
  reasonCodes: string[];
  uncertaintyCodes: string[];
  /** CORE references this row rests on, copied rather than joined (04 §3). */
  basisRefs: string[];
}

/** One replayed simulation, in the shape the READ table stores. */
export interface RewardSimulationProjectionRow {
  requestDigest: string;
  rowSeq: number;
  reproducibility: "reproduced" | "not_reproducible";
  reasonCode: string | null;
  request: SavedSimulationRequest | null;
  offerId: string | null;
  offerVersion: string | null;
  result: Record<string, unknown> | null;
  searchCoverage: "complete" | "bounded";
  evaluatedAt: string;
  policyRelease: string;
}

export interface RewardProjection {
  estimates: RewardExpiryProjectionRow[];
  simulations: RewardSimulationProjectionRow[];
  /** `ruleId@version` of every rule the build used, sorted. */
  ruleRefs: string[];
  /** `offerId@version` of every offer the build used, sorted. */
  offerRefs: string[];
  release: string;
}

/**
 * `snapshotId = sha256(inputContentDigest ‖ buildDigest ‖ contractVersion)`,
 * so a code change that would produce different rows from the same input
 * produces a different snapshot instead of overwriting the old one.
 */
export async function rewardProjectionBuildDigest(): Promise<string> {
  return await canonicalDigest({
    projectionRelease: REWARD_PROJECTION_RELEASE,
    rewardPolicyRelease: REWARD_POLICY_RELEASE,
    conversionSearchRelease: CONVERSION_SEARCH_RELEASE,
    evaluationCalendar: REWARD_EVALUATION_CALENDAR,
    activityWindow: UNCLASSIFIED_REWARD_HISTORY.windowRef,
    contractVersion: REWARD_PROJECTION_CONTRACT_VERSION,
  });
}

/** The digest of the exact `(ruleId, version)` set a build used. */
export async function ruleSetDigest(ruleRefs: readonly string[]): Promise<string> {
  return await sha256Hex([...ruleRefs].sort().join("\n"));
}

/** The clock `estimateExpiry` is given: the UTC day of the fixed instant. */
export function evaluationClock(evaluatedAt: string): TemporalValue {
  return { kind: "local-date", value: evaluatedAt.slice(0, 10), zone: null, basis: "derived" };
}

/**
 * The request a saved simulation retained, or null when the row kept only its
 * digest. Validation is deliberately strict: a half-readable request is not an
 * input either, and guessing the missing half would be the exact mistake
 * G2-20 exists to prevent.
 */
export function savedSimulationRequest(planJson: string): SavedSimulationRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(planJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const request = (parsed as Record<string, unknown>)["request"];
  if (request === null || typeof request !== "object") return null;
  const record = request as Record<string, unknown>;
  const quantity = record["quantity"];
  if (quantity === null || typeof quantity !== "object") return null;
  const amount = quantity as Record<string, unknown>;
  if (
    typeof record["offerId"] !== "string" ||
    typeof record["offerVersion"] !== "string" ||
    typeof amount["coefficient"] !== "string" ||
    !/^(0|[1-9]\d{0,29})$/u.test(amount["coefficient"]) ||
    typeof amount["scale"] !== "number" ||
    !Number.isSafeInteger(amount["scale"]) ||
    amount["scale"] < 0 ||
    amount["scale"] > 4096 ||
    typeof amount["unitRef"] !== "string" ||
    amount["unitRef"] === ""
  )
    return null;
  return {
    offerId: record["offerId"],
    offerVersion: record["offerVersion"],
    quantity: {
      coefficient: amount["coefficient"],
      scale: amount["scale"],
      unitRef: amount["unitRef"],
    },
  };
}

function quantityOf(request: SavedSimulationRequest): Quantity {
  return {
    unitRef: request.quantity.unitRef,
    value: {
      status: "exact",
      value: { coefficient: request.quantity.coefficient, scale: request.quantity.scale },
      normalizationVersion: "decimal-v1",
    },
  };
}

function amountOf(quantity: Quantity): {
  amountCoefficient: string | null;
  amountScale: number | null;
  amountStatus: RewardExpiryProjectionRow["amountStatus"];
  unitRef: string;
} {
  if (quantity.value.status === "exact")
    return {
      amountCoefficient: quantity.value.value.coefficient,
      amountScale: quantity.value.value.scale,
      amountStatus: "exact",
      unitRef: quantity.unitRef,
    };
  return {
    amountCoefficient: null,
    amountScale: null,
    amountStatus: quantity.value.status,
    unitRef: quantity.unitRef,
  };
}

/** A deadline as a calendar date, or null when the value names no day. */
function deadlineDate(value: TemporalValue): string | null {
  if (value.kind === "local-date") return value.value;
  // An instant is not a deadline in a programme's calendar: turning one into a
  // day here would pick a zone the terms never stated.
  return null;
}

/** The holdings of the captured bucket rows, grouped exactly as the reader does. */
function holdingsOf(buckets: readonly RewardBucketSqlRow[]): {
  holding: RewardHolding;
  kinds: Map<string, BucketKind>;
}[] {
  const holdings = new Map<string, { holding: RewardHolding; kinds: Map<string, BucketKind> }>();
  for (const row of buckets) {
    const key = `${row.program_id} ${row.holding_ref}`;
    let entry = holdings.get(key);
    if (!entry) {
      entry = {
        holding: {
          holdingRef: row.holding_ref,
          programId: row.program_id,
          unitRef: row.program_unit_ref,
          buckets: [],
        },
        kinds: new Map<string, BucketKind>(),
      };
      holdings.set(key, entry);
    }
    const bucket: RewardBucket = rewardBucket(row);
    entry.kinds.set(bucket.bucketRef, bucket.kind);
    // A qualification measure is not part of the holding and never expires as
    // a balance would; it is reported beside the holding, exactly as the
    // reward reader does (addendum 08 §2).
    if (bucket.kind !== "qualification") entry.holding.buckets.push(bucket);
  }
  return [...holdings.values()];
}

/**
 * Build the rows of one reward snapshot from its fixed input.
 *
 * Order is part of the contract: estimates by programme, holding, rule and
 * bucket; simulations by the digest CORE stored. The same input therefore
 * produces the same `rowSeq` for the same row, which is what makes a rebuild
 * comparable digest by digest (G2-19).
 */
export function buildRewardProjection(content: RewardProjectionInputContent): RewardProjection {
  const evaluatedAt = content.manifest.evaluatedAt;
  const clock = evaluationClock(evaluatedAt);
  const rules: ExpiryRule[] = content.rules.map(expiryRule);
  const membership: MembershipState[] = content.membership.map(membershipState);
  const offers: ConversionOffer[] = content.offers.map(conversionOffer);
  const estimates: RewardExpiryProjectionRow[] = [];
  const usedRules = new Set<string>();

  for (const { holding, kinds } of holdingsOf(content.buckets)) {
    const applicable = rules
      .filter((rule) => rule.programId === holding.programId)
      .sort((left, right) =>
        `${left.ruleId}@${left.version}` < `${right.ruleId}@${right.version}` ? -1 : 1,
      );
    for (const rule of applicable) {
      const ruleRef = `${rule.ruleId}@${rule.version}`;
      const estimate = estimateExpiry(
        rule,
        holding,
        UNCLASSIFIED_REWARD_HISTORY,
        membership,
        clock,
        `context:reward-read:${REWARD_PROJECTION_RELEASE}:${evaluatedAt}`,
      );
      usedRules.add(ruleRef);
      for (const bucket of estimate.expiringBuckets) {
        const source = holding.buckets.find((entry) => entry.bucketRef === bucket.bucketRef);
        estimates.push({
          rowKey: `${holding.holdingRef}|${ruleRef}|${bucket.bucketRef}`,
          // Filled in below, once the whole set is ordered.
          rowSeq: 0,
          programId: holding.programId,
          holdingRef: holding.holdingRef,
          bucketRef: bucket.bucketRef,
          ruleId: rule.ruleId,
          ruleVersion: rule.version,
          bucketKind: kinds.get(bucket.bucketRef) ?? "regular",
          state: estimate.state,
          deadlineBasis: bucket.basis,
          expiresOn: deadlineDate(bucket.deadline),
          ...amountOf(bucket.quantity),
          providerObserved: bucket.providerObserved,
          policyEstimated: bucket.policyEstimated,
          reasonCodes: [...bucket.reasonCodes],
          uncertaintyCodes: [...estimate.uncertaintyCodes],
          basisRefs: source ? [...source.sourceFactRefs] : [],
        });
      }
    }
  }
  estimates.sort((left, right) => (left.rowKey < right.rowKey ? -1 : 1));
  for (const [index, row] of estimates.entries()) row.rowSeq = index;

  const simulations = replaySimulations(content.simulations, offers, evaluatedAt);
  return {
    estimates,
    simulations,
    ruleRefs: [...usedRules].sort(),
    offerRefs: [
      ...new Set(
        simulations
          .filter((row) => row.offerId !== null)
          .map((row) => `${row.offerId as string}@${row.offerVersion as string}`),
      ),
    ].sort(),
    release: REWARD_PROJECTION_RELEASE,
  };
}

/**
 * Replay the saved simulations against the fixed offer set.
 *
 * Three outcomes, and only the first is a result:
 *   * the request was retained and its offer version is in the fixed input —
 *     the plan is recomputed and stored;
 *   * the request was retained but names an offer this input does not carry —
 *     `offer_not_in_fixed_input`; nothing is recomputed against a substitute;
 *   * the row kept only a digest — `simulation_input_not_retained` (G2-20).
 */
function replaySimulations(
  rows: readonly SavedSimulationSqlRow[],
  offers: readonly ConversionOffer[],
  evaluatedAt: string,
): RewardSimulationProjectionRow[] {
  const byRef = new Map(offers.map((offer) => [`${offer.offerId}@${offer.version}`, offer]));
  const simulations = [...rows]
    .sort((left, right) => (left.input_digest < right.input_digest ? -1 : 1))
    .map((row, index): RewardSimulationProjectionRow => {
      const coverage: "complete" | "bounded" =
        row.search_coverage === "complete" ? "complete" : "bounded";
      const base = {
        requestDigest: row.input_digest,
        rowSeq: index,
        searchCoverage: coverage,
        evaluatedAt,
        policyRelease: row.policy_release,
      };
      const request = savedSimulationRequest(row.plan_json);
      if (!request)
        return {
          ...base,
          reproducibility: "not_reproducible",
          reasonCode: "simulation_input_not_retained",
          request: null,
          offerId: null,
          offerVersion: null,
          result: null,
        };
      const offer = byRef.get(`${request.offerId}@${request.offerVersion}`);
      if (!offer)
        return {
          ...base,
          reproducibility: "not_reproducible",
          reasonCode: "offer_not_in_fixed_input",
          request: null,
          offerId: null,
          offerVersion: null,
          result: null,
        };
      const plan = simulateConversion(offer, quantityOf(request));
      return {
        ...base,
        reproducibility: "reproduced",
        reasonCode: null,
        request,
        offerId: offer.offerId,
        offerVersion: offer.version,
        result: { ...plan } as unknown as Record<string, unknown>,
      };
    });
  return simulations;
}

/** The promotion release a capture reads claims at; one name for both sides. */
export const REWARD_PROJECTION_PROMOTION_RELEASE = REWARD_READ_RELEASE;
