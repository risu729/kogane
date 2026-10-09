-- Own-transfer proposals (ADR 0057, issue #549, stage G3-a; docs/economic-events.md,
-- "Own-transfer proposals"). Proposal-only: a row here says that a debit row and
-- a credit row of two of the person's own accounts may be one movement, under a
-- pinned policy version, engine release and identity epoch. Nothing here is
-- adopted state. No lane writes these tables yet, and no planner that reads
-- them is registered: the change lifecycle still refuses every economic-event
-- command (ADR 0054's production gate is unchanged).
--
-- Additive only: no existing table, view, trigger or row is altered. The new
-- objects read only their own tables and economic_identity_epochs (CORE 0070),
-- so they add nothing to ADR 0054's "Rebuilding a table 0070 reads" list and
-- read no command table. A proposal cites its rows by observation id, parse run
-- and their 5-tuple key, with no foreign key to transaction_observations or
-- parse_runs, so a later rebuild of those tables need not carry these as
-- children; the planner re-derives each key from the cited row when it reads a
-- proposal, and CORE 0070's claim trigger re-derives it again at commit.
--
-- No amount, provider text or merchant is stored: the value of each leg is the
-- cited row's.

-- One proposal, append-only. proposal_id is 'otp_' + SHA-256 of the engine
-- release, policy version, identity epoch and both alias classes; the digest
-- covers everything else the proposal states. codes_json is a set of closed
-- codes; status is needs_review exactly when the pairing is not unique.
CREATE TABLE own_transfer_proposals (
 proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id)=68 AND substr(proposal_id,1,4)='otp_'
  AND substr(proposal_id,5) NOT GLOB '*[^0-9a-f]*'),
 proposal_digest TEXT NOT NULL CHECK(length(proposal_digest)=64 AND proposal_digest NOT GLOB '*[^0-9a-f]*'),
 status TEXT NOT NULL CHECK(status IN ('proposed','needs_review')),
 codes_json TEXT NOT NULL CHECK(length(codes_json)<=512 AND json_valid(codes_json) AND json_type(codes_json)='array'
  AND json_array_length(codes_json) BETWEEN 1 AND 6),
 debit_observation_id INTEGER NOT NULL CHECK(debit_observation_id>0),
 debit_parse_run_id INTEGER NOT NULL CHECK(debit_parse_run_id>0),
 debit_consumption_key TEXT NOT NULL CHECK(length(debit_consumption_key) BETWEEN 2 AND 2048
  AND json_valid(debit_consumption_key) AND json_type(debit_consumption_key)='array' AND json_array_length(debit_consumption_key)=5),
 debit_alias_class TEXT NOT NULL CHECK(length(debit_alias_class) BETWEEN 2 AND 2048
  AND json_valid(debit_alias_class) AND json_type(debit_alias_class)='array' AND json_array_length(debit_alias_class)=4),
 debit_account_id TEXT NOT NULL CHECK(length(debit_account_id) BETWEEN 1 AND 256),
 credit_observation_id INTEGER NOT NULL CHECK(credit_observation_id>0),
 credit_parse_run_id INTEGER NOT NULL CHECK(credit_parse_run_id>0),
 credit_consumption_key TEXT NOT NULL CHECK(length(credit_consumption_key) BETWEEN 2 AND 2048
  AND json_valid(credit_consumption_key) AND json_type(credit_consumption_key)='array' AND json_array_length(credit_consumption_key)=5),
 credit_alias_class TEXT NOT NULL CHECK(length(credit_alias_class) BETWEEN 2 AND 2048
  AND json_valid(credit_alias_class) AND json_type(credit_alias_class)='array' AND json_array_length(credit_alias_class)=4),
 credit_account_id TEXT NOT NULL CHECK(length(credit_account_id) BETWEEN 1 AND 256),
 policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 64 AND policy_version NOT GLOB '*[^a-z0-9.-]*'),
 engine_release TEXT NOT NULL CHECK(length(engine_release) BETWEEN 1 AND 64 AND engine_release NOT GLOB '*[^a-z0-9.:-]*'),
 identity_epoch TEXT NOT NULL REFERENCES economic_identity_epochs(identity_epoch),
 manifest_json TEXT NOT NULL CHECK(length(manifest_json)<=8192 AND json_valid(manifest_json) AND json_type(manifest_json)='object'),
 created_at TEXT NOT NULL CHECK(length(created_at)=24 AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at)
  AND substr(created_at,12,2)<'24'),
 CHECK(debit_account_id<>credit_account_id),
 CHECK(debit_consumption_key<>credit_consumption_key),
 CHECK(debit_alias_class<>credit_alias_class)
) STRICT;
CREATE INDEX own_transfer_proposals_debit_alias ON own_transfer_proposals(debit_alias_class);
CREATE INDEX own_transfer_proposals_credit_alias ON own_transfer_proposals(credit_alias_class);
CREATE TRIGGER own_transfer_proposals_no_update BEFORE UPDATE ON own_transfer_proposals BEGIN SELECT RAISE(ABORT,'own-transfer proposals are append-only'); END;
CREATE TRIGGER own_transfer_proposals_no_delete BEFORE DELETE ON own_transfer_proposals BEGIN SELECT RAISE(ABORT,'own-transfer proposals are append-only'); END;
CREATE TRIGGER own_transfer_proposals_no_replace BEFORE INSERT ON own_transfer_proposals
WHEN EXISTS(SELECT 1 FROM own_transfer_proposals WHERE proposal_id=NEW.proposal_id)
BEGIN SELECT RAISE(ABORT,'own-transfer proposal replacement is forbidden'); END;
-- Closed codes, each once; needs_review exactly with candidate_not_unique; a
-- proposal is made under the current identity epoch only.
CREATE TRIGGER own_transfer_proposals_guard BEFORE INSERT ON own_transfer_proposals
WHEN EXISTS(SELECT 1 FROM json_each(NEW.codes_json) c WHERE c.type<>'text' OR c.value NOT IN
  ('both_accounts_self','same_currency','date_within_window','amount_equal','difference_within_policy','candidate_not_unique'))
 OR (SELECT count(DISTINCT c.value) FROM json_each(NEW.codes_json) c)<>json_array_length(NEW.codes_json)
 OR (NEW.status='needs_review')<>EXISTS(SELECT 1 FROM json_each(NEW.codes_json) c WHERE c.value='candidate_not_unique')
 OR NEW.identity_epoch IS NOT (SELECT e.identity_epoch FROM economic_identity_epochs e ORDER BY e.ordinal DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT,'own_transfer_proposal_invalid'); END;

