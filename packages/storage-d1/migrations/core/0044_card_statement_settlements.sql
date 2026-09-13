-- Reviewable statement-total / bank-debit correspondence. All facts and
-- judgements are append-only; only explicit accepted decisions allocate money.
CREATE TABLE card_settlement_candidates (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
 statement_key TEXT NOT NULL CHECK(length(statement_key) BETWEEN 1 AND 1024),
 bank_key TEXT NOT NULL CHECK(length(bank_key) BETWEEN 1 AND 1024),
 statement_observation_id INTEGER NOT NULL REFERENCES balance_observations(id),
 statement_parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
 bank_observation_id INTEGER NOT NULL REFERENCES transaction_observations(id),
 bank_parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
 policy_release TEXT NOT NULL,
 facts_json TEXT NOT NULL CHECK(json_valid(facts_json) AND json_type(facts_json)='object'),
 proposal_digest TEXT NOT NULL UNIQUE CHECK(length(proposal_digest)=64),
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX card_settlement_candidates_statement ON card_settlement_candidates(statement_key);
CREATE INDEX card_settlement_candidates_bank ON card_settlement_candidates(bank_key);
CREATE TRIGGER card_settlement_candidates_no_update BEFORE UPDATE ON card_settlement_candidates BEGIN SELECT RAISE(ABORT,'card settlement candidates are append-only'); END;
CREATE TRIGGER card_settlement_candidates_no_delete BEFORE DELETE ON card_settlement_candidates BEGIN SELECT RAISE(ABORT,'card settlement candidates are append-only'); END;
CREATE TRIGGER card_settlement_candidates_no_replace BEFORE INSERT ON card_settlement_candidates
WHEN EXISTS(SELECT 1 FROM card_settlement_candidates WHERE id=NEW.id OR proposal_digest=NEW.proposal_digest)
 OR NOT EXISTS(SELECT 1 FROM balance_observations WHERE id=NEW.statement_observation_id AND parse_run_id=NEW.statement_parse_run_id)
 OR NOT EXISTS(SELECT 1 FROM transaction_observations WHERE id=NEW.bank_observation_id AND parse_run_id=NEW.bank_parse_run_id)
BEGIN SELECT RAISE(ABORT,'card_settlement_candidate_invalid'); END;

CREATE TABLE card_settlement_decisions (
 proposal_id TEXT NOT NULL REFERENCES card_settlement_candidates(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('accepted','rejected','withdrawn')),
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 event_id TEXT,
 obligation_id TEXT,
 settlement_id TEXT REFERENCES allocations(id),
 created_at TEXT NOT NULL,
 PRIMARY KEY(proposal_id,revision),
 CHECK((status='rejected' AND event_id IS NULL AND obligation_id IS NULL AND settlement_id IS NULL)
  OR (status<>'rejected' AND event_id IS NOT NULL AND obligation_id IS NULL AND settlement_id IS NOT NULL))
) STRICT;
CREATE TRIGGER card_settlement_decisions_no_update BEFORE UPDATE ON card_settlement_decisions BEGIN SELECT RAISE(ABORT,'card settlement decisions are append-only'); END;
CREATE TRIGGER card_settlement_decisions_no_delete BEFORE DELETE ON card_settlement_decisions BEGIN SELECT RAISE(ABORT,'card settlement decisions are append-only'); END;
CREATE TRIGGER card_settlement_decisions_guard BEFORE INSERT ON card_settlement_decisions
WHEN NEW.revision<>coalesce((SELECT max(revision) FROM card_settlement_decisions WHERE proposal_id=NEW.proposal_id),0)+1
 OR NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id
  AND d.subject_kind='relation' AND d.subject_ref='card-settlement:'||NEW.proposal_id AND d.revision=NEW.revision)
 OR (NEW.revision=1 AND NEW.status='withdrawn')
 OR (NEW.revision>1 AND (NEW.status<>'withdrawn' OR NOT EXISTS(
  SELECT 1 FROM card_settlement_decisions p WHERE p.proposal_id=NEW.proposal_id
   AND p.revision=NEW.revision-1 AND p.status='accepted'
   AND p.event_id=NEW.event_id AND p.obligation_id IS NEW.obligation_id AND p.settlement_id=NEW.settlement_id)))
BEGIN SELECT RAISE(ABORT,'card_settlement_revision_conflict'); END;

CREATE VIEW card_settlement_reviews AS
 SELECT c.*,coalesce(d.revision,0) AS revision,coalesce(d.status,'proposed') AS status,
 d.decision_revision_id,d.event_id,d.obligation_id,d.settlement_id
 FROM card_settlement_candidates c LEFT JOIN card_settlement_decisions d ON d.proposal_id=c.id
 AND d.revision=(SELECT max(latest.revision) FROM card_settlement_decisions latest WHERE latest.proposal_id=c.id);

