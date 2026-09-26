-- Provider prices promoted to price observations by a closed rule
-- (ADR 0020, docs/calculation-and-reports.md §1). Additive only: no existing
-- table, view, trigger or row is altered, and a Worker build that predates
-- this migration keeps working because it never names anything below.
--
-- 1. The SBI Shinsei exchange-rate board (parser
--    `sbi-shinsei-exchange-rate` 1.0.0) is a complete container: the newest
--    complete board supersedes the previous one under `coverage-v1`. The parser
--    refuses an empty board, and an empty one never replaces a board here
--    either.
INSERT INTO dataset_snapshot_policies (
  source_id, dataset, parser_name, policy_id, required_parser_version,
  replaces_previous_on_complete_empty, unit_scope
) VALUES (
  'sbi-shinsei-bank', 'exchange-rate', 'sbi-shinsei-exchange-rate', 'coverage-v1', '1.0.0',
  0, 'run'
);

-- 2. Which claim a promoted price came from. One row per price, written in the
--    same batch as the price: the rule that promoted it (the closed list in
--    packages/domain/src/price-sources.ts), the observation it read, that
--    observation's parse run, and the JSON path of the value inside it. The
--    parse run is what a reader joins to `published_parse_runs`, so a re-parse
--    supersedes a price without any row changing: old prices stay for the
--    contexts that used them (UC36/AT36). Append-only evidence, like the
--    price itself.
CREATE TABLE price_observation_claims (
 price_id TEXT PRIMARY KEY REFERENCES price_observations(id),
 rule_id TEXT NOT NULL CHECK(length(rule_id) BETWEEN 1 AND 128
  AND rule_id GLOB '[a-z]*' AND rule_id NOT GLOB '*[^a-z0-9-]*'),
 claim_kind TEXT NOT NULL CHECK(claim_kind IN ('valuation','position')),
 observation_id INTEGER NOT NULL CHECK(observation_id>0),
 parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
 json_path TEXT NOT NULL CHECK(length(json_path) BETWEEN 1 AND 256 AND json_path GLOB '$*'),
 created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 1 AND 64)
) STRICT;
-- One price per (rule, claim): a second promotion of the same claim is a no-op.
CREATE UNIQUE INDEX price_observation_claims_claim
 ON price_observation_claims(rule_id,claim_kind,observation_id,json_path);
-- Price selection joins a claim to its parse run's publication.
CREATE INDEX price_observation_claims_parse ON price_observation_claims(parse_run_id);
CREATE TRIGGER price_observation_claims_no_update BEFORE UPDATE ON price_observation_claims
BEGIN SELECT RAISE(ABORT,'price observation claims are append-only'); END;
CREATE TRIGGER price_observation_claims_no_delete BEFORE DELETE ON price_observation_claims
BEGIN SELECT RAISE(ABORT,'price observation claims are append-only'); END;
-- A claim names an observation of its own parse run, of its own kind.
CREATE TRIGGER price_observation_claims_observation BEFORE INSERT ON price_observation_claims
WHEN NOT (
 (NEW.claim_kind='valuation' AND EXISTS(SELECT 1 FROM valuation_observations v
   WHERE v.id=NEW.observation_id AND v.parse_run_id=NEW.parse_run_id))
 OR (NEW.claim_kind='position' AND EXISTS(SELECT 1 FROM position_observations po
   WHERE po.id=NEW.observation_id AND po.parse_run_id=NEW.parse_run_id))
)
BEGIN SELECT RAISE(ABORT,'price claim must name an observation of its parse run'); END;

-- 3. The promotion lane's scan progress per claim kind: the highest
--    observation id it has examined. Operational, mutable by design, and
--    outside the source-revision ledger: where the lane is does not change
--    anything a reader sees. An absent row reads as 0.
CREATE TABLE price_promotion_cursor (
 claim_kind TEXT PRIMARY KEY CHECK(claim_kind IN ('valuation','position')),
 last_observation_id INTEGER NOT NULL CHECK(last_observation_id>=0)
) STRICT;
