-- Kogane raw-evidence catalogue.
--
-- The registry tables are mutable configuration reviewed in git. Every table
-- below the "Immutable acquisition history" marker is append-only; D1 triggers
-- enforce the same boundary as the application.

CREATE TABLE sources (
  id           TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 100 AND id NOT GLOB '*[^a-z0-9-]*'),
  provider     TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 200),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

CREATE TABLE producers (
  id           TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 100 AND id NOT GLOB '*[^a-z0-9-]*'),
  kind         TEXT NOT NULL CHECK (length(trim(kind)) BETWEEN 1 AND 40),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

-- A producer may emit several independent source claims. This explicit map is
-- also the server-side authorization boundary for source attribution.
CREATE TABLE producer_sources (
  producer_id TEXT NOT NULL REFERENCES producers(id) ON DELETE RESTRICT,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (producer_id, source_id)
) STRICT, WITHOUT ROWID;

-- Authentication credentials are Worker secrets, never D1 values. The token
-- selects one client id; this table limits that client to reviewed sources.
CREATE TABLE ingest_clients (
  id           TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 100 AND id NOT GLOB '*[^a-z0-9-]*'),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

CREATE TABLE ingest_client_producers (
  ingest_client_id TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  producer_id      TEXT NOT NULL REFERENCES producers(id) ON DELETE RESTRICT,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (ingest_client_id, producer_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE ingest_client_routes (
  ingest_client_id TEXT NOT NULL,
  producer_id      TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (ingest_client_id, producer_id, source_id),
  FOREIGN KEY (ingest_client_id, producer_id)
    REFERENCES ingest_client_producers(ingest_client_id, producer_id) ON DELETE RESTRICT,
  FOREIGN KEY (producer_id, source_id)
    REFERENCES producer_sources(producer_id, source_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE VIEW active_ingest_client_producers AS
SELECT cp.ingest_client_id, cp.producer_id
FROM ingest_client_producers AS cp
JOIN ingest_clients AS c ON c.id = cp.ingest_client_id
JOIN producers AS p ON p.id = cp.producer_id
WHERE cp.active = 1 AND c.active = 1 AND p.active = 1;

CREATE VIEW active_ingest_routes AS
SELECT r.ingest_client_id, r.producer_id, r.source_id
FROM ingest_client_routes AS r
JOIN active_ingest_client_producers AS cp
  ON cp.ingest_client_id = r.ingest_client_id AND cp.producer_id = r.producer_id
JOIN producer_sources AS ps
  ON ps.producer_id = r.producer_id AND ps.source_id = r.source_id
JOIN sources AS s ON s.id = r.source_id
WHERE r.active = 1 AND ps.active = 1 AND s.active = 1;

-- URL values are never stored. Trusted importers classify the original URL;
-- the Worker rechecks the sanitized origin and path template it receives.
CREATE TABLE http_scope_rules (
  id                 INTEGER PRIMARY KEY,
  source_id          TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  action             TEXT NOT NULL CHECK (action IN ('allow', 'deny')),
  scheme             TEXT CHECK (scheme IN ('http', 'https')),
  host               TEXT NOT NULL
    CHECK (host = lower(host) AND length(host) BETWEEN 1 AND 253
           AND instr(host, '/') = 0 AND instr(host, '@') = 0
           AND instr(host, ':') = 0),
  include_subdomains INTEGER NOT NULL DEFAULT 0
    CHECK (include_subdomains IN (0, 1)),
  port               INTEGER CHECK (port BETWEEN 1 AND 65535),
  path_prefix        TEXT NOT NULL DEFAULT '/'
    CHECK (substr(path_prefix, 1, 1) = '/'
           AND instr(path_prefix, '?') = 0
           AND instr(path_prefix, '#') = 0),
  note               TEXT,
  CHECK (action = 'deny' OR source_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX idx_http_scope_rules_global
  ON http_scope_rules (
    action,
    coalesce(scheme, ''),
    host,
    include_subdomains,
    coalesce(port, 0),
    path_prefix
  )
  WHERE source_id IS NULL;

CREATE UNIQUE INDEX idx_http_scope_rules_source
  ON http_scope_rules (
    source_id,
    action,
    coalesce(scheme, ''),
    host,
    include_subdomains,
    coalesce(port, 0),
    path_prefix
  )
  WHERE source_id IS NOT NULL;

-- Immutable acquisition history -------------------------------------------

-- One producer invocation or capture directory. It may contain several
-- sources; source attribution lives in fetch_runs rather than here.
CREATE TABLE acquisition_sessions (
  id                  INTEGER PRIMARY KEY,
  producer_id         TEXT NOT NULL REFERENCES producers(id) ON DELETE RESTRICT,
  first_recorded_by_client_id TEXT NOT NULL,
  external_id_namespace TEXT NOT NULL
    CHECK (length(external_id_namespace) BETWEEN 1 AND 100
           AND external_id_namespace NOT GLOB '*[^a-z0-9-]*'),
  external_session_id TEXT NOT NULL CHECK (
    length(external_session_id) BETWEEN 1 AND 500
    AND external_session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  first_recorded_at_ms INTEGER NOT NULL
    CHECK (first_recorded_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (producer_id, external_id_namespace, external_session_id),
  UNIQUE (id, producer_id),
  UNIQUE (id, producer_id, first_recorded_by_client_id),
  FOREIGN KEY (first_recorded_by_client_id, producer_id)
    REFERENCES ingest_client_producers(ingest_client_id, producer_id) ON DELETE RESTRICT
) STRICT;

-- A source-specific slice of an acquisition session. source_run_key is opaque
-- and permits more than one independently reported ledger in one session.
CREATE TABLE fetch_runs (
  id                     INTEGER PRIMARY KEY,
  acquisition_session_id INTEGER NOT NULL,
  producer_id            TEXT NOT NULL,
  source_id              TEXT NOT NULL,
  first_recorded_by_client_id TEXT NOT NULL,
  source_run_key         TEXT NOT NULL DEFAULT 'default'
    CHECK (length(source_run_key) BETWEEN 1 AND 500
           AND source_run_key NOT GLOB '*[^A-Za-z0-9._:/-]*'),
  first_recorded_at_ms   INTEGER NOT NULL
    CHECK (first_recorded_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (acquisition_session_id, source_id, source_run_key),
  UNIQUE (id, source_id),
  UNIQUE (id, producer_id, source_id),
  UNIQUE (id, acquisition_session_id),
  FOREIGN KEY (acquisition_session_id, producer_id)
    REFERENCES acquisition_sessions(id, producer_id) ON DELETE RESTRICT,
  FOREIGN KEY (producer_id, source_id)
    REFERENCES producer_sources(producer_id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (first_recorded_by_client_id, producer_id, source_id)
    REFERENCES ingest_client_routes(ingest_client_id, producer_id, source_id)
    ON DELETE RESTRICT
) STRICT;

-- Optional hierarchy for cards, connections, chunks, mail parts, or accounts
-- reported inside one source run. Unit kinds and keys remain producer-owned.
CREATE TABLE fetch_units (
  id             INTEGER PRIMARY KEY,
  fetch_run_id   INTEGER NOT NULL REFERENCES fetch_runs(id) ON DELETE RESTRICT,
  parent_unit_id INTEGER,
  unit_kind      TEXT NOT NULL CHECK (length(unit_kind) BETWEEN 1 AND 100),
  unit_key       TEXT NOT NULL CHECK (
    length(unit_key) BETWEEN 1 AND 500
    AND unit_key NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  terminal_report_required INTEGER NOT NULL DEFAULT 0
    CHECK (terminal_report_required IN (0, 1)),
  recorded_by_client_id TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  recorded_at_ms INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (id, fetch_run_id),
  FOREIGN KEY (parent_unit_id, fetch_run_id)
    REFERENCES fetch_units(id, fetch_run_id) ON DELETE RESTRICT,
  CHECK (parent_unit_id IS NULL OR parent_unit_id <> id)
) STRICT;

CREATE UNIQUE INDEX idx_fetch_units_root_key
  ON fetch_units (fetch_run_id, unit_kind, unit_key)
  WHERE parent_unit_id IS NULL;

CREATE UNIQUE INDEX idx_fetch_units_child_key
  ON fetch_units (fetch_run_id, parent_unit_id, unit_kind, unit_key)
  WHERE parent_unit_id IS NOT NULL;

CREATE TABLE fetch_unit_reports (
  id                      INTEGER PRIMARY KEY,
  fetch_unit_id           INTEGER NOT NULL REFERENCES fetch_units(id) ON DELETE RESTRICT,
  report_key              TEXT NOT NULL CHECK (
    length(report_key) BETWEEN 1 AND 500
    AND report_key NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  report_kind             TEXT NOT NULL CHECK (report_kind IN ('progress', 'terminal')),
  recorded_by_client_id   TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  producer_status         TEXT CHECK (producer_status IS NULL OR (
    length(producer_status) BETWEEN 1 AND 100
    AND instr(producer_status, char(10)) = 0 AND instr(producer_status, char(13)) = 0
  )),
  normalized_outcome      TEXT NOT NULL DEFAULT 'unknown' CHECK (normalized_outcome IN (
    'success', 'partial', 'failed', 'running', 'human_required', 'cancelled', 'unknown'
  )),
  started_at_ms           INTEGER CHECK (started_at_ms BETWEEN 0 AND 9007199254740991),
  started_at_basis        TEXT CHECK (started_at_basis IS NULL OR started_at_basis IN (
    'source', 'manifest', 'schedule', 'file_metadata', 'email', 'operator', 'unknown'
  )),
  completed_at_ms         INTEGER CHECK (completed_at_ms BETWEEN 0 AND 9007199254740991),
  completed_at_basis      TEXT CHECK (completed_at_basis IS NULL OR completed_at_basis IN (
    'source', 'manifest', 'schedule', 'file_metadata', 'email', 'operator', 'unknown'
  )),
  declared_artifact_count INTEGER CHECK (
    declared_artifact_count BETWEEN 0 AND 9007199254740991
  ),
  artifact_count_scope    TEXT CHECK (artifact_count_scope IS NULL OR artifact_count_scope IN (
    'direct', 'subtree', 'producer_defined'
  )),
  safe_failure_code       TEXT CHECK (safe_failure_code IS NULL OR (
    length(safe_failure_code) BETWEEN 1 AND 100
    AND instr(safe_failure_code, char(10)) = 0
    AND instr(safe_failure_code, char(13)) = 0
  )),
  recorded_at_ms          INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((started_at_ms IS NULL) = (started_at_basis IS NULL)),
  CHECK ((completed_at_ms IS NULL) = (completed_at_basis IS NULL)),
  CHECK ((declared_artifact_count IS NULL) = (artifact_count_scope IS NULL)),
  CHECK (completed_at_ms IS NULL OR started_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  CHECK (report_kind <> 'progress' OR normalized_outcome IN (
    'running', 'human_required', 'partial', 'unknown'
  )),
  CHECK (report_kind <> 'terminal' OR normalized_outcome <> 'running'),
  UNIQUE (fetch_unit_id, report_key)
) STRICT;

CREATE UNIQUE INDEX idx_fetch_unit_reports_one_terminal
  ON fetch_unit_reports (fetch_unit_id)
  WHERE report_kind = 'terminal';

CREATE TABLE fetch_page_groups (
  id                    INTEGER PRIMARY KEY,
  fetch_run_id          INTEGER NOT NULL REFERENCES fetch_runs(id) ON DELETE RESTRICT,
  page_group_key        TEXT NOT NULL CHECK (
    length(page_group_key) BETWEEN 1 AND 500
    AND page_group_key NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  declared_page_count   INTEGER CHECK (declared_page_count BETWEEN 0 AND 9007199254740991),
  recorded_by_client_id TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  recorded_at_ms        INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (fetch_run_id, page_group_key),
  UNIQUE (id, fetch_run_id)
) STRICT;

-- Producer reports are separate from run identity. Progress reports may be
-- followed by exactly one terminal report without updating earlier history.
CREATE TABLE fetch_run_reports (
  id                      INTEGER PRIMARY KEY,
  fetch_run_id            INTEGER NOT NULL REFERENCES fetch_runs(id) ON DELETE RESTRICT,
  report_key              TEXT NOT NULL CHECK (
    length(report_key) BETWEEN 1 AND 500
    AND report_key NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  report_kind             TEXT NOT NULL CHECK (report_kind IN ('progress', 'terminal')),
  recorded_by_client_id   TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  producer_version        TEXT CHECK (
    producer_version IS NULL OR length(producer_version) BETWEEN 1 AND 200
  ),
  producer_revision       TEXT CHECK (
    producer_revision IS NULL OR length(producer_revision) BETWEEN 1 AND 200
  ),
  manifest_schema_version TEXT CHECK (
    manifest_schema_version IS NULL OR length(manifest_schema_version) BETWEEN 1 AND 200
  ),
  producer_status         TEXT CHECK (producer_status IS NULL OR (
    length(producer_status) BETWEEN 1 AND 100
    AND instr(producer_status, char(10)) = 0 AND instr(producer_status, char(13)) = 0
  )),
  normalized_outcome      TEXT NOT NULL DEFAULT 'unknown'
    CHECK (normalized_outcome IN (
      'success', 'partial', 'failed', 'running', 'human_required',
      'cancelled', 'unknown'
    )),
  started_at_ms           INTEGER CHECK (started_at_ms BETWEEN 0 AND 9007199254740991),
  started_at_basis        TEXT CHECK (started_at_basis IS NULL OR started_at_basis IN (
    'source', 'manifest', 'schedule', 'file_metadata', 'email', 'operator', 'unknown'
  )),
  completed_at_ms         INTEGER CHECK (completed_at_ms BETWEEN 0 AND 9007199254740991),
  completed_at_basis      TEXT CHECK (completed_at_basis IS NULL OR completed_at_basis IN (
    'source', 'manifest', 'schedule', 'file_metadata', 'email', 'operator', 'unknown'
  )),
  declared_artifact_count INTEGER CHECK (
    declared_artifact_count BETWEEN 0 AND 9007199254740991
  ),
  artifact_count_scope    TEXT CHECK (artifact_count_scope IS NULL OR artifact_count_scope IN (
    'all_catalogued', 'provider_artifacts', 'producer_defined'
  )),
  recorded_at_ms          INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (completed_at_ms IS NULL OR started_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  CHECK ((started_at_ms IS NULL) = (started_at_basis IS NULL)),
  CHECK ((completed_at_ms IS NULL) = (completed_at_basis IS NULL)),
  CHECK ((declared_artifact_count IS NULL) = (artifact_count_scope IS NULL)),
  CHECK (report_kind <> 'progress' OR normalized_outcome IN (
    'running', 'human_required', 'partial', 'unknown'
  )),
  CHECK (report_kind <> 'terminal' OR normalized_outcome <> 'running'),
  UNIQUE (fetch_run_id, report_key)
) STRICT;

CREATE UNIQUE INDEX idx_fetch_run_reports_one_terminal
  ON fetch_run_reports (fetch_run_id)
  WHERE report_kind = 'terminal';

CREATE TABLE raw_objects (
  sha256          TEXT PRIMARY KEY
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_size       INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 9007199254740991),
  blob_key        TEXT NOT NULL UNIQUE CHECK (length(blob_key) BETWEEN 1 AND 500),
  first_stored_at_ms INTEGER NOT NULL
    CHECK (first_stored_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (sha256, byte_size)
) STRICT;

CREATE TABLE fetch_artifacts (
  id                  INTEGER PRIMARY KEY,
  fetch_run_id        INTEGER NOT NULL,
  source_id           TEXT NOT NULL,
  producer_id          TEXT NOT NULL,
  first_ingested_by_client_id TEXT NOT NULL,
  fetch_unit_id       INTEGER,
  page_group_id       INTEGER,
  artifact_key        TEXT NOT NULL CHECK (
    length(artifact_key) BETWEEN 1 AND 500
    AND artifact_key NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  artifact_role       TEXT NOT NULL CHECK (artifact_role IN (
    'provider_response', 'provider_export', 'provider_document', 'provider_message',
    'collector_manifest', 'collector_error', 'collector_summary',
    'collector_derived', 'sanitized_provider_capture', 'user_capture'
  )),
  payload_fidelity    TEXT NOT NULL CHECK (payload_fidelity IN (
    'exact', 'transport_decoded', 'transformed', 'generated', 'unknown'
  )),
  container_kind      TEXT NOT NULL DEFAULT 'single' CHECK (container_kind IN (
    'single', 'bundle', 'archive', 'multipart', 'unknown'
  )),
  lineage_disposition TEXT NOT NULL CHECK (lineage_disposition IN (
    'linked', 'embedded_source_bytes', 'source_not_retained_for_security',
    'source_bytes_not_available', 'not_applicable'
  )),
  dataset             TEXT CHECK (dataset IS NULL OR length(dataset) BETWEEN 1 AND 200),
  format_id           TEXT CHECK (format_id IS NULL OR length(format_id) BETWEEN 1 AND 200),
  format_version      TEXT CHECK (format_version IS NULL OR length(format_version) BETWEEN 1 AND 100),
  declared_media_type TEXT CHECK (
    declared_media_type IS NULL OR length(declared_media_type) BETWEEN 1 AND 500
  ),
  media_type_basis    TEXT CHECK (media_type_basis IS NULL OR media_type_basis IN (
    'response_header', 'manifest', 'file_metadata', 'operator', 'unknown'
  )),
  fetched_at_ms       INTEGER CHECK (fetched_at_ms BETWEEN 0 AND 9007199254740991),
  fetched_at_basis    TEXT CHECK (fetched_at_basis IS NULL OR fetched_at_basis IN (
    'source', 'response', 'manifest', 'file_metadata', 'operator', 'unknown'
  )),
  page_index          INTEGER CHECK (page_index BETWEEN 0 AND 9007199254740991),
  sequence            INTEGER CHECK (sequence BETWEEN 0 AND 9007199254740991),
  sha256              TEXT NOT NULL,
  byte_size           INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 9007199254740991),
  descriptor_version  TEXT NOT NULL CHECK (length(descriptor_version) BETWEEN 1 AND 40),
  descriptor_sha256   TEXT NOT NULL CHECK (
    length(descriptor_sha256) = 64 AND descriptor_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at_ms      INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (fetch_run_id, artifact_key),
  UNIQUE (fetch_run_id, artifact_key, sha256, descriptor_sha256),
  FOREIGN KEY (fetch_run_id, source_id)
    REFERENCES fetch_runs(id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (fetch_run_id, producer_id, source_id)
    REFERENCES fetch_runs(id, producer_id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (first_ingested_by_client_id, producer_id, source_id)
    REFERENCES ingest_client_routes(ingest_client_id, producer_id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (fetch_unit_id, fetch_run_id)
    REFERENCES fetch_units(id, fetch_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (page_group_id, fetch_run_id)
    REFERENCES fetch_page_groups(id, fetch_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (sha256, byte_size)
    REFERENCES raw_objects(sha256, byte_size) ON DELETE RESTRICT,
  CHECK ((declared_media_type IS NULL) = (media_type_basis IS NULL)),
  CHECK ((fetched_at_ms IS NULL) = (fetched_at_basis IS NULL)),
  CHECK ((page_group_id IS NULL) = (page_index IS NULL)),
  CHECK (
    artifact_role NOT IN (
      'provider_response', 'provider_export', 'provider_document', 'provider_message'
    )
    OR payload_fidelity IN ('exact', 'transport_decoded', 'transformed', 'unknown')
  ),
  CHECK (
    artifact_role NOT IN (
      'provider_response', 'provider_export', 'provider_document', 'provider_message'
    )
    OR payload_fidelity <> 'transformed'
    OR lineage_disposition IN ('linked', 'source_bytes_not_available')
  ),
  CHECK (
    artifact_role NOT IN ('collector_manifest', 'collector_error', 'collector_summary')
    OR payload_fidelity = 'generated'
  ),
  CHECK (
    payload_fidelity <> 'generated'
    OR artifact_role IN ('collector_manifest', 'collector_error', 'collector_summary')
  ),
  CHECK (
    artifact_role <> 'collector_derived'
    OR payload_fidelity = 'transformed'
  ),
  CHECK (
    artifact_role <> 'collector_derived'
    OR lineage_disposition <> 'not_applicable'
  ),
  CHECK (
    artifact_role <> 'sanitized_provider_capture'
    OR (
      payload_fidelity = 'transformed'
      AND lineage_disposition IN ('linked', 'source_not_retained_for_security')
    )
  ),
  CHECK (
    artifact_role <> 'user_capture'
    OR payload_fidelity IN ('transformed', 'unknown')
  ),
  CHECK (
    lineage_disposition <> 'source_not_retained_for_security'
    OR payload_fidelity = 'transformed'
  ),
  CHECK (
    lineage_disposition <> 'embedded_source_bytes'
    OR container_kind IN ('bundle', 'archive', 'multipart')
  )
) STRICT;

CREATE UNIQUE INDEX idx_fetch_artifacts_run_sequence
  ON fetch_artifacts (fetch_run_id, sequence)
  WHERE sequence IS NOT NULL;

CREATE UNIQUE INDEX idx_fetch_artifacts_page
  ON fetch_artifacts (fetch_run_id, page_group_id, page_index)
  WHERE page_group_id IS NOT NULL;

-- Seal validation follows both direct unit membership and the unit tree. Keep
-- those checks index-backed as the append-only catalogue grows.
CREATE INDEX idx_fetch_artifacts_unit
  ON fetch_artifacts (fetch_unit_id, id)
  WHERE fetch_unit_id IS NOT NULL;

CREATE INDEX idx_fetch_units_parent
  ON fetch_units (parent_unit_id, id)
  WHERE parent_unit_id IS NOT NULL;

CREATE TRIGGER fetch_artifact_page_within_declared_count
BEFORE INSERT ON fetch_artifacts
WHEN NEW.page_group_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM fetch_page_groups
  WHERE id = NEW.page_group_id
    AND declared_page_count IS NOT NULL
    AND NEW.page_index >= declared_page_count
)
BEGIN
  SELECT RAISE(ABORT, 'page_index_out_of_range');
END;

-- Ranges keep requested selectors separate from declared coverage, and retain
-- date/month precision without fabricating instants. Values are canonical
-- ASCII (ISO instant/date or YYYY-MM) validated by the Worker.
CREATE TABLE fetch_run_ranges (
  id              INTEGER PRIMARY KEY,
  fetch_run_id    INTEGER NOT NULL REFERENCES fetch_runs(id) ON DELETE RESTRICT,
  range_key       TEXT NOT NULL CHECK (
    length(range_key) BETWEEN 1 AND 200
    AND range_key NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  range_kind      TEXT NOT NULL CHECK (range_kind IN ('requested', 'declared_coverage', 'selector')),
  precision       TEXT NOT NULL CHECK (precision IN ('instant', 'date', 'month')),
  start_value     TEXT,
  end_value       TEXT,
  start_inclusive INTEGER NOT NULL DEFAULT 1 CHECK (start_inclusive IN (0, 1)),
  end_inclusive   INTEGER NOT NULL DEFAULT 1 CHECK (end_inclusive IN (0, 1)),
  basis           TEXT NOT NULL CHECK (basis IN ('source', 'request', 'manifest', 'operator')),
  recorded_by_client_id TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  recorded_at_ms  INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (start_value IS NOT NULL OR end_value IS NOT NULL),
  CHECK (start_value IS NULL OR length(start_value) BETWEEN 7 AND 35),
  CHECK (end_value IS NULL OR length(end_value) BETWEEN 7 AND 35),
  CHECK (start_value IS NULL OR end_value IS NULL OR start_value <= end_value),
  CHECK (precision <> 'month' OR (
    (start_value IS NULL OR length(start_value) = 7)
    AND (end_value IS NULL OR length(end_value) = 7)
  )),
  CHECK (precision <> 'date' OR (
    (start_value IS NULL OR length(start_value) = 10)
    AND (end_value IS NULL OR length(end_value) = 10)
  )),
  UNIQUE (fetch_run_id, range_key)
) STRICT;

CREATE TABLE artifact_ranges (
  id                INTEGER PRIMARY KEY,
  fetch_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id) ON DELETE RESTRICT,
  range_key         TEXT NOT NULL CHECK (
    length(range_key) BETWEEN 1 AND 200
    AND range_key NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  range_kind        TEXT NOT NULL CHECK (range_kind IN ('requested', 'declared_coverage', 'selector')),
  precision         TEXT NOT NULL CHECK (precision IN ('instant', 'date', 'month')),
  start_value       TEXT,
  end_value         TEXT,
  start_inclusive   INTEGER NOT NULL DEFAULT 1 CHECK (start_inclusive IN (0, 1)),
  end_inclusive     INTEGER NOT NULL DEFAULT 1 CHECK (end_inclusive IN (0, 1)),
  basis             TEXT NOT NULL CHECK (basis IN ('source', 'request', 'manifest', 'operator')),
  recorded_by_client_id TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  recorded_at_ms    INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (start_value IS NOT NULL OR end_value IS NOT NULL),
  CHECK (start_value IS NULL OR length(start_value) BETWEEN 7 AND 35),
  CHECK (end_value IS NULL OR length(end_value) BETWEEN 7 AND 35),
  CHECK (start_value IS NULL OR end_value IS NULL OR start_value <= end_value),
  CHECK (precision <> 'month' OR (
    (start_value IS NULL OR length(start_value) = 7)
    AND (end_value IS NULL OR length(end_value) = 7)
  )),
  CHECK (precision <> 'date' OR (
    (start_value IS NULL OR length(start_value) = 10)
    AND (end_value IS NULL OR length(end_value) = 10)
  )),
  UNIQUE (fetch_artifact_id, range_key)
) STRICT;

-- HTTP metadata is sanitized: no userinfo, fragments, query values, or raw URL.
CREATE TABLE artifact_http_metadata (
  fetch_artifact_id INTEGER PRIMARY KEY
    REFERENCES fetch_artifacts(id) ON DELETE RESTRICT,
  method            TEXT CHECK (method IS NULL OR (
    length(method) BETWEEN 1 AND 20 AND method = upper(method)
  )),
  status            INTEGER CHECK (status BETWEEN 100 AND 599),
  scheme            TEXT NOT NULL CHECK (scheme IN ('http', 'https')),
  host              TEXT NOT NULL CHECK (
    host = lower(host) AND length(host) BETWEEN 1 AND 253
    AND instr(host, '/') = 0 AND instr(host, '@') = 0 AND instr(host, ':') = 0
  ),
  port              INTEGER CHECK (port BETWEEN 1 AND 65535),
  path_template     TEXT NOT NULL CHECK (
    substr(path_template, 1, 1) = '/'
    AND length(path_template) BETWEEN 1 AND 1000
    AND instr(path_template, '?') = 0
    AND instr(path_template, '#') = 0
  ),
  query_names_json  TEXT NOT NULL DEFAULT '[]' CHECK (
    length(query_names_json) BETWEEN 2 AND 4000
    AND json_valid(query_names_json) AND json_type(query_names_json) = 'array'
  ),
  redaction_version TEXT NOT NULL CHECK (length(redaction_version) BETWEEN 1 AND 100),
  url_fingerprint   TEXT CHECK (url_fingerprint IS NULL OR (
    length(url_fingerprint) = 64 AND url_fingerprint NOT GLOB '*[^0-9a-f]*'
  )),
  fingerprint_key_version TEXT CHECK (
    fingerprint_key_version IS NULL OR length(fingerprint_key_version) BETWEEN 1 AND 100
  ),
  CHECK ((url_fingerprint IS NULL) = (fingerprint_key_version IS NULL))
) STRICT;

CREATE TRIGGER artifact_http_query_names_are_names_only
BEFORE INSERT ON artifact_http_metadata
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.query_names_json)
  WHERE type <> 'text'
     OR length(value) NOT BETWEEN 1 AND 100
     OR value GLOB '*[?&=#]*'
     OR instr(value, char(10)) <> 0 OR instr(value, char(13)) <> 0
)
BEGIN SELECT RAISE(ABORT, 'query_name_contains_value'); END;

CREATE TABLE artifact_storage_metadata (
  fetch_artifact_id INTEGER PRIMARY KEY
    REFERENCES fetch_artifacts(id) ON DELETE RESTRICT,
  storage_kind      TEXT NOT NULL CHECK (length(storage_kind) BETWEEN 1 AND 40),
  container_name    TEXT NOT NULL CHECK (length(container_name) BETWEEN 1 AND 200),
  object_key_template TEXT NOT NULL CHECK (
    length(object_key_template) BETWEEN 1 AND 1000
    AND instr(object_key_template, '://') = 0
  ),
  object_key_fingerprint TEXT NOT NULL CHECK (
    length(object_key_fingerprint) = 64
    AND object_key_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  fingerprint_key_version TEXT NOT NULL
    CHECK (length(fingerprint_key_version) BETWEEN 1 AND 100),
  redaction_version TEXT NOT NULL CHECK (length(redaction_version) BETWEEN 1 AND 100),
  object_version    TEXT CHECK (
    object_version IS NULL OR length(object_version) BETWEEN 1 AND 500
  ),
  etag              TEXT CHECK (etag IS NULL OR length(etag) BETWEEN 1 AND 500),
  last_modified_at_ms INTEGER CHECK (
    last_modified_at_ms BETWEEN 0 AND 9007199254740991
  ),
  last_modified_at_basis TEXT CHECK (
    last_modified_at_basis IS NULL OR last_modified_at_basis IN ('storage_metadata', 'manifest')
  ),
  CHECK ((last_modified_at_ms IS NULL) = (last_modified_at_basis IS NULL))
) STRICT;

CREATE TABLE artifact_file_metadata (
  fetch_artifact_id INTEGER PRIMARY KEY
    REFERENCES fetch_artifacts(id) ON DELETE RESTRICT,
  basename_template TEXT NOT NULL CHECK (
    length(basename_template) BETWEEN 1 AND 500
    AND instr(basename_template, '/') = 0 AND instr(basename_template, char(92)) = 0
  ),
  filename_fingerprint TEXT NOT NULL CHECK (
    length(filename_fingerprint) = 64
    AND filename_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  fingerprint_key_version TEXT NOT NULL
    CHECK (length(fingerprint_key_version) BETWEEN 1 AND 100),
  redaction_version TEXT NOT NULL CHECK (length(redaction_version) BETWEEN 1 AND 100),
  source_modified_at_ms INTEGER CHECK (
    source_modified_at_ms BETWEEN 0 AND 9007199254740991
  )
) STRICT;

CREATE TABLE artifact_email_metadata (
  fetch_artifact_id INTEGER PRIMARY KEY
    REFERENCES fetch_artifacts(id) ON DELETE RESTRICT,
  transport_shape   TEXT NOT NULL CHECK (
    transport_shape IN ('direct', 'forwarded_rfc822', 'unknown')
  ),
  sender_domain     TEXT CHECK (sender_domain IS NULL OR (
    sender_domain = lower(sender_domain) AND length(sender_domain) BETWEEN 1 AND 253
    AND instr(sender_domain, '@') = 0 AND instr(sender_domain, '/') = 0
    AND instr(sender_domain, ':') = 0 AND instr(sender_domain, ' ') = 0
    AND instr(sender_domain, char(10)) = 0 AND instr(sender_domain, char(13)) = 0
  )),
  received_at_ms    INTEGER CHECK (received_at_ms BETWEEN 0 AND 9007199254740991),
  received_at_basis TEXT CHECK (received_at_basis IS NULL OR received_at_basis IN (
    'delivery_internal_date', 'rfc_date', 'forwarded_inner_date', 'operator', 'unknown'
  )),
  message_id_sha256 TEXT CHECK (message_id_sha256 IS NULL OR (
    length(message_id_sha256) = 64 AND message_id_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  part_index        INTEGER CHECK (part_index BETWEEN 0 AND 9007199254740991),
  mime_part_path    TEXT CHECK (
    mime_part_path IS NULL OR (
      length(mime_part_path) BETWEEN 1 AND 200
      AND mime_part_path NOT GLOB '*[^0-9.]*'
    )
  ),
  inner_message_sha256 TEXT CHECK (inner_message_sha256 IS NULL OR (
    length(inner_message_sha256) = 64
    AND inner_message_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  inner_sender_domain TEXT CHECK (inner_sender_domain IS NULL OR (
    inner_sender_domain = lower(inner_sender_domain)
    AND length(inner_sender_domain) BETWEEN 1 AND 253
    AND instr(inner_sender_domain, '@') = 0 AND instr(inner_sender_domain, '/') = 0
    AND instr(inner_sender_domain, ':') = 0 AND instr(inner_sender_domain, ' ') = 0
    AND instr(inner_sender_domain, char(10)) = 0
    AND instr(inner_sender_domain, char(13)) = 0
  )),
  filename_template TEXT CHECK (filename_template IS NULL OR (
    length(filename_template) BETWEEN 1 AND 500
    AND instr(filename_template, '/') = 0 AND instr(filename_template, char(92)) = 0
  )),
  filename_fingerprint TEXT CHECK (filename_fingerprint IS NULL OR (
    length(filename_fingerprint) = 64
    AND filename_fingerprint NOT GLOB '*[^0-9a-f]*'
  )),
  fingerprint_key_version TEXT CHECK (
    fingerprint_key_version IS NULL OR length(fingerprint_key_version) BETWEEN 1 AND 100
  ),
  redaction_version TEXT NOT NULL CHECK (length(redaction_version) BETWEEN 1 AND 100),
  CHECK ((received_at_ms IS NULL) = (received_at_basis IS NULL)),
  CHECK ((filename_template IS NULL) = (filename_fingerprint IS NULL)),
  CHECK ((filename_fingerprint IS NULL) = (fingerprint_key_version IS NULL))
) STRICT;

CREATE TABLE artifact_relations (
  child_artifact_id  INTEGER NOT NULL REFERENCES fetch_artifacts(id) ON DELETE RESTRICT,
  parent_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id) ON DELETE RESTRICT,
  relation           TEXT NOT NULL CHECK (relation IN (
    'input', 'described_by'
  )),
  transformer_id     TEXT NOT NULL CHECK (length(transformer_id) BETWEEN 1 AND 100),
  transformer_version TEXT NOT NULL CHECK (length(transformer_version) BETWEEN 1 AND 200),
  recorded_by_client_id TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  recorded_at_ms     INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (child_artifact_id, parent_artifact_id, relation),
  CHECK (child_artifact_id <> parent_artifact_id)
) STRICT, WITHOUT ROWID;

-- Compound byte transformations are ordered and explicit. For example,
-- MyJCB HTML is redacted and then re-encoded; a single fidelity enum cannot
-- represent both. Parent artifact edges remain in artifact_relations, while
-- lineage_disposition records why an input edge may intentionally be absent.
CREATE TABLE artifact_transform_steps (
  fetch_artifact_id      INTEGER NOT NULL REFERENCES fetch_artifacts(id) ON DELETE RESTRICT,
  step_index             INTEGER NOT NULL CHECK (step_index BETWEEN 0 AND 1000),
  step_kind              TEXT NOT NULL CHECK (step_kind IN (
    'transport_decoded', 'decrypted', 'redacted', 'reencoded', 'bundled',
    'rendered', 'extracted', 'generated'
  )),
  transformer_id         TEXT NOT NULL CHECK (length(transformer_id) BETWEEN 1 AND 100),
  transformer_version    TEXT NOT NULL CHECK (length(transformer_version) BETWEEN 1 AND 200),
  recorded_by_client_id  TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  recorded_at_ms         INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (fetch_artifact_id, step_index)
) STRICT, WITHOUT ROWID;

-- A canonical inventory and seal prove central-ingestion completeness. The
-- inventory contains every artifact role in the run, including zero artifacts
-- for a terminal failure. The Worker verifies inventory_sha256 over the sorted
-- (artifact_key, sha256, descriptor_sha256) tuples before inserting these rows.
CREATE TABLE run_inventories (
  id                      INTEGER PRIMARY KEY,
  fetch_run_id            INTEGER NOT NULL REFERENCES fetch_runs(id) ON DELETE RESTRICT,
  inventory_sha256        TEXT NOT NULL CHECK (
    length(inventory_sha256) = 64 AND inventory_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  expected_artifact_count INTEGER NOT NULL
    CHECK (expected_artifact_count BETWEEN 0 AND 9007199254740991),
  inventory_scope         TEXT NOT NULL DEFAULT 'all_catalogued'
    CHECK (inventory_scope = 'all_catalogued'),
  declaration_basis       TEXT NOT NULL CHECK (declaration_basis IN (
    'producer_manifest', 'directory_scan', 'capture_index', 'file_receipt',
    'email_batch', 'operator'
  )),
  created_at_ms           INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  created_by_client_id    TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  UNIQUE (fetch_run_id, inventory_sha256),
  UNIQUE (id, fetch_run_id)
) STRICT;

CREATE TABLE run_inventory_items (
  inventory_id INTEGER NOT NULL,
  fetch_run_id INTEGER NOT NULL,
  artifact_key TEXT NOT NULL CHECK (length(artifact_key) BETWEEN 1 AND 500),
  sha256       TEXT NOT NULL,
  descriptor_sha256 TEXT NOT NULL,
  PRIMARY KEY (inventory_id, artifact_key),
  FOREIGN KEY (inventory_id, fetch_run_id)
    REFERENCES run_inventories(id, fetch_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (fetch_run_id, artifact_key, sha256, descriptor_sha256)
    REFERENCES fetch_artifacts(
      fetch_run_id, artifact_key, sha256, descriptor_sha256
    ) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE fetch_run_seals (
  inventory_id       INTEGER PRIMARY KEY,
  fetch_run_id       INTEGER NOT NULL UNIQUE,
  sealed_at_ms       INTEGER NOT NULL CHECK (sealed_at_ms BETWEEN 0 AND 9007199254740991),
  sealed_by_client_id TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  FOREIGN KEY (inventory_id, fetch_run_id)
    REFERENCES run_inventories(id, fetch_run_id) ON DELETE RESTRICT,
  UNIQUE (inventory_id, fetch_run_id)
) STRICT;

CREATE TRIGGER fetch_run_seal_requires_complete_inventory
BEFORE INSERT ON fetch_run_seals
WHEN
  (SELECT count(*) FROM run_inventory_items WHERE inventory_id = NEW.inventory_id)
  <>
  (SELECT expected_artifact_count FROM run_inventories WHERE id = NEW.inventory_id)
OR
  (SELECT count(*) FROM fetch_artifacts WHERE fetch_run_id = NEW.fetch_run_id)
  <>
  (SELECT expected_artifact_count FROM run_inventories WHERE id = NEW.inventory_id)
OR EXISTS (
  SELECT 1
  FROM run_inventory_items AS i
  LEFT JOIN fetch_artifacts AS a
    ON a.fetch_run_id = i.fetch_run_id
   AND a.artifact_key = i.artifact_key
   AND a.sha256 = i.sha256
  WHERE i.inventory_id = NEW.inventory_id AND a.id IS NULL
)
OR NOT EXISTS (
  SELECT 1 FROM fetch_run_reports
  WHERE fetch_run_id = NEW.fetch_run_id AND report_kind = 'terminal'
)
OR EXISTS (
  SELECT 1 FROM fetch_run_reports AS r
  JOIN run_inventories AS i ON i.fetch_run_id = r.fetch_run_id
  WHERE i.id = NEW.inventory_id
    AND r.report_kind = 'terminal'
    AND r.artifact_count_scope = 'all_catalogued'
    AND r.declared_artifact_count <> i.expected_artifact_count
)
OR EXISTS (
  SELECT 1 FROM fetch_run_reports AS r
  JOIN run_inventories AS i ON i.fetch_run_id = r.fetch_run_id
  WHERE i.id = NEW.inventory_id
    AND r.report_kind = 'terminal'
    AND r.artifact_count_scope = 'provider_artifacts'
    AND r.declared_artifact_count <> (
      SELECT count(*) FROM fetch_artifacts AS a
      WHERE a.fetch_run_id = NEW.fetch_run_id
        AND a.artifact_role IN (
          'provider_response', 'provider_export', 'provider_document',
          'provider_message', 'sanitized_provider_capture'
        )
    )
)
OR EXISTS (
  SELECT 1
  FROM fetch_artifacts AS a
  WHERE a.fetch_run_id = NEW.fetch_run_id
    AND a.lineage_disposition = 'source_not_retained_for_security'
    AND NOT EXISTS (
      SELECT 1 FROM artifact_transform_steps AS t
      WHERE t.fetch_artifact_id = a.id AND t.step_kind = 'redacted'
    )
)
OR EXISTS (
  SELECT 1
  FROM fetch_artifacts AS a
  WHERE a.fetch_run_id = NEW.fetch_run_id
    AND a.lineage_disposition = 'embedded_source_bytes'
    AND NOT EXISTS (
      SELECT 1 FROM artifact_transform_steps AS t
      WHERE t.fetch_artifact_id = a.id AND t.step_kind = 'bundled'
    )
)
OR EXISTS (
  SELECT 1
  FROM fetch_artifacts AS a
  WHERE a.fetch_run_id = NEW.fetch_run_id
    AND a.lineage_disposition = 'linked'
    AND NOT EXISTS (
      SELECT 1 FROM artifact_relations AS r
      WHERE r.child_artifact_id = a.id
        AND r.relation = 'input'
    )
)
OR EXISTS (
  SELECT 1
  FROM fetch_artifacts AS a
  JOIN artifact_transform_steps AS t ON t.fetch_artifact_id = a.id
  WHERE a.fetch_run_id = NEW.fetch_run_id
        AND a.artifact_role IN (
          'provider_response', 'provider_export', 'provider_document',
          'provider_message'
        )
    AND t.step_kind NOT IN ('decrypted', 'extracted')
)
OR EXISTS (
  SELECT 1
  FROM fetch_artifacts AS a
  WHERE a.fetch_run_id = NEW.fetch_run_id
    AND a.artifact_role = 'sanitized_provider_capture'
    AND NOT EXISTS (
      SELECT 1 FROM artifact_transform_steps AS t
      WHERE t.fetch_artifact_id = a.id AND t.step_kind = 'redacted'
    )
)
OR EXISTS (
  SELECT 1
  FROM fetch_artifacts AS a
  JOIN artifact_transform_steps AS t ON t.fetch_artifact_id = a.id
  WHERE a.fetch_run_id = NEW.fetch_run_id
  GROUP BY a.id
  HAVING min(t.step_index) <> 0 OR count(*) <> max(t.step_index) + 1
)
OR EXISTS (
  SELECT 1
  FROM fetch_artifacts AS a
  WHERE a.fetch_run_id = NEW.fetch_run_id
    AND a.payload_fidelity = 'transformed'
    AND NOT EXISTS (
      SELECT 1 FROM artifact_transform_steps AS t
      WHERE t.fetch_artifact_id = a.id
    )
)
OR EXISTS (
  SELECT 1
  FROM fetch_page_groups AS pg
  LEFT JOIN fetch_artifacts AS a
    ON a.fetch_run_id = pg.fetch_run_id AND a.page_group_id = pg.id
  WHERE pg.fetch_run_id = NEW.fetch_run_id
    AND pg.declared_page_count IS NOT NULL
  GROUP BY pg.id, pg.declared_page_count
  HAVING count(a.id) <> pg.declared_page_count
)
OR EXISTS (
  SELECT 1
  FROM fetch_units AS u
  WHERE u.fetch_run_id = NEW.fetch_run_id
    AND u.terminal_report_required = 1
    AND NOT EXISTS (
      SELECT 1 FROM fetch_unit_reports AS r
      WHERE r.fetch_unit_id = u.id AND r.report_kind = 'terminal'
    )
)
OR EXISTS (
  SELECT 1
  FROM fetch_units AS u
  JOIN fetch_unit_reports AS r
    ON r.fetch_unit_id = u.id AND r.report_kind = 'terminal'
  WHERE u.fetch_run_id = NEW.fetch_run_id
    AND r.declared_artifact_count IS NOT NULL
    AND r.artifact_count_scope = 'direct'
    AND r.declared_artifact_count <> (
      SELECT count(*) FROM fetch_artifacts AS a WHERE a.fetch_unit_id = u.id
    )
)
OR EXISTS (
  SELECT 1
  FROM fetch_units AS u
  JOIN fetch_unit_reports AS r
    ON r.fetch_unit_id = u.id AND r.report_kind = 'terminal'
  WHERE u.fetch_run_id = NEW.fetch_run_id
    AND r.declared_artifact_count IS NOT NULL
    AND r.artifact_count_scope = 'subtree'
    AND r.declared_artifact_count <> (
      WITH RECURSIVE descendants(id) AS (
        SELECT u.id
        UNION ALL
        SELECT child.id FROM fetch_units AS child
        JOIN descendants AS d ON child.parent_unit_id = d.id
      )
      SELECT count(*) FROM fetch_artifacts
      WHERE fetch_unit_id IN (SELECT id FROM descendants)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'run_inventory_incomplete');
END;

CREATE TRIGGER run_inventory_item_reject_after_seal
BEFORE INSERT ON run_inventory_items
WHEN EXISTS (
  SELECT 1 FROM fetch_run_seals WHERE fetch_run_id = NEW.fetch_run_id
)
AND NOT EXISTS (
  SELECT 1 FROM run_inventory_items
  WHERE inventory_id = NEW.inventory_id AND artifact_key = NEW.artifact_key
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_sealed');
END;

CREATE TRIGGER fetch_run_report_reject_after_terminal
BEFORE INSERT ON fetch_run_reports
WHEN EXISTS (
  SELECT 1 FROM fetch_run_reports
  WHERE fetch_run_id = NEW.fetch_run_id AND report_kind = 'terminal'
)
AND NOT EXISTS (
  SELECT 1 FROM fetch_run_reports
  WHERE fetch_run_id = NEW.fetch_run_id AND report_key = NEW.report_key
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_terminal');
END;

CREATE TRIGGER fetch_artifact_reject_after_seal
BEFORE INSERT ON fetch_artifacts
WHEN EXISTS (
  SELECT 1
  FROM fetch_run_seals AS s
  JOIN run_inventories AS i ON i.id = s.inventory_id
  WHERE i.fetch_run_id = NEW.fetch_run_id
)
AND NOT EXISTS (
  SELECT 1 FROM fetch_artifacts
  WHERE fetch_run_id = NEW.fetch_run_id AND artifact_key = NEW.artifact_key
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_sealed');
END;

CREATE TRIGGER fetch_unit_reject_after_seal
BEFORE INSERT ON fetch_units
WHEN EXISTS (
  SELECT 1
  FROM fetch_run_seals AS s
  JOIN run_inventories AS i ON i.id = s.inventory_id
  WHERE i.fetch_run_id = NEW.fetch_run_id
)
AND NOT EXISTS (
  SELECT 1 FROM fetch_units
  WHERE fetch_run_id = NEW.fetch_run_id
    AND unit_kind = NEW.unit_kind AND unit_key = NEW.unit_key
    AND (
      parent_unit_id = NEW.parent_unit_id
      OR (parent_unit_id IS NULL AND NEW.parent_unit_id IS NULL)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_sealed');
END;

CREATE TRIGGER fetch_unit_report_reject_after_terminal
BEFORE INSERT ON fetch_unit_reports
WHEN EXISTS (
  SELECT 1 FROM fetch_unit_reports
  WHERE fetch_unit_id = NEW.fetch_unit_id AND report_kind = 'terminal'
)
AND NOT EXISTS (
  SELECT 1 FROM fetch_unit_reports
  WHERE fetch_unit_id = NEW.fetch_unit_id AND report_key = NEW.report_key
)
BEGIN SELECT RAISE(ABORT, 'fetch_unit_already_terminal'); END;

CREATE TRIGGER fetch_unit_report_reject_after_seal
BEFORE INSERT ON fetch_unit_reports
WHEN EXISTS (
  SELECT 1 FROM fetch_units AS u
  JOIN fetch_run_seals AS s ON s.fetch_run_id = u.fetch_run_id
  WHERE u.id = NEW.fetch_unit_id
)
AND NOT EXISTS (
  SELECT 1 FROM fetch_unit_reports
  WHERE fetch_unit_id = NEW.fetch_unit_id AND report_key = NEW.report_key
)
BEGIN SELECT RAISE(ABORT, 'fetch_run_already_sealed'); END;

CREATE TRIGGER fetch_page_group_reject_after_seal
BEFORE INSERT ON fetch_page_groups
WHEN EXISTS (
  SELECT 1 FROM fetch_run_seals WHERE fetch_run_id = NEW.fetch_run_id
)
AND NOT EXISTS (
  SELECT 1 FROM fetch_page_groups
  WHERE fetch_run_id = NEW.fetch_run_id AND page_group_key = NEW.page_group_key
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_sealed');
END;

CREATE TRIGGER fetch_run_range_reject_after_seal
BEFORE INSERT ON fetch_run_ranges
WHEN EXISTS (
  SELECT 1 FROM fetch_run_seals WHERE fetch_run_id = NEW.fetch_run_id
)
AND NOT EXISTS (
  SELECT 1 FROM fetch_run_ranges
  WHERE fetch_run_id = NEW.fetch_run_id AND range_key = NEW.range_key
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_sealed');
END;

CREATE TRIGGER fetch_run_report_reject_after_seal
BEFORE INSERT ON fetch_run_reports
WHEN EXISTS (
  SELECT 1
  FROM fetch_run_seals AS s
  JOIN run_inventories AS i ON i.id = s.inventory_id
  WHERE i.fetch_run_id = NEW.fetch_run_id
)
AND NOT EXISTS (
  SELECT 1 FROM fetch_run_reports
  WHERE fetch_run_id = NEW.fetch_run_id AND report_key = NEW.report_key
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_sealed');
END;

CREATE TRIGGER run_inventory_reject_after_seal
BEFORE INSERT ON run_inventories
WHEN EXISTS (
  SELECT 1
  FROM fetch_run_seals AS s
  JOIN run_inventories AS i ON i.id = s.inventory_id
  WHERE i.fetch_run_id = NEW.fetch_run_id
)
AND NOT EXISTS (
  SELECT 1 FROM run_inventories
  WHERE fetch_run_id = NEW.fetch_run_id
    AND inventory_sha256 = NEW.inventory_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_sealed');
END;

CREATE TRIGGER artifact_range_reject_after_seal
BEFORE INSERT ON artifact_ranges
WHEN EXISTS (
  SELECT 1
  FROM fetch_artifacts AS a
  JOIN fetch_run_seals AS s ON s.fetch_run_id = a.fetch_run_id
  WHERE a.id = NEW.fetch_artifact_id
)
AND NOT EXISTS (
  SELECT 1 FROM artifact_ranges
  WHERE fetch_artifact_id = NEW.fetch_artifact_id AND range_key = NEW.range_key
)
BEGIN
  SELECT RAISE(ABORT, 'fetch_run_already_sealed');
END;

CREATE TRIGGER artifact_http_metadata_reject_after_seal
BEFORE INSERT ON artifact_http_metadata
WHEN EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_run_seals AS s ON s.fetch_run_id = a.fetch_run_id
  WHERE a.id = NEW.fetch_artifact_id
)
AND NOT EXISTS (
  SELECT 1 FROM artifact_http_metadata
  WHERE fetch_artifact_id = NEW.fetch_artifact_id
)
BEGIN SELECT RAISE(ABORT, 'fetch_run_already_sealed'); END;

CREATE TRIGGER artifact_storage_metadata_reject_after_seal
BEFORE INSERT ON artifact_storage_metadata
WHEN EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_run_seals AS s ON s.fetch_run_id = a.fetch_run_id
  WHERE a.id = NEW.fetch_artifact_id
)
AND NOT EXISTS (
  SELECT 1 FROM artifact_storage_metadata
  WHERE fetch_artifact_id = NEW.fetch_artifact_id
)
BEGIN SELECT RAISE(ABORT, 'fetch_run_already_sealed'); END;

CREATE TRIGGER artifact_file_metadata_reject_after_seal
BEFORE INSERT ON artifact_file_metadata
WHEN EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_run_seals AS s ON s.fetch_run_id = a.fetch_run_id
  WHERE a.id = NEW.fetch_artifact_id
)
AND NOT EXISTS (
  SELECT 1 FROM artifact_file_metadata
  WHERE fetch_artifact_id = NEW.fetch_artifact_id
)
BEGIN SELECT RAISE(ABORT, 'fetch_run_already_sealed'); END;

CREATE TRIGGER artifact_email_metadata_reject_after_seal
BEFORE INSERT ON artifact_email_metadata
WHEN EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_run_seals AS s ON s.fetch_run_id = a.fetch_run_id
  WHERE a.id = NEW.fetch_artifact_id
)
AND NOT EXISTS (
  SELECT 1 FROM artifact_email_metadata
  WHERE fetch_artifact_id = NEW.fetch_artifact_id
)
BEGIN SELECT RAISE(ABORT, 'fetch_run_already_sealed'); END;

CREATE TRIGGER artifact_relation_reject_after_seal
BEFORE INSERT ON artifact_relations
WHEN EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_run_seals AS s ON s.fetch_run_id = a.fetch_run_id
  WHERE a.id = NEW.child_artifact_id
)
AND NOT EXISTS (
  SELECT 1 FROM artifact_relations
  WHERE child_artifact_id = NEW.child_artifact_id
    AND parent_artifact_id = NEW.parent_artifact_id
    AND relation = NEW.relation
)
BEGIN SELECT RAISE(ABORT, 'fetch_run_already_sealed'); END;

CREATE TRIGGER artifact_relation_requires_same_source
BEFORE INSERT ON artifact_relations
WHEN (
  SELECT a.source_id
  FROM fetch_artifacts AS a
  WHERE a.id = NEW.child_artifact_id
) <> (
  SELECT a.source_id
  FROM fetch_artifacts AS a
  WHERE a.id = NEW.parent_artifact_id
)
BEGIN SELECT RAISE(ABORT, 'artifact_relation_crosses_source'); END;

CREATE TRIGGER artifact_transform_step_reject_after_seal
BEFORE INSERT ON artifact_transform_steps
WHEN EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_run_seals AS s ON s.fetch_run_id = a.fetch_run_id
  WHERE a.id = NEW.fetch_artifact_id
)
AND NOT EXISTS (
  SELECT 1 FROM artifact_transform_steps
  WHERE fetch_artifact_id = NEW.fetch_artifact_id
    AND step_index = NEW.step_index
)
BEGIN SELECT RAISE(ABORT, 'fetch_run_already_sealed'); END;

CREATE TRIGGER artifact_transform_step_requires_transformed_artifact
BEFORE INSERT ON artifact_transform_steps
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_artifacts
  WHERE id = NEW.fetch_artifact_id AND payload_fidelity = 'transformed'
)
BEGIN SELECT RAISE(ABORT, 'artifact_is_not_transformed'); END;

CREATE TRIGGER artifact_relation_reject_cycle
BEFORE INSERT ON artifact_relations
WHEN EXISTS (
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.parent_artifact_id
    UNION
    SELECT r.parent_artifact_id
    FROM artifact_relations AS r
    JOIN ancestors AS a ON r.child_artifact_id = a.id
  )
  SELECT 1 FROM ancestors WHERE id = NEW.child_artifact_id
)
BEGIN SELECT RAISE(ABORT, 'artifact_relation_cycle'); END;

-- The producer outcome above and central-transfer outcome here are distinct.
-- A retry writes another attempt; no source history is mutated.
CREATE TABLE ingestion_attempts (
  id                      INTEGER PRIMARY KEY,
  fetch_run_id            INTEGER NOT NULL,
  producer_id             TEXT NOT NULL,
  source_id               TEXT NOT NULL,
  ingest_client_id        TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  ingest_client_version   TEXT CHECK (
    ingest_client_version IS NULL OR length(ingest_client_version) BETWEEN 1 AND 200
  ),
  external_attempt_id     TEXT NOT NULL CHECK (
    length(external_attempt_id) BETWEEN 1 AND 500
    AND external_attempt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  started_at_ms           INTEGER CHECK (started_at_ms BETWEEN 0 AND 9007199254740991),
  completed_at_ms         INTEGER NOT NULL
    CHECK (completed_at_ms BETWEEN 0 AND 9007199254740991),
  expected_artifact_count INTEGER CHECK (expected_artifact_count BETWEEN 0 AND 9007199254740991),
  observed_artifact_count INTEGER NOT NULL CHECK (observed_artifact_count BETWEEN 0 AND 9007199254740991),
  accepted_artifact_count INTEGER NOT NULL CHECK (accepted_artifact_count BETWEEN 0 AND 9007199254740991),
  reused_artifact_count   INTEGER NOT NULL CHECK (reused_artifact_count BETWEEN 0 AND 9007199254740991),
  rejected_artifact_count INTEGER NOT NULL CHECK (rejected_artifact_count BETWEEN 0 AND 9007199254740991),
  sealed_inventory_id     INTEGER,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('complete', 'incomplete', 'failed')),
  error_code              TEXT CHECK (error_code IS NULL OR (
    length(error_code) BETWEEN 1 AND 100
    AND instr(error_code, char(10)) = 0 AND instr(error_code, char(13)) = 0
  )),
  recorded_at_ms          INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (started_at_ms IS NULL OR completed_at_ms >= started_at_ms),
  CHECK (accepted_artifact_count + reused_artifact_count + rejected_artifact_count
         <= observed_artifact_count),
  CHECK (outcome <> 'complete' OR rejected_artifact_count = 0),
  CHECK (outcome <> 'complete' OR
         accepted_artifact_count + reused_artifact_count = observed_artifact_count),
  CHECK (outcome <> 'complete' OR expected_artifact_count IS NULL
         OR expected_artifact_count = observed_artifact_count),
  CHECK ((outcome = 'complete') = (sealed_inventory_id IS NOT NULL)),
  FOREIGN KEY (fetch_run_id, producer_id, source_id)
    REFERENCES fetch_runs(id, producer_id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (ingest_client_id, producer_id, source_id)
    REFERENCES ingest_client_routes(ingest_client_id, producer_id, source_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (sealed_inventory_id, fetch_run_id)
    REFERENCES fetch_run_seals(inventory_id, fetch_run_id) ON DELETE RESTRICT,
  UNIQUE (fetch_run_id, ingest_client_id, external_attempt_id)
) STRICT;

CREATE TRIGGER ingestion_attempt_complete_matches_sealed_inventory
BEFORE INSERT ON ingestion_attempts
WHEN NEW.outcome = 'complete' AND NOT EXISTS (
  SELECT 1
  FROM fetch_run_seals AS s
  JOIN run_inventories AS i ON i.id = s.inventory_id
  WHERE s.inventory_id = NEW.sealed_inventory_id
    AND s.fetch_run_id = NEW.fetch_run_id
    AND i.expected_artifact_count = NEW.observed_artifact_count
    AND (
      NEW.expected_artifact_count IS NULL
      OR i.expected_artifact_count = NEW.expected_artifact_count
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ingestion_attempt_count_mismatch');
END;

CREATE TABLE raw_object_verification_events (
  id              INTEGER PRIMARY KEY,
  sha256          TEXT NOT NULL REFERENCES raw_objects(sha256) ON DELETE RESTRICT,
  checked_at_ms   INTEGER NOT NULL CHECK (checked_at_ms BETWEEN 0 AND 9007199254740991),
  result          TEXT NOT NULL CHECK (result IN (
    'ok', 'missing', 'size_mismatch', 'hash_mismatch', 'read_error'
  )),
  observed_size   INTEGER CHECK (observed_size BETWEEN 0 AND 9007199254740991),
  observed_sha256 TEXT CHECK (
    observed_sha256 IS NULL OR (
      length(observed_sha256) = 64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  detail_code     TEXT CHECK (detail_code IS NULL OR (
    length(detail_code) BETWEEN 1 AND 100
    AND instr(detail_code, char(10)) = 0 AND instr(detail_code, char(13)) = 0
  )),
  checked_by_client_id TEXT NOT NULL REFERENCES ingest_clients(id) ON DELETE RESTRICT,
  recorded_at_ms  INTEGER NOT NULL
    CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (result <> 'ok' OR (observed_size IS NOT NULL AND observed_sha256 IS NOT NULL)),
  CHECK (result <> 'missing' OR (observed_size IS NULL AND observed_sha256 IS NULL)),
  CHECK (result <> 'size_mismatch' OR observed_size IS NOT NULL),
  CHECK (result <> 'hash_mismatch' OR observed_sha256 IS NOT NULL)
) STRICT;

CREATE TRIGGER raw_object_verification_result_matches_measurement
BEFORE INSERT ON raw_object_verification_events
WHEN
  (NEW.result = 'ok' AND NOT EXISTS (
    SELECT 1 FROM raw_objects
    WHERE sha256 = NEW.sha256
      AND byte_size = NEW.observed_size
      AND sha256 = NEW.observed_sha256
  ))
  OR (NEW.result = 'size_mismatch' AND EXISTS (
    SELECT 1 FROM raw_objects
    WHERE sha256 = NEW.sha256 AND byte_size = NEW.observed_size
  ))
  OR (NEW.result = 'hash_mismatch' AND NEW.sha256 = NEW.observed_sha256)
BEGIN
  SELECT RAISE(ABORT, 'verification_result_mismatch');
END;

-- Verification is source-independent, but disabled clients must not append
-- new audit claims.
CREATE TRIGGER raw_object_verification_requires_active_client
BEFORE INSERT ON raw_object_verification_events
WHEN NOT EXISTS (
  SELECT 1 FROM ingest_clients
  WHERE id = NEW.checked_by_client_id AND active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'inactive_ingest_client');
END;

-- Actor authorization is checked again in D1. Foreign keys preserve the
-- historical route even after deactivation; these triggers reject new writes
-- through an inactive client, producer, source, or route.
CREATE TRIGGER acquisition_session_requires_active_route
BEFORE INSERT ON acquisition_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM active_ingest_client_producers
  WHERE ingest_client_id = NEW.first_recorded_by_client_id
    AND producer_id = NEW.producer_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER fetch_run_requires_active_route
BEFORE INSERT ON fetch_runs
WHEN NOT EXISTS (
  SELECT 1 FROM active_ingest_routes
  WHERE ingest_client_id = NEW.first_recorded_by_client_id
    AND producer_id = NEW.producer_id AND source_id = NEW.source_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER fetch_unit_requires_active_route
BEFORE INSERT ON fetch_units
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_runs AS f
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE f.id = NEW.fetch_run_id
    AND r.ingest_client_id = NEW.recorded_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER fetch_unit_report_requires_active_route
BEFORE INSERT ON fetch_unit_reports
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_units AS u
  JOIN fetch_runs AS f ON f.id = u.fetch_run_id
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE u.id = NEW.fetch_unit_id
    AND r.ingest_client_id = NEW.recorded_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER fetch_page_group_requires_active_route
BEFORE INSERT ON fetch_page_groups
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_runs AS f
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE f.id = NEW.fetch_run_id
    AND r.ingest_client_id = NEW.recorded_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER fetch_run_report_requires_active_route
BEFORE INSERT ON fetch_run_reports
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_runs AS f
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE f.id = NEW.fetch_run_id
    AND r.ingest_client_id = NEW.recorded_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER fetch_artifact_requires_active_route
BEFORE INSERT ON fetch_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM active_ingest_routes AS r
  WHERE r.ingest_client_id = NEW.first_ingested_by_client_id
    AND r.producer_id = NEW.producer_id AND r.source_id = NEW.source_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER fetch_run_range_requires_active_route
BEFORE INSERT ON fetch_run_ranges
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_runs AS f
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE f.id = NEW.fetch_run_id
    AND r.ingest_client_id = NEW.recorded_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER artifact_range_requires_active_route
BEFORE INSERT ON artifact_ranges
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_runs AS f ON f.id = a.fetch_run_id
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE a.id = NEW.fetch_artifact_id
    AND r.ingest_client_id = NEW.recorded_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER artifact_relation_requires_active_route
BEFORE INSERT ON artifact_relations
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_runs AS f ON f.id = a.fetch_run_id
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE a.id = NEW.child_artifact_id
    AND r.ingest_client_id = NEW.recorded_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER artifact_transform_step_requires_active_route
BEFORE INSERT ON artifact_transform_steps
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_artifacts AS a
  JOIN fetch_runs AS f ON f.id = a.fetch_run_id
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE a.id = NEW.fetch_artifact_id
    AND r.ingest_client_id = NEW.recorded_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER run_inventory_requires_active_route
BEFORE INSERT ON run_inventories
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_runs AS f
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE f.id = NEW.fetch_run_id
    AND r.ingest_client_id = NEW.created_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER fetch_run_seal_requires_active_route
BEFORE INSERT ON fetch_run_seals
WHEN NOT EXISTS (
  SELECT 1 FROM fetch_runs AS f
  JOIN active_ingest_routes AS r
    ON r.producer_id = f.producer_id AND r.source_id = f.source_id
  WHERE f.id = NEW.fetch_run_id
    AND r.ingest_client_id = NEW.sealed_by_client_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

CREATE TRIGGER ingestion_attempt_requires_active_route
BEFORE INSERT ON ingestion_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM active_ingest_routes
  WHERE ingest_client_id = NEW.ingest_client_id
    AND producer_id = NEW.producer_id AND source_id = NEW.source_id
)
BEGIN SELECT RAISE(ABORT, 'inactive_ingest_route'); END;

-- SQLite's INSERT OR REPLACE can bypass DELETE triggers when
-- recursive_triggers is disabled. Reject every attempted insert whose immutable
-- natural key already exists. The Worker obtains idempotency with
-- INSERT ... SELECT ... WHERE NOT EXISTS, then compares the existing row.
CREATE TRIGGER acquisition_sessions_reject_duplicate_insert
BEFORE INSERT ON acquisition_sessions
WHEN EXISTS (
  SELECT 1 FROM acquisition_sessions
  WHERE id = NEW.id OR (
    producer_id = NEW.producer_id
    AND external_id_namespace = NEW.external_id_namespace
    AND external_session_id = NEW.external_session_id
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER fetch_runs_reject_duplicate_insert
BEFORE INSERT ON fetch_runs
WHEN EXISTS (
  SELECT 1 FROM fetch_runs
  WHERE id = NEW.id OR (
    acquisition_session_id = NEW.acquisition_session_id
    AND source_id = NEW.source_id AND source_run_key = NEW.source_run_key
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER fetch_units_reject_duplicate_insert
BEFORE INSERT ON fetch_units
WHEN EXISTS (
  SELECT 1 FROM fetch_units
  WHERE id = NEW.id OR (
    fetch_run_id = NEW.fetch_run_id
    AND unit_kind = NEW.unit_kind AND unit_key = NEW.unit_key
    AND (
      parent_unit_id = NEW.parent_unit_id
      OR (parent_unit_id IS NULL AND NEW.parent_unit_id IS NULL)
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER fetch_unit_reports_reject_duplicate_insert
BEFORE INSERT ON fetch_unit_reports
WHEN EXISTS (
  SELECT 1 FROM fetch_unit_reports
  WHERE id = NEW.id OR (
    fetch_unit_id = NEW.fetch_unit_id AND report_key = NEW.report_key
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER fetch_page_groups_reject_duplicate_insert
BEFORE INSERT ON fetch_page_groups
WHEN EXISTS (
  SELECT 1 FROM fetch_page_groups
  WHERE id = NEW.id OR (
    fetch_run_id = NEW.fetch_run_id AND page_group_key = NEW.page_group_key
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER fetch_run_reports_reject_duplicate_insert
BEFORE INSERT ON fetch_run_reports
WHEN EXISTS (
  SELECT 1 FROM fetch_run_reports
  WHERE id = NEW.id OR (
    fetch_run_id = NEW.fetch_run_id AND report_key = NEW.report_key
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER raw_objects_reject_duplicate_insert
BEFORE INSERT ON raw_objects
WHEN EXISTS (
  SELECT 1 FROM raw_objects WHERE sha256 = NEW.sha256 OR blob_key = NEW.blob_key
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER fetch_artifacts_reject_duplicate_insert
BEFORE INSERT ON fetch_artifacts
WHEN EXISTS (
  SELECT 1 FROM fetch_artifacts
  WHERE id = NEW.id OR (
    fetch_run_id = NEW.fetch_run_id AND artifact_key = NEW.artifact_key
  ) OR (
    NEW.sequence IS NOT NULL
    AND fetch_run_id = NEW.fetch_run_id AND sequence = NEW.sequence
  ) OR (
    NEW.page_group_id IS NOT NULL
    AND fetch_run_id = NEW.fetch_run_id
    AND page_group_id = NEW.page_group_id AND page_index = NEW.page_index
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER fetch_run_ranges_reject_duplicate_insert
BEFORE INSERT ON fetch_run_ranges
WHEN EXISTS (
  SELECT 1 FROM fetch_run_ranges
  WHERE id = NEW.id OR (fetch_run_id = NEW.fetch_run_id AND range_key = NEW.range_key)
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER artifact_ranges_reject_duplicate_insert
BEFORE INSERT ON artifact_ranges
WHEN EXISTS (
  SELECT 1 FROM artifact_ranges
  WHERE id = NEW.id OR (
    fetch_artifact_id = NEW.fetch_artifact_id AND range_key = NEW.range_key
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER artifact_http_metadata_reject_duplicate_insert
BEFORE INSERT ON artifact_http_metadata
WHEN EXISTS (SELECT 1 FROM artifact_http_metadata WHERE fetch_artifact_id = NEW.fetch_artifact_id)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER artifact_storage_metadata_reject_duplicate_insert
BEFORE INSERT ON artifact_storage_metadata
WHEN EXISTS (SELECT 1 FROM artifact_storage_metadata WHERE fetch_artifact_id = NEW.fetch_artifact_id)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER artifact_file_metadata_reject_duplicate_insert
BEFORE INSERT ON artifact_file_metadata
WHEN EXISTS (SELECT 1 FROM artifact_file_metadata WHERE fetch_artifact_id = NEW.fetch_artifact_id)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER artifact_email_metadata_reject_duplicate_insert
BEFORE INSERT ON artifact_email_metadata
WHEN EXISTS (SELECT 1 FROM artifact_email_metadata WHERE fetch_artifact_id = NEW.fetch_artifact_id)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER artifact_relations_reject_duplicate_insert
BEFORE INSERT ON artifact_relations
WHEN EXISTS (
  SELECT 1 FROM artifact_relations
  WHERE child_artifact_id = NEW.child_artifact_id
    AND parent_artifact_id = NEW.parent_artifact_id AND relation = NEW.relation
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER artifact_transform_steps_reject_duplicate_insert
BEFORE INSERT ON artifact_transform_steps
WHEN EXISTS (
  SELECT 1 FROM artifact_transform_steps
  WHERE fetch_artifact_id = NEW.fetch_artifact_id AND step_index = NEW.step_index
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER run_inventories_reject_duplicate_insert
BEFORE INSERT ON run_inventories
WHEN EXISTS (
  SELECT 1 FROM run_inventories
  WHERE id = NEW.id OR (
    fetch_run_id = NEW.fetch_run_id AND inventory_sha256 = NEW.inventory_sha256
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER run_inventory_items_reject_duplicate_insert
BEFORE INSERT ON run_inventory_items
WHEN EXISTS (
  SELECT 1 FROM run_inventory_items
  WHERE inventory_id = NEW.inventory_id AND artifact_key = NEW.artifact_key
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER fetch_run_seals_reject_duplicate_insert
BEFORE INSERT ON fetch_run_seals
WHEN EXISTS (
  SELECT 1 FROM fetch_run_seals
  WHERE inventory_id = NEW.inventory_id OR fetch_run_id = NEW.fetch_run_id
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER ingestion_attempts_reject_duplicate_insert
BEFORE INSERT ON ingestion_attempts
WHEN EXISTS (
  SELECT 1 FROM ingestion_attempts
  WHERE id = NEW.id OR (
    fetch_run_id = NEW.fetch_run_id
    AND ingest_client_id = NEW.ingest_client_id
    AND external_attempt_id = NEW.external_attempt_id
  )
)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE TRIGGER raw_object_verification_events_reject_duplicate_insert
BEFORE INSERT ON raw_object_verification_events
WHEN EXISTS (SELECT 1 FROM raw_object_verification_events WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'immutable_duplicate_insert'); END;

CREATE INDEX idx_fetch_runs_source
  ON fetch_runs (source_id, id DESC);
CREATE INDEX idx_acquisition_sessions_producer_time
  ON acquisition_sessions (producer_id, first_recorded_at_ms DESC, id DESC);
CREATE INDEX idx_fetch_units_run
  ON fetch_units (fetch_run_id, unit_kind, unit_key);
CREATE INDEX idx_fetch_unit_reports_unit
  ON fetch_unit_reports (fetch_unit_id, recorded_at_ms DESC, id DESC);
CREATE INDEX idx_fetch_run_reports_run
  ON fetch_run_reports (fetch_run_id, recorded_at_ms DESC, id DESC);
CREATE INDEX idx_fetch_run_ranges_run
  ON fetch_run_ranges (fetch_run_id, range_kind, id);
CREATE INDEX idx_fetch_artifacts_source_dataset_time
  ON fetch_artifacts (source_id, artifact_role, dataset, fetched_at_ms DESC, id DESC);
CREATE INDEX idx_fetch_artifacts_sha256
  ON fetch_artifacts (sha256);
CREATE INDEX idx_fetch_artifacts_run_role
  ON fetch_artifacts (fetch_run_id, artifact_role, id);
CREATE INDEX idx_artifact_http_origin
  ON artifact_http_metadata (host, path_template);
CREATE INDEX idx_artifact_ranges_artifact
  ON artifact_ranges (fetch_artifact_id, range_kind, id);
CREATE INDEX idx_run_inventories_run
  ON run_inventories (fetch_run_id, id DESC);
CREATE INDEX idx_ingestion_attempts_run
  ON ingestion_attempts (fetch_run_id, recorded_at_ms DESC, id DESC);
CREATE INDEX idx_raw_object_verification
  ON raw_object_verification_events (sha256, checked_at_ms DESC, id DESC);

-- The database enforces append-only evidence even if a future Worker route or
-- an ad-hoc D1 command accidentally attempts a mutation.
CREATE TRIGGER acquisition_sessions_no_update BEFORE UPDATE ON acquisition_sessions
BEGIN SELECT RAISE(ABORT, 'acquisition_sessions is append-only'); END;
CREATE TRIGGER acquisition_sessions_no_delete BEFORE DELETE ON acquisition_sessions
BEGIN SELECT RAISE(ABORT, 'acquisition_sessions is append-only'); END;
CREATE TRIGGER fetch_runs_no_update BEFORE UPDATE ON fetch_runs
BEGIN SELECT RAISE(ABORT, 'fetch_runs is append-only'); END;
CREATE TRIGGER fetch_runs_no_delete BEFORE DELETE ON fetch_runs
BEGIN SELECT RAISE(ABORT, 'fetch_runs is append-only'); END;
CREATE TRIGGER fetch_units_no_update BEFORE UPDATE ON fetch_units
BEGIN SELECT RAISE(ABORT, 'fetch_units is append-only'); END;
CREATE TRIGGER fetch_units_no_delete BEFORE DELETE ON fetch_units
BEGIN SELECT RAISE(ABORT, 'fetch_units is append-only'); END;
CREATE TRIGGER fetch_unit_reports_no_update BEFORE UPDATE ON fetch_unit_reports
BEGIN SELECT RAISE(ABORT, 'fetch_unit_reports is append-only'); END;
CREATE TRIGGER fetch_unit_reports_no_delete BEFORE DELETE ON fetch_unit_reports
BEGIN SELECT RAISE(ABORT, 'fetch_unit_reports is append-only'); END;
CREATE TRIGGER fetch_page_groups_no_update BEFORE UPDATE ON fetch_page_groups
BEGIN SELECT RAISE(ABORT, 'fetch_page_groups is append-only'); END;
CREATE TRIGGER fetch_page_groups_no_delete BEFORE DELETE ON fetch_page_groups
BEGIN SELECT RAISE(ABORT, 'fetch_page_groups is append-only'); END;
CREATE TRIGGER fetch_run_ranges_no_update BEFORE UPDATE ON fetch_run_ranges
BEGIN SELECT RAISE(ABORT, 'fetch_run_ranges is append-only'); END;
CREATE TRIGGER fetch_run_ranges_no_delete BEFORE DELETE ON fetch_run_ranges
BEGIN SELECT RAISE(ABORT, 'fetch_run_ranges is append-only'); END;
CREATE TRIGGER fetch_run_reports_no_update BEFORE UPDATE ON fetch_run_reports
BEGIN SELECT RAISE(ABORT, 'fetch_run_reports is append-only'); END;
CREATE TRIGGER fetch_run_reports_no_delete BEFORE DELETE ON fetch_run_reports
BEGIN SELECT RAISE(ABORT, 'fetch_run_reports is append-only'); END;
CREATE TRIGGER raw_objects_no_update BEFORE UPDATE ON raw_objects
BEGIN SELECT RAISE(ABORT, 'raw_objects is append-only'); END;
CREATE TRIGGER raw_objects_no_delete BEFORE DELETE ON raw_objects
BEGIN SELECT RAISE(ABORT, 'raw_objects is append-only'); END;
CREATE TRIGGER fetch_artifacts_no_update BEFORE UPDATE ON fetch_artifacts
BEGIN SELECT RAISE(ABORT, 'fetch_artifacts is append-only'); END;
CREATE TRIGGER fetch_artifacts_no_delete BEFORE DELETE ON fetch_artifacts
BEGIN SELECT RAISE(ABORT, 'fetch_artifacts is append-only'); END;
CREATE TRIGGER artifact_ranges_no_update BEFORE UPDATE ON artifact_ranges
BEGIN SELECT RAISE(ABORT, 'artifact_ranges is append-only'); END;
CREATE TRIGGER artifact_ranges_no_delete BEFORE DELETE ON artifact_ranges
BEGIN SELECT RAISE(ABORT, 'artifact_ranges is append-only'); END;
CREATE TRIGGER artifact_http_metadata_no_update BEFORE UPDATE ON artifact_http_metadata
BEGIN SELECT RAISE(ABORT, 'artifact_http_metadata is append-only'); END;
CREATE TRIGGER artifact_http_metadata_no_delete BEFORE DELETE ON artifact_http_metadata
BEGIN SELECT RAISE(ABORT, 'artifact_http_metadata is append-only'); END;
CREATE TRIGGER artifact_storage_metadata_no_update BEFORE UPDATE ON artifact_storage_metadata
BEGIN SELECT RAISE(ABORT, 'artifact_storage_metadata is append-only'); END;
CREATE TRIGGER artifact_storage_metadata_no_delete BEFORE DELETE ON artifact_storage_metadata
BEGIN SELECT RAISE(ABORT, 'artifact_storage_metadata is append-only'); END;
CREATE TRIGGER artifact_file_metadata_no_update BEFORE UPDATE ON artifact_file_metadata
BEGIN SELECT RAISE(ABORT, 'artifact_file_metadata is append-only'); END;
CREATE TRIGGER artifact_file_metadata_no_delete BEFORE DELETE ON artifact_file_metadata
BEGIN SELECT RAISE(ABORT, 'artifact_file_metadata is append-only'); END;
CREATE TRIGGER artifact_email_metadata_no_update BEFORE UPDATE ON artifact_email_metadata
BEGIN SELECT RAISE(ABORT, 'artifact_email_metadata is append-only'); END;
CREATE TRIGGER artifact_email_metadata_no_delete BEFORE DELETE ON artifact_email_metadata
BEGIN SELECT RAISE(ABORT, 'artifact_email_metadata is append-only'); END;
CREATE TRIGGER artifact_relations_no_update BEFORE UPDATE ON artifact_relations
BEGIN SELECT RAISE(ABORT, 'artifact_relations is append-only'); END;
CREATE TRIGGER artifact_relations_no_delete BEFORE DELETE ON artifact_relations
BEGIN SELECT RAISE(ABORT, 'artifact_relations is append-only'); END;
CREATE TRIGGER artifact_transform_steps_no_update BEFORE UPDATE ON artifact_transform_steps
BEGIN SELECT RAISE(ABORT, 'artifact_transform_steps is append-only'); END;
CREATE TRIGGER artifact_transform_steps_no_delete BEFORE DELETE ON artifact_transform_steps
BEGIN SELECT RAISE(ABORT, 'artifact_transform_steps is append-only'); END;
CREATE TRIGGER run_inventories_no_update BEFORE UPDATE ON run_inventories
BEGIN SELECT RAISE(ABORT, 'run_inventories is append-only'); END;
CREATE TRIGGER run_inventories_no_delete BEFORE DELETE ON run_inventories
BEGIN SELECT RAISE(ABORT, 'run_inventories is append-only'); END;
CREATE TRIGGER run_inventory_items_no_update BEFORE UPDATE ON run_inventory_items
BEGIN SELECT RAISE(ABORT, 'run_inventory_items is append-only'); END;
CREATE TRIGGER run_inventory_items_no_delete BEFORE DELETE ON run_inventory_items
BEGIN SELECT RAISE(ABORT, 'run_inventory_items is append-only'); END;
CREATE TRIGGER fetch_run_seals_no_update BEFORE UPDATE ON fetch_run_seals
BEGIN SELECT RAISE(ABORT, 'fetch_run_seals is append-only'); END;
CREATE TRIGGER fetch_run_seals_no_delete BEFORE DELETE ON fetch_run_seals
BEGIN SELECT RAISE(ABORT, 'fetch_run_seals is append-only'); END;
CREATE TRIGGER ingestion_attempts_no_update BEFORE UPDATE ON ingestion_attempts
BEGIN SELECT RAISE(ABORT, 'ingestion_attempts is append-only'); END;
CREATE TRIGGER ingestion_attempts_no_delete BEFORE DELETE ON ingestion_attempts
BEGIN SELECT RAISE(ABORT, 'ingestion_attempts is append-only'); END;
CREATE TRIGGER raw_object_verification_events_no_update
BEFORE UPDATE ON raw_object_verification_events
BEGIN SELECT RAISE(ABORT, 'raw_object_verification_events is append-only'); END;
CREATE TRIGGER raw_object_verification_events_no_delete
BEFORE DELETE ON raw_object_verification_events
BEGIN SELECT RAISE(ABORT, 'raw_object_verification_events is append-only'); END;