-- A withdrawal retracts a judgement, never a payment or an immutable source row.
CREATE TABLE card_settlement_allocation_withdrawals (
 settlement_id TEXT PRIMARY KEY REFERENCES allocations(id),
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER card_settlement_allocation_withdrawals_no_update BEFORE UPDATE ON card_settlement_allocation_withdrawals BEGIN SELECT RAISE(ABORT,'settlement withdrawals are append-only'); END;
CREATE TRIGGER card_settlement_allocation_withdrawals_no_delete BEFORE DELETE ON card_settlement_allocation_withdrawals BEGIN SELECT RAISE(ABORT,'settlement withdrawals are append-only'); END;
CREATE TRIGGER card_settlement_allocation_withdrawals_guard BEFORE INSERT ON card_settlement_allocation_withdrawals
WHEN EXISTS(SELECT 1 FROM card_settlement_allocation_withdrawals WHERE settlement_id=NEW.settlement_id)
 OR NOT EXISTS(SELECT 1 FROM decision_revisions d WHERE d.id=NEW.decision_revision_id AND d.decision_kind='supersede' AND d.subject_ref='allocation:'||NEW.settlement_id)
BEGIN SELECT RAISE(ABORT,'settlement_withdrawal_invalid'); END;
CREATE VIEW current_card_settlement_allocations AS SELECT a.* FROM allocations a
 WHERE a.role='settlement' AND a.superseded_by IS NULL
 AND NOT EXISTS(SELECT 1 FROM card_settlement_allocation_withdrawals w WHERE w.settlement_id=a.id);
CREATE TRIGGER card_settlement_decisions_bump_revision_insert AFTER INSERT ON card_settlement_decisions
 BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER card_settlement_decisions_bump_revision_update AFTER UPDATE ON card_settlement_decisions
 BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;
CREATE TRIGGER card_settlement_decisions_bump_revision_delete AFTER DELETE ON card_settlement_decisions
 BEGIN UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1; END;


-- Latest published provider statements. A missing paymentDate stays missing:
-- the as_of month-start used by old MyJCB aggregates is never a due date.
CREATE VIEW card_statement_facts AS
WITH ranked AS (
 SELECT b.id,b.parse_run_id,b.source_account,b.instrument AS unit_ref,a.source_id,
 d.status AS value_status,d.coefficient,d.scale,
 json_extract(b.extra_json,'$._kogane.paymentDate') AS payment_date,
 coalesce(json_extract(b.extra_json,'$._kogane.period'),
  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2)) AS period,
 json_array(a.source_id,fr.producer_id,ses.external_id_namespace,b.source_account,
  coalesce(json_extract(b.extra_json,'$._kogane.period'),
   substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2))) AS statement_key,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,b.source_account,
  coalesce(json_extract(b.extra_json,'$._kogane.period'),
   substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2))
  ORDER BY a.fetched_at DESC,json_extract(b.extra_json,'$._kogane.paymentDate') IS NOT NULL DESC,b.id DESC) AS position
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
 WHERE ((a.source_id='vpass' AND p.parser_name='vpass-statement-page') OR (a.source_id='myjcb' AND p.parser_name='myjcb-credit-statement-total'))
 AND b.metric='credit_statement_payment_amount' AND json_valid(b.extra_json)
 AND json_extract(b.extra_json,'$._kogane.snapshotSemantics')='provider-reported-monthly-payment-amount'
)
SELECT * FROM ranked WHERE position=1;

-- First bank adapter: SMBC's provider-id and explicitly signed debit fields.
-- Re-observing a provider id does not create another allocatable payment.
CREATE VIEW card_bank_debit_facts AS
WITH ranked AS (
 SELECT t.id,t.parse_run_id,t.source_account,t.currency AS unit_ref,a.source_id,t.as_of,
 t.external_id,t.status,t.extra_json,d.status AS value_status,d.coefficient,d.scale,
 json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS bank_key,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id
  ORDER BY a.fetched_at DESC,t.id DESC) AS position
 FROM transaction_observations t
 JOIN published_parse_runs pub ON pub.parse_run_id=t.parse_run_id
 JOIN parse_runs p ON p.id=t.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='transaction' AND d.observation_id=t.id AND d.policy_version='decimal-v1'
 WHERE a.source_id='smbc-bank' AND t.external_id IS NOT NULL AND t.external_id<>''
)
SELECT * FROM ranked WHERE position=1 AND status='posted' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.direction')='outflow'
 AND json_extract(extra_json,'$._kogane.amountSignSource')='direction'
 AND coefficient LIKE '-%';

