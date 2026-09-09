-- Kogane observation-pipeline PoC schema.
-- D1-compatible SQLite (STRICT tables, no PRAGMA statements; foreign-key
-- enforcement is enabled by the connection, as D1 does by default).
--
-- Layer A (raw evidence): sources / fetch_runs / raw_objects / fetch_artifacts,
-- following the sketch in docs/roadmap.md phase 2. Layer B (observations):
-- parse_runs plus one physically separate table per observation shape,
-- following docs/roadmap.md phase 3 and docs/design.md.
--
-- Conventions enforced here (docs/design.md):
--   * append-only: raw evidence and observations are never updated, with one
--     deliberate exception — parse_runs.superseded_by_parse_run_id, which marks
--     a whole parse run as superseded by a re-parse (supersession is data about
--     the parse lineage, not a mutation of any observation row);
--   * fiat amounts are INTEGER minor units (JPY as yen, AUD/USD as cents);
--     REAL is never used for money;
--   * high-precision quantities are TEXT decimal strings with explicit scale;
--   * three timestamps are distinguished: as_of / observed_at / fetched_at;
--   * unrecognized provider fields are carried in extra_json, never dropped.

-- ── layer A: raw evidence ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,       -- e.g. 'sbi-securities'
  provider       TEXT NOT NULL,          -- display name
  ingestion      TEXT NOT NULL           -- 'kuebiko' | 'collector-r2' | 'file-export'
) STRICT;

CREATE TABLE IF NOT EXISTS fetch_runs (
  id              INTEGER PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES sources(id),
  external_run_id TEXT,                  -- collector runId / kuebiko run dir name
  tool            TEXT NOT NULL,         -- 'import-run' | 'ingest-file' | ...
  started_at      TEXT NOT NULL,         -- ISO 8601 UTC
  completed_at    TEXT,
  status          TEXT NOT NULL,         -- 'success' | 'partial' | 'failed'
  failure_count   INTEGER NOT NULL DEFAULT 0
                  CHECK (failure_count >= 0),
  window_start    TEXT,
  window_end      TEXT,
  UNIQUE (source_id, external_run_id)
) STRICT;

CREATE TABLE IF NOT EXISTS raw_objects (
  sha256       TEXT PRIMARY KEY,         -- hex digest; also the blob key
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  blob_key     TEXT NOT NULL             -- R2 key (PoC: path under state/blobs/)
) STRICT;

