# ADR 0049: Keep the displayed and the computed reward expiry apart, each with its basis

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-08
- Issue: part of #554 (roadmap Phase 10)

## Context

The rewards model already kept the provider's displayed expiry
(`reward_bucket_claims.observed_expiry_json`) apart from the rule-based
estimate, and `estimateExpiry` returned both dates per bucket. What it did not
return was the basis of the computed side, and in several places it filled a
gap instead of reporting it:

1. A computed date did not say which rule version produced it, which period
   that version is in force for, which repository record confirms its terms,
   which activity it was counted from or which membership claims it relied on.
   The READ row kept the rule id and version and the bucket's source claims,
   nothing more.
2. When no date was computed, the reason lived only in the estimate-wide
   uncertainty codes. The V Point regular bucket, for example, had an unknown
   deadline and an empty per-bucket reason list.
3. Gaps were filled. A tier-gated rule computed a date for a member without the
   tier, or whose tier began after the anchor activity. A qualifying activity
   whose date could not be read was skipped and a date computed from the
   others, although the skipped one might have been the newest. A history of
   unknown completeness still produced a date. A rule or tier period that could
   not be read counted as covering any day. An unreadable provider display was
   called a conflict and replaced the computed date in the list. A rule version
   with an applicable period produced deadlines after that period ended.

What the repository confirms today (and therefore all a computation may use):

- migration `0033_reward_buckets.sql` seeds four rules. Only the two V Point
  rules are `verified`, both citing `docs/sources/v-point.md#4.1`:
  `rule:v-point:regular-inactivity@v1` (inactivity, one year from the last
  regular-point movement, open-ended, deadline zone assumed) and
  `rule:v-point:fixed-expiry-lot@v1` (each fixed-expiry or store-limited lot
  carries its own date). V Point Pay and Mobile Suica SF are
  `needs-rule-verification` / `unsupported`;
- the V Point history parser stores `point_div` and `point_type` as numbers with
  the meaning `unmapped-provider-enum`. No value has been mapped to "a regular
  point movement" with an observed label or an owner confirmation, so the
  projection's activity history is `UNCLASSIFIED_REWARD_HISTORY` (completeness
  `unknown`, no activities);
- no job writes `membership_state_claims`, and no seeded rule is tier-gated.

## Options considered

1. **Add reason codes to the existing rows only.** Rejected: a reader still
   could not see the rule version, activity or membership a date rests on, and
   the gap-filling above would remain.
2. **Pick one "best" deadline per bucket from display and computation.**
   Rejected: it decides silently between an observation and a derivation, which
   the existing `conflict` state exists to prevent.
3. **A per-bucket basis with both sides, one closed reason when the computed
   side is unavailable, and their agreement; tighten the derivation so it never
   fills a gap; store the basis in READ as one validated JSON object.**
   Selected.
4. **Select one rule version per bucket at programme level and emit one row per
   bucket.** Deferred. READ rows are keyed by rule version (`rule_id` and
   `rule_version` are `NOT NULL`, and a trigger requires the rule in the
   snapshot's input refs), so a bucket that no stored rule covers cannot become
   a row without rebuilding the table. Per-version rows already express a
   version boundary through `rule_out_of_force` and
   `rule_transition_unconfirmed`.
5. **Typed READ columns for every basis field.** Rejected for now: the rule,
   activity and membership facts are nested and would multiply the migration
   surface. One JSON object, validated with exact keys by the domain, is the
   same shape the API returns.

No dependency was added. The derivation reuses the repository's own role-typed
time module (`packages/domain/src/time.ts`: `addMonths`, `periodContainsDate`,
`compareTemporal`) and the validator combinators of
`packages/domain/src/guards.ts`. A second date library would duplicate the one
date implementation the domain already enforces (a date is never promoted to an
instant, INV05), and a schema library would duplicate the exact-key guards every
domain validator uses.

## Decision

### Two answers per bucket

Every `ExpiringBucket` carries `expiryBasis: { displayed, computed, agreement }`
(`BucketExpiryBasis`, validated by `validBucketExpiryBasis`).

- `displayed` is the claim's observation: the promoted value exactly (including
  `unknown` with `provider_expiry_unparsed`), the claim's `observedAt`, and its
  source fact refs. `null` when the provider displayed nothing.
