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
