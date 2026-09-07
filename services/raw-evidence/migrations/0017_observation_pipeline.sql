-- Production Layer B. Layer A remains append-only and authoritative.
-- ── layer B: observations ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS parse_runs (
  id                          INTEGER PRIMARY KEY,
  fetch_artifact_id           INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  parser_name                 TEXT NOT NULL,
  parser_version              TEXT NOT NULL,
  parsed_at                   TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK(status IN ('pending','ok','error')),
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


-- Mutable scheduling state is separate from immutable observations.
CREATE TABLE observation_scan_state (
 id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO observation_scan_state(id) VALUES(1);
CREATE TABLE observation_parse_jobs (
 fetch_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
 parser_name TEXT NOT NULL, parser_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, available_at_ms INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until_ms INTEGER NOT NULL DEFAULT 0,
 last_error_code TEXT,
 PRIMARY KEY(fetch_artifact_id,parser_name,parser_version)
) STRICT;
CREATE TRIGGER parse_runs_no_delete BEFORE DELETE ON parse_runs
BEGIN SELECT RAISE(ABORT,'parse_runs cannot be deleted'); END;
CREATE TRIGGER parse_runs_preserve_identity BEFORE UPDATE ON parse_runs
WHEN NEW.id<>OLD.id OR NEW.fetch_artifact_id<>OLD.fetch_artifact_id
 OR NEW.parser_name<>OLD.parser_name OR NEW.parser_version<>OLD.parser_version
 OR NEW.parsed_at<>OLD.parsed_at OR NEW.warnings_json IS NOT OLD.warnings_json
 OR (OLD.status<>'pending' AND NEW.status<>OLD.status)
 OR (OLD.status<>'pending' AND NEW.error IS NOT OLD.error)
 OR (OLD.superseded_by_parse_run_id IS NOT NULL AND NEW.superseded_by_parse_run_id IS NOT OLD.superseded_by_parse_run_id)
BEGIN SELECT RAISE(ABORT,'parse_runs history is immutable'); END;
CREATE INDEX observation_jobs_ready ON observation_parse_jobs(status,available_at_ms,lease_until_ms);
CREATE TABLE observation_artifact_metadata (
 fetch_artifact_id INTEGER PRIMARY KEY REFERENCES fetch_artifacts(id),
 statement_state TEXT, period TEXT,
 metadata_manifest_artifact_id INTEGER REFERENCES fetch_artifacts(id)
) STRICT;
CREATE VIEW observation_sources AS
 SELECT s.id,s.provider, 'collector-r2' AS ingestion FROM sources s WHERE s.id <> 'kogane-synthetic';
CREATE VIEW observation_raw_objects AS
 SELECT o.sha256,o.byte_size AS size,o.blob_key,
 coalesce((SELECT declared_media_type FROM fetch_artifacts a WHERE a.sha256=o.sha256 LIMIT 1),'application/octet-stream') AS content_type
 FROM raw_objects o;
CREATE VIEW observation_fetch_runs AS
 SELECT r.id,r.source_id,s.external_session_id AS external_run_id,r.producer_id AS tool,
 strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(t.started_at_ms,r.first_recorded_at_ms)/1000.0,'unixepoch') AS started_at,
 strftime('%Y-%m-%dT%H:%M:%fZ', t.completed_at_ms/1000.0,'unixepoch') AS completed_at,
 CASE WHEN t.normalized_outcome='success' AND NOT EXISTS (
   SELECT 1 FROM fetch_units u JOIN fetch_unit_reports ur ON ur.fetch_unit_id=u.id
   WHERE u.fetch_run_id=r.id AND ur.report_kind='terminal' AND
    (ur.normalized_outcome <> 'success' OR ur.safe_failure_code IS NOT NULL)
 ) AND NOT EXISTS (SELECT 1 FROM fetch_artifacts a WHERE a.fetch_run_id=r.id AND a.artifact_role='collector_error')
 THEN 'success' ELSE 'partial' END AS status,
 CASE WHEN t.normalized_outcome='success' THEN 0 ELSE 1 END AS failure_count,
 (SELECT start_value FROM fetch_run_ranges q WHERE q.fetch_run_id=r.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1) AS window_start,
 (SELECT end_value FROM fetch_run_ranges q WHERE q.fetch_run_id=r.id AND q.range_kind='requested' ORDER BY q.id LIMIT 1) AS window_end
 FROM financial_fetch_runs r
 JOIN acquisition_sessions s ON s.id=r.acquisition_session_id
 JOIN fetch_run_seals seal ON seal.fetch_run_id=r.id
 JOIN fetch_run_reports t ON t.fetch_run_id=r.id AND t.report_kind='terminal';
CREATE VIEW observation_fetch_artifacts AS
 SELECT a.id,a.fetch_run_id,a.source_id,a.dataset,a.artifact_key,
 u.unit_key AS fetch_unit_key,m.statement_state,m.period,
 NULL AS url,NULL AS method,NULL AS http_status,
 coalesce(a.declared_media_type,'application/octet-stream') AS mime,
 strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(a.fetched_at_ms,a.recorded_at_ms)/1000.0,'unixepoch') AS fetched_at,
 a.sha256
 FROM fetch_artifacts a
 JOIN observation_fetch_runs r ON r.id=a.fetch_run_id
 LEFT JOIN fetch_units u ON u.id=a.fetch_unit_id
 LEFT JOIN observation_artifact_metadata m ON m.fetch_artifact_id=a.id;

CREATE TRIGGER transaction_observations_no_update BEFORE UPDATE ON transaction_observations BEGIN SELECT RAISE(ABORT,'transaction_observations is append-only'); END;
CREATE TRIGGER transaction_observations_no_delete BEFORE DELETE ON transaction_observations BEGIN SELECT RAISE(ABORT,'transaction_observations is append-only'); END;

CREATE TRIGGER balance_observations_no_update BEFORE UPDATE ON balance_observations BEGIN SELECT RAISE(ABORT,'balance_observations is append-only'); END;
CREATE TRIGGER balance_observations_no_delete BEFORE DELETE ON balance_observations BEGIN SELECT RAISE(ABORT,'balance_observations is append-only'); END;

CREATE TRIGGER position_observations_no_update BEFORE UPDATE ON position_observations BEGIN SELECT RAISE(ABORT,'position_observations is append-only'); END;
CREATE TRIGGER position_observations_no_delete BEFORE DELETE ON position_observations BEGIN SELECT RAISE(ABORT,'position_observations is append-only'); END;

CREATE TRIGGER valuation_observations_no_update BEFORE UPDATE ON valuation_observations BEGIN SELECT RAISE(ABORT,'valuation_observations is append-only'); END;
CREATE TRIGGER valuation_observations_no_delete BEFORE DELETE ON valuation_observations BEGIN SELECT RAISE(ABORT,'valuation_observations is append-only'); END;

CREATE TRIGGER observation_artifact_metadata_no_update BEFORE UPDATE ON observation_artifact_metadata BEGIN SELECT RAISE(ABORT,'observation_artifact_metadata is append-only'); END;
CREATE TRIGGER observation_artifact_metadata_no_delete BEFORE DELETE ON observation_artifact_metadata BEGIN SELECT RAISE(ABORT,'observation_artifact_metadata is append-only'); END;
