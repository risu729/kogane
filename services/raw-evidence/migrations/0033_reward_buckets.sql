-- Reward programmes, restricted buckets, expiry rules and conversion offers
-- (architecture addendum 08; plan step A11). Additive: no existing table,
-- trigger or index is touched, and a Worker that predates this migration keeps
-- parsing, publishing and reading exactly as before. Nothing here changes what
-- /api/balances returns.
--
-- Four layers are deliberately kept apart.
--   * reward_programs / expiry_rules / conversion_offers are versioned
--     REFERENCE claims: what a published rule or offer says. Append-only; a
--     correction is a new version, never an overwrite (INV01, INV09).
--   * reward_bucket_claims / membership_state_claims are typed SOURCE claims
--     promoted from already-published balance observations. Append-only, one
--     row per (source fact, promotion release) enforced by claim_digest.
--   * expiry_estimates / conversion_simulations are REBUILDABLE projections.
--     They are mutable operational state: dropping every row and recomputing
--     from the claims and rules above must produce the same content.
--
-- A programme rule is only 'verified' when a docs/sources record cites the
-- provider's own terms. Everything else is stored as
-- verification='needs-rule-verification' with family='unsupported', enforced
-- by a CHECK so an unverified rule can never be used to compute a deadline
-- (docs/rewards.md).

-- ── reference: programmes ────────────────────────────────────────────
-- unit_ref is the programme's own counting unit. Two programmes never share
-- one even when both display "ポイント"; a prepaid yen balance keeps the JPY
-- unit and records its prepaid nature on the programme, so it is never merged
-- with a bank deposit (addendum 05 §3).
CREATE TABLE reward_programs (
  program_id               TEXT PRIMARY KEY,
  institution_ref          TEXT NOT NULL,
  program_ref              TEXT NOT NULL,
  source_id                TEXT NOT NULL,
  unit_ref                 TEXT NOT NULL,
  holding_kind             TEXT NOT NULL CHECK(holding_kind IN ('reward-points','prepaid-balance')),
  terms_evidence_refs_json TEXT NOT NULL,
  release_id               TEXT NOT NULL,
  recorded_at              TEXT NOT NULL
) STRICT;
CREATE INDEX reward_programs_source ON reward_programs(source_id,program_id);
CREATE TRIGGER reward_programs_no_update BEFORE UPDATE ON reward_programs
BEGIN SELECT RAISE(ABORT,'reward_programs is append-only'); END;
CREATE TRIGGER reward_programs_no_delete BEFORE DELETE ON reward_programs
BEGIN SELECT RAISE(ABORT,'reward_programs is append-only'); END;

-- ── reference: expiry rules ──────────────────────────────────────────
-- family is the calculation shape, not the answer. 'none' asserts that the
-- terms confirm no expiry; it is not the same as an unknown deadline, which is
-- family='unsupported'. deadline_calendar_ref carries the IANA zone, the day
-- boundary and how the zone was established, kept separate from any display
-- zone (addendum 06 §2).
CREATE TABLE expiry_rules (
  rule_id                        TEXT NOT NULL,
  version                        TEXT NOT NULL,
  family                         TEXT NOT NULL CHECK(family IN ('fixed-lot','inactivity','fixed-account','none','unsupported')),
  program_id                     TEXT NOT NULL REFERENCES reward_programs(program_id),
  applicability_json             TEXT NOT NULL,
  qualifying_activity_policy_ref TEXT,
  deadline_calendar_ref          TEXT NOT NULL,
  priority_policy_ref            TEXT,
  evidence_refs_json             TEXT NOT NULL,
  verification                   TEXT NOT NULL CHECK(verification IN ('verified','needs-rule-verification')),
  recorded_at                    TEXT NOT NULL,
  -- An unverified rule may only ever be 'unsupported': it can carry evidence
  -- and applicability, but never a computable deadline family.
  CHECK(verification = 'verified' OR family = 'unsupported'),
  -- An inactivity rule without a qualifying-activity policy would silently
  -- fall back to max(activity date), which SC12 forbids.
  CHECK(family <> 'inactivity' OR qualifying_activity_policy_ref IS NOT NULL),
  PRIMARY KEY(rule_id,version)
) STRICT;
CREATE INDEX expiry_rules_program ON expiry_rules(program_id,rule_id,version);
CREATE TRIGGER expiry_rules_no_update BEFORE UPDATE ON expiry_rules
BEGIN SELECT RAISE(ABORT,'expiry_rules is append-only; publish a new version'); END;
CREATE TRIGGER expiry_rules_no_delete BEFORE DELETE ON expiry_rules
BEGIN SELECT RAISE(ABORT,'expiry_rules is append-only; publish a new version'); END;

