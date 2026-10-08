-- Who wrote a public maintenance revision, why, and on which reviewed
-- decision (ADR 0046). Additive only: revisions written before this migration
-- keep NULL, which means "not recorded", never a guessed operator. The
-- append-only triggers of 0065 stay.
ALTER TABLE provider_maintenance_rules ADD COLUMN actor_kind TEXT
 CHECK(actor_kind IN('operator','agent'));
-- An agent revision always carries its reason; an operator revision may.
ALTER TABLE provider_maintenance_rules ADD COLUMN change_reason TEXT
 CHECK(CASE WHEN change_reason IS NULL THEN actor_kind IS NOT 'agent'
  ELSE length(change_reason) BETWEEN 1 AND 500 END);
-- An optional reference to the reviewed proposal or decision behind a revision.
ALTER TABLE provider_maintenance_rules ADD COLUMN decision_ref TEXT
 CHECK(decision_ref IS NULL OR length(decision_ref) BETWEEN 1 AND 200);
-- Bounds the per-principal daily agent write budget check.
CREATE INDEX maintenance_agent_writes ON provider_maintenance_rules(actor,created_at)
 WHERE actor_kind='agent';
