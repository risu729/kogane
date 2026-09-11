// Synthetic reward input for the READ adapter tests (U16). No provider name,
// no member reference and no real amount appears here: one made-up programme,
// two buckets, one rule, one offer and two saved simulations — one that kept
// its request and one that kept only a digest.
import {
  REWARD_EVALUATION_CALENDAR,
  type RewardProjectionInputContent,
} from "../../read-model/src/index.ts";

export const REWARD_DIGEST_A = "1".repeat(64);
export const REWARD_DIGEST_B = "2".repeat(64);

const PROGRAM = "program:synthetic";
const HOLDING = `${PROGRAM}:member`;
const UNIT = "points:synthetic";

function bucket(
  slot: string,
  kind: string,
  coefficient: string,
  expiry: string | null,
  factId: number,
) {
  return {
    id: factId,
    program_id: PROGRAM,
    holding_ref: HOLDING,
    bucket_ref: `${PROGRAM}:${slot}`,
    bucket_kind: kind,
    restriction_refs_json: "[]",
    unit_ref: UNIT,
    quantity_coefficient: coefficient,
    quantity_scale: 0,
    quantity_status: "exact",
    observed_expiry_json:
      expiry === null
        ? null
        : JSON.stringify({
            kind: "local-date",
            value: expiry,
            zone: "Asia/Tokyo",
            basis: "provider",
          }),
    observed_at: "2026-09-01T00:00:00.000Z",
    parse_run_id: 7,
    source_fact_kind: "balance",
    source_fact_id: factId,
    institution_ref: "institution:synthetic",
    program_ref: "synthetic-points",
    source_id: "synthetic",
    program_unit_ref: UNIT,
    holding_kind: "reward-points",
    terms_evidence_refs_json: '["docs/sources/synthetic.md"]',
    release_id: "reward-model-v1",
  };
}

const RULE = {
  rule_id: "rule:synthetic:fixed-lot",
  version: "v1",
  family: "fixed-lot",
  program_id: PROGRAM,
  applicability_json: JSON.stringify({
    bucketKinds: ["time-limited", "regular"],
    tiers: null,
    validPeriod: null,
  }),
  qualifying_activity_policy_ref: null,
  deadline_calendar_ref: "Asia/Tokyo:end-of-day:assumed",
  priority_policy_ref: null,
  evidence_refs_json: '["docs/sources/synthetic.md"]',
  verification: "verified",
};

const OFFER = {
  offer_id: "offer:synthetic",
  version: "v1",
  source_program_ref: PROGRAM,
  destination_program_ref: "program:synthetic-cash",
  from_unit_ref: UNIT,
  to_unit_ref: "JPY",
  ratio_numerator: "1",
  ratio_denominator: "2",
  minimum_coefficient: "100",
  minimum_scale: 0,
  increment_coefficient: "100",
  increment_scale: 0,
  maximum_per_request_coefficient: null,
  maximum_per_request_scale: null,
  shared_quota_ref: null,
  fixed_fees_json: "[]",
  variable_fee_policy_ref: null,
  eligibility_policy_ref: "policy:synthetic:eligibility:v1",
  eligible_bucket_kinds_json: '["regular"]',
  eligible_restriction_refs_json: "[]",
  eligible_tiers_json: null,
  valid_time_json: JSON.stringify({ kind: "unknown", reasonCode: "synthetic_offer" }),
  application_deadline_json: JSON.stringify({ kind: "unknown", reasonCode: "synthetic_offer" }),
  processing_policy_ref: "policy:synthetic:processing:v1",
  processing_days: 3,
  rounding_policy_ref: "policy:synthetic:rounding:v1",
  rounding_scale: 0,
  rounding_mode: "down",
  cancellation_policy_ref: null,
  evidence_refs_json: '["docs/sources/synthetic.md"]',
  verification: "verified",
};

/** A saved simulation that retained its request: replayable (G2-20). */
export const RETAINED_SIMULATION = {
  input_digest: "a".repeat(64),
  plan_json: JSON.stringify({
    request: {
      offerId: OFFER.offer_id,
      offerVersion: OFFER.version,
      quantity: { coefficient: "1000", scale: 0, unitRef: UNIT },
    },
    offerRef: `${OFFER.offer_id}@${OFFER.version}`,
  }),
  search_coverage: "bounded",
  policy_release: "conversion-search-v1",
  computed_at: "2026-09-02T00:00:00.000Z",
};

/** A saved simulation that kept only its digest: not reproducible (G2-20). */
export const DIGEST_ONLY_SIMULATION = {
  input_digest: "b".repeat(64),
  plan_json: JSON.stringify({ offerRef: "offer:forgotten@v1" }),
  search_coverage: "bounded",
  policy_release: "conversion-search-v1",
  computed_at: "2026-09-02T00:00:00.000Z",
};

/** One fixed reward input, evaluated at the instant the caller names. */
export function rewardInput(options: { evaluatedAt: string }): {
  content: RewardProjectionInputContent;
} {
  const buckets = [
    bucket("slot-a", "time-limited", "5000", "2026-12-31", 101),
    bucket("slot-b", "regular", "3000", null, 102),
  ];
  return {
    content: {
      manifest: {
        evaluatedAt: options.evaluatedAt,
        evaluationCalendar: REWARD_EVALUATION_CALENDAR,
        promotionRelease: "reward-promotion-v1",
        policyRelease: "reward-projection-v1",
        claimsHighWater: 102,
        ruleCount: 1,
        bucketCount: buckets.length,
        membershipCount: 0,
        offerCount: 1,
        simulationCount: 2,
      },
      rules: [RULE],
      buckets,
      membership: [],
      offers: [OFFER],
      simulations: [RETAINED_SIMULATION, DIGEST_ONLY_SIMULATION],
    },
  };
}