-- ── reference: conversion offers ─────────────────────────────────────
-- Exactly the contract of addendum 08 §5. The ratio is two integers, never a
-- decimal rate: overwriting a rate would destroy the basis of past exchanges,
-- so several offers between the same pair of programmes coexist by version.
CREATE TABLE conversion_offers (
  offer_id                        TEXT NOT NULL,
  version                         TEXT NOT NULL,
  source_program_ref              TEXT NOT NULL,
  destination_program_ref         TEXT NOT NULL,
  from_unit_ref                   TEXT NOT NULL,
  to_unit_ref                     TEXT NOT NULL,
  ratio_numerator                 TEXT NOT NULL CHECK(ratio_numerator GLOB '[0-9]*' AND ratio_numerator NOT GLOB '*[^0-9]*'),
  ratio_denominator               TEXT NOT NULL CHECK(ratio_denominator GLOB '[1-9]*' AND ratio_denominator NOT GLOB '*[^0-9]*'),
  minimum_coefficient             TEXT NOT NULL,
  minimum_scale                   INTEGER NOT NULL,
  increment_coefficient           TEXT NOT NULL,
  increment_scale                 INTEGER NOT NULL,
  maximum_per_request_coefficient TEXT,
  maximum_per_request_scale       INTEGER,
  shared_quota_ref                TEXT,
  fixed_fees_json                 TEXT NOT NULL,
  variable_fee_policy_ref         TEXT,
  eligibility_policy_ref          TEXT NOT NULL,
  eligible_bucket_kinds_json      TEXT NOT NULL,
  eligible_restriction_refs_json  TEXT NOT NULL,
  eligible_tiers_json             TEXT,
  valid_time_json                 TEXT NOT NULL,
  application_deadline_json       TEXT NOT NULL,
  processing_policy_ref           TEXT NOT NULL,
  processing_days                 INTEGER NOT NULL CHECK(processing_days >= 0),
  rounding_policy_ref             TEXT NOT NULL,
  rounding_scale                  INTEGER NOT NULL CHECK(rounding_scale >= 0),
  rounding_mode                   TEXT NOT NULL CHECK(rounding_mode IN ('down','up','floor','ceiling','half-up','half-even')),
  cancellation_policy_ref         TEXT,
  evidence_refs_json              TEXT NOT NULL,
  verification                    TEXT NOT NULL CHECK(verification IN ('verified','needs-rule-verification')),
  recorded_at                     TEXT NOT NULL,
  CHECK((maximum_per_request_coefficient IS NULL) = (maximum_per_request_scale IS NULL)),
  PRIMARY KEY(offer_id,version)
) STRICT;
CREATE INDEX conversion_offers_route ON conversion_offers(from_unit_ref,to_unit_ref,offer_id,version);
CREATE TRIGGER conversion_offers_no_update BEFORE UPDATE ON conversion_offers
BEGIN SELECT RAISE(ABORT,'conversion_offers is append-only; publish a new version'); END;
CREATE TRIGGER conversion_offers_no_delete BEFORE DELETE ON conversion_offers
BEGIN SELECT RAISE(ABORT,'conversion_offers is append-only; publish a new version'); END;

