-- Economic events, allocations, obligations and settlements (architecture
-- addendum A10; addendum 07, findings AR07/AR08). Additive only: no existing
-- table, view, trigger or row is altered, and a Worker build that predates this
-- migration keeps working because it never reads or writes the tables below.
--
-- Every table here is Layer C: an interpretation supported by Layer B evidence
-- and by a decision. Layer A and Layer B are never rewritten, so a wrong merge
-- is undone by appending a new revision, and the reports that cite the old
-- revision keep reading it (addendum 07 section 7, INV01/INV08).
--
-- Append-only, with the same *_no_update / *_no_delete / *_no_replace triggers
-- as 0018 and 0029. Exactly two one-shot pointers may ever be written after
-- insert, each guarded by a trigger and each settable once:
--   * superseded_by on the revision and allocation tables, and
--   * (status, decision_revision_id) on reconciliation_proposals, which is the
--     same kind of pointer: it records which decision resolved a candidate.
-- No column that carries a fact is ever updated.
--
-- Judgements about these rows are recorded in decision_revisions (0029) with
-- subject_kind='relation' -- the only non-mapping subject that CHECK admits --
-- and a prefixed subject_ref: 'proposal:', 'event:', 'obligation:',
-- 'allocation:' or 'settlement:'. The prefix keeps the subject namespaces
-- disjoint from the entity_relations ids that use the bare form.

-- Candidate matches (addendum 07 section 3). A proposal changes no adopted
-- state (INV07): it records the target claims, why they were proposed, what
-- would reject them, and which matcher release produced it. `kind` is a strict
-- subset of the entity_relations kinds of 0029, so an accepted proposal can
-- always be written as a relation without widening that closed list.
CREATE TABLE reconciliation_proposals (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
 kind TEXT NOT NULL CHECK(kind IN ('provider_same','pending_to_posted','supersedes','supports','contradicts','funded_by','statement_covers')),
 stage TEXT NOT NULL CHECK(stage IN ('A','B','C')),
 -- Typed SourceFactRefs: [{kind,id,revision}, ...], at least two of them.
 target_refs_json TEXT NOT NULL CHECK(json_valid(target_refs_json) AND json_type(target_refs_json)='array' AND json_array_length(target_refs_json)>=2),
 method TEXT NOT NULL CHECK(method IN ('rule','manual','ai')),
 policy_release TEXT NOT NULL CHECK(length(policy_release) BETWEEN 1 AND 128),
 rationale_codes_json TEXT NOT NULL CHECK(json_valid(rationale_codes_json) AND json_type(rationale_codes_json)='array'),
 rejection_conditions_json TEXT NOT NULL CHECK(json_valid(rejection_conditions_json) AND json_type(rejection_conditions_json)='array'),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND json_type(evidence_refs_json)='array'),
 status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected','withdrawn')),
 decision_revision_id TEXT REFERENCES decision_revisions(id),
 -- Idempotency: the same candidate from the same matcher release is one row.
 proposal_digest TEXT NOT NULL UNIQUE CHECK(length(proposal_digest)=64 AND proposal_digest NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 CHECK((status='proposed') = (decision_revision_id IS NULL))
) STRICT;
CREATE INDEX reconciliation_proposals_status ON reconciliation_proposals(status,kind,stage);
CREATE INDEX reconciliation_proposals_decision ON reconciliation_proposals(decision_revision_id);
CREATE TRIGGER reconciliation_proposals_no_delete BEFORE DELETE ON reconciliation_proposals BEGIN SELECT RAISE(ABORT,'reconciliation proposals are append-only'); END;
CREATE TRIGGER reconciliation_proposals_no_replace BEFORE INSERT ON reconciliation_proposals
WHEN EXISTS(SELECT 1 FROM reconciliation_proposals WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'reconciliation proposal replacement is forbidden'); END;
-- A matcher only ever writes candidates; nothing is born accepted (INV07).
CREATE TRIGGER reconciliation_proposals_insert_proposed BEFORE INSERT ON reconciliation_proposals
WHEN NEW.status<>'proposed' OR NEW.decision_revision_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'proposal_must_start_proposed'); END;
-- The one permitted update: resolve a still-open proposal by naming the
-- decision that resolved it. Every fact column stays as inserted.
CREATE TRIGGER reconciliation_proposals_resolve_only BEFORE UPDATE ON reconciliation_proposals
WHEN OLD.status<>'proposed' OR NEW.status='proposed' OR NEW.decision_revision_id IS NULL
 OR NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.stage<>OLD.stage
 OR NEW.target_refs_json<>OLD.target_refs_json OR NEW.method<>OLD.method
 OR NEW.policy_release<>OLD.policy_release OR NEW.rationale_codes_json<>OLD.rationale_codes_json
 OR NEW.rejection_conditions_json<>OLD.rejection_conditions_json
 OR NEW.evidence_refs_json<>OLD.evidence_refs_json OR NEW.proposal_digest<>OLD.proposal_digest
 OR NEW.created_at<>OLD.created_at
 OR NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id
  AND d.subject_kind='relation' AND d.subject_ref='proposal:'||OLD.id)
