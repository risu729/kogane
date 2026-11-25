-- ADR 0129, slice 3 (issue #1491): a cursor sweep that has read every row
-- waits for a change instead of starting over.
--
-- The card settlement sweep and the card purchase recognition pass page
-- through their whole input (current statements; current card usage rows) and
-- wrap to the start at the end. Their input is small enough that one pass fits
-- in one tick, so every tick read all of it again, whether or not anything
-- had changed (about 0.8M rows a tick each in production on 2026-11-24).
--
-- One row per sweep. `pass_*` is the current pass, recorded when it started
-- from the first row: the CORE revision read then (source revision,
-- visibility revision, core epoch), the sweep's policy then, and a token the
-- pass's own end must name (so an overlapping tick's pass is never marked by
-- another's end). `clean_*` is the start of the last pass that reached the end
-- with all its work done. The policy is code-owned and carries whatever the
-- sweep reads beside the CORE ledger (a version, a high-water mark of an
-- off-ledger table), so a deploy or such a write runs a pass again. While the
-- CORE revision and the policy still equal `clean_*` the sweep reads nothing
-- else: everything else it reads is on the CORE dependency ledger or written
-- only by the sweep itself, so the pass that started there saw what a new pass
-- would see. A pass whose own writes moved the revision is followed by one
-- more pass, which writes nothing and closes the gate.
--
-- Operational state only, like the cursors it sits beside: outside the
-- source-revision ledger (REVISION_EXCLUDED_TABLES), and no reader's result
-- depends on it.
CREATE TABLE processor_sweep_passes (
 sweep TEXT PRIMARY KEY CHECK(sweep IN ('card_settlement','card_purchase_recognition')),
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
INSERT INTO processor_sweep_passes(sweep) VALUES('card_settlement'),('card_purchase_recognition');
