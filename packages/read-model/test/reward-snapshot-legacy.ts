// Frozen shipped query at 3966b3778, before the deliberate snapshot correction.
export const LEGACY_REWARD_BUCKETS_SQL = `WITH ranked AS (
  SELECT c.id,c.program_id,c.holding_ref,c.bucket_ref,c.bucket_kind,c.restriction_refs_json,
    c.unit_ref,c.quantity_coefficient,c.quantity_scale,c.quantity_status,c.observed_expiry_json,
    c.observed_at,c.parse_run_id,c.source_fact_kind,c.source_fact_id,
    row_number() OVER(PARTITION BY c.program_id,c.holding_ref,c.bucket_ref
      ORDER BY c.observed_at DESC,c.id DESC) AS rank
  FROM reward_bucket_claims c
  JOIN published_parse_runs pub ON pub.parse_run_id=c.parse_run_id
  WHERE c.promotion_release=?1 AND (?2 IS NULL OR c.program_id=?2)
)
SELECT r.id,r.program_id,r.holding_ref,r.bucket_ref,r.bucket_kind,r.restriction_refs_json,
  r.unit_ref,r.quantity_coefficient,r.quantity_scale,r.quantity_status,r.observed_expiry_json,
  r.observed_at,r.parse_run_id,r.source_fact_kind,r.source_fact_id,
  p.institution_ref,p.program_ref,p.source_id,p.unit_ref AS program_unit_ref,p.holding_kind,
  p.terms_evidence_refs_json,p.release_id
FROM ranked r JOIN reward_programs p ON p.program_id=r.program_id
WHERE r.rank=1
ORDER BY r.program_id,r.holding_ref,r.bucket_ref
LIMIT 201 OFFSET ?3`;