- `computed` is the derivation under one rule version, stamped
  `EXPIRY_DERIVATION_RELEASE = "reward-expiry-v1"`:
  - `status`: `date` (a calendar day in the rule's deadline calendar),
    `no-expiry` (only from verified, open-ended terms of family `none`, and
    for a tier-gated version only with a required tier on the evaluation day), or
    `unavailable` with exactly one `reasonCode`;
  - `rule`: rule ref, id, version, family, verification, the version's
    `validPeriod`, the evidence refs that confirm its terms, the
    qualifying-activity policy ref and the deadline calendar;
  - `activity`: for an inactivity rule, the window ref, its completeness, its
    earliest observed day and the anchor activity (ref and day), else `null`;
  - `membership`: for a tier-gated rule, the required tiers and this holding's
    claims for them, else `null`;
  - `uncertaintyCodes`: conditions about the consumed inputs that do not
    prevent the answer (an assumed deadline zone, an older end of history not
    observed, a self-reported tier), less the reason code itself.
- `agreement` is `agree`, `disagree` or `not-comparable`. Only two calendar
  answers compare. An unreadable display, an unavailable computation or a zone
  mismatch is `not-comparable`; verified "no expiry" beside a displayed date is
  `disagree`. Any `disagree` makes the estimate `conflict`, and both dates are
  returned.

### When a date is computed

Only when every input the rule needs is present:

1. the rule is `verified`, of a family with a calculation, and in force on the
   evaluation day (an open-ended version always is; a period that cannot be read
   covers nothing);
2. the bucket's kind is in the rule's applicability;
3. for an inactivity rule: no qualifying activity has an unreadable date (under
   a `member-used` basis, a missing usage date is unreadable, not the posting
   date); at least one qualifying activity is observed (excluded kinds never
   anchor); the history's completeness is not `unknown` (a `partial` window,
   whose older end is unobserved, still contains the newest activity and only
   adds `history_incomplete`); same-day anchors are chosen by activity ref, so
   input order does not matter;
4. for a tier-gated rule: a claim of a required tier exists for this programme
   and holding and covers the anchor day (for family `none`, whose answer is
   "no expiry", the evaluation day);
5. the anchor and the computed deadline both lie inside the version's own
   period. How a later version treats a deadline that crosses the boundary is
   not recorded, so it is not guessed.

Otherwise the computed side is `unavailable` with one closed reason
(`COMPUTED_EXPIRY_REASONS`). The issue's vocabulary maps onto names the
repository already used, plus two new ones:

