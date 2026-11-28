-- ADR 0129, "One-page sweeps wait for a change too" (issue #1491): the
-- identity sweep and the reward claim promotion get a gate row in
-- processor_sweep_passes (migration 0109).
--
-- Neither sweep pages with a cursor. Each tick reads its whole candidate set
-- in one statement, so with nothing to do it still read about 197k rows
-- (identity) and 187k rows (reward claims) every five minutes in production on
-- 2026-11-27, about 110M rows a day between them. With a gate row, a sweep
-- whose candidate read returned nothing marks the CORE revision and its
-- policy clean, and the next tick reads only the gate row until one of them
-- moves.
--
-- SQLite cannot change a CHECK in place, so the table is rebuilt with the two
-- new names and the rows already recorded are kept as they are. The table is
-- operational state outside the source-revision ledger (no triggers), and the
-- columns are unchanged, so a build still running the 0109 code reads and
-- writes it as before.
CREATE TABLE processor_sweep_passes_v2 (
 sweep TEXT PRIMARY KEY CHECK(sweep IN ('card_settlement','card_purchase_recognition','identity_sweep','reward_claims')),
 pass_source_revision INTEGER CHECK(pass_source_revision IS NULL OR pass_source_revision>=0),
 pass_visibility_revision INTEGER CHECK(pass_visibility_revision IS NULL OR pass_visibility_revision>=0),
 pass_core_epoch TEXT CHECK(pass_core_epoch IS NULL OR length(pass_core_epoch) BETWEEN 1 AND 128),
 pass_policy TEXT CHECK(pass_policy IS NULL OR length(pass_policy) BETWEEN 1 AND 256),
 pass_token TEXT CHECK(pass_token IS NULL OR length(pass_token) BETWEEN 1 AND 64),
 clean_source_revision INTEGER CHECK(clean_source_revision IS NULL OR clean_source_revision>=0),
 clean_visibility_revision INTEGER CHECK(clean_visibility_revision IS NULL OR clean_visibility_revision>=0),
 clean_core_epoch TEXT CHECK(clean_core_epoch IS NULL OR length(clean_core_epoch) BETWEEN 1 AND 128),
 clean_policy TEXT CHECK(clean_policy IS NULL OR length(clean_policy) BETWEEN 1 AND 256),
 CHECK((pass_source_revision IS NULL)=(pass_visibility_revision IS NULL)
   AND (pass_source_revision IS NULL)=(pass_core_epoch IS NULL)
   AND (pass_source_revision IS NULL)=(pass_policy IS NULL)
   AND (pass_source_revision IS NULL)=(pass_token IS NULL)),
 CHECK((clean_source_revision IS NULL)=(clean_visibility_revision IS NULL)
   AND (clean_source_revision IS NULL)=(clean_core_epoch IS NULL)
   AND (clean_source_revision IS NULL)=(clean_policy IS NULL))
) STRICT;
INSERT INTO processor_sweep_passes_v2 SELECT sweep,pass_source_revision,pass_visibility_revision,
 pass_core_epoch,pass_policy,pass_token,clean_source_revision,clean_visibility_revision,
 clean_core_epoch,clean_policy FROM processor_sweep_passes;
DROP TABLE processor_sweep_passes;
ALTER TABLE processor_sweep_passes_v2 RENAME TO processor_sweep_passes;
INSERT INTO processor_sweep_passes(sweep) VALUES('identity_sweep'),('reward_claims');