BEGIN SELECT RAISE(ABORT,'proposal_resolution_invalid'); END;

-- One adopted economic event, one revision at a time. `state` belongs to the
-- state family of its own kind (addendum 07 section 5); a state that cannot be
-- decided is 'unknown' with the reason it is unknown, never a neighbouring
-- state. superseded_by names 'event_id@revision', which may be a different
-- event id so a wrongly merged event can be split apart later.
CREATE TABLE economic_event_revisions (
 event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 256),
 revision INTEGER NOT NULL CHECK(revision>0),
 kind TEXT NOT NULL CHECK(kind IN ('purchase','charge','refund','transfer','card_settlement','fee','platform_payout','unknown')),
 state TEXT NOT NULL CHECK(state IN ('proposed','authorized','captured','canceled','observed','issued','revised','requested','debited','in-transit','credited','returned','confirmed','unknown')),
 unknown_reason TEXT CHECK(unknown_reason IS NULL OR unknown_reason IN ('provider_status_absent','provider_status_unmapped','conflicting_evidence','evidence_out_of_scope','kind_undecided')),
 effective_time_json TEXT NOT NULL CHECK(json_valid(effective_time_json) AND json_type(effective_time_json)='object'),
 basis TEXT NOT NULL CHECK(basis IN ('cash-movement','purchase-recognition','obligation-change','trade-date','settlement-date','unknown')),
 evidence_support_json TEXT NOT NULL CHECK(json_valid(evidence_support_json) AND json_type(evidence_support_json)='array' AND json_array_length(evidence_support_json)>0),
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 superseded_by TEXT CHECK(superseded_by IS NULL OR length(superseded_by) BETWEEN 3 AND 512),
 created_at TEXT NOT NULL,
 PRIMARY KEY(event_id,revision),
 CHECK((state='unknown') = (unknown_reason IS NOT NULL)),
 CHECK(CASE kind
  WHEN 'purchase' THEN state IN ('proposed','authorized','captured','canceled','unknown')
  WHEN 'refund' THEN state IN ('proposed','authorized','captured','canceled','unknown')
  WHEN 'charge' THEN state IN ('observed','issued','revised','canceled','unknown')
  WHEN 'transfer' THEN state IN ('requested','debited','in-transit','credited','returned','unknown')
  WHEN 'card_settlement' THEN state IN ('requested','debited','credited','returned','unknown')
  WHEN 'platform_payout' THEN state IN ('requested','debited','in-transit','credited','returned','unknown')
  WHEN 'fee' THEN state IN ('proposed','confirmed','canceled','unknown')
  ELSE state='unknown' END)
) STRICT;
CREATE INDEX economic_event_revisions_current ON economic_event_revisions(event_id,revision) WHERE superseded_by IS NULL;
CREATE INDEX economic_event_revisions_kind ON economic_event_revisions(kind,state);
CREATE INDEX economic_event_revisions_decision ON economic_event_revisions(decision_revision_id);
CREATE TRIGGER economic_event_revisions_no_delete BEFORE DELETE ON economic_event_revisions BEGIN SELECT RAISE(ABORT,'economic event revisions are append-only'); END;
CREATE TRIGGER economic_event_revisions_no_replace BEFORE INSERT ON economic_event_revisions
WHEN EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=NEW.event_id AND revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic event revision replacement is forbidden'); END;
CREATE TRIGGER economic_event_revisions_provenance BEFORE INSERT ON economic_event_revisions
WHEN NEW.superseded_by IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id
  AND d.subject_kind='relation' AND d.subject_ref='event:'||NEW.event_id)