CREATE TABLE IF NOT EXISTS fetch_artifacts (
  id           INTEGER PRIMARY KEY,
  fetch_run_id INTEGER NOT NULL REFERENCES fetch_runs(id),
  source_id    TEXT NOT NULL REFERENCES sources(id),
  dataset      TEXT,                     -- collector dataset name, if any
  artifact_key TEXT,                     -- run-relative collector key, if declared
  fetch_unit_key TEXT,                   -- stable Layer-A unit key (card/account/etc.)
  statement_state TEXT,                  -- artifact-specific provider statement state
  period       TEXT,                     -- artifact-specific provider period label
  url          TEXT,                     -- original URL for capture-style ingestion
  method       TEXT,
  http_status  INTEGER,
  mime         TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  sha256       TEXT NOT NULL REFERENCES raw_objects(sha256)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_fetch_artifacts_source
  ON fetch_artifacts (source_id, dataset, fetched_at);
CREATE INDEX IF NOT EXISTS idx_fetch_artifacts_sha
  ON fetch_artifacts (sha256);

-- Per-unit terminal outcome. Production Layer A keeps this in `fetch_units` /
-- `fetch_unit_reports` and projects it as `observation_fetch_artifact_units`
-- (migration 0037); the PoC has no unit hierarchy, so it records the same fact
-- flatly against the artifact's `fetch_unit_key` and projects the identically
-- named view. `unit_status` carries the same meaning in both: 'success' means
-- the unit's own terminal report succeeded, which is the only evidence
-- `unit-independent-v1` accepts (design review D13).
CREATE TABLE IF NOT EXISTS fetch_unit_outcomes (
  fetch_run_id  INTEGER NOT NULL REFERENCES fetch_runs(id),
  unit_key      TEXT NOT NULL,
  unit_outcome  TEXT NOT NULL CHECK (unit_outcome IN (
    'success', 'partial', 'failed', 'human_required', 'cancelled', 'unknown')),
  unit_failure_code TEXT,
  PRIMARY KEY (fetch_run_id, unit_key)
) STRICT;

CREATE VIEW IF NOT EXISTS observation_fetch_artifact_units AS
  SELECT a.id AS fetch_artifact_id, a.fetch_run_id, NULL AS fetch_unit_id,
         'unit' AS unit_kind, u.unit_key,
         u.unit_outcome, u.unit_failure_code,
         CASE WHEN u.unit_outcome = 'success' AND u.unit_failure_code IS NULL
              THEN 'success' ELSE 'failed' END AS unit_status
    FROM fetch_artifacts a
    JOIN fetch_unit_outcomes u
      ON u.fetch_run_id = a.fetch_run_id AND u.unit_key = a.fetch_unit_key;

-- ── layer B: observations ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS parse_runs (
  id                          INTEGER PRIMARY KEY,
  fetch_artifact_id           INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  parser_name                 TEXT NOT NULL,
  parser_version              TEXT NOT NULL,
  parsed_at                   TEXT NOT NULL,
  status                      TEXT NOT NULL,  -- 'ok' | 'error'
  error                       TEXT,
  warnings_json               TEXT,           -- JSON array of warning strings
  superseded_by_parse_run_id  INTEGER REFERENCES parse_runs(id)
) STRICT;

-- One SUCCESSFUL parse run per (artifact, parser, version). Failed attempts
-- are deliberately not covered by this index: a parse that failed on a
-- transient condition must remain retryable at the same version, and a failed
-- attempt is itself evidence worth keeping.
CREATE UNIQUE INDEX IF NOT EXISTS idx_parse_runs_success
  ON parse_runs (fetch_artifact_id, parser_name, parser_version)
  WHERE status = 'ok';

CREATE INDEX IF NOT EXISTS idx_parse_runs_artifact
  ON parse_runs (fetch_artifact_id, parser_name);

-- "The source says: this transaction happened / is pending."
CREATE TABLE IF NOT EXISTS transaction_observations (
  id             INTEGER PRIMARY KEY,
  parse_run_id   INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account TEXT NOT NULL,          -- the provider's own account label
  external_id    TEXT,                   -- provider id; NOT a logical identity
  status         TEXT,                   -- provider-shown status, verbatim domain
  amount_minor   INTEGER,                -- signed minor units; NULL if unparseable
  amount_text    TEXT,                   -- verbatim/high-precision amount, never lost
  amount_scale   INTEGER,
  currency       TEXT,                   -- ISO 4217 as the provider stated it
  description    TEXT,
  counterparty   TEXT,
  as_of          TEXT,                   -- the date the value describes
  observed_at    TEXT,                   -- when the source displayed/reported it
  raw_locator    TEXT NOT NULL,          -- locator inside the raw object
  extra_json     TEXT NOT NULL           -- everything else the source said
) STRICT;

CREATE INDEX IF NOT EXISTS idx_txn_obs_account
  ON transaction_observations (source_account, as_of);

-- "The source says: metric M of account A was N at time T."
CREATE TABLE IF NOT EXISTS balance_observations (
  id             INTEGER PRIMARY KEY,
  parse_run_id   INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account TEXT NOT NULL,
  metric         TEXT NOT NULL,          -- 'buy_possible' | 'keep_cash' | ...
  amount_minor   INTEGER,                -- fiat path
  amount_text    TEXT,                   -- high-precision path (crypto etc.)
  amount_scale   INTEGER,
  instrument     TEXT NOT NULL,          -- currency / unit code as provider stated
  as_of          TEXT,
  observed_at    TEXT,
  raw_locator    TEXT NOT NULL,
  extra_json     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_bal_obs_account
  ON balance_observations (source_account, metric, instrument, as_of);

-- "The source says: account A holds quantity Q of security S."
CREATE TABLE IF NOT EXISTS position_observations (
  id              INTEGER PRIMARY KEY,
  parse_run_id    INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account  TEXT NOT NULL,
  security_code   TEXT NOT NULL,         -- provider's code, verbatim
  security_name   TEXT,
  market          TEXT,
  quantity_text   TEXT NOT NULL,         -- decimal string, never REAL
  quantity_scale  INTEGER NOT NULL,
  currency        TEXT,                  -- trading currency as provider stated
  as_of           TEXT,
  observed_at     TEXT,
  raw_locator     TEXT NOT NULL,
  extra_json      TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pos_obs_account
  ON position_observations (source_account, security_code, as_of);

-- "The source says: this holding is worth V / has P&L L" — provider-reported
-- valuations only; our own computed valuations are a derived layer, not this.
CREATE TABLE IF NOT EXISTS valuation_observations (
  id             INTEGER PRIMARY KEY,
  parse_run_id   INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account TEXT NOT NULL,
  subject        TEXT NOT NULL,          -- what is valued (security code, ...)
  metric         TEXT NOT NULL,          -- 'evaluation_amount' | 'evaluation_profit_loss' | ...
  amount_minor   INTEGER,
  amount_text    TEXT,
  amount_scale   INTEGER,
  currency       TEXT NOT NULL,
  as_of          TEXT,
  observed_at    TEXT,
  raw_locator    TEXT NOT NULL,
  extra_json     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_val_obs_subject
  ON valuation_observations (source_account, subject, metric, as_of);

-- parse_run_id is the join column for every "which observations are current"
-- query, so each observation table is indexed on it.
CREATE INDEX IF NOT EXISTS idx_txn_obs_parse_run
  ON transaction_observations (parse_run_id);
CREATE INDEX IF NOT EXISTS idx_bal_obs_parse_run
  ON balance_observations (parse_run_id);
CREATE INDEX IF NOT EXISTS idx_pos_obs_parse_run
  ON position_observations (parse_run_id);
CREATE INDEX IF NOT EXISTS idx_val_obs_parse_run
  ON valuation_observations (parse_run_id);

-- ── publication gate ───────────────────────────────────────────────────
-- The same contract as production migration 0026 (docs/publication-gate.md):
-- "this parse succeeded" and "readers use this parse" are two facts. The
-- pointer per (artifact, parser) is operational state moved only by
-- publishParseRun in store.ts; every move appends a publication_events row.
-- Current views read the pointer, never the supersession column.

CREATE TABLE IF NOT EXISTS published_parse_runs (
  fetch_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  parser_name       TEXT NOT NULL,
  parse_run_id      INTEGER NOT NULL REFERENCES parse_runs(id),
  parser_version    TEXT NOT NULL,
  published_at      TEXT NOT NULL,
  publication_kind  TEXT NOT NULL CHECK(publication_kind IN ('normal','activation','rollback')),
  release_id        TEXT,
  PRIMARY KEY(fetch_artifact_id, parser_name)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS published_parse_runs_run
  ON published_parse_runs (parse_run_id);
CREATE TRIGGER IF NOT EXISTS published_parse_runs_no_delete BEFORE DELETE ON published_parse_runs
BEGIN SELECT RAISE(ABORT,'published_parse_runs cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS published_parse_runs_requires_ok_insert BEFORE INSERT ON published_parse_runs
WHEN NOT EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=NEW.parse_run_id AND p.status='ok'
 AND p.fetch_artifact_id=NEW.fetch_artifact_id AND p.parser_name=NEW.parser_name
 AND p.parser_version=NEW.parser_version)
BEGIN SELECT RAISE(ABORT,'published parse run must be a successful run of the same artifact and parser'); END;
CREATE TRIGGER IF NOT EXISTS published_parse_runs_requires_ok_update BEFORE UPDATE ON published_parse_runs
WHEN NEW.fetch_artifact_id<>OLD.fetch_artifact_id OR NEW.parser_name<>OLD.parser_name
 OR NOT EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=NEW.parse_run_id AND p.status='ok'
  AND p.fetch_artifact_id=NEW.fetch_artifact_id AND p.parser_name=NEW.parser_name
  AND p.parser_version=NEW.parser_version)
BEGIN SELECT RAISE(ABORT,'published parse run must be a successful run of the same artifact and parser'); END;

CREATE TABLE IF NOT EXISTS publication_events (
  id                    INTEGER PRIMARY KEY,
  fetch_artifact_id     INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  parser_name           TEXT NOT NULL,
  previous_parse_run_id INTEGER REFERENCES parse_runs(id),
  new_parse_run_id      INTEGER NOT NULL REFERENCES parse_runs(id),
  kind                  TEXT NOT NULL CHECK(kind IN ('normal','activation','rollback','backfill','repair')),
  actor                 TEXT NOT NULL,
  reason                TEXT NOT NULL,
  occurred_at           TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS publication_events_target
  ON publication_events (fetch_artifact_id, parser_name, id);
CREATE TRIGGER IF NOT EXISTS publication_events_no_update BEFORE UPDATE ON publication_events
BEGIN SELECT RAISE(ABORT,'publication_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS publication_events_no_delete BEFORE DELETE ON publication_events
BEGIN SELECT RAISE(ABORT,'publication_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS publication_events_requires_ok BEFORE INSERT ON publication_events
WHEN NOT EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=NEW.new_parse_run_id AND p.status='ok'
 AND p.fetch_artifact_id=NEW.fetch_artifact_id AND p.parser_name=NEW.parser_name)
BEGIN SELECT RAISE(ABORT,'publication_events requires a successful parse run of the same artifact and parser'); END;

CREATE VIEW IF NOT EXISTS published_observation_parses AS
 SELECT p.id, p.fetch_artifact_id, p.parser_name, p.parser_version, p.parsed_at, p.status,
  p.error, p.warnings_json, p.superseded_by_parse_run_id,
  x.published_at, x.publication_kind, x.release_id
 FROM published_parse_runs x JOIN parse_runs p ON p.id = x.parse_run_id;

-- Consistency between the pointer and the legacy supersession rule; empty
-- whenever publishParseRun maintained the pointer.
CREATE VIEW IF NOT EXISTS publication_gate_mismatches AS
 SELECT p.fetch_artifact_id, p.parser_name, p.id AS parse_run_id, 'legacy_only' AS mismatch
 FROM parse_runs p
 WHERE p.status = 'ok' AND p.superseded_by_parse_run_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id = p.id)
 UNION ALL
 SELECT x.fetch_artifact_id, x.parser_name, x.parse_run_id, 'projection_only'
 FROM published_parse_runs x JOIN parse_runs p ON p.id = x.parse_run_id
 WHERE p.status <> 'ok' OR p.superseded_by_parse_run_id IS NOT NULL;
