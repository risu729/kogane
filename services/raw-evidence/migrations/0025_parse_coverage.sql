-- Parser coverage contract (design review D01/D13, A03). Additive: Layer A
-- and the existing Layer B tables are untouched, and a Worker that predates
-- this migration keeps publishing parse runs exactly as before. New rows are
-- written only by parsers that emit contract v2 issues and coverage claims;
-- nothing here backfills or synthesizes a claim for an existing parse run.

-- What a parser could not read, typed. `message` is for people and is never
-- an adoption condition; `code` and `impact` are. Append-only like every
-- Layer B fact table.
CREATE TABLE parse_issues (
  id INTEGER PRIMARY KEY,
  parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
  code TEXT NOT NULL CHECK(code IN (
    'container_unreadable','row_unreadable','unknown_fields_preserved',
    'exact_decimal_without_minor_units')),
  locator TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','error')),
  impact TEXT NOT NULL CHECK(impact IN ('none','field','membership','whole-artifact')),
  message TEXT NOT NULL
) STRICT;
CREATE INDEX parse_issues_parse_run ON parse_issues(parse_run_id);
CREATE TRIGGER parse_issues_no_update BEFORE UPDATE ON parse_issues
BEGIN SELECT RAISE(ABORT,'parse_issues is append-only'); END;
CREATE TRIGGER parse_issues_no_delete BEFORE DELETE ON parse_issues
BEGIN SELECT RAISE(ABORT,'parse_issues is append-only'); END;

-- What scope a parse proves. One row per claim of a parse run; the snapshot
-- policy `coverage-v1` reads `scope_key`, `completeness` and
-- `membership_complete` and nothing else. The parent fetch run outcome is
-- recorded on the claim so a later unit-scoped policy (PR-14) can tell a
-- rescued unit of a partial run from a fully successful run.
CREATE TABLE parse_coverage_claims (
  id INTEGER PRIMARY KEY,
  parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
  claim_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('complete-container','window','event-feed','evidence-only')),
  completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial','unknown')),
  membership_complete INTEGER NOT NULL CHECK(membership_complete IN (0,1)),
  observed_count INTEGER NOT NULL CHECK(observed_count >= 0),
  expected_count INTEGER CHECK(expected_count IS NULL OR expected_count >= 0),
  evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
  policy_version TEXT NOT NULL,
  failure_cause TEXT CHECK(failure_cause IS NULL OR failure_cause IN (
    'auth_failed','fetch_failed','page_missing','container_unreadable',
    'row_unreadable','collector_error')),
  absence_meaning TEXT NOT NULL CHECK(absence_meaning IN (
    'complete-empty','window-no-events','not-observed','unknown','not-applicable')),
  parent_run_status TEXT NOT NULL CHECK(parent_run_status IN ('success','partial','failed')),
  parent_run_failure_count INTEGER NOT NULL CHECK(parent_run_failure_count >= 0),
  UNIQUE(parse_run_id, claim_id),
  CHECK(membership_complete = 0 OR completeness = 'complete'),
  CHECK(membership_complete = 0 OR failure_cause IS NULL),
  CHECK(failure_cause IS NULL OR completeness <> 'complete'),
  CHECK(observed_count > 0 OR absence_meaning <> 'not-applicable'),
  CHECK(observed_count = 0 OR absence_meaning = 'not-applicable')
) STRICT;
CREATE INDEX parse_coverage_claims_parse_run ON parse_coverage_claims(parse_run_id, scope_key);
CREATE TRIGGER parse_coverage_claims_no_update BEFORE UPDATE ON parse_coverage_claims
BEGIN SELECT RAISE(ABORT,'parse_coverage_claims is append-only'); END;
CREATE TRIGGER parse_coverage_claims_no_delete BEFORE DELETE ON parse_coverage_claims
BEGIN SELECT RAISE(ABORT,'parse_coverage_claims is append-only'); END;

-- Which selection policy decides the current snapshot of a container dataset.
-- Operational state (mutable): switching a row to 'coverage-v1' or back to
-- 'legacy-warning-compat-v1' is the rollout and the rollback. The join in
-- snapshot-query.ts is on (parser_name, dataset), exactly as the former
-- SNAPSHOT_DATASETS constant joined; source_id records the source whose
-- parser accepts the dataset and is not a join key, because the parser's own
-- `accepts` already binds the source and synthetic fixtures use other ids.
--   policy_version: revision of this row's policy parameters.
--   required_parser_version: only parses at exactly this version participate
--     (the pagination-validating foreign position parser); NULL means any.
--   replaces_previous_on_complete_empty: whether a complete-empty claim
--     supersedes the previous snapshot; read by coverage-v1 only, the legacy
--     policy always lets an empty successful parse replace.
--   unit_scope: 'run' requires the whole parent run to have succeeded;
--     'unit' is reserved for unit-independent-v1 (PR-14) and is not read yet.
CREATE TABLE dataset_snapshot_policies (
  source_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  parser_name TEXT NOT NULL,
  policy_id TEXT NOT NULL CHECK(policy_id IN ('legacy-warning-compat-v1','coverage-v1')),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version >= 1),
  required_parser_version TEXT,
  replaces_previous_on_complete_empty INTEGER NOT NULL DEFAULT 1
    CHECK(replaces_previous_on_complete_empty IN (0,1)),
  unit_scope TEXT NOT NULL DEFAULT 'run' CHECK(unit_scope IN ('run','unit')),
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(parser_name, dataset)
) STRICT;

-- Seed: every current SNAPSHOT_DATASETS row on the legacy policy, so nothing
-- changes on deploy. A test compares this seed with the TypeScript constant.
INSERT INTO dataset_snapshot_policies
  (source_id, dataset, parser_name, policy_id, required_parser_version) VALUES
  ('sbi-securities','domestic-cash-positions','sbi-domestic-cash-positions','legacy-warning-compat-v1',NULL),
  ('sbi-securities','foreign-cash-positions','sbi-foreign-cash-positions','legacy-warning-compat-v1','0.3.0'),
  ('sbi-securities','account-assets-current','sbi-account-assets-current','legacy-warning-compat-v1',NULL),
  ('sbi-securities','foreign-cash-balances','sbi-foreign-cash-balances','legacy-warning-compat-v1',NULL),
  ('sbi-vc-trade','position-summary','sbi-vc-position-summary','legacy-warning-compat-v1',NULL),
  ('sbi-vc-trade','cash-balances','sbi-vc-cash-balances','legacy-warning-compat-v1',NULL),
  ('sbi-vc-trade','account-margin','sbi-vc-account-margin','legacy-warning-compat-v1',NULL),
  ('sbi-shinsei-bank','top-accounts-balance-and-activity','sbi-shinsei-top-balances-and-activity','legacy-warning-compat-v1',NULL),
  ('sbi-shinsei-bank','yen-deposit-account','sbi-shinsei-yen-deposit-account','legacy-warning-compat-v1',NULL),
  ('sony-bank','gross-balance','sony-bank-gross-balance','legacy-warning-compat-v1',NULL),
  ('smbc-bank','balance-normalized','smbc-direct-balance','legacy-warning-compat-v1',NULL);