-- ── typed source claims: reward buckets ──────────────────────────────
-- Promoted from an already-published balance observation, never parsed again
-- and never written by a parser. observed_expiry_json is exactly the date the
-- provider displayed; a predicted deadline lives in expiry_estimates instead.
-- claim_digest = sha256(source fact reference + promotion release), so the
-- promotion job is idempotent and a release bump promotes afresh.
CREATE TABLE reward_bucket_claims (
  id                    INTEGER PRIMARY KEY,
  claim_digest          TEXT NOT NULL UNIQUE,
  parse_run_id          INTEGER NOT NULL REFERENCES parse_runs(id),
  source_fact_kind      TEXT NOT NULL CHECK(source_fact_kind IN ('balance','transaction','position','valuation')),
  source_fact_id        INTEGER NOT NULL,
  program_id            TEXT NOT NULL REFERENCES reward_programs(program_id),
  holding_ref           TEXT NOT NULL,
  bucket_ref            TEXT NOT NULL,
  bucket_kind           TEXT NOT NULL CHECK(bucket_kind IN ('regular','restricted','time-limited','pending-award','qualification')),
  restriction_refs_json TEXT NOT NULL,
  unit_ref              TEXT NOT NULL,
  -- decimal-v1 projection, reused unchanged: an unparsed quantity keeps its
  -- status and never becomes zero (INV05).
  quantity_coefficient  TEXT,
  quantity_scale        INTEGER,
  quantity_status       TEXT NOT NULL CHECK(quantity_status IN ('exact','missing','unparsed','conflict')),
  observed_expiry_json  TEXT,
  observed_at           TEXT NOT NULL,
  promotion_release     TEXT NOT NULL,
  recorded_at           TEXT NOT NULL,
  CHECK(quantity_status <> 'exact' OR (quantity_coefficient IS NOT NULL AND quantity_scale IS NOT NULL))
) STRICT;
CREATE INDEX reward_bucket_claims_holding ON reward_bucket_claims(program_id,holding_ref,id);
CREATE INDEX reward_bucket_claims_parse_run ON reward_bucket_claims(parse_run_id);
CREATE INDEX reward_bucket_claims_fact ON reward_bucket_claims(source_fact_kind,source_fact_id);
CREATE TRIGGER reward_bucket_claims_no_update BEFORE UPDATE ON reward_bucket_claims
BEGIN SELECT RAISE(ABORT,'reward_bucket_claims is append-only'); END;
CREATE TRIGGER reward_bucket_claims_no_delete BEFORE DELETE ON reward_bucket_claims
BEGIN SELECT RAISE(ABORT,'reward_bucket_claims is append-only'); END;
-- Only a published parse run may be promoted: a candidate or superseded parse
-- must never appear in a reward read (docs/publication-gate.md).
CREATE TRIGGER reward_bucket_claims_requires_published BEFORE INSERT ON reward_bucket_claims
WHEN NOT EXISTS(SELECT 1 FROM published_parse_runs p WHERE p.parse_run_id=NEW.parse_run_id)
BEGIN SELECT RAISE(ABORT,'reward bucket claims require a published parse run'); END;

-- ── typed source claims: membership ──────────────────────────────────
-- A tier is claimed for a period. A provider-confirmed tier and a
-- self-reported one are different claims and are never merged.
CREATE TABLE membership_state_claims (
  id                 INTEGER PRIMARY KEY,
  claim_digest       TEXT NOT NULL UNIQUE,
  parse_run_id       INTEGER REFERENCES parse_runs(id),
  program_id         TEXT NOT NULL REFERENCES reward_programs(program_id),
  holding_ref        TEXT NOT NULL,
  tier               TEXT NOT NULL,
  valid_json         TEXT NOT NULL,
  source             TEXT NOT NULL CHECK(source IN ('provider','self-reported')),
  evidence_refs_json TEXT NOT NULL,
  recorded_at        TEXT NOT NULL,
  CHECK(source <> 'provider' OR parse_run_id IS NOT NULL)
) STRICT;
CREATE INDEX membership_state_claims_holding ON membership_state_claims(program_id,holding_ref,id);
CREATE TRIGGER membership_state_claims_no_update BEFORE UPDATE ON membership_state_claims
BEGIN SELECT RAISE(ABORT,'membership_state_claims is append-only'); END;
CREATE TRIGGER membership_state_claims_no_delete BEFORE DELETE ON membership_state_claims
BEGIN SELECT RAISE(ABORT,'membership_state_claims is append-only'); END;

-- ── rebuildable projections ──────────────────────────────────────────
-- Not evidence: every row can be dropped and recomputed from the claims and
-- rules above by the domain functions, so these two tables are mutable.
-- state and uncertainty codes travel with the numbers; a reader that shows a
-- deadline must show them too (addendum 08 §8).
CREATE TABLE expiry_estimates (
  id                      INTEGER PRIMARY KEY,
  holding_ref             TEXT NOT NULL,
  rule_id                 TEXT NOT NULL,
  rule_version            TEXT NOT NULL,
  context_id              TEXT NOT NULL,
  state                   TEXT NOT NULL CHECK(state IN ('computed','partial','conflict','needs-rule-verification')),
  expiring_buckets_json   TEXT NOT NULL,
  uncertainty_codes_json  TEXT NOT NULL,
  source_expiry_refs_json TEXT NOT NULL,
  policy_release          TEXT NOT NULL,
  computed_at             TEXT NOT NULL,
  UNIQUE(holding_ref,rule_id,rule_version,context_id)
) STRICT;
CREATE INDEX expiry_estimates_holding ON expiry_estimates(holding_ref,id);