BEGIN SELECT RAISE(ABORT,'event_decision_missing'); END;
-- The one permitted update: point a live revision at the revision that
-- replaced it. The replacement must already exist and must not be this row.
CREATE TRIGGER economic_event_revisions_supersede_only BEFORE UPDATE ON economic_event_revisions
WHEN OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
 OR NEW.event_id<>OLD.event_id OR NEW.revision<>OLD.revision OR NEW.kind<>OLD.kind
 OR NEW.state<>OLD.state OR NEW.unknown_reason IS NOT OLD.unknown_reason
 OR NEW.effective_time_json<>OLD.effective_time_json OR NEW.basis<>OLD.basis
 OR NEW.evidence_support_json<>OLD.evidence_support_json
 OR NEW.decision_revision_id<>OLD.decision_revision_id OR NEW.created_at<>OLD.created_at
 OR NEW.superseded_by=OLD.event_id||'@'||OLD.revision
 OR NOT EXISTS(SELECT 1 FROM economic_event_revisions r WHERE r.event_id||'@'||r.revision=NEW.superseded_by)
BEGIN SELECT RAISE(ABORT,'event_supersession_invalid'); END;

-- The legs of one event revision. Each leg keeps its own unit: a fee, a
-- principal and a receipt in another currency are separate rows and are never
-- added together (INV03). A leg whose amount is missing, unparsed or in
-- conflict keeps that status; it never becomes zero (INV05).
CREATE TABLE economic_legs (
 event_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 leg_index INTEGER NOT NULL CHECK(leg_index>=0),
 subject_ref TEXT NOT NULL CHECK(length(subject_ref) BETWEEN 1 AND 512),
 unit_ref TEXT NOT NULL CHECK(length(unit_ref) BETWEEN 1 AND 128),
 value_status TEXT NOT NULL CHECK(value_status IN ('exact','missing','unparsed','conflict')),
 coefficient TEXT,
 scale INTEGER,
 value_reason_code TEXT,
 role TEXT NOT NULL CHECK(role IN ('increase','decrease','fee','unresolved')),
 basis TEXT NOT NULL CHECK(basis IN ('cash-movement','purchase-recognition','obligation-change','trade-date','settlement-date','unknown')),
 PRIMARY KEY(event_id,revision,leg_index),
 FOREIGN KEY(event_id,revision) REFERENCES economic_event_revisions(event_id,revision),
 CHECK((value_status='exact' AND coefficient IS NOT NULL AND scale IS NOT NULL AND scale BETWEEN 0 AND 4096 AND value_reason_code IS NULL)
  OR (value_status<>'exact' AND coefficient IS NULL AND scale IS NULL AND value_reason_code IS NOT NULL)),
 CHECK(coefficient IS NULL OR (length(coefficient) BETWEEN 1 AND 4096
  AND (coefficient='0' OR (length(coefficient)-length(replace(coefficient,'-',''))<=1
   AND ltrim(coefficient,'-') NOT GLOB '*[^0-9]*'
   AND substr(ltrim(coefficient,'-'),1,1) BETWEEN '1' AND '9')))),
 CHECK(coefficient IS NOT '0' OR scale=0)
) STRICT;
CREATE INDEX economic_legs_subject ON economic_legs(subject_ref,unit_ref);
CREATE INDEX economic_legs_basis ON economic_legs(basis,role);
CREATE TRIGGER economic_legs_no_update BEFORE UPDATE ON economic_legs BEGIN SELECT RAISE(ABORT,'economic legs are append-only'); END;
CREATE TRIGGER economic_legs_no_delete BEFORE DELETE ON economic_legs BEGIN SELECT RAISE(ABORT,'economic legs are append-only'); END;
CREATE TRIGGER economic_legs_no_replace BEFORE INSERT ON economic_legs
WHEN EXISTS(SELECT 1 FROM economic_legs WHERE event_id=NEW.event_id AND revision=NEW.revision AND leg_index=NEW.leg_index)
 OR NOT EXISTS(SELECT 1 FROM economic_event_revisions r WHERE r.event_id=NEW.event_id AND r.revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'economic_leg_invalid'); END;

