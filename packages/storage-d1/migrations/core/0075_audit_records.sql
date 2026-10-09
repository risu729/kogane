-- The common append-only audit record (ADR 0064; docs/audit-log.md). Additive
-- only: no existing table, view, trigger or row is altered, and a Worker build
-- that predates this migration never names these tables.
--
-- One row per operation, for the human UI and the agent paths alike: who
-- (the verified Access subject and the principal it was graded as), through
-- which path, which catalogued operation, on which target, with which result
-- and closed code, under which correlation id. The row names what changed by
-- reference into the existing logs (plan ids, approval ids, decision revision
-- ids, `<id>@<revision>`, operation ids) and holds counts and closed codes; it
-- never copies a decision, a plan payload, a rule pattern or provider text.
--
-- Every column is an enum, a bounded pattern, a digest, a count or a canonical
-- time: there is no free-text column. `refs_json` is an array of at most 16
-- closed references and `diff_json` one object of at most 2,048 bytes whose
-- text values are codes; the trigger below refuses anything else, so a write
-- path that tried to store a provider string, a reason or an amount as text
-- fails rather than records it.
--
-- `principal_kind` admits `delegated` and `delegation_ref` for the delegated
-- MCP principal of ADR 0063, whose slice adds no migration; no writer of this
-- slice produces either.
--
-- An `applied` or `accepted` record is the last statement of its writer's own
-- D1 batch, joined to the writer's guard, so it exists exactly when the effect
-- does. `refused`, `failed`, `read` and `replayed` records are written by the
-- App adapter after the answer, at most 2,000 `read` and 500 `refused` per
-- principal and UTC day; past a cap each event increments a row of
-- audit_overflow_counters instead, which the Processor turns into one
-- `overflow` record after the day ends.
CREATE TABLE audit_records (
 audit_id TEXT PRIMARY KEY CHECK(length(audit_id)=40 AND substr(audit_id,1,4)='aud_'
  AND substr(audit_id,5) NOT GLOB '*[^0-9a-f-]*' AND length(replace(substr(audit_id,5),'-',''))=32
  AND substr(audit_id,13,1)='-' AND substr(audit_id,18,1)='-' AND substr(audit_id,23,1)='-'
  AND substr(audit_id,28,1)='-'),
 -- The economic_commit_log.known_at shape (0070): canonical UTC milliseconds.
 recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24
  AND recorded_at IS strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) AND substr(recorded_at,12,2)<'24'),
 path TEXT NOT NULL CHECK(path IN ('ui','agent-http','mcp','alarm','lane')),
 subject TEXT CHECK(subject IS NULL OR (length(subject) BETWEEN 1 AND 256
  AND subject GLOB '[A-Za-z0-9]*' AND subject NOT GLOB '*[^A-Za-z0-9._:@/-]*')),
 principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 256
  AND principal GLOB '[A-Za-z0-9]*' AND principal NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
 principal_kind TEXT NOT NULL CHECK(principal_kind IN ('human','agent','delegated','automatic')),
 delegation_ref TEXT CHECK(delegation_ref IS NULL OR (length(delegation_ref)=68
  AND substr(delegation_ref,1,4)='dlg_' AND substr(delegation_ref,5) NOT GLOB '*[^0-9a-f]*')),
 operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64
  AND operation GLOB '[a-z]*' AND operation NOT GLOB '*[^a-z0-9.-]*'),
 risk_class TEXT NOT NULL CHECK(risk_class IN ('R0','R1','R2','R3','R4')),
 step TEXT NOT NULL CHECK(step IN ('call','prepare','confirm')),
 scope_namespace TEXT CHECK(scope_namespace IS NULL OR scope_namespace IN ('core-source','schedule-source')),
 scope_source TEXT CHECK(scope_source IS NULL OR (length(scope_source) BETWEEN 1 AND 100
  AND scope_source NOT GLOB '*[^a-z0-9-]*')),
 target_ref TEXT CHECK(target_ref IS NULL OR (length(target_ref) BETWEEN 1 AND 300
  AND target_ref GLOB '[a-z]*' AND target_ref NOT GLOB '*[^A-Za-z0-9._:@/-]*')),
 result TEXT NOT NULL CHECK(result IN ('applied','accepted','prepared','read','replayed','refused','failed','overflow')),
 result_code TEXT CHECK(result_code IS NULL OR (length(result_code) BETWEEN 1 AND 64
  AND result_code GLOB '[a-z]*' AND result_code NOT GLOB '*[^a-z0-9_]*')),
 reason_code TEXT CHECK(reason_code IS NULL OR (length(reason_code) BETWEEN 1 AND 64
  AND reason_code GLOB '[a-z]*' AND reason_code NOT GLOB '*[^a-z0-9_-]*')),
 correlation_id TEXT NOT NULL CHECK(length(correlation_id)=36
  AND correlation_id NOT GLOB '*[^0-9a-f-]*' AND length(replace(correlation_id,'-',''))=32
  AND substr(correlation_id,9,1)='-' AND substr(correlation_id,14,1)='-'
  AND substr(correlation_id,19,1)='-' AND substr(correlation_id,24,1)='-'),
 idempotency_key TEXT CHECK(idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 1 AND 128
  AND idempotency_key GLOB '[A-Za-z0-9]*' AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*')),
 payload_digest TEXT CHECK(payload_digest IS NULL OR (length(payload_digest)=64
  AND payload_digest NOT GLOB '*[^0-9a-f]*')),
 confirmation_digest TEXT CHECK(confirmation_digest IS NULL OR (length(confirmation_digest)=68
  AND substr(confirmation_digest,1,4)='cfm_' AND substr(confirmation_digest,5) NOT GLOB '*[^0-9a-f]*')),
 confirm_expires_at TEXT CHECK(confirm_expires_at IS NULL OR (length(confirm_expires_at)=24
  AND confirm_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ',confirm_expires_at)
  AND substr(confirm_expires_at,12,2)<'24')),
 confirms_audit_id TEXT REFERENCES audit_records(audit_id),
 reverts_audit_id TEXT REFERENCES audit_records(audit_id),
 refs_json TEXT NOT NULL DEFAULT '[]' CHECK(length(refs_json)<=5000 AND json_valid(refs_json)
  AND json_type(refs_json)='array' AND json_array_length(refs_json)<=16),
 diff_json TEXT NOT NULL CHECK(length(diff_json)<=2048 AND json_valid(diff_json)
  AND json_type(diff_json)='object'
  AND json_extract(diff_json,'$.kind') IN ('revision','decision','request','read','lane','release','overflow','none')),
 -- A subject exactly where a verified person stands behind the call; alarm and
 -- lane records are the Processor's own and carry an automatic principal.
 CHECK((subject IS NULL)=(path IN ('alarm','lane'))),
 CHECK((principal_kind='automatic')=(path IN ('alarm','lane'))),
 CHECK((delegation_ref IS NOT NULL)=(principal_kind='delegated')),
 CHECK((scope_namespace IS NULL)=(scope_source IS NULL)),
 CHECK((result_code IS NOT NULL)=(result IN ('refused','failed'))),
 CHECK((confirmation_digest IS NOT NULL)=(result='prepared')),
 CHECK((confirm_expires_at IS NOT NULL)=(result='prepared')),
 CHECK(result<>'prepared' OR step='prepare'),
 CHECK((confirms_audit_id IS NOT NULL)=(step='confirm')),
 CHECK(json_extract(diff_json,'$.kind')<>'overflow' OR result='overflow'),
 CHECK(result<>'overflow' OR json_extract(diff_json,'$.kind')='overflow')
) STRICT;
CREATE INDEX audit_records_by_principal ON audit_records(principal,recorded_at);
CREATE INDEX audit_records_by_scope ON audit_records(scope_namespace,scope_source,recorded_at);
CREATE INDEX audit_records_by_operation ON audit_records(operation,recorded_at);
CREATE INDEX audit_records_by_target ON audit_records(target_ref);
CREATE INDEX audit_records_by_correlation ON audit_records(correlation_id);
-- The operator's whole-store page reads newest first; without this index every
-- page would scan and sort the whole table (docs/audit-log.md, "Cost").
CREATE INDEX audit_records_by_time ON audit_records(recorded_at,audit_id);
-- A prepared operation is confirmed at most once, and a caller's key names at
-- most one applied operation per principal: a second one raises inside the
-- writer's batch and rolls its effect back with it.
CREATE UNIQUE INDEX audit_records_confirm_once ON audit_records(confirms_audit_id)
 WHERE confirms_audit_id IS NOT NULL AND result IN ('applied','accepted');
