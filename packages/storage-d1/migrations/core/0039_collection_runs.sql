-- Shared-R2 terminal registration records (unified plan 03 §4-§6, U08).
-- Additive only: no existing table, view, trigger or row is altered, and a
-- Worker that predates this migration keeps working because it never reads or
-- writes what is below.
--
-- What these tables are for: a terminal manifest in the shared DATA bucket is
-- the record that a collection run finished persisting its bytes (03 §2). The
-- Processor has to know, per run, whether it already registered that exact
-- terminal, and what happened at each stage. `last_success_at` cannot answer
-- that: a newer run succeeding says nothing about an older run that is still
-- unregistered (03 §5), so the record is per run and per stage.
--
-- Nothing here holds an amount, a credential, provider text or a URL. A row
-- holds a declared source id, a bounded run id, a bucket key that is derived
-- from those two, content digests and safe codes.

-- One (source, run, terminal digest, registration contract) the Processor has
-- seen. The four columns of the UNIQUE constraint are the idempotency key of
-- 03 §4: the same terminal delivered twice addresses this row instead of
-- registering a second time (G1-05, G1-11), a *different* manifest under the
-- same run id is a different row and is blocked as a conflict rather than
-- overwriting anything (G1-06), and a changed registration contract registers
-- the run again as a new revision instead of silently reusing the old one.
--
-- `source` deliberately carries no foreign key to `sources`. A terminal whose
-- source is not declared, or whose manifest cannot be validated at all, must
-- still be recordable as blocked — a row that cannot be written is a run that
-- silently disappears from the scan (G1-13). Authorization to *register* is
-- unchanged: it is the ingest route check that `createRun` makes.
CREATE TABLE collection_runs (
  id INTEGER PRIMARY KEY,
  -- The source the terminal claims, in the ingest contract's own charset.
  source TEXT NOT NULL
    CHECK(length(source) BETWEEN 1 AND 100 AND source NOT GLOB '*[^a-z0-9-]*'),
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 200),
  -- `runs/<source>/<runId>/terminal.json`, derived from the two above.
  terminal_key TEXT NOT NULL CHECK(length(terminal_key) BETWEEN 1 AND 1024),
  -- sha256 of the canonical terminal bytes. For a terminal that could not be
  -- validated it is the digest of the bytes that were actually stored, so a
  -- corrupt terminal still has one stable identity instead of many.
  terminal_digest TEXT NOT NULL
    CHECK(length(terminal_digest)=64 AND terminal_digest NOT GLOB '*[^0-9a-f]*'),
  registration_contract_version TEXT NOT NULL
    CHECK(length(registration_contract_version) BETWEEN 1 AND 100
          AND registration_contract_version NOT GLOB '*[^a-z0-9._-]*'),
  -- The manifest's own outcome, never widened: a partial acquisition stays
  -- partial (03 §2). NULL means the terminal could not be validated, so this
  -- run has no provider outcome at all and is never read as a success.
  provider_outcome TEXT
    CHECK(provider_outcome IS NULL OR provider_outcome IN ('success','partial','failed')),
  coverage_status TEXT
    CHECK(coverage_status IS NULL OR coverage_status IN ('complete','partial','unknown')),
  -- One acquisition session that visited several sources keeps its ref on
  -- every per-source run (03 §3); the runs stay separate.
  acquisition_session_ref TEXT
    CHECK(acquisition_session_ref IS NULL OR length(acquisition_session_ref) BETWEEN 1 AND 200),
  first_seen_at TEXT NOT NULL,
  -- Why this run is not being registered. A safe code, never a message.
  blocked_code TEXT
    CHECK(blocked_code IS NULL OR (length(blocked_code) BETWEEN 1 AND 64
          AND blocked_code NOT GLOB '*[^a-z0-9_]*')),
  -- Filled once registration reached CORE: the existing rows this terminal
  -- became. They are the link from the R2 record to the registered run, so a
  -- reader never has to re-derive it from a key or a timestamp.
  fetch_run_id INTEGER REFERENCES fetch_runs(id),
  acquisition_session_id INTEGER REFERENCES acquisition_sessions(id),
  registered_at TEXT,
  -- A validated terminal has both outcome columns; an unvalidated one has
  -- neither and must say why.
  CHECK((provider_outcome IS NULL) = (coverage_status IS NULL)),
  CHECK(provider_outcome IS NOT NULL OR blocked_code IS NOT NULL),
  -- A run is registered only together with the rows it produced.
  CHECK((registered_at IS NULL) = (fetch_run_id IS NULL)),
  UNIQUE(source, run_id, terminal_digest, registration_contract_version)
) STRICT;
CREATE INDEX collection_runs_run ON collection_runs(source, run_id);
CREATE INDEX collection_runs_fetch_run ON collection_runs(fetch_run_id)
  WHERE fetch_run_id IS NOT NULL;
CREATE INDEX collection_runs_open ON collection_runs(blocked_code, registered_at, id);
CREATE TRIGGER collection_runs_no_delete BEFORE DELETE ON collection_runs
BEGIN SELECT RAISE(ABORT,'collection runs are append-only'); END;
-- A run is seen once, unregistered and unblocked. It is never inserted as
-- already registered by somebody who did not do the registration.
CREATE TRIGGER collection_runs_no_replace BEFORE INSERT ON collection_runs
WHEN NEW.registered_at IS NOT NULL OR NEW.fetch_run_id IS NOT NULL
 OR NEW.acquisition_session_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'a collection run is recorded before it is registered'); END;
