-- Replacement guards also refuse a replacing insert by rowid.
--
-- SQLite's REPLACE conflict resolution deletes every row a new row collides
-- with, on the primary key, any unique index or the rowid, without firing
-- DELETE triggers while recursive_triggers is off (as on D1). Each table below
-- refuses a DELETE by trigger and has a replacement guard: a BEFORE INSERT
-- trigger that refuses an insert colliding with a stored row on the keys it
-- names (0001, 0018, 0029 and later). None of those guards names the rowid.
-- Every table here but `decision_outbox` has no INTEGER PRIMARY KEY, so it
-- keeps a hidden rowid; `decision_outbox`'s rowid is its `id`, which its
-- guard does not check. An `INSERT OR REPLACE` that names a stored row's
-- rowid, whatever key it states, therefore deleted that row past every guard.
-- 0105 closed the same hole on the observation tables; these are the other
-- tables with a replacement guard.
--
-- Each table gets a second BEFORE INSERT trigger, `<table>_no_replace_rowid`,
-- that refuses an insert whose rowid is already stored. No existing trigger
-- is dropped, replaced or changed, so every clause the older guards check
-- still applies. SQLite leaves NEW.rowid undefined in a BEFORE INSERT trigger
-- when the insert names no rowid; bun:sqlite and Miniflare's D1 give -1, which
-- no stored row has because no writer names a rowid (a storage-d1 test pins
-- the value for these tables' insert shapes). No production writer of these
-- tables uses `OR IGNORE`, `OR REPLACE` or `ON CONFLICT`, and none names a
-- rowid, so no write that succeeded before is refused now.
--
-- Not covered here, and written down as limits in docs/design.md: append-only
-- tables with no replacement guard at all, `parser_releases` (its BEFORE
-- INSERT trigger refuses only a changed code digest), and the partial unique
-- indexes some guards do not name. Additive only: no row, column, index or
-- existing trigger changes.

CREATE TRIGGER account_mappings_no_replace_rowid BEFORE INSERT ON account_mappings
WHEN EXISTS(SELECT 1 FROM account_mappings WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'account_mappings replacement is forbidden'); END;

CREATE TRIGGER accounts_no_replace_rowid BEFORE INSERT ON accounts
WHEN EXISTS(SELECT 1 FROM accounts WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'accounts replacement is forbidden'); END;

CREATE TRIGGER allocations_no_replace_rowid BEFORE INSERT ON allocations
WHEN EXISTS(SELECT 1 FROM allocations WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'allocations replacement is forbidden'); END;

CREATE TRIGGER approvals_no_replace_rowid BEFORE INSERT ON approvals
WHEN EXISTS(SELECT 1 FROM approvals WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'approvals replacement is forbidden'); END;

CREATE TRIGGER audit_records_no_replace_rowid BEFORE INSERT ON audit_records
WHEN EXISTS(SELECT 1 FROM audit_records WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'audit_records replacement is forbidden'); END;

CREATE TRIGGER card_purchase_recognition_keys_no_replace_rowid BEFORE INSERT ON card_purchase_recognition_keys
WHEN EXISTS(SELECT 1 FROM card_purchase_recognition_keys WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'card_purchase_recognition_keys replacement is forbidden'); END;

CREATE TRIGGER card_purchase_recognitions_no_replace_rowid BEFORE INSERT ON card_purchase_recognitions
WHEN EXISTS(SELECT 1 FROM card_purchase_recognitions WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'card_purchase_recognitions replacement is forbidden'); END;

CREATE TRIGGER card_settlement_allocation_withdrawals_no_replace_rowid BEFORE INSERT ON card_settlement_allocation_withdrawals
WHEN EXISTS(SELECT 1 FROM card_settlement_allocation_withdrawals WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'card_settlement_allocation_withdrawals replacement is forbidden'); END;

CREATE TRIGGER card_settlement_candidates_no_replace_rowid BEFORE INSERT ON card_settlement_candidates
WHEN EXISTS(SELECT 1 FROM card_settlement_candidates WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'card_settlement_candidates replacement is forbidden'); END;

CREATE TRIGGER card_settlement_decisions_no_replace_rowid BEFORE INSERT ON card_settlement_decisions
WHEN EXISTS(SELECT 1 FROM card_settlement_decisions WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'card_settlement_decisions replacement is forbidden'); END;

CREATE TRIGGER change_plans_no_replace_rowid BEFORE INSERT ON change_plans
WHEN EXISTS(SELECT 1 FROM change_plans WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'change_plans replacement is forbidden'); END;

CREATE TRIGGER decision_operations_no_replace_rowid BEFORE INSERT ON decision_operations
WHEN EXISTS(SELECT 1 FROM decision_operations WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'decision_operations replacement is forbidden'); END;

CREATE TRIGGER decision_outbox_no_replace_rowid BEFORE INSERT ON decision_outbox
WHEN EXISTS(SELECT 1 FROM decision_outbox WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'decision_outbox replacement is forbidden'); END;

CREATE TRIGGER decision_revisions_no_replace_rowid BEFORE INSERT ON decision_revisions
WHEN EXISTS(SELECT 1 FROM decision_revisions WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'decision_revisions replacement is forbidden'); END;

CREATE TRIGGER economic_claims_no_replace_rowid BEFORE INSERT ON economic_claims
WHEN EXISTS(SELECT 1 FROM economic_claims WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'economic_claims replacement is forbidden'); END;

CREATE TRIGGER economic_commit_log_no_replace_rowid BEFORE INSERT ON economic_commit_log
WHEN EXISTS(SELECT 1 FROM economic_commit_log WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'economic_commit_log replacement is forbidden'); END;

CREATE TRIGGER economic_event_revisions_no_replace_rowid BEFORE INSERT ON economic_event_revisions
WHEN EXISTS(SELECT 1 FROM economic_event_revisions WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'economic_event_revisions replacement is forbidden'); END;

CREATE TRIGGER economic_event_times_no_replace_rowid BEFORE INSERT ON economic_event_times
WHEN EXISTS(SELECT 1 FROM economic_event_times WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'economic_event_times replacement is forbidden'); END;

CREATE TRIGGER economic_leg_effects_no_replace_rowid BEFORE INSERT ON economic_leg_effects
WHEN EXISTS(SELECT 1 FROM economic_leg_effects WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'economic_leg_effects replacement is forbidden'); END;

CREATE TRIGGER economic_legs_no_replace_rowid BEFORE INSERT ON economic_legs
WHEN EXISTS(SELECT 1 FROM economic_legs WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'economic_legs replacement is forbidden'); END;

CREATE TRIGGER economic_revision_seals_no_replace_rowid BEFORE INSERT ON economic_revision_seals
WHEN EXISTS(SELECT 1 FROM economic_revision_seals WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'economic_revision_seals replacement is forbidden'); END;

CREATE TRIGGER entity_relations_no_replace_rowid BEFORE INSERT ON entity_relations
WHEN EXISTS(SELECT 1 FROM entity_relations WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'entity_relations replacement is forbidden'); END;

CREATE TRIGGER identity_instrument_uses_no_replace_rowid BEFORE INSERT ON identity_instrument_uses
WHEN EXISTS(SELECT 1 FROM identity_instrument_uses WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'identity_instrument_uses replacement is forbidden'); END;

CREATE TRIGGER identity_observations_no_replace_rowid BEFORE INSERT ON identity_observations
WHEN EXISTS(SELECT 1 FROM identity_observations WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'identity_observations replacement is forbidden'); END;

CREATE TRIGGER identity_run_policies_no_replace_rowid BEFORE INSERT ON identity_run_policies
WHEN EXISTS(SELECT 1 FROM identity_run_policies WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'identity_run_policies replacement is forbidden'); END;

CREATE TRIGGER identity_run_seals_no_replace_rowid BEFORE INSERT ON identity_run_seals
WHEN EXISTS(SELECT 1 FROM identity_run_seals WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'identity_run_seals replacement is forbidden'); END;

CREATE TRIGGER identity_runs_no_replace_rowid BEFORE INSERT ON identity_runs
WHEN EXISTS(SELECT 1 FROM identity_runs WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'identity_runs replacement is forbidden'); END;

CREATE TRIGGER identity_vpass_bindings_no_replace_rowid BEFORE INSERT ON identity_vpass_bindings
WHEN EXISTS(SELECT 1 FROM identity_vpass_bindings WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'identity_vpass_bindings replacement is forbidden'); END;

CREATE TRIGGER instrument_identifiers_no_replace_rowid BEFORE INSERT ON instrument_identifiers
WHEN EXISTS(SELECT 1 FROM instrument_identifiers WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'instrument_identifiers replacement is forbidden'); END;

CREATE TRIGGER instrument_mappings_no_replace_rowid BEFORE INSERT ON instrument_mappings
WHEN EXISTS(SELECT 1 FROM instrument_mappings WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'instrument_mappings replacement is forbidden'); END;

CREATE TRIGGER instrument_temporal_acceptances_no_replace_rowid BEFORE INSERT ON instrument_temporal_acceptances
WHEN EXISTS(SELECT 1 FROM instrument_temporal_acceptances WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'instrument_temporal_acceptances replacement is forbidden'); END;

CREATE TRIGGER instrument_temporal_versions_no_replace_rowid BEFORE INSERT ON instrument_temporal_versions
WHEN EXISTS(SELECT 1 FROM instrument_temporal_versions WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'instrument_temporal_versions replacement is forbidden'); END;

CREATE TRIGGER instruments_no_replace_rowid BEFORE INSERT ON instruments
WHEN EXISTS(SELECT 1 FROM instruments WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'instruments replacement is forbidden'); END;

CREATE TRIGGER obligation_revisions_no_replace_rowid BEFORE INSERT ON obligation_revisions
WHEN EXISTS(SELECT 1 FROM obligation_revisions WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'obligation_revisions replacement is forbidden'); END;

CREATE TRIGGER operation_receipts_no_replace_rowid BEFORE INSERT ON operation_receipts
WHEN EXISTS(SELECT 1 FROM operation_receipts WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'operation_receipts replacement is forbidden'); END;

CREATE TRIGGER ops_requests_no_replace_rowid BEFORE INSERT ON ops_requests
WHEN EXISTS(SELECT 1 FROM ops_requests WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'ops_requests replacement is forbidden'); END;

CREATE TRIGGER own_transfer_proposal_retirements_no_replace_rowid BEFORE INSERT ON own_transfer_proposal_retirements
WHEN EXISTS(SELECT 1 FROM own_transfer_proposal_retirements WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'own_transfer_proposal_retirements replacement is forbidden'); END;

CREATE TRIGGER own_transfer_proposals_no_replace_rowid BEFORE INSERT ON own_transfer_proposals
WHEN EXISTS(SELECT 1 FROM own_transfer_proposals WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'own_transfer_proposals replacement is forbidden'); END;

CREATE TRIGGER projection_input_records_no_replace_rowid BEFORE INSERT ON projection_input_records
WHEN EXISTS(SELECT 1 FROM projection_input_records WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'projection_input_records replacement is forbidden'); END;

CREATE TRIGGER raw_objects_no_replace_rowid BEFORE INSERT ON raw_objects
WHEN EXISTS(SELECT 1 FROM raw_objects WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'raw_objects replacement is forbidden'); END;

CREATE TRIGGER reconciliation_proposals_no_replace_rowid BEFORE INSERT ON reconciliation_proposals
WHEN EXISTS(SELECT 1 FROM reconciliation_proposals WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'reconciliation_proposals replacement is forbidden'); END;

CREATE TRIGGER settlement_relations_no_replace_rowid BEFORE INSERT ON settlement_relations
WHEN EXISTS(SELECT 1 FROM settlement_relations WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'settlement_relations replacement is forbidden'); END;

CREATE TRIGGER source_accounts_no_replace_rowid BEFORE INSERT ON source_accounts
WHEN EXISTS(SELECT 1 FROM source_accounts WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'source_accounts replacement is forbidden'); END;