-- A proposal that is no longer in force, append-only, once per proposal: a
-- later engine run under another policy, engine release or identity epoch, or
-- a cited row that is no longer what the proposal read. A retired proposal is
-- never in force again; the same pair under a new policy is a new proposal.
CREATE TABLE own_transfer_proposal_retirements (
 proposal_id TEXT PRIMARY KEY REFERENCES own_transfer_proposals(proposal_id),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('engine_superseded','evidence_changed','identity_epoch_changed')),
 retired_at TEXT NOT NULL CHECK(length(retired_at)=24 AND retired_at IS strftime('%Y-%m-%dT%H:%M:%fZ',retired_at)
  AND substr(retired_at,12,2)<'24')
) STRICT;
CREATE TRIGGER own_transfer_proposal_retirements_no_update BEFORE UPDATE ON own_transfer_proposal_retirements BEGIN SELECT RAISE(ABORT,'own-transfer proposal retirements are append-only'); END;
CREATE TRIGGER own_transfer_proposal_retirements_no_delete BEFORE DELETE ON own_transfer_proposal_retirements BEGIN SELECT RAISE(ABORT,'own-transfer proposal retirements are append-only'); END;
CREATE TRIGGER own_transfer_proposal_retirements_no_replace BEFORE INSERT ON own_transfer_proposal_retirements
WHEN EXISTS(SELECT 1 FROM own_transfer_proposal_retirements WHERE proposal_id=NEW.proposal_id)
BEGIN SELECT RAISE(ABORT,'own-transfer proposal retirement replacement is forbidden'); END;