-- Which part of one observed amount was attributed to which economic effect.
-- Citing an observation twice as supporting evidence and allocating its amount
-- twice are different things: the partial unique index below permits the first
-- and refuses the second inside one live set (INV06).
CREATE TABLE allocations (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
 source_component_ref TEXT NOT NULL CHECK(length(source_component_ref) BETWEEN 1 AND 512),
 target_effect_ref TEXT NOT NULL CHECK(length(target_effect_ref) BETWEEN 1 AND 512),
 role TEXT NOT NULL CHECK(role IN ('principal','fee','refund','settlement','fill','transfer','unresolved-difference')),
 unit_ref TEXT NOT NULL CHECK(length(unit_ref) BETWEEN 1 AND 128),
 coefficient TEXT NOT NULL CHECK(length(coefficient) BETWEEN 1 AND 4096
  AND (coefficient='0' OR (length(coefficient)-length(replace(coefficient,'-',''))<=1
   AND ltrim(coefficient,'-') NOT GLOB '*[^0-9]*'
   AND substr(ltrim(coefficient,'-'),1,1) BETWEEN '1' AND '9'))),
 scale INTEGER NOT NULL CHECK(scale BETWEEN 0 AND 4096),
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 superseded_by TEXT REFERENCES allocations(id),
 created_at TEXT NOT NULL,
 CHECK(coefficient IS NOT '0' OR scale=0),
 CHECK(superseded_by IS NULL OR superseded_by<>id)
) STRICT;
CREATE UNIQUE INDEX allocations_live_pair ON allocations(source_component_ref,target_effect_ref,role) WHERE superseded_by IS NULL;
CREATE INDEX allocations_target ON allocations(target_effect_ref,role);
CREATE INDEX allocations_source ON allocations(source_component_ref);
CREATE TRIGGER allocations_no_delete BEFORE DELETE ON allocations BEGIN SELECT RAISE(ABORT,'allocations are append-only'); END;
CREATE TRIGGER allocations_no_replace BEFORE INSERT ON allocations
WHEN EXISTS(SELECT 1 FROM allocations WHERE id=NEW.id) OR NEW.superseded_by IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id
  AND d.subject_kind='relation' AND d.subject_ref='allocation:'||NEW.id)
BEGIN SELECT RAISE(ABORT,'allocation_invalid'); END;
CREATE TRIGGER allocations_supersede_only BEFORE UPDATE ON allocations
WHEN OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
 OR NEW.id<>OLD.id OR NEW.source_component_ref<>OLD.source_component_ref
 OR NEW.target_effect_ref<>OLD.target_effect_ref OR NEW.role<>OLD.role
 OR NEW.unit_ref<>OLD.unit_ref OR NEW.coefficient<>OLD.coefficient OR NEW.scale<>OLD.scale
 OR NEW.decision_revision_id<>OLD.decision_revision_id OR NEW.created_at<>OLD.created_at
 OR NOT EXISTS(SELECT 1 FROM allocations a WHERE a.id=NEW.superseded_by)
BEGIN SELECT RAISE(ABORT,'allocation_supersession_invalid'); END;

