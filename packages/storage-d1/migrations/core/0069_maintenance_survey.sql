-- The official-site maintenance re-survey (ADR 0050). Additive only: no
-- existing table, view, trigger or row is altered, and a Worker build that
-- predates this migration never names these tables.
--
-- Every attempt to read an allowlisted notice page is a fetch row: when, the
-- HTTP status, the closed media type, the byte size and SHA-256 of the body
-- (stored content-addressed in R2 under `object_key`), the extractor version
-- and a closed outcome. A failed or empty fetch is a row with its failure
-- code, never "no maintenance". What the page would change in the current
-- rules is a proposal; an operator's accept or reject is a decision. Fetches,
-- proposals and decisions are append-only evidence. No column holds provider
-- text: patterns are the schedule model's closed JSON and reasons are closed
-- codes. The per-page cursor is the lane's mutable bookkeeping.
CREATE TABLE maintenance_survey_fetches (
 id INTEGER PRIMARY KEY,
 target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 100 AND target_id NOT GLOB '*[^a-z0-9-]*'),
 source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 100 AND source NOT GLOB '*[^a-z0-9-]*'),
 url TEXT NOT NULL CHECK(url GLOB 'https://*' AND length(url)<=1500),
 fetched_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('extracted','network_error','timeout','http_error','redirected',
  'too_large','unsupported_content_type','empty_body','store_failed','decode_failed',
  'no_window_recognized','too_many_windows')),
 http_status INTEGER CHECK(http_status IS NULL OR http_status BETWEEN 100 AND 599),
 media_type TEXT CHECK(media_type IS NULL OR media_type IN('text/html','application/xhtml+xml','text/plain','other')),
 byte_size INTEGER CHECK(byte_size IS NULL OR byte_size>=0),
 sha256 TEXT CHECK(sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
 object_key TEXT CHECK(object_key IS NULL OR object_key='maintenance-survey/objects/'||substr(sha256,1,2)||'/'||sha256),
 extractor_version TEXT NOT NULL CHECK(length(extractor_version) BETWEEN 1 AND 100),
 windows INTEGER NOT NULL DEFAULT 0 CHECK(windows>=0),
 past INTEGER NOT NULL DEFAULT 0 CHECK(past>=0),
 rejected INTEGER NOT NULL DEFAULT 0 CHECK(rejected>=0),
 CHECK((object_key IS NULL)=(sha256 IS NULL)),
 -- Only a stored body can be read; a read always has a stored body.
 CHECK(outcome NOT IN('extracted','decode_failed','no_window_recognized','too_many_windows') OR object_key IS NOT NULL),
 CHECK(outcome<>'extracted' OR windows+past>0)
) STRICT;
CREATE INDEX maintenance_survey_fetches_target ON maintenance_survey_fetches(target_id,id);
CREATE TRIGGER maintenance_survey_fetches_no_update BEFORE UPDATE ON maintenance_survey_fetches
BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER maintenance_survey_fetches_no_delete BEFORE DELETE ON maintenance_survey_fetches
BEGIN SELECT RAISE(ABORT,'append_only'); END;

