-- Parsed observations and the parse outputs beside them are append-only
-- (0017, 0024, 0025, 0027, 0034, 0053): each table has a `*_no_update` and a
-- `*_no_delete` trigger. SQLite's REPLACE conflict resolution deletes the
-- conflicting row without firing DELETE triggers while recursive_triggers is
-- off, so `INSERT OR REPLACE` with an existing key rewrote a stored
-- observation or amount past both guards. Acquisition history (0001), identity
-- (0018) and the decision log (0029) already refuse that; these tables did not.
--
-- Each trigger refuses an insert that would collide on any uniqueness path of
-- its table. No writer relies on a collision: the Processor inserts
-- observations, issues and coverage claims without an id, a parse input
-- reference once per new parse run, and prices and price claims behind
-- `WHERE NOT EXISTS` on their key. Nothing writes these tables with
-- `OR IGNORE`, `OR REPLACE` or `ON CONFLICT`, whose conflict a BEFORE INSERT
-- trigger would turn into an error. Additive only: no row, column or existing
-- trigger changes.
CREATE TRIGGER transaction_observations_no_replace BEFORE INSERT ON transaction_observations
WHEN EXISTS(SELECT 1 FROM transaction_observations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'transaction_observations replacement is forbidden'); END;

CREATE TRIGGER balance_observations_no_replace BEFORE INSERT ON balance_observations
WHEN EXISTS(SELECT 1 FROM balance_observations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'balance_observations replacement is forbidden'); END;

CREATE TRIGGER position_observations_no_replace BEFORE INSERT ON position_observations
WHEN EXISTS(SELECT 1 FROM position_observations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'position_observations replacement is forbidden'); END;

CREATE TRIGGER valuation_observations_no_replace BEFORE INSERT ON valuation_observations
WHEN EXISTS(SELECT 1 FROM valuation_observations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'valuation_observations replacement is forbidden'); END;

CREATE TRIGGER scheduled_payment_observations_no_replace BEFORE INSERT ON scheduled_payment_observations
WHEN EXISTS(SELECT 1 FROM scheduled_payment_observations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'scheduled_payment_observations replacement is forbidden'); END;

CREATE TRIGGER observation_decimals_no_replace BEFORE INSERT ON observation_decimal_values
WHEN EXISTS(SELECT 1 FROM observation_decimal_values
  WHERE kind=NEW.kind AND observation_id=NEW.observation_id AND policy_version=NEW.policy_version)
BEGIN SELECT RAISE(ABORT,'versioned decimal value replacement is forbidden'); END;

CREATE TRIGGER parse_issues_no_replace BEFORE INSERT ON parse_issues
WHEN EXISTS(SELECT 1 FROM parse_issues WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'parse_issues replacement is forbidden'); END;

CREATE TRIGGER parse_coverage_claims_no_replace BEFORE INSERT ON parse_coverage_claims
WHEN EXISTS(SELECT 1 FROM parse_coverage_claims
  WHERE id=NEW.id OR (parse_run_id=NEW.parse_run_id AND claim_id=NEW.claim_id))
BEGIN SELECT RAISE(ABORT,'parse_coverage_claims replacement is forbidden'); END;

CREATE TRIGGER parse_input_references_no_replace BEFORE INSERT ON parse_input_references
WHEN EXISTS(SELECT 1 FROM parse_input_references WHERE parse_run_id=NEW.parse_run_id)
BEGIN SELECT RAISE(ABORT,'parse_input_references replacement is forbidden'); END;

CREATE TRIGGER price_observations_no_replace BEFORE INSERT ON price_observations
WHEN EXISTS(SELECT 1 FROM price_observations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'price_observations replacement is forbidden'); END;

CREATE TRIGGER price_observation_claims_no_replace BEFORE INSERT ON price_observation_claims
WHEN EXISTS(SELECT 1 FROM price_observation_claims
  WHERE price_id=NEW.price_id OR (rule_id=NEW.rule_id AND claim_kind=NEW.claim_kind
    AND observation_id=NEW.observation_id AND json_path=NEW.json_path))
BEGIN SELECT RAISE(ABORT,'price_observation_claims replacement is forbidden'); END;