CREATE UNIQUE INDEX audit_records_idempotency ON audit_records(principal,operation,idempotency_key)
 WHERE idempotency_key IS NOT NULL AND result IN ('applied','accepted');
CREATE TRIGGER audit_records_no_update BEFORE UPDATE ON audit_records
BEGIN SELECT RAISE(ABORT,'audit records are append-only'); END;
CREATE TRIGGER audit_records_no_delete BEFORE DELETE ON audit_records
BEGIN SELECT RAISE(ABORT,'audit records are append-only'); END;
-- INSERT OR REPLACE on the key would delete the stored row without firing the
-- delete trigger.
CREATE TRIGGER audit_records_no_replace BEFORE INSERT ON audit_records
WHEN EXISTS(SELECT 1 FROM audit_records WHERE audit_id=NEW.audit_id)
BEGIN SELECT RAISE(ABORT,'audit record replacement is forbidden'); END;
-- No free text in the two JSON columns: references are closed-pattern ids, and
-- the diff's keys are names and its text values codes (lower case, no space),
-- its numbers non-negative integers.
CREATE TRIGGER audit_records_closed_json BEFORE INSERT ON audit_records
WHEN EXISTS(SELECT 1 FROM json_each(NEW.refs_json) r
  WHERE r.type<>'text' OR length(r.atom) NOT BETWEEN 1 AND 300
  OR r.atom NOT GLOB '[a-z]*' OR r.atom GLOB '*[^A-Za-z0-9._:@/-]*')
 OR EXISTS(SELECT 1 FROM json_tree(NEW.diff_json) d
  WHERE (typeof(d.key)='text' AND (length(d.key) NOT BETWEEN 1 AND 64
    OR d.key NOT GLOB '[a-z]*' OR d.key GLOB '*[^A-Za-z0-9_]*'))
  OR d.type='real' OR (d.type='integer' AND d.atom<0)
  OR (d.type='text' AND (length(d.atom) NOT BETWEEN 1 AND 64
    OR d.atom NOT GLOB '[a-z]*' OR d.atom GLOB '*[^a-z0-9._:@-]*')))
BEGIN SELECT RAISE(ABORT,'audit_record_free_text'); END;

-- How many `read` and `refused` events of one principal, path and UTC day
-- went past the day's cap and were therefore not recorded one by one. The
-- first Processor tick after the day ends appends one `overflow` audit record
-- per row, with the exact count, and deletes the row in the same batch.
-- Mutable bookkeeping (operational-mutable), keyed by day first so that tick
-- reads only the days that ended.
CREATE TABLE audit_overflow_counters (
 day TEXT NOT NULL CHECK(length(day)=10 AND day IS strftime('%Y-%m-%d',day)),
 principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 256
  AND principal GLOB '[A-Za-z0-9]*' AND principal NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
 path TEXT NOT NULL CHECK(path IN ('ui','agent-http','mcp')),
 result TEXT NOT NULL CHECK(result IN ('read','refused')),
 subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 256
  AND subject GLOB '[A-Za-z0-9]*' AND subject NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
 principal_kind TEXT NOT NULL CHECK(principal_kind IN ('human','agent','delegated')),
 count INTEGER NOT NULL CHECK(count>=1),
 PRIMARY KEY(day,principal,path,result)
) STRICT;