-- What is still owed, on what evidence. An obligation is never created from a
-- statement total or a credit limit (addendum 05 section 2): principal, fee
-- components and the schedule are separate, and a projected instalment fee is
-- never mixed with a fee that has been confirmed (SC04).
CREATE TABLE obligation_revisions (
 obligation_id TEXT NOT NULL CHECK(length(obligation_id) BETWEEN 1 AND 256),
 revision INTEGER NOT NULL CHECK(revision>0),
 creditor_ref TEXT NOT NULL CHECK(length(creditor_ref) BETWEEN 1 AND 512),
 debtor_ref TEXT NOT NULL CHECK(length(debtor_ref) BETWEEN 1 AND 512 AND debtor_ref<>creditor_ref),
 principal_unit_ref TEXT NOT NULL CHECK(length(principal_unit_ref) BETWEEN 1 AND 128),
 principal_status TEXT NOT NULL CHECK(principal_status IN ('exact','missing','unparsed','conflict')),
 principal_coefficient TEXT,
 principal_scale INTEGER,
 fee_components_json TEXT NOT NULL CHECK(json_valid(fee_components_json) AND json_type(fee_components_json)='array'),
 schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json) AND json_type(schedule_json)='array'),
 state TEXT NOT NULL CHECK(state IN ('open','partially-settled','settled','disputed','unknown')),
 unknown_reason TEXT CHECK(unknown_reason IS NULL OR unknown_reason IN ('provider_status_absent','provider_status_unmapped','conflicting_evidence','evidence_out_of_scope','kind_undecided')),
 state_evidence_refs_json TEXT NOT NULL CHECK(json_valid(state_evidence_refs_json) AND json_type(state_evidence_refs_json)='array'),
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 superseded_by INTEGER CHECK(superseded_by IS NULL OR superseded_by>0),
 created_at TEXT NOT NULL,
 PRIMARY KEY(obligation_id,revision),
 CHECK((state='unknown') = (unknown_reason IS NOT NULL)),
 CHECK((principal_status='exact' AND principal_coefficient IS NOT NULL AND principal_scale BETWEEN 0 AND 4096)
  OR (principal_status<>'exact' AND principal_coefficient IS NULL AND principal_scale IS NULL)),
 CHECK(principal_coefficient IS NULL OR (length(principal_coefficient) BETWEEN 1 AND 4096
  AND (principal_coefficient='0' OR (length(principal_coefficient)-length(replace(principal_coefficient,'-',''))<=1
   AND ltrim(principal_coefficient,'-') NOT GLOB '*[^0-9]*'
   AND substr(ltrim(principal_coefficient,'-'),1,1) BETWEEN '1' AND '9')))),
 CHECK(superseded_by IS NULL OR superseded_by>revision)
) STRICT;
CREATE INDEX obligation_revisions_current ON obligation_revisions(obligation_id,revision) WHERE superseded_by IS NULL;
CREATE INDEX obligation_revisions_parties ON obligation_revisions(creditor_ref,debtor_ref);
CREATE TRIGGER obligation_revisions_no_delete BEFORE DELETE ON obligation_revisions BEGIN SELECT RAISE(ABORT,'obligation revisions are append-only'); END;
CREATE TRIGGER obligation_revisions_no_replace BEFORE INSERT ON obligation_revisions
WHEN EXISTS(SELECT 1 FROM obligation_revisions WHERE obligation_id=NEW.obligation_id AND revision=NEW.revision)
 OR NEW.superseded_by IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id
  AND d.subject_kind='relation' AND d.subject_ref='obligation:'||NEW.obligation_id)
BEGIN SELECT RAISE(ABORT,'obligation_revision_invalid'); END;
CREATE TRIGGER obligation_revisions_supersede_only BEFORE UPDATE ON obligation_revisions
WHEN OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
 OR NEW.obligation_id<>OLD.obligation_id OR NEW.revision<>OLD.revision
 OR NEW.creditor_ref<>OLD.creditor_ref OR NEW.debtor_ref<>OLD.debtor_ref
 OR NEW.principal_unit_ref<>OLD.principal_unit_ref OR NEW.principal_status<>OLD.principal_status
 OR NEW.principal_coefficient IS NOT OLD.principal_coefficient
 OR NEW.principal_scale IS NOT OLD.principal_scale
 OR NEW.fee_components_json<>OLD.fee_components_json OR NEW.schedule_json<>OLD.schedule_json
 OR NEW.state<>OLD.state OR NEW.unknown_reason IS NOT OLD.unknown_reason
 OR NEW.state_evidence_refs_json<>OLD.state_evidence_refs_json
 OR NEW.decision_revision_id<>OLD.decision_revision_id OR NEW.created_at<>OLD.created_at
 OR NOT EXISTS(SELECT 1 FROM obligation_revisions o WHERE o.obligation_id=OLD.obligation_id AND o.revision=NEW.superseded_by)
BEGIN SELECT RAISE(ABORT,'obligation_supersession_invalid'); END;

