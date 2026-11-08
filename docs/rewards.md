<a id="ポイントマイル前払式残高a11"></a>

# Points, miles and prepaid balances (A11)

The current configuration enables claim promotion, READ projection and presentation. The initial activation steps and synthetic-data tests below describe the checks made at that time; they do not mean that prediction/conversion simulation using real data is complete. Current status and missing inputs are in [implementation status](current-status.md).

The scope is design-review addendum 08, "Dedicated design for points, miles and prepaid balances", scenarios SC11–SC14 and acceptance tests AT37/AT39/AT41/AT43–AT54. The migration is `0033_reward_buckets.sql`.

**This feature performs no actual exchange.** No command submits an application, exchange or top-up externally, and no route can be added for one. It returns only a breakdown of holdings, observed expiry, estimates derived from terms, conditional simulations and conditions requiring verification.

<a id="1-何を分けているか"></a>

## 1. What stays separate

| Concept              | Stored in                                                       | Why it stays separate                                                       |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ProgramUnit          | `reward_programs.unit_ref`                                      | The same "points" label does not make units identical across programs       |
| RewardHolding        | `reward_bucket_claims_v2.holding_ref`                           | A member account, separate from a provider display slot                     |
| EligibilityBucket    | `reward_bucket_claims_v2.bucket_kind` / `restriction_refs_json` | Buckets with different uses/expiry are not mixed into an available quantity |
| ExpiryObservation    | `reward_bucket_claims_v2.observed_expiry_json`                  | Provider-displayed expiry, in a separate column from predictions            |
| MembershipState      | `membership_state_claims`                                       | Self-reported and verified states are distinct, with applicable periods     |
| QualificationMeasure | `bucket_kind='qualification'`                                   | A non-consumable qualification measure, excluded from holdings              |
| ExpiryRule           | `expiry_rules`                                                  | Calculation family, evidence, verification state and applicability          |
| ConversionOffer      | `conversion_offers`                                             | Integer ratios; campaigns/member-specific terms are separate offers         |

Calculations use pure functions in `packages/domain/src/rewards.ts` and `reward-conversion.ts`, which separates conversion and route search. They depend on no database, clock or HTTP.

- `summarizeHolding(holding, qualifications)` — Totals only consumable buckets in the program's own unit, excluding `pending-award` and `qualification` with reason codes. Different units or unparsed values make the total `conflict`, never a smaller number (INV05).
- `availableForOffer(buckets, offer, membership, clock)` — SC13. Regular 5,000 is eligible; restricted-use 3,000 is excluded with `bucket_kind_not_eligible`. Membership conditions, validity and the application deadline are also checked.
- `simulateConversion(offer, eligible, fees)` — SC14. Applies the maximum, rounds down to an increment, then applies the minimum, in that order. Receipt is "quantity used × ratio" under the offer's rounding policy. It does not return `2,500 × 0.5 = 1,250`.
- `estimateExpiry(rule, holding, activity, membership, clock)` — SC12. `max(transaction_date)` is not the starting date. Only the rule's qualifying activities are considered; excluded family transfers and similar activity are ignored. Each bucket returns the provider's displayed expiry (observed) and the expiry derived from terms (derived) separately in `expiryBasis` (§2.1, [ADR 0049](adr/0049-reward-expiry-basis.md)).
- `redemptionPositions(held, events, destinationUnit)` — Tracks application, deduction, credit, cancellation and return as separate stages. An application alone moves nothing; a return creates a new bucket claim rather than reviving the original lot. An inexact deduction makes holdings and in-flight quantities unknown with reasons; an inexact credit does so for cumulative credits, and an inexact return for holdings. They are not treated as quantities that did not move (0) (INV05). Credits and returns reset the in-flight quantity to 0 regardless of quantity.
- `findConversionPaths(offers, start, goal, budget)` — Search with explicit depth and candidate bounds.

### Standing offers: no end date and no deadline

Owner decision (2026-11-07 12:51 UTC): an offer whose end date is not announced is
common, and it is a standing offer, not an offer of unknown period. Kogane stores
"no end" and "no deadline" as values, so the offer stays usable instead of falling
into `needs-rule-verification`.

| Field                                               | Standing offer                                                   | Bounded offer (unchanged)             |
| --------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `validTime` / `valid_time_json`                     | `{"kind":"open-ended","start":"2026-04-01","zone":"Asia/Tokyo"}` | a `local-date`, `period` or `instant` |
| `applicationDeadline` / `application_deadline_json` | `null` (the JSON text `null`; the column stays `NOT NULL`)       | a `local-date`, `period` or `instant` |

- `start` is the first day the offer is known to apply. When the provider states no
  start, it is the date of the evidence that shows the offer. A day before `start` is
  `offer_not_valid_at_clock`; `start` and every later day are inside. An instant
  counts by its own calendar date. The zone follows the same compatibility rule as
  `compareTemporal` (`null` is compatible with any zone; a different zone is not
  comparable).