CREATE TABLE conversion_simulations (
  id              INTEGER PRIMARY KEY,
  input_digest    TEXT NOT NULL UNIQUE,
  plan_json       TEXT NOT NULL,
  search_coverage TEXT NOT NULL CHECK(search_coverage IN ('complete','bounded')),
  policy_release  TEXT NOT NULL,
  computed_at     TEXT NOT NULL
) STRICT;

-- ── seeds ────────────────────────────────────────────────────────────
-- Only programmes whose unit is documented in docs/sources are seeded. No
-- conversion offer is seeded: the one candidate route in the review
-- (JRE POINT to Suica) is search-excerpt evidence only, so it would have to
-- be needs-rule-verification and cannot be simulated (docs/rewards.md).
INSERT INTO reward_programs(program_id,institution_ref,program_ref,source_id,unit_ref,holding_kind,terms_evidence_refs_json,release_id,recorded_at) VALUES
 ('program:v-point','institution:smfg','v-point','v-point','points:v-point','reward-points','["docs/sources/v-point.md#4.1"]','reward-model-v1','2026-09-09T00:00:00.000Z'),
 ('program:v-point-pay','institution:smfg','v-point-pay','v-point-pay','JPY','prepaid-balance','["docs/sources/v-point.md#5.1"]','reward-model-v1','2026-09-09T00:00:00.000Z'),
 ('program:mobile-suica-sf','institution:jr-east','mobile-suica-sf','mobile-suica','JPY','prepaid-balance','["docs/sources/mobile-suica.md"]','reward-model-v1','2026-09-09T00:00:00.000Z');

-- V Point regular points: docs/sources/v-point.md §4.1 records the provider's
-- own terms (Vポイントサービス利用規約) — one year from the last movement of a
-- regular point, where store-limited earning and spending do not extend it.
-- That is enough for family='inactivity' and verification='verified'. The
-- deadline time zone is NOT stated in those terms, so the calendar reference
-- records it as assumed and every estimate carries deadline_zone_assumed.
INSERT INTO expiry_rules(rule_id,version,family,program_id,applicability_json,qualifying_activity_policy_ref,deadline_calendar_ref,priority_policy_ref,evidence_refs_json,verification,recorded_at) VALUES
 ('rule:v-point:regular-inactivity','v1','inactivity','program:v-point',
  '{"bucketKinds":["regular"],"tiers":null,"validPeriod":null}',
  'policy:v-point:qualifying-activity:v1','Asia/Tokyo:end-of-day:assumed',
  'policy:v-point:consumption-order:v1','["docs/sources/v-point.md#4.1"]','verified','2026-09-09T00:00:00.000Z'),
 -- Fixed-expiry and store-limited points: the same terms record that each
 -- carries its own date and that earning or spending it does not extend that
 -- date. The date itself is only ever the one the provider displays.
 ('rule:v-point:fixed-expiry-lot','v1','fixed-lot','program:v-point',
  '{"bucketKinds":["time-limited","restricted"],"tiers":null,"validPeriod":null}',
  NULL,'Asia/Tokyo:end-of-day:assumed','policy:v-point:consumption-order:v1',
  '["docs/sources/v-point.md#4.1"]','verified','2026-09-09T00:00:00.000Z'),
 -- V Point Pay: docs/sources/v-point.md §5.1 cites a validity FAQ but records
 -- that the wording may already have changed and must be re-checked, so the
 -- rule stays unsupported and no deadline is computed from it.
 ('rule:v-point-pay:prepaid-validity','v1','unsupported','program:v-point-pay',
  '{"bucketKinds":["regular"],"tiers":null,"validPeriod":null}',
  NULL,'Asia/Tokyo:end-of-day:assumed',NULL,
  '["docs/sources/v-point.md#5.1"]','needs-rule-verification','2026-09-09T00:00:00.000Z'),
 -- Mobile Suica SF: docs/sources/mobile-suica.md documents the balance and
 -- history routes but cites no validity terms at all.
 ('rule:mobile-suica-sf:validity','v1','unsupported','program:mobile-suica-sf',
  '{"bucketKinds":["regular"],"tiers":null,"validPeriod":null}',
  NULL,'Asia/Tokyo:end-of-day:assumed',NULL,
  '["docs/sources/mobile-suica.md"]','needs-rule-verification','2026-09-09T00:00:00.000Z');
