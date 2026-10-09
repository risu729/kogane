-- Who wrote a public maintenance revision, why, and on which reviewed decision
-- (ADR 0046, re-shaped by ADR 0063 item 8). Additive only: revisions written
-- before this migration keep NULL, which means "not recorded", never a guessed
-- operator. The append-only triggers of 0065 stay.
--
-- The actor kinds are the operator and a principal the owner delegated
-- (`mcp-client:<sub>` under MCP_DELEGATIONS, ADR 0063); there is no bare agent
-- kind.
ALTER TABLE provider_maintenance_rules ADD COLUMN actor_kind TEXT
 CHECK(actor_kind IN('operator','delegated'));
-- Why, as a closed code (MAINTENANCE_CHANGE_REASONS in
-- packages/collection/src/schedule-model.ts); never free text. A revision that
-- records its actor kind records its reason, and only the operator's own edit
-- is `operator-edit`.
ALTER TABLE provider_maintenance_rules ADD COLUMN change_reason TEXT
 CHECK(CASE WHEN change_reason IS NULL THEN actor_kind IS NULL
  WHEN change_reason='operator-edit' THEN actor_kind IS 'operator'
  ELSE actor_kind IS NOT NULL AND change_reason IN('official-notice-added',
   'official-notice-changed','official-notice-withdrawn','outage-observed',
   'owner-instructed','correction','maintenance-survey-proposal-accepted') END);
-- An optional reference to the reviewed proposal or decision behind a revision.
ALTER TABLE provider_maintenance_rules ADD COLUMN decision_ref TEXT
 CHECK(decision_ref IS NULL OR length(decision_ref) BETWEEN 1 AND 200);
-- Bounds the per-principal daily budget check of delegated revisions, which
-- the writer runs inside its INSERT.
CREATE INDEX maintenance_agent_writes ON provider_maintenance_rules(actor,created_at)
 WHERE actor_kind='delegated';