| Issue term            | Reason codes                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rule_unknown`        | `rule_not_verified`, `rule_family_unsupported`, `rule_out_of_force`, `rule_bucket_kind_not_covered`, `qualifying_activity_policy_missing`, **`rule_transition_unconfirmed`** (new) |
| `activity_unobserved` | `no_qualifying_activity_observed`, `history_completeness_unknown`, `activity_date_unknown`                                                                                         |
| `membership_unknown`  | `membership_out_of_scope`, `membership_not_retroactive`                                                                                                                            |
| (lot deadlines)       | **`fixed_deadline_not_derivable`** (new): the rule fixes each lot's own date and only the provider's display states it                                                             |

The per-bucket `reasonCodes` now always include the computed reason. Activity
and membership are reported as consumed only for buckets the rule computes for;
a rule-level failure, an uncovered kind and a fixed-lot rule consume neither.

### The list's deadline

`deadline`/`basis` (READ `expires_on`/`deadline_basis`) stay the ordering
choice: the provider's readable display, else the computed date, else unknown.
An unreadable display is no longer a date and no longer hides a computed one.
`deadline_passed` is attached only to a day a display or a computation
established.

### Estimate state

`needs-rule-verification` for a rule-level failure; `conflict` for any
disagreement; `partial` when a covered bucket's deadline is not established
(other than verified "no expiry") or a consumed input is incomplete; otherwise
`computed`. A fixed-lot bucket whose display cannot be read is now `partial`
(before: `computed`).

### READ, API and screen

- `REWARD_PROJECTION_RELEASE` becomes `reward-projection-v2`, and the build
  digest includes `EXPIRY_DERIVATION_RELEASE`, so the next tick builds a new
  snapshot instead of reusing the published one (ADR 0035).
- READ migration `0003_reward_expiry_basis.sql` adds the nullable
  `reward_expiry_estimates.expiry_basis_json` (a JSON object). The row digest
  covers it; sealed snapshots stay immutable under the existing guards.
- `GET /api/v2/rewards/expiry` returns `expiryBasis` per row: the stored basis
  when it validates, else `null`: not recorded (a row built before v2) or a
  stored value that fails the check, never "no computed expiry". Nothing is
  reconstructed from other columns. The validator also refuses a date or "no
  expiry" under a version that cannot give one, and an agreement claimed for an
  unreadable display.
- `RewardReadExpiryRow` carries `expiryBasis?: RewardExpiryBasis | null`, and
  the shared response check (`packages/observation-shared/src/api-validation.ts`)
  validates it with `optional(nullable(validRewardExpiryBasis))`: a malformed
  basis fails the response; `null`, and a row without the key (a response from
  an App before the field), pass. The screen checks the basis again before
  rendering it.
- `/rewards` shows, per READ row, "取得元が表示した期限（観測）" and
  "規約からの算定（導出）" with the rule version, its period and evidence, the
  activity window and anchor, the membership claims, the reason in words and
  the agreement.

### What the stored buckets get today

| Programme, bucket kind                | Rule (seeded)                        | Computed side                                        | List deadline                     |
| ------------------------------------- | ------------------------------------ | ---------------------------------------------------- | --------------------------------- |
| V Point regular                       | `regular-inactivity@v1` (verified)   | `unavailable` / `no_qualifying_activity_observed`    | unknown                           |
| V Point time-limited, restricted      | `fixed-expiry-lot@v1` (verified)     | `unavailable` / `fixed_deadline_not_derivable`       | the provider's display, when read |
| V Point, under the other V Point rule | the rule that does not name the kind | `unavailable` / `rule_bucket_kind_not_covered`       | display or unknown                |
| V Point Pay, Mobile Suica SF          | `*-validity@v1` (needs verification) | `unavailable` / `rule_not_verified`                  | unknown                           |
| V Point qualification measure         | —                                    | not an expiring balance; reported beside the holding | —                                 |

No stored holding receives a computed date. That is the expected result of
this decision, not a defect: the inputs that would allow one are not confirmed.

## Consequences

- A reader can tell, for every bucket, what the provider displayed, what the
  rules computed, what the computation used, why it has no date, and whether
  the two agree. No bucket is shown with a zero quantity or as expired without
  a basis.
- Synthetic edge cases change output: tier-gated rules without a covering tier,
  unreadable-dated qualifying activities, unknown-completeness histories with an
  anchor and deadlines crossing a version boundary now yield no date; an
  unreadable display beside a computed date is no longer `conflict`; a display
  beside verified "no expiry" is `conflict`; a fixed-lot bucket with an
  unreadable display is `partial`; a tier-gated "no expiry" rule whose tier
  does not cover the evaluation day yields `membership_not_retroactive`, and the
  estimate carries `no_expiry_under_verified_terms` only when a bucket's answer
  is "no expiry"; under a `member-used` policy a qualifying activity without a
  usage date is `activity_date_unknown`, not dated by its posting. A stored rule
  whose tier list or period cannot be read is mapped to "a tier no claim names"
  and "a period covering no day", never to "every tier" or "always in force".
- A programme with no stored rule at all still produces no expiry row (the
  holdings route lists its buckets with their displays). Every seeded programme
  has at least one rule; a migration that adds a programme must add at least an
  `unsupported` rule for its buckets to appear in the expiry list.
- The evaluation day remains the UTC day of the snapshot while each rule's
  deadline calendar is its own (`Asia/Tokyo`, assumed); this limit is unchanged.
- Rollback: an older Processor writes `NULL` into the new column and the App
  reports "not recorded"; the migration is additive and stays.
- Blocked on the owner, not implemented here: a classification of V Point
  `point_div`/`point_type` values into the rule's qualifying kinds with observed
  labels, the history window's completeness, provider membership observations,
  the V Point Pay and Mobile Suica validity terms, and the deadline zone of the
  V Point terms. Until each is confirmed in the repository, the corresponding
  reason code stays.

## Verification

- `packages/domain/test/reward-expiry-basis.test.ts`: agreeing and disagreeing
  display and computation with the full rule and activity basis; an unreadable
  display; a fixed-lot display; verified `none` (open-ended, displayed,
  bounded); membership basis and another programme's claim; same-day anchor
  order; every one of the twelve reasons, each with no date, no `deadline_passed`
  and the observed quantity, and a check that the cases cover the closed list
  exactly; two rule versions across a period boundary, including the last day
  of v1 and the first day of v2, an anchor before v2 and a deadline after v1;
  an unreadable period; a combination sweep (6 rules × 2 histories × 4 kinds ×
  3 quantities × 4 displays) asserting every bucket is listed, quantities are
  unchanged, and `deadline_passed` appears only on a displayed or computed day;
  a tier-gated `none` rule with a current and an ended tier; validator refusals
  (contradictory status and reason, a date or "no expiry" from a version that
  cannot give one, agreement with an unreadable display).
- `packages/domain/test/rewards.test.ts`: the existing SC11–SC14 / AT43–AT54
  cases pass unchanged; the `member-used` case also checks that a missing usage
  date yields `activity_date_unknown`.
- `packages/read-model/test/reward-projection.test.ts`: the seeded rules read
  from the migrated CORE schema, applied to synthetic V Point, V Point Pay and
  Mobile Suica buckets; every row's basis validates; the reasons per rule and
  bucket kind are those in the table above; unparsed and missing quantities stay
  non-exact; unverified rules never yield "no expiry"; a programme with no
  stored rule gets no expiry row and no date.
- `packages/read-model/test/rewards.test.ts`: a stored rule's unreadable tier
  list or period is never read as "every tier" or "always in force", and
  verified `none` terms with an unreadable period yield no "no expiry".
- `apps/web/test/rewards-contract.test.tsx`: the response with `expiryBasis`
  passes the shared validator, a malformed basis fails it while `null` and a
  row without the key pass, the screen renders both sides, and a missing or
  malformed basis is shown as "not recorded".
- `packages/storage-d1` and `scripts/core-schema-ledger.test.ts`: the READ
  migration list and the regenerated `infra/schema/read-ledger.*`.
