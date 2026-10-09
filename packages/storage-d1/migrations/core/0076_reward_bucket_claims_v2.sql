-- Canonical reward source claims for promotion v2. Legacy claims remain
-- append-only historical evidence; no rows are copied or reclassified.
-- V Point common buckets retain an unclassified kind until provider semantics
-- are verified. Re-promotion reads the original published balance observations.

CREATE TABLE reward_bucket_claims_v2 (
  id                    INTEGER PRIMARY KEY,
  claim_digest          TEXT NOT NULL UNIQUE,
  parse_run_id          INTEGER NOT NULL REFERENCES parse_runs(id),
  source_fact_kind      TEXT NOT NULL CHECK(source_fact_kind IN ('balance','transaction','position','valuation')),
  source_fact_id        INTEGER NOT NULL,
  program_id            TEXT NOT NULL REFERENCES reward_programs(program_id),
  holding_ref           TEXT NOT NULL,
  bucket_ref            TEXT NOT NULL,
  bucket_kind           TEXT NOT NULL CHECK(bucket_kind IN ('regular','restricted','time-limited','pending-award','qualification','unclassified')),
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
CREATE INDEX reward_bucket_claims_v2_holding ON reward_bucket_claims_v2(program_id,holding_ref,id);
CREATE INDEX reward_bucket_claims_v2_parse_run ON reward_bucket_claims_v2(parse_run_id);
CREATE INDEX reward_bucket_claims_v2_fact ON reward_bucket_claims_v2(source_fact_kind,source_fact_id);
CREATE TRIGGER reward_bucket_claims_v2_no_update BEFORE UPDATE ON reward_bucket_claims_v2
BEGIN SELECT RAISE(ABORT,'reward_bucket_claims_v2 is append-only'); END;
CREATE TRIGGER reward_bucket_claims_v2_no_delete BEFORE DELETE ON reward_bucket_claims_v2
BEGIN SELECT RAISE(ABORT,'reward_bucket_claims_v2 is append-only'); END;
-- Only a published parse run may be promoted: a candidate or superseded parse
-- must never appear in a reward read (docs/publication-gate.md).
CREATE TRIGGER reward_bucket_claims_v2_requires_published BEFORE INSERT ON reward_bucket_claims_v2
WHEN NOT EXISTS(SELECT 1 FROM published_parse_runs p WHERE p.parse_run_id=NEW.parse_run_id)
BEGIN SELECT RAISE(ABORT,'reward bucket claims require a published parse run'); END;

CREATE TRIGGER reward_bucket_claims_v2_bump_revision_insert AFTER INSERT ON reward_bucket_claims_v2 BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER reward_bucket_claims_v2_bump_revision_update AFTER UPDATE ON reward_bucket_claims_v2 BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER reward_bucket_claims_v2_bump_revision_delete AFTER DELETE ON reward_bucket_claims_v2 BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
