-- The second stage of the READ database: reward expiry estimates and the
-- replay of saved conversion simulations (unified plan 04 §2, 05 §3–§7; U16).
--
-- Chapter 04 §2 lists `expiry_estimates` and `conversion_simulations` as READ
-- candidates under one condition: **the evaluation time, the original request
-- and the rule have to be fixed**. A deadline that is recomputed from "now"
-- every time it is read is not a projection of anything; it is a new answer
-- each request, and no reader can be told which one they are looking at. So
-- this file adds nothing that could be recomputed implicitly:
--
--   * `evaluated_at` is part of the snapshot's input content, not a timestamp
--     of when the row happened to be written. A different instant is a
--     different input digest, a different content key and therefore a
--     different snapshot — never an update of an existing one (G2-19);
--   * `calendar_rule_id` and `rule_set_digest` fix the calendar and the exact
--     set of `(rule_id, version)` pairs the deadlines were computed under, so
--     "the same rule" is a checkable statement and not an assumption;
--   * a saved simulation is replayed only when its request was retained. A row
--     that kept nothing but a digest is recorded as `not_reproducible` with a
--     reason code; it is never recomputed under today's offers and presented
--     as the same simulation (G2-20).
--
-- The CORE tables of migration 0033 are untouched by this file and stay where
-- they are: `reward_programs`, `expiry_rules` and `conversion_offers` are
-- versioned reference claims, and `reward_bucket_claims` /
-- `membership_state_claims` are provider claims. Losing this database costs
-- the estimates and the replays, never a claim or a rule (04 §2).
--
-- The same three rules as the baseline hold here: no foreign key names a CORE
-- table, every table is STRICT, and a reader that goes through
-- `reward_snapshot_pointer` can never observe a build in progress.
--
-- Identity is the baseline's, with the evaluation input inside the content:
--
--   content_key = sha256(input_digest ‖ build_digest ‖ contract_version)
--   snapshot_id = sha256(content_key ‖ ':' ‖ attempt ‖ ':' ‖ contract_version)
--
-- where `input_digest` is the digest of the captured content, and that content
-- carries the evaluation instant, the calendar, the rules, the claims, the
-- offers and the saved requests. `attempt` exists for the same reason it does
-- in the baseline: content whose builds were all retired can be built again.

