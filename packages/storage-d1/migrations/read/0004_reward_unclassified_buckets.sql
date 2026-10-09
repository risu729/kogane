-- ADR 0049 amendment: an unclassified bucket remains a bucket, with its
-- observed quantity, displayed expiry and references. The old CHECK cannot
-- admit it. Add a replacement projection rather than rewriting sealed rows.
-- The old table stays historical; new releases write/read only this table.
-- Rebuild from fixed v2 promotion inputs before serving the new contract.

CREATE TABLE reward_expiry_estimates_v2 (
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
    ('regular','restricted','time-limited','pending-award','qualification','unclassified')),
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
  expiry_basis_json TEXT CHECK(expiry_basis_json IS NULL OR
    (json_valid(expiry_basis_json) AND json_type(expiry_basis_json)='object')),
  row_digest TEXT NOT NULL CHECK(length(row_digest)=64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(snapshot_id,row_key),
  CHECK((amount_status='exact') = (amount_coefficient IS NOT NULL AND amount_scale IS NOT NULL)),
  -- A date exists only where a basis established it.
  CHECK(expires_on IS NULL OR deadline_basis<>'unknown')
) STRICT;
CREATE UNIQUE INDEX reward_expiry_estimates_v2_order
  ON reward_expiry_estimates_v2(snapshot_id,row_seq);
CREATE INDEX reward_expiry_estimates_v2_deadline
  ON reward_expiry_estimates_v2(snapshot_id,expires_on,row_seq);
CREATE INDEX reward_expiry_estimates_v2_holding
  ON reward_expiry_estimates_v2(snapshot_id,program_id,holding_ref,row_seq);

CREATE TRIGGER reward_expiry_estimates_v2_building_only BEFORE INSERT ON reward_expiry_estimates_v2
WHEN NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'reward estimates need a building snapshot'); END;
-- 04 §3: the rule an estimate claims is one this snapshot fixed as input. A
-- deadline computed from a rule version the snapshot never recorded would be
-- unreproducible by construction.
CREATE TRIGGER reward_expiry_estimates_v2_rule_ref BEFORE INSERT ON reward_expiry_estimates_v2
WHEN NOT EXISTS(SELECT 1 FROM reward_snapshot_input_refs r
  WHERE r.snapshot_id=NEW.snapshot_id AND r.ref_kind='expiry_rule'
    AND r.ref_id=NEW.rule_id||'@'||NEW.rule_version)
BEGIN SELECT RAISE(ABORT,'a reward estimate needs its rule in the snapshot input refs'); END;
-- A re-sent chunk is a no-op only when its content is identical; different
-- content for a row already written is a conflict, not a silent OR IGNORE.
CREATE TRIGGER reward_expiry_estimates_v2_chunk_conflict BEFORE INSERT ON reward_expiry_estimates_v2
WHEN EXISTS(SELECT 1 FROM reward_expiry_estimates_v2 r
  WHERE r.snapshot_id=NEW.snapshot_id AND r.row_key=NEW.row_key
    AND r.row_digest IS NOT NEW.row_digest)
BEGIN SELECT RAISE(ABORT,'reward estimate chunk conflict'); END;
CREATE TRIGGER reward_expiry_estimates_v2_sealed_no_update BEFORE UPDATE ON reward_expiry_estimates_v2
WHEN EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'building')
BEGIN SELECT RAISE(ABORT,'a sealed reward snapshot is immutable'); END;
CREATE TRIGGER reward_expiry_estimates_v2_sealed_no_delete BEFORE DELETE ON reward_expiry_estimates_v2
WHEN EXISTS(SELECT 1 FROM reward_expiry_snapshots s
  WHERE s.snapshot_id=OLD.snapshot_id AND s.status='complete')
BEGIN SELECT RAISE(ABORT,'retire the reward snapshot before deleting its estimates'); END;