-- Only progress moves: the identity of the run and of its terminal never
-- changes, and the links and the block reason are written once. Re-pointing a
-- registered run at other CORE rows would rewrite history rather than record it.
CREATE TRIGGER collection_runs_progress_only BEFORE UPDATE ON collection_runs
WHEN NEW.id<>OLD.id OR NEW.source<>OLD.source OR NEW.run_id<>OLD.run_id
 OR NEW.terminal_key<>OLD.terminal_key OR NEW.terminal_digest<>OLD.terminal_digest
 OR NEW.registration_contract_version<>OLD.registration_contract_version
 OR NEW.provider_outcome IS NOT OLD.provider_outcome
 OR NEW.coverage_status IS NOT OLD.coverage_status
 OR NEW.acquisition_session_ref IS NOT OLD.acquisition_session_ref
 OR NEW.first_seen_at<>OLD.first_seen_at
 OR (OLD.blocked_code IS NOT NULL AND NEW.blocked_code IS NOT OLD.blocked_code)
 OR (OLD.fetch_run_id IS NOT NULL AND NEW.fetch_run_id IS NOT OLD.fetch_run_id)
 OR (OLD.acquisition_session_id IS NOT NULL
     AND NEW.acquisition_session_id IS NOT OLD.acquisition_session_id)
 OR (OLD.registered_at IS NOT NULL AND NEW.registered_at IS NOT OLD.registered_at)
BEGIN SELECT RAISE(ABORT,'a collection run is immutable except its progress'); END;

-- Stage evidence, in the vocabulary of contracts/stages.json (03 §5):
-- persisted -> registered -> parsed -> adopted -> projected. Each attempt is
-- its own row, so the table is append-only in the strict sense: a failed
-- attempt is never rewritten into a success, and the history of what was
-- tried survives. The current state of a stage is its newest row.
--
-- `state` is the job outcome vocabulary. `completed` is written only by the
-- executor that holds the evidence; queued, building, a flag being off and
-- "no processor" are never completion, which the shared stage contract in
-- `packages/collection/src/stages.ts` refuses before this table is reached.
CREATE TABLE collection_run_stages (
  id INTEGER PRIMARY KEY,
  collection_run_id INTEGER NOT NULL REFERENCES collection_runs(id),
  stage TEXT NOT NULL
    CHECK(stage IN ('persisted','registered','parsed','adopted','projected')),
  state TEXT NOT NULL CHECK(state IN ('pending','completed','retryable','blocked')),
  -- What proves the stage: a run id, a parse run id, a snapshot id. Never a
  -- URL, a bucket key or provider text.
  evidence_ref TEXT CHECK(evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 256),
  failure_code TEXT
    CHECK(failure_code IS NULL OR (length(failure_code) BETWEEN 1 AND 64
          AND failure_code NOT GLOB '*[^a-z0-9_]*')),
  recorded_at TEXT NOT NULL
) STRICT;
CREATE INDEX collection_run_stages_run ON collection_run_stages(collection_run_id, stage, id);
CREATE INDEX collection_run_stages_state ON collection_run_stages(stage, state, id);
CREATE TRIGGER collection_run_stages_no_update BEFORE UPDATE ON collection_run_stages
BEGIN SELECT RAISE(ABORT,'collection run stages are append-only'); END;
CREATE TRIGGER collection_run_stages_no_delete BEFORE DELETE ON collection_run_stages
BEGIN SELECT RAISE(ABORT,'collection run stages are append-only'); END;

-- The cron scan's cursor. Operational state, not a fact: it may be reset, and
-- resetting it re-walks the prefix rather than losing anything.
--
-- It is an R2 list cursor over the whole `runs/` prefix, one bounded page per
-- tick, and it is deliberately not a timestamp window or a lexicographic
-- watermark: a run whose terminal is confirmed late sorts wherever its run id
-- puts it, and "everything after the newest key I saw" would drop it (03 §6,
-- G1-12). `cursor` NULL means the next tick starts a new cycle at the
-- beginning of the prefix.
CREATE TABLE collection_scan_state (
  lane TEXT PRIMARY KEY CHECK(lane='collection_scan'),
  cursor TEXT CHECK(cursor IS NULL OR length(cursor) BETWEEN 1 AND 12000),
  last_scan_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_scan_at_ms>=0),
  pages_completed INTEGER NOT NULL DEFAULT 0 CHECK(pages_completed>=0),
  cycles_completed INTEGER NOT NULL DEFAULT 0 CHECK(cycles_completed>=0),
  last_seen INTEGER NOT NULL DEFAULT 0 CHECK(last_seen>=0),
  last_registered INTEGER NOT NULL DEFAULT 0 CHECK(last_registered>=0),
  last_blocked INTEGER NOT NULL DEFAULT 0 CHECK(last_blocked>=0)
) STRICT;
INSERT INTO collection_scan_state(lane) VALUES('collection_scan');