- `open-ended` is accepted only where a field says so (an offer's `validTime`); it is
  not a `TemporalValue`, so no other time field accepts it.
- `{"kind":"unknown"}` keeps its meaning: the period was not established (including
  stored text that does not parse). It is never read as a standing offer, and the
  reader never turns damaged text into `open-ended` or `null`.
- `availableForOffer` checks neither an `unknown` deadline nor an `unknown` validity
  and adds no code for them, nor for a clock inside a `period` deadline, on the day
  of an instant deadline or in another zone, and it reads an instant by the date its
  offset was written in (`compareTemporal`) (a limit; `/offers/simulate` calls it
  without a clock, so it checks neither field there).
  Route search rejects an `unknown` validity or deadline as
  `needs_rule_verification` (see "Search eligibility at each hop"), which is why a
  standing offer stores `open-ended` and `null` instead of `unknown`.
- No migration: both columns already hold JSON text, and nothing writes offer rows
  today (§3).

<a id="2-期限の状態"></a>

## 2. Expiry states

`ExpiryEstimate.state` has 4 states.

| state                     | Meaning                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `computed`                | The rule's inputs are present and calculation succeeded                   |
| `partial`                 | History, acquisition date or membership is incomplete                     |
| `conflict`                | Provider-displayed expiry and the calculation disagree; both are returned |
| `needs-rule-verification` | Terms are unverified or cannot yet be expressed as a calculation family   |

`family='none'` means that the terms have been verified to impose no expiry; it is distinct from unknown expiry. An unverified rule never returns "no expiry". Buckets without an established expiry stay in the deadline-sorted list as `deadline.kind='unknown'` rows.

| state                     | Condition (ADR 0049)                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs-rule-verification` | The rule version itself is unusable: unverified, no calculation family, evaluation day outside validity, or unresolved qualifying-activity definition |
| `conflict`                | A bucket's displayed and computed expiry disagree                                                                                                     |
| `partial`                 | Expiry is unestablished for a covered bucket kind (excluding verified no-expiry), or a consumed input is incomplete                                   |
| `computed`                | None of the above                                                                                                                                     |

<a id="21-表示期限と算定期限"></a>

### 2.1 Displayed and computed expiry

Each bucket's `expiryBasis` has the following 3 parts. `validBucketExpiryBasis` validates exact keys.

- `displayed` — The expiry the provider displayed (observed). It retains the promoted claim value unchanged; unreadable text remains `unknown` (such as `provider_expiry_unparsed`). It includes the claim's `observedAt` and source-fact references. With no display it is `null`.
- `computed` — A derivation under 1 rule version, carrying `EXPIRY_DERIVATION_RELEASE` (`reward-expiry-v2`).
  - `status`: `date` (a civil date on the rule's deadline calendar), `no-expiry` (only for verified, unbounded `family='none'`; for a tier-dependent rule, only with a required-tier claim covering the evaluation day), or `unavailable` (exactly 1 reason code).
  - `rule`: rule reference, version, family, verification state, version validity `validPeriod`, terms evidence (`evidenceRefs`, records in `docs/sources`), qualifying-activity policy reference and deadline calendar.
  - `activity`: the history window, completeness, oldest observed day and starting activity (reference/date) consumed by an inactivity rule.
  - `membership`: the required tier and this holding's applicable claims consumed by a tier-dependent rule. Claims are ordered by tier code points (the same order as `MEMBERSHIP_SQL`'s `ORDER BY tier`), then by canonical claim JSON within a tier, independent of input order.
  - `uncertaintyCodes`: qualifications that limit rather than prevent derivation: assumed time zone, missing older history or a self-reported tier.
- `agreement` — `agree` / `disagree` / `not-comparable`. Only civil dates are comparable. Unreadable displays, unavailable derivations and zone mismatches are `not-comparable`. Verified no-expiry alongside a displayed deadline is `disagree`. Any `disagree` makes the estimate `conflict` and returns both.

A computed expiry is a date only when the rule is verified, has a supported calculation family and applies on the evaluation day; the bucket kind is covered; an inactivity rule has no qualifying activity with an unknown date, at least 1 observed qualifying activity and history completeness other than `unknown` (`partial` lacks only older history, so derivation proceeds with `history_incomplete`); a tier-dependent rule has a tier claim covering the starting day; and both the starting day and derived deadline lie within that version's validity. No treatment across rule versions is inferred where the terms do not record it. Otherwise the result is `unavailable` with exactly 1 reason from the closed `COMPUTED_EXPIRY_REASONS` list.

| reasonCode                           | Meaning                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `rule_not_verified`                  | Terms have not been verified in the repository                                                                            |
| `rule_family_unsupported`            | Terms cannot yet be expressed as a calculation family                                                                     |
| `rule_out_of_force`                  | The evaluation day is outside this version's validity; an unreadable period is not treated as always valid                |
| `rule_transition_unconfirmed`        | The starting day or deadline is outside this version's validity, and transition handling is unrecorded                    |
| `rule_bucket_kind_not_covered`       | This version does not cover this kind                                                                                     |
| `bucket_kind_unclassified`           | The provider quantity is retained, but its bucket kind is unconfirmed                                                     |
| `fixed_deadline_not_derivable`       | Each lot has its own deadline, with no evidence beyond the provider display                                               |
| `qualifying_activity_policy_missing` | The inactivity rule's qualifying-activity definition cannot be resolved                                                   |
| `membership_out_of_scope`            | This holding lacks the tier claim required by a tier-dependent rule                                                       |
| `membership_not_retroactive`         | The required-tier claim does not cover the starting day (the evaluation day for `family='none'`)                          |
| `activity_date_unknown`              | A qualifying activity has an unreadable date (including a missing usage date under `member-used`) and could be the newest |
| `no_qualifying_activity_observed`    | Observed history contains no qualifying activity                                                                          |
| `history_completeness_unknown`       | History gaps are unknown, so a newer qualifying activity may have been missed                                             |

The list's deadline (`deadline` / READ `expires_on` and `deadline_basis`) is a sorting choice: a readable display, otherwise a computed expiry, otherwise unknown. An unreadable display is not a deadline and does not hide a computed expiry. `deadline_passed` applies only to a civil date established by a display or derivation. Quantities remain as observed; unparsed/missing values never become 0.

<a id="3-規約の確認状態重要"></a>

## 3. Verification of terms (important)

`verification='verified'` is used **only when `docs/sources/*.md` contains a record quoting the provider's terms themselves**. Otherwise `verification='needs-rule-verification'` and `family='unsupported'`; a migration CHECK enforces this pairing. Unverified rules derive no expiry.

Migration 0033 seeds these rules:

| rule                                | family        | verification            | Evidence                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rule:v-point:regular-inactivity`   | `inactivity`  | **verified**            | `docs/sources/v-point.md` §4.1 quotes [`Vポイントサービス利用規約`][Vポイントサービス利用規約] ("V Point service terms"), recording that regular points expire 1 year after the last point movement and earning/using store-limited points does not extend that expiry |
| `rule:v-point:fixed-expiry-lot`     | `fixed-lot`   | **verified**            | The same §4.1: fixed-expiry points have individual deadlines that earning/using them does not extend                                                                                                                                                                   |
| `rule:v-point-pay:prepaid-validity` | `unsupported` | needs-rule-verification | `docs/sources/v-point.md` §5.1 quotes the expiry FAQ but explicitly requires rechecking the current FAQ and app display at implementation because conditions may differ from the older explanation; no calculation family is assigned before that recheck              |
| `rule:mobile-suica-sf:validity`     | `unsupported` | needs-rule-verification | `docs/sources/mobile-suica.md` records balance/history capture paths but quotes no expiry terms                                                                                                                                                                        |

**The time zone is separate.** The quoted terms do not state the deadline's reference time zone, so `deadline_calendar_ref` is `Asia/Tokyo:end-of-day:assumed`, and every derivation carries `deadline_zone_assumed`. The UI display zone is separate from the program's deadline zone (addendum 06 §2).

No `conversion_offers` rows are seeded. The candidate named by the review (a JRE POINT-to-Suica top-up) has search-excerpt evidence only [W13], can only be stored as `needs-rule-verification`, and cannot be simulation input. ANA, JAL and `楽天` (Rakuten) mileage/point rules are likewise not created until `docs/sources` records a terms quotation [W09] [W10] [W11] [W12] [W14].

The V Point history parser also retains numeric `point_div` (earning, use, expiry, correction, cancellation, etc.) and `point_type` as `unmapped-provider-enum`. Some public-UI labels are recorded, but which values are a regular-point movement under the terms, and which date starts the period, remain unconfirmed. Observed detail rows therefore cannot be classified as expiry-extending qualifying activity. For current real data, common buckets under `rule:v-point:regular-inactivity` remain in the list with unclassified kind, with computed expiry `unavailable` / `bucket_kind_unclassified`. Even synthetic verified regular buckets have unknown history input, so no date is derived. Store-limited buckets under `rule:v-point:fixed-expiry-lot` have `fixed_deadline_not_derivable`; their deadlines depend only on the provider display. V Point Pay and Mobile Suica SF have `rule_not_verified`. This is the intended consequence of not inventing expiry from the last transaction date.

<a id="4-simulationの限界"></a>

## 4. Simulation limits

- Search has `searchCoverage='bounded'`: depth (default 2) and candidate bounds mean not every path is examined. No path is called optimal; it returns `optimality: "not-determined"`.
- Reusing an offer, double-using a shared quota, cycling to a visited unit and reusing before credit (an offer that can only be applied for before the earlier hop's expected credit day) are rejected with reason codes.
- A path whose expected completion exceeds `requiredCompletionBy` is rejected rather than claimed to meet it.
- Unverified conditions are returned as separate `needs_rule_verification` candidates, not as impossibility.
- Fees accumulate each hop's `fixedFees` unchanged. Variable fees retain only `variableFeePolicyRef`; no amount is calculated.

- The offer set is read once and bounded by one reader page: `CONVERSION_OFFERS_SQL` reads
  `REWARD_PAGE_LIMIT + 1` (201) rows in `offer_id, version` order, the same read and bound
  (200) as the READ capture. Every `/offers/simulate` answer carries
  `offerCoverage: {limit: 200, truncated}`. When more than 200 offers match (all stored
  offers for a goal search, or the named offer's versions), nothing is computed: the answer
  is `simulation: null`, `searchCoverage: "bounded"`, `offerCoverage.truncated: true` and
  `reasonCodes: ["offer_set_too_large"]`, with no `paths` or `rejected` list, so an unread
  offer never reads as "no path" or as a shorter candidate list (INV05). The route does not
  page past the bound. An answer with `truncated: false` read every matching stored offer;
  the depth, candidate and expansion caps still make it `bounded`. A goal search answer also
  carries `expansions` (offer examinations used across every hop, against
  `budget.maxExpansions` = 500) and `stoppedBy`, the closed list of caps that ended the
  search early (`max_expansions`: an offer was left unexamined; `max_candidates`: a goal
  path was dropped or a state left unexpanded because the 8-candidate list was full). An
  empty `stoppedBy` means every offer was examined at every reachable state within the
  depth, so an empty `paths` is the offers' answer; a non-empty one means it may be the cap
  ([ADR 0049 amendment 2026-11-06](adr/0049-reward-expiry-basis.md#amendment-bounded-offer-set-for-offer-simulation)).
- Offer versions are append-only reference claims (`PRIMARY KEY(offer_id, version)`, a
  correction is a new version). No adoption pointer marks one version current, and the
  version text has no defined order, so the route never picks one. `version` (only with
  `offer`; without it the request is `400 invalid_query`) selects one stored version. A
  single simulation for an offer with more than one stored version and no `version` is
  `simulation: null`, `offerVersions` (every stored `offerId@version`, in reader order) and
  `reasonCodes: ["offer_version_not_selected"]`; a `version` that is not stored is
  `no_stored_offer`. A goal search treats each stored version as its own candidate, named
  by its `offerRef`.
- A goal search starts from one unit: `unit`, or, without it, the single distinct
  `fromUnitRef` of the matching offers (all stored offers, or the named offer's versions).
  The stored offers do not say which unit the caller holds, so the route never picks one.
  A goal search without `unit` over offers with more than one source unit answers
  `simulation: null`, `searchCoverage: "bounded"`, the `offerCoverage`, `sourceUnits`
  (every distinct source unit ref, in code-unit order) and
  `reasonCodes: ["source_unit_not_selected"]`, with no `paths` or `rejected` list. The
  list counts every source unit, including the goal unit when an offer leaves it, and
  whether or not a path from it reaches the goal. `unit` is taken as given and is not
  checked against the list. The bound check runs first, then `no_stored_offer`
  ([ADR 0049 amendment 2026-11-06](adr/0049-reward-expiry-basis.md#addendum-a-goal-searchs-starting-unit-is-chosen-by-the-caller)).

<a id="5-価値の扱い"></a>

## 5. Treatment of value

As addendum 08 §7 states, **points are not converted to yen and added to asset totals**.

- Provider-displayed value is retained as a Layer B claim, separate from an independently assigned price.
- A `cash-like redemption estimate` is generated only for a named offer and always carries that offer's eligibility/processing/rounding/cancellation policy references.
- `RewardValueClaim.netAssetEligible` is fixed as `false` by its type and cannot be assigned to an asset subtotal.
- `/api/v2/rewards/holdings` returns `valueModel.cashLikeRedemptionEstimate: null` with `reasonCode: "no_offer_named"`. No redemption amount exists without a named offer.

<a id="6-表とその性質"></a>

## 6. Tables and their properties

| Table                     | Property               | Notes                                                                                    |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `reward_programs`         | Append-only            | Seeds only programs whose unit is recorded in `docs/sources`                             |
| `expiry_rules`            | Append-only            | Corrections use a new version; CHECK forbids calculation families for unverified rules   |
| `conversion_offers`       | Append-only            | Integer ratios; multiple offers may cover the same interval                              |
| `reward_bucket_claims_v2` | Append-only (trigger)  | UNIQUE `claim_digest`; only published parse runs (trigger)                               |
| `membership_state_claims` | Append-only (trigger)  | A `provider` claim requires a parse run                                                  |
| `expiry_estimates`        | Rebuildable projection | Recomputing after complete deletion gives identical contents; moved to READ in U16 (§12) |
| `conversion_simulations`  | Rebuildable projection | Per input digest; no write from the simulation route; U16 stores reruns in READ (§12)    |

<a id="7-昇格ジョブ"></a>

## 7. Promotion job

`services/processor/src/reward-claims-job.ts`, controlled by `REWARD_CLAIMS_ENABLED` (default `"false"`). Like A10's reconciliation lane, `runScheduled` executes `reward_claims_sweep` only for `"1"` or `"true"`. When off, the lane itself is skipped, leaving existing `observation_sweep` / `identity_sweep` output unchanged.

- **Existing parsers are unchanged.** It only reads published `balance_observations` (past the publication gate) and promotes them to typed claims.
- Only the 3 sources whose units are recorded in `docs/sources` are covered.
  - V Point `available_point_bucket`: prefix `v-point:store-limited:` is `restricted`; common buckets are `unclassified`. Regular points also display expiry, so kind is not inferred from its presence. Public-UI labels for some enums are recorded but are not an established kind mapping for this promotion.
  - V Point `displayed_point_balance` (points earned last month): `qualification`, because it is not a holding.
  - V Point Pay `prepaid_balance_after_event` and Mobile Suica `sf_balance_after_transaction`: each is `regular` in its separate program. Both use JPY; `holding_kind` records their prepaid nature.
- **Observed expiry is retained unchanged.** Unreadable text is not discarded: it remains `{"kind":"unknown","reasonCode":"provider_expiry_unparsed"}`. No prediction is written.
- Idempotency uses UNIQUE `claim_digest = sha256(source fact reference + promotion release)` with `INSERT OR IGNORE`. Running a sweep twice adds nothing. Bumping the release promotes every row again under the new mapping.
- No extra cursor table is added; it reads `MAX(source_fact_id)` per release.

<a id="8-読み取りapi"></a>

## 8. Read API

`/api/v2/rewards/*` is served, and `/api/meta` advertises `rewardsV2` as true. `rewardsV2ReadModel` is `read-d1` only when a published, readable READ snapshot exists; otherwise it stays `none`, and expiry/simulations return 503. Holdings and offer simulation read CORE. `centralStoreCapabilities(env)` in `services/app/src/capabilities.ts` decides both advertisement and responses in one place. The same function overlays A10 `eventsV2` based only on whether `economic_event_revisions` exists. `/api/meta` never advertises a route the Worker refuses. An unknown reward path is 404; an unknown parameter on a known path is 400.

| route                                 | Contents                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/v2/rewards/holdings`        | Holdings per program: buckets, observed expiry, qualification measures, membership and exclusion reasons |
| `GET /api/v2/rewards/expiry`          | Expiry judgment per rule: state, reason codes, both provider display and derivation                      |
| `GET /api/v2/rewards/offers/simulate` | Pure query: a single simulation for a named offer, or depth-bounded route search for a goal              |

All are GET routes, with no writes or external communications. `Page<T>` = `{rows, coverage:{limit,truncated,nextOffset}}`.
`/offers/simulate` is not paged: it reads at most 200 offers and reports the bound in
`offerCoverage`, refusing with `offer_set_too_large` beyond it (§4).
`offset` traverses bucket rows. Reads see only claims linked to published parse runs, so rolling back a publication pointer also removes them from reward presentation.
The holdings and expiry pages are also the MCP page read `kogane.rewards.read`,
answered by the routes' own reader `readRewardRoute`
([agent API](agent-api.md#ui-read-pages)); no agent tool runs `/offers/simulate`.

## 9. UI

`/rewards` appears in navigation only with `rewardsV2`. For each program:

- Quantities always show the program's own unit. No yen-conversion field or cross-program total is shown.
- Buckets, observed expiry, qualification measures, membership and exclusions from totals have separate sections.
- Rows with unestablished expiry remain in the list as `期限未確認` ("expiry unconfirmed"); no row is dropped.
- Confidence is conveyed by words and reason codes, not color alone. Each row also shows `provider-observed` / `policy-estimated` / `期限未確認`.

- On a connection whose `/api/meta` does not advertise `rewardsV2`, the page says the
  connection does not offer rewards and sends no reward request.
- The page reads only the first page of each route (`offset=0`). When the server's
  page bound cuts a list, that block says how many rows it shows and that it did not
  read the rest; it offers no link to a next page.
- Each expiry panel is named by what tells it apart: a published-snapshot row by its
  programme, bucket kind, bucket reference and rule (the snapshot holds one row per
  bucket for every rule version of the programme); a provider display section by its
  programme and parent bucket; a legacy row by its rule and holding. The holding is
  left out of a snapshot row's name because a promoted bucket reference already names
  the provider account it came from.
  `apps/web/test/rewards.browser.test.ts` checks these three points.

<a id="10-デプロイ順とロールバック"></a>

## 10. Deployment order and rollback

The numbered sequence is the original first activation, not a current control.
Current releases follow [rollout controls](rollout.md#4-deployment-order), and
rollback targets must satisfy its current schema/resource/alarm floor. An old
component-level compatibility test does not authorize a pre-alarm production
rollback.

1. Apply `0033_reward_buckets.sql` (additive only; no existing table, trigger or index is touched).
2. Deploy `services/processor`. At that time, `REWARD_CLAIMS_ENABLED` stayed `"false"` until checks passed, then was set to `"1"` (or `"true"`) to begin promotion.
3. Deploy `services/app`. At that time, `REWARDS_V2_ENABLED` stayed `"false"` until claims accumulated, then was enabled. That App switch no longer exists.
4. The UI is served as assets of the same Worker.

Current rollback:

- No App flag hides reward routes. `/api/v2/rewards/*` is served and `/api/meta` advertises `rewardsV2` as true.
- Expiry and simulations without a snapshot still return 503.
- Stop promotion with processor `REWARD_CLAIMS_ENABLED="false"`. The entire lane is skipped, including its log line.
- Stop the writer with processor `REWARD_READ_PROJECTION_ENABLED=false`.
- Do not roll back the migration. `reward_bucket_claims_v2` is append-only and only references other tables.
- `expiry_estimates` and `conversion_simulations` are rebuildable projections and may be deleted entirely.

<a id="11-ローカルで確認したことしていないこと"></a>

## 11. What was and was not verified locally

Verification used synthetic data only. No real account or actual exchange was used.

- `packages/domain/test/rewards.test.ts` — Loads SC11–SC14 from `packages/domain/fixtures/v3` and runs the minimum AT43–AT54 input variations: lots/expiry-only buckets/unknown acquisition date, excluded transfers and missing history, tier changes without retroactive evidence, multiple campaign/member-only offers, completion across a deadline, cancellations with different return buckets/expiry, and rejection of cycles/shared quotas/depth bounds/reuse before credit; also month ends, leap days, date-only inputs and assumed time zones.
- `services/processor/test/reward-claims.test.ts` — Migration 0033 with existing rows, seed contents, append-only constraints, promotion idempotency, unpublished parse-run invisibility, unreadable expiry, and no lane execution or writes when the flag is off.
- `services/app/test/rewards-api.test.ts` — The retired App flag does not make routes 404; authentication, write refusal, holdings/expiry/simulation contents, 503 for expiry without a snapshot, and no simulation writes.
- `services/app/test/conformance.test.ts` — Capability/route correspondence.

Not verified: behavior on production D1/Workers, the current contents of real program terms, actual variation in provider expiry text, or real V Point `point_type` / `point_div` values.

<a id="read-second-stage"></a>

<a id="12-read-second-stageu16"></a>

## 12. READ second stage (U16)

Plan 04 §2 names `expiry_estimates` and `conversion_simulations` as stage-2 READ candidates under 1 condition: **the evaluation time, original request and rule can be fixed**. An unfixed expiry gives a different answer each time and is not a projection. U16 implements that condition. Processor-only `REWARD_READ_PROJECTION_ENABLED` (default `"false"`) controls the writer. It is enabled in production. App expiry/simulation projections always use READ; 0042 deletes the old CORE projections.

CORE `reward_programs` / `expiry_rules` / `conversion_offers` (versioned reference claims) and `reward_bucket_claims_v2` / `membership_state_claims` (provider/self-reported claims) **do not move**. As 04 §2 requires, they stay in CORE. Even if READ is lost entirely, not 1 claim or rule row is lost.

<a id="固定する入力"></a>

### Fixed inputs

The processor's `reward_read_projection` lane (after `reward_claims_sweep`, before `report_job`, then `decision_outbox`, with `audit_overflow` last) performs the optimistic capture from 05 §3.

```text
read revision r0
  → read rules, current bucket claims, membership, offers and stored simulations
read revision r1
r0 == r1 means fixed input; otherwise discard and retry (at most 3 times)
```

Fixed input `content` includes **evaluation time `evaluatedAt` and the evaluation calendar**. Its digest is the `content` digest, so **a changed evaluation time creates a different snapshot**; no existing snapshot is rewritten (G2-19). An interrupted build resumed on the next tick retains its own input time. Rereading the clock on resume would mix 2 "nows" within 1 snapshot.

Evaluation time is **the start of the UTC day containing the capture time (`YYYY-MM-DDT00:00:00.000Z`)**, not the capture instant itself. The evaluation calendar is `UTC:start-of-day:assumed` (`REWARD_EVALUATION_CALENDAR`), returned unchanged in snapshot `calendar_rule_id` and `/api/meta` `evaluationCalendar`. Rules consume civil dates rather than instants, so 2 ticks on the same UTC day have the same input (`unchanged`); the next day creates another snapshot. Raw instants would create identical-content snapshots every 5 minutes. Each rule's `deadline_calendar_ref` (for example `Asia/Tokyo:end-of-day:assumed`) is separate, determines **which day the deadline falls on**, and is fixed with the rule version. The evaluation boundary is a UTC day, not a JST date. `evaluated_at` is written only in this fixed-length form, so lexical comparison establishes that a pointer's evaluation time never moves backward within the same revision.

Canonical fixed-input bytes use the same `projection-inputs/<digest>/input.json` (DATA R2) as balances, referenced by CORE `projection_input_records`. No table, prefix or recording mechanism is added.

Every captured set is bounded and **refused rather than truncated** beyond its bound (`rule_set_too_large`, `claim_set_too_large`, `offer_set_too_large`). Fresh captures read no saved
simulations (`captureRewardInput` in `services/processor/src/reward-read-projection.ts`
captures an empty set), so there is no simulation bound.

CORE migration `0041_reward_revision_triggers.sql` adds the original 5 tables to the 0038 dependency ledger; `0077_reward_bucket_claims_v2.sql` adds the current claim table and revision trigger. Without these, r0/r1 capture cannot detect rule/claim changes. Projection outputs `expiry_estimates` / `conversion_simulations` remain **excluded** from the ledger, so outputs do not invalidate themselves. As a side effect, reward-claim promotion also marks balance-projection input as potentially changed. This over-detects rather than misses a change; balances recapture and settle on the same content digest.

<a id="readの表migration-0002_reward_readsql現在の期限行は-0004_reward_unclassified_bucketssql"></a>

### READ tables (migration `0002_reward_read.sql`; current expiry rows use `0004_reward_unclassified_buckets.sql`)

| Table                           | Contents                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reward_expiry_snapshots`       | 1 build: content key + attempt, fixed `evaluated_at`, evaluation calendar, rule-set digest, claim window, status, output digest, writer fence                                                                                               |
| `reward_expiry_estimates_v2`    | Expiry per bucket × rule version; date-only `expires_on`, quantities in the program's own unit, `row_digest`; READ migration `0004_reward_unclassified_buckets.sql` stores displayed/computed expiry evidence (§2.1) in `expiry_basis_json` |
| `reward_conversion_simulations` | Stored simulation reruns and whether they were reproducible                                                                                                                                                                                 |
| `reward_snapshot_input_refs`    | References/digests for rules, offers, claim sets, evaluation time and calendar (04 §3; no FK to CORE)                                                                                                                                       |
| `reward_snapshot_pointer`       | Published snapshot: revision never moves backward within the same epoch, nor evaluation time within the same revision                                                                                                                       |
| `reward_build_checkpoints`      | Resume position per stage (estimates / simulations), written in the same batch as its chunk                                                                                                                                                 |

All are STRICT, without FKs to CORE. `building` rows are invisible to readers through the pointer.

<a id="保存済みsimulationの扱いg2-20"></a>

### Stored simulations (G2-20)

A stored `conversion_simulations` row is rerun **only when its original request remains**.

| Situation                                              | Record                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `plan_json` retains `request`                          | `reproduced`: stores the result recomputed with fixed offers |
| Only a digest remains                                  | `not_reproducible` / `simulation_input_not_retained`         |
| The requested offer version is absent from fixed input | `not_reproducible` / `offer_not_in_fixed_input`              |

A digest is not input. A different calculation using today's offers is not called the same simulation.

There are currently no such rows. CORE `conversion_simulations` was deleted in 0042, and no writer wrote it before that either. Processor capture fixes stored simulations as an empty set (`services/processor/src/reward-read-projection.ts`). Consequently, `GET /api/v2/rewards/simulations` for a published snapshot returns empty `rows`, and the web screen does not call it (the points/prepaid-balance page has no stored-simulation section). A screen is added when a saving writer is built.

<a id="読み取り"></a>

### Reads

| route                                 | No published snapshot               | Published snapshot                                                                         |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/v2/rewards/expiry`          | `503 reward_read_model_unavailable` | Snapshot rows, with `evaluatedAt`, evaluation calendar and each row's `expiryBasis` (§2.1) |
| `GET /api/v2/rewards/simulations`     | `503 reward_read_model_unavailable` | Stored simulations and reproducibility                                                     |
| `GET /api/v2/rewards/holdings`        | CORE claims; independent of READ    | Same as left                                                                               |
| `GET /api/v2/rewards/offers/simulate` | Pure query, no writes               | Same as left                                                                               |

`expiryBasis` is returned only when stored evidence satisfies `validRewardExpiryBasis`; otherwise it is `null`. `null` means either that evidence was not recorded by a build before `reward-projection-v2` or that the stored value fails validation, not that no computed expiry exists. Evidence is not reconstructed from other columns. Validation also rejects `date` / `no-expiry` for unverified rule versions, `no-expiry` for bounded rules or families other than `none`, and `agree`/`disagree` with an unreadable displayed expiry. If CORE rule `applicability_json` has unreadable `tiers` / `validPeriod`, they are treated as a tier no claim meets and a period containing no day, not all tiers or always valid. The shared response validator (`api-validation.ts`) checks `RewardReadExpiryRow.expiryBasis` with `optional(nullable(validRewardExpiryBasis))`. Responses containing damaged evidence are rejected; `null` and an absent field (an App predating it) are accepted. The screen performs the same validation before rendering.

No published snapshot, a different epoch or a changed restriction returns 503 (`reward_read_model_unavailable` / `reward_read_model_context_changed` / `reward_read_model_restriction_changed`), not an empty success. Cursors use the same `{snapshotId, readInstanceId, filterDigest, position}` as U11. A cursor for another query is 400 `cursor_mismatch`; another instance or a retired snapshot is 410 `context_expired`. A different cursor is never reinterpreted as an offset.

Retained snapshots: a cursor that still names an older, retained snapshot is refused with the same
503 code as the published one when the CORE epoch or visibility revision that snapshot was captured
under has moved since (a use restriction invalidates the rows computed before it); it is never
continued. A rebuild that moves neither keeps such a cursor readable. The check uses the snapshot's
own capture, so a snapshot that a later build only re-verified at the new revision (status
`unchanged`) is still refused once a newer snapshot replaces it; a request without the cursor
reads the published one. `/api/v2/balances/*` cursors behave the same way.

`/api/meta` advertises capability `rewardsV2ReadModel` (`none` / `read-d1`), without `core-d1`. CORE never published a reward snapshot; an answer calculated per request is not a snapshot.

<a id="デプロイ順と復旧"></a>

### Deployment order and recovery

GitHub Actions applies CORE/READ migrations, then deploys processor and app in that order. Processor `REWARD_CLAIMS_ENABLED` and `REWARD_READ_PROJECTION_ENABLED` are enabled in production. The App reads published READ snapshots. The App's READ switch and fallback to CORE projections are retired.

To stop the writer, deploy processor `REWARD_READ_PROJECTION_ENABLED=false`. No App flag hides reward routes; expiry/simulations without a snapshot remain 503. Do not switch back to old CORE projections. Recover damaged READ using the [rebuild procedure](read-rebuild-runbook.md), retaining CORE claims/rules/offers, stored inputs and original evidence.

<a id="合成データで確認したことu16"></a>

### Synthetic verification (U16)

- `packages/storage-d1/test/reward-read-writer.test.ts` — Identical input rebuilds exactly; changing evaluation time produces a different snapshot; an existing snapshot's evaluation time/calendar are immutable (G2-19). A stored simulation retaining only its digest becomes `not_reproducible` (G2-20). Triggers reject rows naming unfixed rules/offers. Chunk resends, lease loss and forward-only pointers are covered.
- `services/processor/test/reward-read-projection.test.ts` — The lane on actual D1: flag-off prevents execution; lane ordering; builds lacking budget stay unpublished and resume with their own time; unstable capture becomes `pending`; dropping all READ reward tables does not change even 1 CORE claim/rule/offer/stored-input row and expires old cursors (G0-09).
- `services/app/test/rewards-v2-read.test.ts` — Route 503/cursors/reproducibility, `/api/meta` advertisement and 503 without READ.

<a id="合成データで確認したことadr-0049"></a>

### Synthetic verification (ADR 0049)

- `packages/domain/test/reward-expiry-basis.test.ts` — Agreement/disagreement between displayed and computed expiry, unreadable displays, fixed-expiry lots, verified no-expiry, tier-claim records, deterministic same-day starting activity, each of the 13 reason codes (no date, 0 or "expired" is returned; cases match the closed list), 2 rule versions across validity boundaries (v1's last day/v2's first day, a starting day before v2, a deadline after v1, unreadable periods), every rule × history × kind × quantity × display combination retaining all buckets and unchanged quantities, `deadline_passed` only on evidenced civil dates, and validator refusals.
- `packages/read-model/test/reward-projection.test.ts` — Reads migration-seeded rules unchanged and applies them to synthetic V Point/V Point Pay/Mobile Suica buckets with the §3 results. A program without even 1 rule gets no expiry rows or dates.
- `apps/web/test/rewards-contract.test.tsx` — Responses with `expiryBasis` pass the shared validator; damaged evidence is rejected; `null` and an absent field pass. The screen separates observation from derivation and labels missing/damaged evidence `記録がありません` ("no record").

Not verified: production D1/Workers, the current contents of actual provider terms, production-scale pagination performance, or real stored-simulation data (no saving writer exists and capture fixes an empty set).

[Vポイントサービス利用規約]: sources/v-point.md

[W09]: 設計レビュー追補99 W09（ANAマイル口座グループ）
[W10]: 同 W10（ANAマイル有効期限）
[W11]: 同 W11（Qantas Frequent Flyer terms）
[W12]: 同 W12（楽天ポイントのルール）
[W13]: 同 W13（JRE POINTからSuicaへチャージ・検索抜粋のみ）
[W14]: 同 W14（JAL Life Statusプログラム）

<a id="2026-10-09-現在の集合と種類未確認"></a>

### 2026-10-09: Current set and unclassified kinds

Current claims use `reward_bucket_claims_v2` / `reward-promotion-v2`. V Point ranks slots only within the same capture selected by shared `ELIGIBLE_VPOINT_RUNS`, without filling slots absent from an older array. Even an empty array can be an eligible run when history-page-0001 is published as a successful parse with 0 rows. This does not prove activity-window completeness.

`unclassified` retains quantity, displayed expiry and source refs. Consumable quantity is `missing / bucket_kind_unclassified`, conversion excludes it, and computed expiry is unavailable for the same reason. READ uses `reward_expiry_estimates_v2`. Old tables/claims stay as history; snapshots/continuations from an older release are not returned as newly established values. Normal migration, v2 re-promotion and READ rebuild are required, with expiry returning 503 meanwhile. Incomplete promotion does not seal input and returns `reward_promotion_incomplete`. Connecting real activity classification/windows/terms transitions is unimplemented; #554 is not complete. See the ADR0049 amendment (accepted when #632 merged).

<a id="v2への通常復旧の適用条件"></a>

### Conditions for normal recovery to v2

Apply CORE `0077` and READ `0004` to their respective databases, then distribute the same release's Processor/App through the normal release path. Processor `REWARD_CLAIMS_ENABLED=true`, `REWARD_READ_PROJECTION_ENABLED=true`, DB/READ/DATA bindings and normal ticks must be active. A sweep processes at most 500 candidates; READ stays pending until every candidate's promotion completes. New claims can be made from published observations, so this repair alone needs no new capture.

With a finite healthy candidate set, stable CORE revision/visibility and writer lease, and input sets within their bounds, the next tick retires incomplete old builds; later ticks capture current input, write chunks, seal and publish the pointer. Old active snapshots are refused with 503 meanwhile. After current-snapshot publication, a new request without a cursor recovers to 200. A cursor naming an older release stays 410, so pagination restarts from the beginning. No old-row rewrite, CORE deletion or fallback to old READ tables is needed.

Stopped flags, unapplied migrations, candidates the promoter keeps skipping, incomplete parse/publication, bound overflow, repeated revision/visibility changes or competing writer leases invalidate these recovery assumptions. Investigate using each closed code and promotion/pointer state. Continuing pending/503 is not success. This change has synthetic verification; production database migration, re-promotion, READ publication and HTTP recovery are unverified.

## Provider expiry subsets (ADR 0068)

J-POINT's observed total is one unclassified holding in points:j-point. Its provider-expiring portion is a non-additive display section attached to the exact total source fact, carried inside the same fixed READ snapshot. The portion is not another bucket and does not enter by-kind/consumable totals, conversion or a computed expiry rule. The total's expiry stays unattached; no remainder is computed.

Not-displayed and unknown sections are stored even with zero display rows, and the UI calls the expiry unconfirmed. They never become zero or no expiry. READ 0005 adds provider display sections/checkpoints and immutable snapshot section counts. projection-input-v3 / projection-v4 fixed inputs and output digests include the bounded provider stream; publication waits for verification of every stream. Existing rule-derived estimates retain their rule-reference guards and pagination. Provider sections in the expiry response are a complete bounded companion set from the same resolved sealed snapshot.

## Conversion module boundary

`packages/domain/src/reward-conversion.ts` owns pure conversion amount simulation
and bounded route traversal. `rewards.ts` re-exports its existing public API;
reward contracts, bucket eligibility, expiry and redemption remain in that file.
The extraction preserves derivation releases and returned values. The finite-domain
tests cover conversion amounts and all directed offer graphs on three units.

## Search eligibility at each hop

The route search checks an offer's validity and membership at its applied calendar
day, including after an earlier hop's processing delay. `conversion-search-v2`
requires a local date or containing civil period in a compatible zone. An instant,
unknown time or zone mismatch cannot establish a whole application day and yields
`needs_rule_verification`; a known day outside the offer's period yields
`offer_not_valid_at_clock`. A standing offer (`open-ended` validity, §1) covers its
first day and every later day, so it stays a route instead of becoming
`needs_rule_verification`; a `null` deadline is never passed.

The application deadline is checked at the same day (`conversion-search-v3`). A
local-date deadline is its own calendar day (an instant: see v4 below), and a later day is
`application_deadline_passed` (`reuse_before_credit` after an earlier hop when the wait
for its credit passed it: see v5 below). A period deadline is passed only after the
period ends; a day inside the period establishes nothing and yields `needs_rule_verification`. An `unknown` or malformed deadline also
yields `needs_rule_verification`: only `null` means no deadline (INV05). Before v3 an
unknown, malformed or period deadline was never checked, so such an offer was a route
on any day.

Since `conversion-search-v4` the deadline is judged on the application day's calendar
(the clock's zone), never an assumed one. A local-date or period deadline of another
zone is not compared and yields `needs_rule_verification`, as a validity of another
zone does (`zone_mismatch` in `compareTemporal`); a `null` zone on either side is
compatible. An instant deadline is one moment, read as its civil date on the
application day's calendar, or in its own zone when the clock names none
(`civilDateOfInstant`, [ADR 0056](adr/0056-as-of-price-fx-selection.md)): an earlier
day is a route, a later day is passed, and the day holding the instant is
`needs_rule_verification`, because a whole day cannot be before or after a moment
inside it. A zone the runtime does not know yields `needs_rule_verification`, never
UTC. An instant clock starts on its civil date in its own zone, and one whose zone the
runtime does not know is `clock_not_a_date`. In v3 a deadline's zone was ignored and an
instant was read by the date its offset was written in, so `2026-04-15T15:30:00Z`
(00:30 on the 16th in Tokyo) refused the whole Tokyo 16th, and a day holding an
instant deadline was always a route.

Since `conversion-search-v5` a deadline passed at a later hop's application day is
`reuse_before_credit` only when the same rule establishes it as not passed on the
clock's day, the first hop's application day: then the wait for the earlier hops' credits passed it, and only
applying before a credit arrives would meet it (§4). A deadline already passed on the
clock's day, or one the clock's day does not establish (a day inside a period deadline,
the day holding an instant deadline), is `application_deadline_passed` at any hop: the
passed deadline is established, the credit wait as its cause is not. Before v5 every
deadline passed after an earlier hop was `reuse_before_credit`, even one closed before
the clock's day or after a hop with no processing days.

An offer that cannot be taken at a state gets one `rejected` row, the first reason in
this order (an offer of another source unit is skipped with no row):
`same_offer_reuse`, `shared_quota_reuse`, `cycle_rejected`, `needs_rule_verification`
for an offer whose terms are not verified, then its validity on the application day
(`needs_rule_verification` or `offer_not_valid_at_clock`), membership
(`needs_rule_verification`), the application deadline (`needs_rule_verification`,
`application_deadline_passed` or `reuse_before_credit`), the caller's
`requiredCompletionBy` on the credit day (`needs_rule_verification` or
`completion_after_required_by`), and last the amount. The amount's row names the
refusal of `simulateConversion` (`quantity_not_exact`, `below_minimum`, `invalid_ratio`,
or the increment division's error code), never an adjustment made on the way to it
(v5): before v5 a balance rounded down to an increment below the minimum was
`rounded_down_to_increment`, and one capped below the minimum was `capped_by_maximum`. Because the first reason wins, a
review reason earlier in the order hides a refusal later in it: an offer whose
membership is unestablished and whose deadline has passed is `needs_rule_verification`
(a limit). The validity code says `at_clock` but is judged on the hop's application day,
so a validity that ends while an earlier hop's credit is awaited is
`offer_not_valid_at_clock`, not `reuse_before_credit` (a limit).

The `/offers/simulate` goal search starts from today's UTC date as a `local-date`
with zone `null` (`services/app/src/rewards-api.ts`). A `null` zone is compatible with
any offer zone, so an `Asia/Tokyo` offer is checked against the UTC date: between
00:00 and 09:00 JST that is the previous JST day, and an offer's first or last day,
and its application deadline, can be judged one day off at the boundary (a deadline
of the previous JST day is still a route then). This is a limit of the route's clock,
not of the search.

For a tier-limited offer, a provider membership claim must name the source program,
an admitted tier and a validity date/period covering that same day. Missing,
self-reported, another program's or out-of-period claims remain
`needs_rule_verification`, rather than proving entitlement. These rejection rows
describe an unestablished condition, not proof that a future application is impossible.
No provider terms, quota, fee or acceptance policy is inferred. The `/offers/simulate`
route passes no membership claims, so every tier-limited offer is
`needs_rule_verification` there until membership is supplied.

`CONVERSION_SEARCH_RELEASE` is part of the reward projection's build digest
(`packages/read-model/src/reward-projection.ts`), so each bump (`conversion-search-v2`, `-v3`, `-v4`, then `-v5`)
builds a new projection snapshot once; stored snapshots are not rewritten and no
migration is needed.

The exhaustive eligibility test covers all 960 combinations of ten validity shapes
(including three standing-offer shapes), eight membership scenarios,
restricted/unrestricted tiers, three application days and direct/two-hop routes. A
malformed stored validity establishes no day and stays `needs_rule_verification`.
`packages/domain/test/reward-conversion.test.ts` also pins unknown, malformed and
period deadlines, and synthetic day-boundary cases: a Tokyo or Los Angeles day against
a deadline of the other zone, an instant written in UTC that falls just after
midnight in Tokyo, a last-second instant read on both calendars, a zoneless clock, a
zone the runtime does not know, an instant clock, and the completion date below. It
also pins a second hop's deadline open on the clock's day, closed before it, and
unestablished on it (a period, an instant), and an amount refused below the minimum
after rounding down or a cap.

A caller's `requiredCompletionBy` follows the same rule on each hop's expected credit
day (v4): a later day is `completion_after_required_by`; a date or period of another
zone, a day inside a period, the day holding an instant, an `unknown` or malformed
value, and an instant read in a zone the runtime does not know (the clock's, or its
own when the clock names none) are `needs_rule_verification`. In v3 it was compared
as a bare day, ignoring its zone and reading an instant by the date its offset was
written in, and an `unknown`, malformed or period value was not checked at all. No caller passes one today
(`/offers/simulate` passes `null`).

An instant clock is reduced to its civil day: on the day holding an instant deadline
the result is `needs_rule_verification` even when the clock's moment is before the
deadline's. This is a limit; no caller passes an instant clock today.