-- One proposed change per (target, kind, rule, base revision, window): the
-- same reading again is the same proposal, and a rejected one is not
-- proposed again until the rule or the page changes.
CREATE TABLE maintenance_survey_proposals (
 id INTEGER PRIMARY KEY,
 fetch_id INTEGER NOT NULL REFERENCES maintenance_survey_fetches(id),
 target_id TEXT NOT NULL,
 source TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('new','changed','absent')),
 rule_id TEXT CHECK(rule_id IS NULL OR (length(rule_id) BETWEEN 1 AND 100 AND rule_id NOT GLOB '*[^a-z0-9-]*')),
 base_revision INTEGER NOT NULL CHECK(base_revision>=0),
 timezone TEXT NOT NULL CHECK(timezone IN('Asia/Tokyo','UTC','Australia/Sydney')),
 pattern_json TEXT NOT NULL CHECK(json_valid(pattern_json) AND json_type(pattern_json)='object'),
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 scope TEXT NOT NULL CHECK(scope IN('collection','session','feature-only')),
 status TEXT NOT NULL CHECK(status IN('proposed','review_pending')),
 reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json) AND json_type(reasons_json)='array'),
 proposal_key TEXT NOT NULL UNIQUE CHECK(length(proposal_key)=64 AND proposal_key NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 CHECK((kind='new')=(rule_id IS NULL)),
 CHECK((rule_id IS NULL)=(base_revision=0)),
 CHECK((kind='absent')=(enabled=0)),
 CHECK((status='proposed')=(reasons_json='[]'))
) STRICT;
CREATE INDEX maintenance_survey_proposals_fetch ON maintenance_survey_proposals(fetch_id);
-- Reasons are closed codes (packages/collection/src/maintenance-survey-model.ts).
CREATE TRIGGER maintenance_survey_proposal_reasons BEFORE INSERT ON maintenance_survey_proposals
WHEN EXISTS(SELECT 1 FROM json_each(NEW.reasons_json) WHERE type<>'text' OR value NOT IN(
 'year_inferred','weekday_mismatch','end_next_day_inferred','timezone_mismatch','exception_stated',
 'may_change','cancellation_stated','partial_service','long_window','contradictory_windows',
 'ambiguous_rule_match','rule_disabled_by_operator','rule_absent_from_page'))
BEGIN SELECT RAISE(ABORT,'maintenance_survey_reason_invalid'); END;
CREATE TRIGGER maintenance_survey_proposals_no_update BEFORE UPDATE ON maintenance_survey_proposals
BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER maintenance_survey_proposals_no_delete BEFORE DELETE ON maintenance_survey_proposals
BEGIN SELECT RAISE(ABORT,'append_only'); END;

-- An operator's judgement of one proposal, once. An accepted proposal names
-- the rule revision the maintenance writer appended for it.
CREATE TABLE maintenance_survey_decisions (
 proposal_id INTEGER PRIMARY KEY REFERENCES maintenance_survey_proposals(id),
 decision TEXT NOT NULL CHECK(decision IN('accepted','rejected')),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 decided_at TEXT NOT NULL,
 rule_id TEXT,
 rule_revision INTEGER CHECK(rule_revision IS NULL OR rule_revision>=1),
 CHECK((decision='accepted')=(rule_id IS NOT NULL AND rule_revision IS NOT NULL)),
 CHECK(decision='accepted' OR (rule_id IS NULL AND rule_revision IS NULL))
) STRICT;
CREATE TRIGGER maintenance_survey_decisions_no_update BEFORE UPDATE ON maintenance_survey_decisions
BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER maintenance_survey_decisions_no_delete BEFORE DELETE ON maintenance_survey_decisions
BEGIN SELECT RAISE(ABORT,'append_only'); END;

-- The lane's position per allowlisted page: when it is next due, and the
-- freshness the schedule page shows. Mutable bookkeeping; the fetch rows are
-- the record.
CREATE TABLE maintenance_survey_cursors (
 target_id TEXT PRIMARY KEY CHECK(length(target_id) BETWEEN 1 AND 100 AND target_id NOT GLOB '*[^a-z0-9-]*'),
 next_due_at TEXT NOT NULL,
 last_attempt_at TEXT,
 last_success_at TEXT,
 last_failure_at TEXT,
 last_failure_code TEXT CHECK(last_failure_code IS NULL OR last_failure_code IN('network_error','timeout',
  'http_error','redirected','too_large','unsupported_content_type','empty_body','store_failed',
  'decode_failed','no_window_recognized','too_many_windows')),
 consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
 last_fetch_id INTEGER REFERENCES maintenance_survey_fetches(id),
 last_sha256 TEXT,
 last_changed_at TEXT
) STRICT;
