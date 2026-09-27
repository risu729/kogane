-- The card provider's own statement of the debit account, and what it says
-- about each card settlement candidate (ADR 0032 and its 2026-09-27
-- amendment, docs/card-settlements.md). Additive only: no existing table,
-- view, trigger or row is altered, and a Worker build that predates this
-- migration keeps working because it never names anything below.
--
-- 1. card_debit_account_statement: one reading of the 「カード情報」 table of
--    one stored MyJCB credit detail page (`readMyJcbCardInformation`), per
--    card, per raw object, per reader version. The same bytes stored by
--    several runs are read once. A reading is either `read`, with the bank
--    name, branch name, 科目 and the leading digits as the page shows them,
--    or `refused`, with a closed code and no value at all. The account
--    holder's name (口座名義) and the card name are never stored (ADR 0029).
--    A corrected reader is a new reader version and a new row; a row is
--    never changed. Append-only evidence.
CREATE TABLE card_debit_account_statement (
 id INTEGER PRIMARY KEY,
 source_id TEXT NOT NULL CHECK(source_id='myjcb'),
 -- The card side's CORE source account, as the page's statement total
 -- carries it: `myjcb:<connection>:root`.
 card_source_account TEXT NOT NULL CHECK(length(card_source_account) BETWEEN 12 AND 75
  AND card_source_account GLOB 'myjcb:[a-z0-9]*:root'
  AND substr(card_source_account,7,length(card_source_account)-11) NOT GLOB '*[^a-z0-9-]*'),
 -- The artifact read first, and the published statement parse that admitted
 -- the page (parser `myjcb-credit-statement-total`).
 fetch_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
 statement_parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
 raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'),
 source_object_key TEXT NOT NULL CHECK(length(source_object_key) BETWEEN 1 AND 500),
 -- When the page was captured (the artifact's fetch time), not when it was read.
 observed_at TEXT NOT NULL CHECK(length(observed_at) BETWEEN 1 AND 64),
 reader_version TEXT NOT NULL CHECK(length(reader_version) BETWEEN 1 AND 64
  AND reader_version GLOB '[a-z]*' AND reader_version NOT GLOB '*[^a-z0-9.-]*'),
 outcome TEXT NOT NULL CHECK(outcome IN ('read','refused')),
 refusal_code TEXT CHECK(refusal_code IS NULL OR refusal_code IN (
  'card_information_absent','card_information_ambiguous','card_information_table_missing',
  'card_information_table_invalid','card_information_name_invalid',
  'card_information_account_invalid','page_not_utf8','raw_object_unreadable')),
 bank_name TEXT CHECK(bank_name IS NULL OR length(bank_name) BETWEEN 1 AND 64),
 branch_name TEXT CHECK(branch_name IS NULL OR length(branch_name) BETWEEN 1 AND 64),
 account_type TEXT CHECK(account_type IS NULL OR account_type IN ('普通','当座')),
 -- The account number's FIRST digits, as shown; the rest is masked.
 leading_digits TEXT CHECK(leading_digits IS NULL OR (length(leading_digits)=4
  AND leading_digits NOT GLOB '*[^0-9]*')),
 masked_digit_count INTEGER CHECK(masked_digit_count IS NULL OR masked_digit_count BETWEEN 1 AND 12),
 created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 1 AND 64),
 CHECK((outcome='read' AND refusal_code IS NULL AND bank_name IS NOT NULL
   AND branch_name IS NOT NULL AND account_type IS NOT NULL AND leading_digits IS NOT NULL
   AND masked_digit_count IS NOT NULL)
  OR (outcome='refused' AND refusal_code IS NOT NULL AND bank_name IS NULL
   AND branch_name IS NULL AND account_type IS NULL AND leading_digits IS NULL
   AND masked_digit_count IS NULL))
) STRICT;
-- One reading per card, raw object and reader version: the lane's anti-join
-- and the settlement sweep's lookup both probe this key.
CREATE UNIQUE INDEX card_debit_account_statement_object
 ON card_debit_account_statement(raw_sha256,card_source_account,reader_version);
CREATE TRIGGER card_debit_account_statement_no_update BEFORE UPDATE ON card_debit_account_statement
BEGIN SELECT RAISE(ABORT,'card debit account statements are append-only'); END;
CREATE TRIGGER card_debit_account_statement_no_delete BEFORE DELETE ON card_debit_account_statement
BEGIN SELECT RAISE(ABORT,'card debit account statements are append-only'); END;

-- 2. card_settlement_debit_account_evidence: what one debit-account statement
--    says about one settlement candidate under one rule policy
--    (`candidateDebitAccountEvidence`): `supports` (the proposal names the
--    candidate's card and bank account), `names_other_account`, or
--    `not_proposed` with the rule's closed reason. Evidence only: the
--    candidate's facts, digest and eligibility never change, and the
--    operator still accepts (INV07). A new row is appended only when the
--    outcome differs from the candidate's latest row for that statement and
--    policy. Append-only evidence.
CREATE TABLE card_settlement_debit_account_evidence (
 id INTEGER PRIMARY KEY,
 candidate_id TEXT NOT NULL REFERENCES card_settlement_candidates(id),
 statement_id INTEGER NOT NULL REFERENCES card_debit_account_statement(id),
 policy TEXT NOT NULL CHECK(length(policy) BETWEEN 1 AND 64
  AND policy GLOB 'card-debit-account-statement-v[0-9]*'),
 outcome TEXT NOT NULL CHECK(outcome IN ('supports','names_other_account','not_proposed')),
 reason TEXT CHECK(reason IS NULL OR reason IN (
  'statement_invalid','bank_not_resolved','account_type_not_resolved','account_digits_not_shown',
  'no_comparable_bank_account','no_matching_account','ambiguous_accounts',
  'uncomparable_account_at_bank')),
 -- The proposal as the rule made it: source accounts, rationale codes and the
 -- statement reference. Never an amount or displayed text.
 proposal_json TEXT CHECK(proposal_json IS NULL OR (json_valid(proposal_json)
  AND json_type(proposal_json)='object' AND length(proposal_json)<=4096)),
 evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 1 AND 64),
 CHECK((outcome='not_proposed')=(reason IS NOT NULL)),
 CHECK((outcome='not_proposed')=(proposal_json IS NULL))
) STRICT;
CREATE INDEX card_settlement_debit_account_evidence_candidate
 ON card_settlement_debit_account_evidence(candidate_id,statement_id,policy,id);
CREATE TRIGGER card_settlement_debit_account_evidence_no_update BEFORE UPDATE ON card_settlement_debit_account_evidence
BEGIN SELECT RAISE(ABORT,'card settlement debit account evidence is append-only'); END;
CREATE TRIGGER card_settlement_debit_account_evidence_no_delete BEFORE DELETE ON card_settlement_debit_account_evidence
BEGIN SELECT RAISE(ABORT,'card settlement debit account evidence is append-only'); END;
-- The statement a row cites is a reading of this candidate's own card.
CREATE TRIGGER card_settlement_debit_account_evidence_card BEFORE INSERT ON card_settlement_debit_account_evidence
WHEN NOT EXISTS(SELECT 1 FROM card_debit_account_statement s
  JOIN card_settlement_candidates c ON c.id=NEW.candidate_id
  WHERE s.id=NEW.statement_id AND s.outcome='read'
   AND json_extract(c.facts_json,'$.statement.sourceAccount')=s.card_source_account)
BEGIN SELECT RAISE(ABORT,'debit account evidence must cite a reading of the candidate card'); END;
