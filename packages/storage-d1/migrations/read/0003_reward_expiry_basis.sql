-- The basis of each reward expiry estimate: the provider's display and the
-- computed answer, kept apart (ADR 0049, docs/rewards.md §2).
--
-- `expires_on` and `deadline_basis` remain what a deadline-ordered list sorts
-- by: the provider's readable display, else the computed date, else NULL.
-- They cannot say what the computed side used or why it has no date. This
-- column carries, as one JSON object validated by `validBucketExpiryBasis` in
-- packages/domain:
--
--   * `displayed` — the date the provider displayed, exactly as the bucket
--     claim promoted it, with the claim's observation time and references;
--     null when the provider displayed nothing;
--   * `computed` — `date`, `no-expiry` or `unavailable` with one closed
--     reason code, and the rule version (with its applicable period and the
--     repository evidence that confirms its terms), the activity window and
--     anchor, and the membership claims it consumed;
--   * `agreement` — `agree`, `disagree` or `not-comparable`.
--
-- Additive and nullable: a row written by a build before
-- `reward-projection-v2` has no basis and keeps NULL, which a reader reports
-- as "not recorded", never as "no computed expiry". Nothing is dropped,
-- renamed or rewritten, and no other READ table changes. A sealed snapshot
-- stays immutable through the existing guards: this column joins the row
-- content that `row_digest` covers.
ALTER TABLE reward_expiry_estimates ADD COLUMN expiry_basis_json TEXT
  CHECK(expiry_basis_json IS NULL OR
    (json_valid(expiry_basis_json) AND json_type(expiry_basis_json)='object'));
