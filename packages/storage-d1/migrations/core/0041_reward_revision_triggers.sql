-- The reward tables join the CORE dependency ledger (unified plan 05 §2; U16).
-- Additive only: no existing table, column, view or trigger is altered, and a
-- Worker build that predates this migration keeps reading and writing exactly
-- as before.
--
-- Why. The reward read model moves to READ in U16: expiry estimates and the
-- replay of saved simulations are built from a fixed input, captured by the
-- optimistic protocol of 05 §3 (read revision r0, read the data, read revision
-- r1, keep it only when r0 = r1). That protocol can only see a change if every
-- write the capture depends on bumps `core_source_revision` inside its own
-- transaction. Migration 0038 built the ledger for the balance projection; the
-- five tables below are what a reward capture reads and 0038 did not cover:
--
--   reward_programs, expiry_rules, conversion_offers   (versioned reference claims)
--   reward_bucket_claims, membership_state_claims      (provider/self-reported claims)
--
-- They are all append-only by their own triggers from migration 0033, so in
-- practice only the insert trigger can fire; the update and delete triggers
-- exist so the trigger set is exactly what the ledger declares, and so a future
-- maintenance path cannot change a rule without moving the revision.
--
-- These are `source_revision` bumps, not `visibility_revision`: a new rule
-- version or a new claim changes what the projection computes, not who may see
-- it. Restrictions stay the only writers of the visibility counter (0038).
--
-- Consequence to know: a reward claim promotion now also makes the balance
-- projection's captured input stale, because the two share one counter. That is
-- over-detection, never a miss — the balance build re-captures, digests the
-- same content and is recognised as the same snapshot without rebuilding rows
-- (05 §4). One counter that is sometimes too eager is the safe direction; a
-- second counter that could disagree with the first is not.
--
-- DELIBERATELY EXCLUDED, as in 0038: `expiry_estimates` and
-- `conversion_simulations`. They are the projection's own output (migration
-- 0033 calls them rebuildable projections), so bumping the revision when they
-- are written would make every build stale the moment it recorded its result.

CREATE TRIGGER reward_programs_bump_revision_insert AFTER INSERT ON reward_programs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER reward_programs_bump_revision_update AFTER UPDATE ON reward_programs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER reward_programs_bump_revision_delete AFTER DELETE ON reward_programs BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER expiry_rules_bump_revision_insert AFTER INSERT ON expiry_rules BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER expiry_rules_bump_revision_update AFTER UPDATE ON expiry_rules BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER expiry_rules_bump_revision_delete AFTER DELETE ON expiry_rules BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER conversion_offers_bump_revision_insert AFTER INSERT ON conversion_offers BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER conversion_offers_bump_revision_update AFTER UPDATE ON conversion_offers BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER conversion_offers_bump_revision_delete AFTER DELETE ON conversion_offers BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER reward_bucket_claims_bump_revision_insert AFTER INSERT ON reward_bucket_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER reward_bucket_claims_bump_revision_update AFTER UPDATE ON reward_bucket_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER reward_bucket_claims_bump_revision_delete AFTER DELETE ON reward_bucket_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER membership_state_claims_bump_revision_insert AFTER INSERT ON membership_state_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER membership_state_claims_bump_revision_update AFTER UPDATE ON membership_state_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER membership_state_claims_bump_revision_delete AFTER DELETE ON membership_state_claims BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