-- One build of the reward projection under one fixed evaluation input.
CREATE TABLE reward_expiry_snapshots (
  snapshot_id TEXT PRIMARY KEY
    CHECK(length(snapshot_id)=64 AND snapshot_id NOT GLOB '*[^0-9a-f]*'),
  content_key TEXT NOT NULL
    CHECK(length(content_key)=64 AND content_key NOT GLOB '*[^0-9a-f]*'),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  input_digest TEXT NOT NULL
    CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  build_digest TEXT NOT NULL
    CHECK(length(build_digest)=64 AND build_digest NOT GLOB '*[^0-9a-f]*'),
  contract_version TEXT NOT NULL CHECK(length(contract_version) BETWEEN 1 AND 64),
  read_instance_id TEXT NOT NULL CHECK(length(read_instance_id) BETWEEN 8 AND 64),
  -- The evaluation instant every deadline in this snapshot was computed
  -- against (05 §3). It is inside the input content, so it cannot be changed
  -- for an existing build: the guard below refuses it and a new instant
  -- produces a new snapshot instead.
  evaluated_at TEXT NOT NULL CHECK(length(evaluated_at) BETWEEN 10 AND 40),
  -- `zone:dayBoundary:zoneBasis`, exactly as the rule declared it. A deadline
  -- is a calendar day in this calendar and never an instant, which is why the
  -- estimate rows store a date and not a timestamp.
  calendar_rule_id TEXT NOT NULL CHECK(length(calendar_rule_id) BETWEEN 1 AND 128),
  -- Digest of the `(rule_id, version)` set used, and its size. Two builds that
  -- claim the same rules can be compared without reading CORE again.
  rule_set_digest TEXT NOT NULL
    CHECK(length(rule_set_digest)=64 AND rule_set_digest NOT GLOB '*[^0-9a-f]*'),
  rule_count INTEGER NOT NULL CHECK(rule_count>=0),
  -- Which promotion release the claims came from, and the highest claim id the
  -- input carried: the claim window this snapshot describes.
  claims_release TEXT NOT NULL CHECK(length(claims_release) BETWEEN 1 AND 64),
  claims_high_water INTEGER NOT NULL CHECK(claims_high_water>=0),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  visibility_revision INTEGER NOT NULL CHECK(visibility_revision>=0),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK(status IN ('building','complete','retired')),
  estimate_count INTEGER NOT NULL DEFAULT 0 CHECK(estimate_count>=0),
  simulation_count INTEGER NOT NULL DEFAULT 0 CHECK(simulation_count>=0),
  output_digest TEXT
    CHECK(output_digest IS NULL OR (length(output_digest)=64 AND output_digest NOT GLOB '*[^0-9a-f]*')),
  writer_lease TEXT,
  writer_lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(writer_lease_until_ms>=0),
  writer_fence INTEGER NOT NULL DEFAULT 0 CHECK(writer_fence>=0),
  input_manifest_json TEXT NOT NULL
    CHECK(json_valid(input_manifest_json) AND json_type(input_manifest_json)='object'),
  policy_release TEXT NOT NULL CHECK(length(policy_release) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(content_key,attempt),
  CHECK(status<>'complete' OR (completed_at IS NOT NULL AND output_digest IS NOT NULL)),
  CHECK(status<>'building' OR (completed_at IS NULL AND output_digest IS NULL))
) STRICT;
CREATE INDEX reward_expiry_snapshots_status ON reward_expiry_snapshots(status,created_at);
CREATE INDEX reward_expiry_snapshots_content ON reward_expiry_snapshots(content_key,attempt);

CREATE TRIGGER reward_expiry_snapshots_instance BEFORE INSERT ON reward_expiry_snapshots
WHEN NOT EXISTS(SELECT 1 FROM read_instance i
  WHERE i.id=1 AND i.read_instance_id=NEW.read_instance_id)
BEGIN SELECT RAISE(ABORT,'a reward snapshot belongs to this read instance only'); END;

-- building -> complete -> retired, never back; the fixed evaluation input of a
-- build never changes. This is the rule G2-19 rests on: re-evaluating at a
-- later instant writes a new snapshot and cannot mutate an old one.
CREATE TRIGGER reward_expiry_snapshots_transition BEFORE UPDATE ON reward_expiry_snapshots
WHEN NEW.snapshot_id<>OLD.snapshot_id OR NEW.content_key<>OLD.content_key
 OR NEW.attempt<>OLD.attempt OR NEW.input_digest<>OLD.input_digest
 OR NEW.build_digest<>OLD.build_digest OR NEW.contract_version<>OLD.contract_version
 OR NEW.read_instance_id<>OLD.read_instance_id OR NEW.created_at<>OLD.created_at
 OR NEW.evaluated_at<>OLD.evaluated_at OR NEW.calendar_rule_id<>OLD.calendar_rule_id
 OR NEW.rule_set_digest<>OLD.rule_set_digest OR NEW.rule_count<>OLD.rule_count
 OR NEW.claims_release<>OLD.claims_release OR NEW.claims_high_water<>OLD.claims_high_water
 OR NEW.source_revision<>OLD.source_revision
 OR NEW.visibility_revision<>OLD.visibility_revision OR NEW.core_epoch<>OLD.core_epoch
 OR NEW.input_manifest_json<>OLD.input_manifest_json
 OR NEW.policy_release<>OLD.policy_release
 OR NEW.writer_fence<OLD.writer_fence
 OR (OLD.output_digest IS NOT NULL AND NEW.output_digest IS NOT OLD.output_digest)
 OR NOT ((OLD.status='building' AND NEW.status IN ('building','complete','retired'))
      OR (OLD.status='complete' AND NEW.status IN ('complete','retired'))
      OR (OLD.status='retired' AND NEW.status='retired'))
BEGIN SELECT RAISE(ABORT,'invalid reward snapshot transition'); END;

-- The CORE references this build was made from, copied and digested from the
-- fixed input (04 §3). A rule, an offer or a claim cannot be a foreign key
-- across databases, so a row that names one must name one this snapshot fixed.
CREATE TABLE reward_snapshot_input_refs (
  snapshot_id TEXT NOT NULL REFERENCES reward_expiry_snapshots(snapshot_id),
  ref_kind TEXT NOT NULL CHECK(ref_kind IN
    ('expiry_rule','conversion_offer','reward_program','bucket_claim','membership_claim',
     'simulation_request','evaluation_clock','calendar_rule','promotion_release',
     'restriction_revision')),
  ref_id TEXT NOT NULL CHECK(length(ref_id) BETWEEN 1 AND 256),
  ref_digest TEXT NOT NULL
    CHECK(length(ref_digest)=64 AND ref_digest NOT GLOB '*[^0-9a-f]*'),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,ref_kind,ref_id)
) STRICT;
CREATE INDEX reward_snapshot_input_refs_kind ON reward_snapshot_input_refs(ref_kind,ref_id);
CREATE TRIGGER reward_snapshot_input_refs_building_only
BEFORE INSERT ON reward_snapshot_input_refs
WHEN NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'reward input refs are recorded while the snapshot is building'); END;
CREATE TRIGGER reward_snapshot_input_refs_no_update BEFORE UPDATE ON reward_snapshot_input_refs
BEGIN SELECT RAISE(ABORT,'a reward snapshot never changes its own input refs'); END;
CREATE TRIGGER reward_snapshot_input_refs_no_delete BEFORE DELETE ON reward_snapshot_input_refs
WHEN EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'retired')
BEGIN SELECT RAISE(ABORT,'retire the reward snapshot before deleting its input refs'); END;

