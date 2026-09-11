-- Version the canonical inventory digest independently from the descriptor
-- format so either algorithm can evolve without reinterpreting old seals.
ALTER TABLE run_inventories ADD COLUMN inventory_digest_version TEXT NOT NULL
  DEFAULT 'v1' CHECK (length(inventory_digest_version) BETWEEN 1 AND 40);

-- Keep production verification evidence out of real financial sources, and
-- register the MoneyForward collector already present in the repository.
INSERT INTO sources (id, provider, display_name) VALUES
  ('kogane-synthetic', 'Kogane', 'Kogane synthetic verification'),
  ('moneyforward-me', 'Money Forward', 'MoneyForward ME');

INSERT INTO producer_sources (producer_id, source_id)
SELECT producer.id, source.id
FROM producers AS producer CROSS JOIN sources AS source
WHERE producer.id IN (
  'collector-r2-importer', 'kuebiko-importer', 'local-file-importer'
)
AND source.id IN ('kogane-synthetic', 'moneyforward-me');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id)
SELECT 'local-backfill', producer_id, source_id
FROM producer_sources
WHERE producer_id = 'local-file-importer'
  AND source_id IN ('kogane-synthetic', 'moneyforward-me');

-- The bootstrap credential is intentionally limited to local-file imports.
-- Collector-R2 and Kuebiko receive distinct clients and secrets before their
-- importers are enabled.
DELETE FROM ingest_client_routes
WHERE ingest_client_id = 'local-backfill'
  AND producer_id IN ('collector-r2-importer', 'kuebiko-importer');
DELETE FROM ingest_client_producers
WHERE ingest_client_id = 'local-backfill'
  AND producer_id IN ('collector-r2-importer', 'kuebiko-importer');

-- Synthetic verification is the only source allowed to use the harmless
-- example.test HTTP fixture. Financial-source scopes stay default-deny until
-- a source-specific reviewed migration is added with its importer.
INSERT INTO http_scope_rules (
  source_id, action, scheme, host, include_subdomains, port, path_prefix,
  note
) VALUES (
  'kogane-synthetic', 'allow', 'https', 'api.example.test', 0, NULL, '/v1/',
  'production verification fixture'
);

-- Explicit aliases turn names used by existing manifests into a reviewed,
-- queryable contract instead of importer-specific string substitutions.
CREATE TABLE source_external_ids (
  producer_id       TEXT NOT NULL REFERENCES producers(id) ON DELETE RESTRICT,
  external_source_id TEXT NOT NULL CHECK (
    length(external_source_id) BETWEEN 1 AND 100
    AND external_source_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (producer_id, external_source_id),
  FOREIGN KEY (producer_id, source_id)
    REFERENCES producer_sources(producer_id, source_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

-- Preserve, but explicitly quarantine, early production verification runs
-- that were recorded under a real source before the synthetic source existed.
CREATE TABLE fetch_run_annotations (
  fetch_run_id    INTEGER NOT NULL REFERENCES fetch_runs(id) ON DELETE RESTRICT,
  annotation_kind TEXT NOT NULL CHECK (annotation_kind IN ('exclude_from_financial_views')),
  reason_code     TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 1 AND 100
    AND reason_code NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  recorded_at_ms  INTEGER NOT NULL CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (fetch_run_id, annotation_kind)
) STRICT, WITHOUT ROWID;

INSERT INTO fetch_run_annotations (
  fetch_run_id, annotation_kind, reason_code, recorded_at_ms
)
SELECT run.id, 'exclude_from_financial_views', 'legacy-synthetic-bootstrap', 0
FROM fetch_runs AS run
JOIN acquisition_sessions AS session ON session.id = run.acquisition_session_id
WHERE session.external_id_namespace = 'synthetic'
  AND run.source_id <> 'kogane-synthetic';

CREATE VIEW financial_fetch_runs AS
SELECT run.* FROM fetch_runs AS run
WHERE NOT EXISTS (
  SELECT 1 FROM fetch_run_annotations AS annotation
  WHERE annotation.fetch_run_id = run.id
    AND annotation.annotation_kind = 'exclude_from_financial_views'
);

INSERT INTO source_external_ids (producer_id, external_source_id, source_id) VALUES
  ('collector-r2-importer', 'sbi-shinsei', 'sbi-shinsei-bank'),
  ('collector-r2-importer', 'prestia-globalpass', 'global-pass'),
  ('collector-r2-importer', 'smbc-direct', 'smbc-bank'),
  ('collector-r2-importer', 'moneyforward-me', 'moneyforward-me'),
  ('collector-r2-importer', 'v-point-pay-email', 'v-point-pay'),
  ('collector-r2-importer', 'v-point-pay-email-reconciliation', 'v-point');

CREATE INDEX idx_artifact_relations_parent
  ON artifact_relations (parent_artifact_id, child_artifact_id, relation);

CREATE TRIGGER run_inventory_item_reject_overflow
BEFORE INSERT ON run_inventory_items
WHEN (SELECT count(*) FROM run_inventory_items WHERE inventory_id = NEW.inventory_id)
  >= (SELECT expected_artifact_count FROM run_inventories WHERE id = NEW.inventory_id)
BEGIN SELECT RAISE(ABORT, 'inventory_overflow'); END;

-- The Worker only accepts sanitized templates that were explicitly reviewed
-- for a source and origin kind. This turns privacy from an importer convention
-- into an enforced registry boundary.
CREATE TABLE origin_template_policies (
  source_id               TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  origin_kind             TEXT NOT NULL CHECK (origin_kind IN ('http', 'storage', 'file', 'email')),
  template                TEXT NOT NULL CHECK (length(template) BETWEEN 1 AND 1000),
  redaction_version       TEXT NOT NULL CHECK (length(redaction_version) BETWEEN 1 AND 100),
  fingerprint_key_version TEXT NOT NULL DEFAULT '' CHECK (length(fingerprint_key_version) <= 100),
  query_names_json        TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(query_names_json) AND json_type(query_names_json) = 'array'
    AND length(query_names_json) BETWEEN 2 AND 4000
  ),
  active                  INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note                    TEXT,
  PRIMARY KEY (
    source_id, origin_kind, template, redaction_version,
    fingerprint_key_version, query_names_json
  )
) STRICT, WITHOUT ROWID;

INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version, fingerprint_key_version, note
)
SELECT id, 'file', '{redacted}', 'v1', 'local-file-v1',
       'local file importer without an extension'
FROM sources;
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version, fingerprint_key_version, note
)
SELECT id, 'file', '{redacted}.{extension}', 'v1', 'local-file-v1',
       'local file importer with a redacted extension placeholder'
FROM sources;
INSERT INTO origin_template_policies (
  source_id, origin_kind, template, redaction_version, fingerprint_key_version,
  query_names_json, note
) VALUES (
  'kogane-synthetic', 'http', '/v1/history/{month}', 'v1', '', '[]',
  'production verification HTTP fixture'
);

CREATE TRIGGER fetch_run_annotations_no_update
BEFORE UPDATE ON fetch_run_annotations
BEGIN SELECT RAISE(ABORT, 'fetch_run_annotations is append-only'); END;
CREATE TRIGGER fetch_run_annotations_no_delete
BEFORE DELETE ON fetch_run_annotations
BEGIN SELECT RAISE(ABORT, 'fetch_run_annotations is append-only'); END;