-- N-to-M settlement. One payment component may settle several obligations and
-- one obligation may be settled by several components. The difference a
-- settlement could not explain is stored beside it and is never folded into
-- the principal or turned into a fee (addendum 07 section 4).
CREATE TABLE settlement_relations (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
 obligation_id TEXT NOT NULL CHECK(length(obligation_id) BETWEEN 1 AND 256),
 settlement_component_ref TEXT NOT NULL CHECK(length(settlement_component_ref) BETWEEN 1 AND 512),
 unit_ref TEXT NOT NULL CHECK(length(unit_ref) BETWEEN 1 AND 128),
 coefficient TEXT NOT NULL CHECK(length(coefficient) BETWEEN 1 AND 4096
  AND (coefficient='0' OR (length(coefficient)-length(replace(coefficient,'-',''))<=1
   AND ltrim(coefficient,'-') NOT GLOB '*[^0-9]*'
   AND substr(ltrim(coefficient,'-'),1,1) BETWEEN '1' AND '9'))),
 scale INTEGER NOT NULL CHECK(scale BETWEEN 0 AND 4096),
 occurred_json TEXT NOT NULL CHECK(json_valid(occurred_json) AND json_type(occurred_json)='object'),
 unresolved_coefficient TEXT,
 unresolved_scale INTEGER,
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 superseded_by TEXT REFERENCES settlement_relations(id),
 created_at TEXT NOT NULL,
 CHECK(coefficient IS NOT '0' OR scale=0),
 CHECK((unresolved_coefficient IS NULL AND unresolved_scale IS NULL)
  OR (unresolved_coefficient IS NOT NULL AND unresolved_scale BETWEEN 0 AND 4096)),
 CHECK(superseded_by IS NULL OR superseded_by<>id)
) STRICT;
CREATE UNIQUE INDEX settlement_relations_live_pair ON settlement_relations(obligation_id,settlement_component_ref) WHERE superseded_by IS NULL;
CREATE INDEX settlement_relations_obligation ON settlement_relations(obligation_id);
CREATE INDEX settlement_relations_component ON settlement_relations(settlement_component_ref);
CREATE TRIGGER settlement_relations_no_delete BEFORE DELETE ON settlement_relations BEGIN SELECT RAISE(ABORT,'settlement relations are append-only'); END;
CREATE TRIGGER settlement_relations_no_replace BEFORE INSERT ON settlement_relations
WHEN EXISTS(SELECT 1 FROM settlement_relations WHERE id=NEW.id) OR NEW.superseded_by IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id
  AND d.subject_kind='relation' AND d.subject_ref='settlement:'||NEW.id)
BEGIN SELECT RAISE(ABORT,'settlement_relation_invalid'); END;
CREATE TRIGGER settlement_relations_supersede_only BEFORE UPDATE ON settlement_relations
WHEN OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
 OR NEW.id<>OLD.id OR NEW.obligation_id<>OLD.obligation_id
 OR NEW.settlement_component_ref<>OLD.settlement_component_ref OR NEW.unit_ref<>OLD.unit_ref
 OR NEW.coefficient<>OLD.coefficient OR NEW.scale<>OLD.scale
 OR NEW.occurred_json<>OLD.occurred_json
 OR NEW.unresolved_coefficient IS NOT OLD.unresolved_coefficient
 OR NEW.unresolved_scale IS NOT OLD.unresolved_scale
 OR NEW.decision_revision_id<>OLD.decision_revision_id OR NEW.created_at<>OLD.created_at
 OR NOT EXISTS(SELECT 1 FROM settlement_relations s WHERE s.id=NEW.superseded_by)
BEGIN SELECT RAISE(ABORT,'settlement_supersession_invalid'); END;

-- Reader views. "Current" is always the live revision, never the newest row:
-- a revision stays readable after it is superseded so an old report keeps
-- resolving (addendum 07 section 7).
CREATE VIEW current_economic_events AS
 SELECT * FROM economic_event_revisions WHERE superseded_by IS NULL;
CREATE VIEW current_obligations AS
 SELECT * FROM obligation_revisions WHERE superseded_by IS NULL;
CREATE VIEW current_allocations AS
 SELECT * FROM allocations WHERE superseded_by IS NULL;
CREATE VIEW current_settlement_relations AS
 SELECT * FROM settlement_relations WHERE superseded_by IS NULL;