-- One estimated deadline: one bucket of one holding under one rule version, as
-- of the snapshot's evaluation instant.
--
-- `expires_on` is a calendar date and nothing else. The deadline of a reward
-- programme is a day in the programme's own calendar (`calendar_rule_id`), so
-- storing an instant here would invent a time the terms never stated. A row
-- whose deadline could not be established keeps its place in the list with
-- `expires_on` NULL and a reason code — a deadline-ordered page never drops
-- the unknowns (addendum 08 §8).
CREATE TABLE reward_expiry_estimates (
  snapshot_id TEXT NOT NULL REFERENCES reward_expiry_snapshots(snapshot_id),
  -- `holding_ref|rule_id@version|bucket_ref`: the identity of the row inside
  -- the snapshot, so a re-sent chunk is decidable without a row number.
  row_key TEXT NOT NULL CHECK(length(row_key) BETWEEN 1 AND 1024),
  row_seq INTEGER NOT NULL CHECK(row_seq>=0),
  program_id TEXT NOT NULL,
  holding_ref TEXT NOT NULL,
  bucket_ref TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  bucket_kind TEXT NOT NULL CHECK(bucket_kind IN
    ('regular','restricted','time-limited','pending-award','qualification')),
  state TEXT NOT NULL CHECK(state IN ('computed','partial','conflict','needs-rule-verification')),
  deadline_basis TEXT NOT NULL
    CHECK(deadline_basis IN ('provider-observed','policy-estimated','unknown')),
  expires_on TEXT CHECK(expires_on IS NULL OR
    (length(expires_on)=10 AND expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  -- The amount at risk, in the programme's own unit. decimal-v1 coefficient
  -- and scale; an unparsed quantity keeps its status and never becomes zero.
  amount_coefficient TEXT,
  amount_scale INTEGER CHECK(amount_scale IS NULL OR (amount_scale BETWEEN 0 AND 4096)),
  amount_status TEXT NOT NULL CHECK(amount_status IN ('exact','missing','unparsed','conflict')),
  unit_ref TEXT NOT NULL CHECK(length(unit_ref) BETWEEN 1 AND 128),
  -- Both dates travel: `conflict` means the provider's own date and the rule's
  -- estimate disagree, and a reader is shown both rather than one of them.
  provider_observed_json TEXT CHECK(provider_observed_json IS NULL OR json_valid(provider_observed_json)),
  policy_estimated_json TEXT CHECK(policy_estimated_json IS NULL OR json_valid(policy_estimated_json)),
  reason_codes_json TEXT NOT NULL
    CHECK(json_valid(reason_codes_json) AND json_type(reason_codes_json)='array'),
  uncertainty_codes_json TEXT NOT NULL
    CHECK(json_valid(uncertainty_codes_json) AND json_type(uncertainty_codes_json)='array'),
  -- The CORE facts this row rests on: the claims it was computed from and the
  -- provider expiry observations it cites, as references, never as a join.
  basis_refs_json TEXT NOT NULL
    CHECK(json_valid(basis_refs_json) AND json_type(basis_refs_json)='array'),
  row_digest TEXT NOT NULL CHECK(length(row_digest)=64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(snapshot_id,row_key),
  CHECK((amount_status='exact') = (amount_coefficient IS NOT NULL AND amount_scale IS NOT NULL)),
  -- A date exists only where a basis established it.
  CHECK(expires_on IS NULL OR deadline_basis<>'unknown')
) STRICT;
CREATE UNIQUE INDEX reward_expiry_estimates_order
  ON reward_expiry_estimates(snapshot_id,row_seq);
CREATE INDEX reward_expiry_estimates_deadline
  ON reward_expiry_estimates(snapshot_id,expires_on,row_seq);
CREATE INDEX reward_expiry_estimates_holding
  ON reward_expiry_estimates(snapshot_id,program_id,holding_ref,row_seq);

CREATE TRIGGER reward_expiry_estimates_building_only BEFORE INSERT ON reward_expiry_estimates
WHEN NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'reward estimates need a building snapshot'); END;
-- 04 §3: the rule an estimate claims is one this snapshot fixed as input. A
-- deadline computed from a rule version the snapshot never recorded would be
-- unreproducible by construction.
CREATE TRIGGER reward_expiry_estimates_rule_ref BEFORE INSERT ON reward_expiry_estimates
WHEN NOT EXISTS(SELECT 1 FROM reward_snapshot_input_refs r
  WHERE r.snapshot_id=NEW.snapshot_id AND r.ref_kind='expiry_rule'
    AND r.ref_id=NEW.rule_id||'@'||NEW.rule_version)
BEGIN SELECT RAISE(ABORT,'a reward estimate needs its rule in the snapshot input refs'); END;
-- A re-sent chunk is a no-op only when its content is identical; different
-- content for a row already written is a conflict, not a silent OR IGNORE.
CREATE TRIGGER reward_expiry_estimates_chunk_conflict BEFORE INSERT ON reward_expiry_estimates
WHEN EXISTS(SELECT 1 FROM reward_expiry_estimates r
  WHERE r.snapshot_id=NEW.snapshot_id AND r.row_key=NEW.row_key
    AND r.row_digest IS NOT NEW.row_digest)
BEGIN SELECT RAISE(ABORT,'reward estimate chunk conflict'); END;
CREATE TRIGGER reward_expiry_estimates_sealed_no_update BEFORE UPDATE ON reward_expiry_estimates
WHEN EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'building')
BEGIN SELECT RAISE(ABORT,'a sealed reward snapshot is immutable'); END;
CREATE TRIGGER reward_expiry_estimates_sealed_no_delete BEFORE DELETE ON reward_expiry_estimates
WHEN EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status='complete')
BEGIN SELECT RAISE(ABORT,'retire the reward snapshot before deleting its estimates'); END;