-- Ownership is an explicit accepted relation, never inferred from the login,
-- matching labels or amounts. Conflicting account/party mappings stay unknown.
CREATE VIEW card_settlement_fact_ownership AS
SELECT o.kind,o.observation_id,
 CASE WHEN count(DISTINCT m.account_id)=1 THEN min(m.account_id) END AS account_id,
 CASE WHEN count(DISTINCT m.account_id)=1 AND count(DISTINCT r.to_ref)=1 THEN min(r.to_ref) END AS owner_ref,
 json_array('account_mapping:'||min(m.id),'relation:'||min(r.id),'decision:'||min(d.id)) AS evidence_refs_json
FROM current_identity_observations o
JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
LEFT JOIN entity_relations r ON r.from_ref IN(m.account_id,'account:'||m.account_id)
 AND r.kind=CASE WHEN o.kind='balance' THEN 'liable_party' ELSE 'beneficial_owner' END AND r.status='accepted'
 AND r.valid_from IS NULL AND r.valid_to IS NULL
 AND NOT EXISTS(SELECT 1 FROM entity_relations newer WHERE newer.kind=r.kind
  AND newer.from_ref=r.from_ref AND newer.to_ref=r.to_ref AND newer.rowid>r.rowid)
LEFT JOIN decision_revisions d ON d.id=r.decision_revision_id AND d.superseded_by IS NULL
WHERE o.kind IN ('balance','transaction') AND (r.id IS NULL OR d.id IS NOT NULL)
GROUP BY o.kind,o.observation_id;

-- Same predicate flags feed review and the atomic acceptance reservation.
CREATE VIEW card_settlement_readiness AS
SELECT c.id,
 EXISTS(SELECT 1 FROM card_statement_facts s WHERE s.id=c.statement_observation_id AND s.parse_run_id=c.statement_parse_run_id) AS statement_current,
 EXISTS(SELECT 1 FROM card_bank_debit_facts b WHERE b.id=c.bank_observation_id AND b.parse_run_id=c.bank_parse_run_id) AS bank_current,
 EXISTS(SELECT 1 FROM card_settlement_fact_ownership s JOIN card_settlement_fact_ownership b
  ON b.kind='transaction' AND b.observation_id=c.bank_observation_id
  WHERE s.kind='balance' AND s.observation_id=c.statement_observation_id
   AND s.owner_ref IS NOT NULL AND s.owner_ref=b.owner_ref
   AND s.account_id=json_extract(c.facts_json,'$.statement.accountId')
   AND b.account_id=json_extract(c.facts_json,'$.bankDebit.accountId')
   AND s.owner_ref=json_extract(c.facts_json,'$.statement.ownerRef')
   AND b.owner_ref=json_extract(c.facts_json,'$.bankDebit.ownerRef')
   AND NOT EXISTS(SELECT 1 FROM json_each(s.evidence_refs_json) e WHERE e.value NOT IN (SELECT value FROM json_each(c.facts_json,'$.ownershipEvidenceRefs')))
   AND NOT EXISTS(SELECT 1 FROM json_each(b.evidence_refs_json) e WHERE e.value NOT IN (SELECT value FROM json_each(c.facts_json,'$.ownershipEvidenceRefs')))
 ) AS ownership_current,
 NOT EXISTS(SELECT 1 FROM card_settlement_reviews used WHERE used.status='accepted' AND used.id<>c.id
  AND (used.statement_key=c.statement_key OR used.bank_key=c.bank_key))
 AND NOT EXISTS(SELECT 1 FROM current_allocations a
  JOIN transaction_observations t ON a.source_component_ref='transaction:'||t.id
  JOIN parse_runs p ON p.id=t.parse_run_id
  JOIN observation_fetch_artifacts artifact ON artifact.id=p.fetch_artifact_id
  JOIN financial_fetch_runs fr ON fr.id=artifact.fetch_run_id
  JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
  WHERE json_array(artifact.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id)=c.bank_key
  AND a.id IS NOT (SELECT settlement_id FROM card_settlement_reviews self WHERE self.id=c.id)) AS allocation_available
FROM card_settlement_candidates c;

DROP VIEW current_allocations;
CREATE VIEW current_allocations AS SELECT a.* FROM allocations a
WHERE a.superseded_by IS NULL AND NOT EXISTS(
 SELECT 1 FROM card_settlement_allocation_withdrawals w WHERE w.settlement_id=a.id);

-- Operational scan progress, not financial evidence. Cycles through older
-- statements so new observations cannot permanently starve historical review.
CREATE TABLE card_settlement_scan_cursor (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 last_statement_id INTEGER NOT NULL
) STRICT;
INSERT INTO card_settlement_scan_cursor VALUES(1,0);