-- The replay of one saved conversion simulation under this snapshot's fixed
-- offers and evaluation instant (G2-20).
--
-- `request_digest` is the identity CORE stored. `request_json` is the request
-- itself, and it is the whole difference between the two outcomes: with it the
-- simulation is recomputed and the result is stored; without it the row is
-- `not_reproducible` and carries no result at all. A digest is not an input,
-- and a plan recomputed from today's offers is not the saved simulation.
CREATE TABLE reward_conversion_simulations (
  snapshot_id TEXT NOT NULL REFERENCES reward_expiry_snapshots(snapshot_id),
  request_digest TEXT NOT NULL
    CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  row_seq INTEGER NOT NULL CHECK(row_seq>=0),
  reproducibility TEXT NOT NULL CHECK(reproducibility IN ('reproduced','not_reproducible')),
  reason_code TEXT CHECK(reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  request_json TEXT CHECK(request_json IS NULL OR
    (json_valid(request_json) AND json_type(request_json)='object')),
  offer_id TEXT,
  offer_version TEXT,
  result_json TEXT CHECK(result_json IS NULL OR
    (json_valid(result_json) AND json_type(result_json)='object')),
  search_coverage TEXT NOT NULL CHECK(search_coverage IN ('complete','bounded')),
  -- Copied from the snapshot so a row answers "as of when?" on its own.
  evaluated_at TEXT NOT NULL CHECK(length(evaluated_at) BETWEEN 10 AND 40),
  policy_release TEXT NOT NULL CHECK(length(policy_release) BETWEEN 1 AND 64),
  row_digest TEXT NOT NULL CHECK(length(row_digest)=64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(snapshot_id,request_digest),
  -- The three are one statement: reproduced exactly when the request was
  -- retained, and then with a result and the offer version it used.
  CHECK((reproducibility='reproduced') = (request_json IS NOT NULL)),
  CHECK((reproducibility='reproduced') = (result_json IS NOT NULL)),
  CHECK((reproducibility='reproduced') = (offer_id IS NOT NULL AND offer_version IS NOT NULL)),
  CHECK(reproducibility='reproduced' OR reason_code IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX reward_conversion_simulations_order
  ON reward_conversion_simulations(snapshot_id,row_seq);
CREATE INDEX reward_conversion_simulations_state
  ON reward_conversion_simulations(snapshot_id,reproducibility,row_seq);

CREATE TRIGGER reward_conversion_simulations_building_only
BEFORE INSERT ON reward_conversion_simulations
WHEN NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'reward simulations need a building snapshot'); END;
-- A replayed simulation names the offer version it used, and that version is
-- one the snapshot fixed. Recomputing against an offer the input never carried
-- would be a new simulation wearing an old request's digest.
CREATE TRIGGER reward_conversion_simulations_offer_ref
BEFORE INSERT ON reward_conversion_simulations
WHEN NEW.offer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reward_snapshot_input_refs r
  WHERE r.snapshot_id=NEW.snapshot_id AND r.ref_kind='conversion_offer'
    AND r.ref_id=NEW.offer_id||'@'||NEW.offer_version)
BEGIN SELECT RAISE(ABORT,'a replayed simulation needs its offer in the snapshot input refs'); END;
CREATE TRIGGER reward_conversion_simulations_chunk_conflict
BEFORE INSERT ON reward_conversion_simulations
WHEN EXISTS(SELECT 1 FROM reward_conversion_simulations r
  WHERE r.snapshot_id=NEW.snapshot_id AND r.request_digest=NEW.request_digest
    AND r.row_digest IS NOT NEW.row_digest)
BEGIN SELECT RAISE(ABORT,'reward simulation chunk conflict'); END;
CREATE TRIGGER reward_conversion_simulations_sealed_no_update
BEFORE UPDATE ON reward_conversion_simulations
WHEN EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'building')
BEGIN SELECT RAISE(ABORT,'a sealed reward snapshot is immutable'); END;
CREATE TRIGGER reward_conversion_simulations_sealed_no_delete
BEFORE DELETE ON reward_conversion_simulations
WHEN EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status='complete')
BEGIN SELECT RAISE(ABORT,'retire the reward snapshot before deleting its simulations'); END;

-- What the reward read model publishes. The seal and this switch are one D1
-- batch (05 §5).
--
-- Forward only has two parts here, because a reward build can be the same CORE
-- context evaluated later: under one epoch the source revision never goes
-- back, and at the same revision the evaluation instant never goes back
-- either. A build that finishes late is complete and simply not published.
CREATE TABLE reward_snapshot_pointer (
  id INTEGER PRIMARY KEY CHECK(id=1),
  snapshot_id TEXT NOT NULL REFERENCES reward_expiry_snapshots(snapshot_id),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  visibility_revision INTEGER NOT NULL CHECK(visibility_revision>=0),
  core_epoch TEXT NOT NULL CHECK(length(core_epoch) BETWEEN 1 AND 64),
  read_instance_id TEXT NOT NULL CHECK(length(read_instance_id) BETWEEN 8 AND 64),
  evaluated_at TEXT NOT NULL CHECK(length(evaluated_at) BETWEEN 10 AND 40),
  output_digest TEXT NOT NULL
    CHECK(length(output_digest)=64 AND output_digest NOT GLOB '*[^0-9a-f]*'),
  switched_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER reward_snapshot_pointer_complete_only BEFORE INSERT ON reward_snapshot_pointer
WHEN NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='complete'
    AND s.read_instance_id=NEW.read_instance_id)
BEGIN SELECT RAISE(ABORT,'the active reward snapshot must be complete and local'); END;
CREATE TRIGGER reward_snapshot_pointer_forward_only BEFORE UPDATE ON reward_snapshot_pointer
WHEN NEW.id<>OLD.id
 OR NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s
   WHERE s.snapshot_id=NEW.snapshot_id AND s.status='complete'
     AND s.read_instance_id=NEW.read_instance_id)
 OR (NEW.core_epoch=OLD.core_epoch
     AND (NEW.source_revision<OLD.source_revision
          OR (NEW.source_revision=OLD.source_revision AND NEW.evaluated_at<OLD.evaluated_at)))
BEGIN SELECT RAISE(ABORT,'the active reward snapshot never moves backwards'); END;
CREATE TRIGGER reward_snapshot_pointer_no_delete BEFORE DELETE ON reward_snapshot_pointer
BEGIN SELECT RAISE(ABORT,'the active reward pointer is switched, never removed'); END;

-- Where a bounded reward build got to. The chunk and its checkpoint are one D1
-- batch, under the same lease that guards the rows (05 §4, G2-08).
CREATE TABLE reward_build_checkpoints (
  snapshot_id TEXT NOT NULL REFERENCES reward_expiry_snapshots(snapshot_id),
  stage TEXT NOT NULL CHECK(stage IN ('estimates','simulations')),
  position TEXT NOT NULL CHECK(length(position) BETWEEN 1 AND 128),
  rows_written INTEGER NOT NULL CHECK(rows_written>=0),
  writer_lease TEXT NOT NULL CHECK(length(writer_lease) BETWEEN 1 AND 128),
  writer_fence INTEGER NOT NULL CHECK(writer_fence>=0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,stage)
) STRICT;
CREATE TRIGGER reward_build_checkpoints_building_only BEFORE INSERT ON reward_build_checkpoints
WHEN NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'a reward checkpoint needs a building snapshot'); END;
CREATE TRIGGER reward_build_checkpoints_forward_only BEFORE UPDATE ON reward_build_checkpoints
WHEN NEW.rows_written<OLD.rows_written OR NEW.writer_fence<OLD.writer_fence
BEGIN SELECT RAISE(ABORT,'a reward build checkpoint never goes backwards'); END;
