-- Versioned metadata projections (design review D02, PR-06 / A04).
--
-- `observation_artifact_metadata` (0017) is keyed by artifact alone and is
-- append-only, so the first extraction of a statement state or period fixes
-- the parser's input forever. That table is not a cache: it is an
-- interpretation result. This migration makes the interpretation a versioned
-- transform instead.
--
--   financial artifact + manifest/sidecar artifacts
--     -> metadata extractor release
--   metadata_projections (append-only, keeps its inputs and its version)
--     -> parser release
--   parse_runs, which record which projection they read
--
-- Additive only: `observation_artifact_metadata` keeps its rows, its triggers
-- and its role in `observation_fetch_artifacts`, and a Worker that predates
-- this migration keeps reading and writing it unchanged.

-- One extraction result. The cache key is not the artifact: it is
-- (artifact, extractor release, digest of the input evidence). Reading the
-- same evidence with a new extractor adds a row and leaves the old one, so an
-- old parse keeps pointing at the metadata it actually used.
--   status 'ok'     the extraction ran and produced at least one value
--   status 'absent' the extraction ran and the inputs say there is no value
--                   (which is not the same as "no extraction was attempted")
--   status 'error'  the extraction ran and failed; output_json records the
--                   safe failure code only, never provider values
CREATE TABLE metadata_projections (
  id                INTEGER PRIMARY KEY,
  fetch_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  extractor_release TEXT NOT NULL,
  -- 'unknown' where the digest of the inputs of a past run cannot be known;
  -- never a digest of today's code standing in as evidence of an old run.
  input_digest      TEXT NOT NULL,
  output_json       TEXT NOT NULL CHECK(json_valid(output_json)),
  output_digest     TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('ok','absent','error')),
  created_at        TEXT NOT NULL,
  UNIQUE(fetch_artifact_id, extractor_release, input_digest)
) STRICT;
CREATE INDEX metadata_projections_artifact
  ON metadata_projections(fetch_artifact_id, extractor_release, id);
CREATE TRIGGER metadata_projections_no_update BEFORE UPDATE ON metadata_projections
BEGIN SELECT RAISE(ABORT,'metadata_projections is append-only'); END;
CREATE TRIGGER metadata_projections_no_delete BEFORE DELETE ON metadata_projections
BEGIN SELECT RAISE(ABORT,'metadata_projections is append-only'); END;

-- The sidecar evidence one projection was computed from: which artifacts, in
-- which role, at which raw digest. The subject artifact itself is the
-- projection's own `fetch_artifact_id` and is not repeated here, so an
-- extraction that reads no sidecar simply has no input rows.
CREATE TABLE metadata_projection_inputs (
  projection_id     INTEGER NOT NULL REFERENCES metadata_projections(id),
  input_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  role              TEXT NOT NULL,
  raw_sha256        TEXT NOT NULL,
  PRIMARY KEY(projection_id, input_artifact_id, role)
) STRICT;
CREATE INDEX metadata_projection_inputs_artifact
  ON metadata_projection_inputs(input_artifact_id, projection_id);
CREATE TRIGGER metadata_projection_inputs_no_update BEFORE UPDATE ON metadata_projection_inputs
BEGIN SELECT RAISE(ABORT,'metadata_projection_inputs is append-only'); END;
CREATE TRIGGER metadata_projection_inputs_no_delete BEFORE DELETE ON metadata_projection_inputs
BEGIN SELECT RAISE(ABORT,'metadata_projection_inputs is append-only'); END;

-- What a parse run actually consumed. `input_fingerprint` is
-- canonicalDigest({rawSha256, parserVisibleMetadata, manifestDigest}) and is
-- the identity of the transformation input, independent of the parse run id
-- and of the wall clock. `parser_release_id` is deliberately not a foreign
-- key: this migration is applied before 0028 creates `parser_releases`, and a
-- run recorded by a Worker that predates release registration must still keep
-- its fingerprint.
CREATE TABLE parse_input_references (
  parse_run_id           INTEGER PRIMARY KEY REFERENCES parse_runs(id),
  metadata_projection_id INTEGER REFERENCES metadata_projections(id),
  parser_release_id      TEXT NOT NULL,
  input_fingerprint      TEXT NOT NULL
) STRICT;
CREATE INDEX parse_input_references_release
  ON parse_input_references(parser_release_id, parse_run_id);
CREATE INDEX parse_input_references_fingerprint
  ON parse_input_references(input_fingerprint);
CREATE TRIGGER parse_input_references_no_update BEFORE UPDATE ON parse_input_references
BEGIN SELECT RAISE(ABORT,'parse_input_references is append-only'); END;
CREATE TRIGGER parse_input_references_no_delete BEFORE DELETE ON parse_input_references
BEGIN SELECT RAISE(ABORT,'parse_input_references is append-only'); END;

-- Backfill: every existing metadata row becomes the projection of the
-- compatibility extractor `legacy-metadata-v1`. Its `input_digest` and
-- `output_digest` are 'unknown' on purpose: the code digest and the exact
-- input set of the run that produced these values are not recorded anywhere,
-- and SQLite cannot compute SHA-256, so nothing is invented here. `status` is
-- 'absent' when the extraction produced no value at all, which the review
-- asks be distinguishable from "no extraction happened" - the presence of the
-- row is that distinction.
-- output_json is the canonical form the Worker writes for this release: the
-- two fields `observation_artifact_metadata` actually holds, keys sorted
-- (period, statementState). A projection written later by the Worker for the
-- same artifact and release is therefore byte-identical to this one.
INSERT INTO metadata_projections
  (fetch_artifact_id,extractor_release,input_digest,output_json,output_digest,status,created_at)
SELECT m.fetch_artifact_id,'legacy-metadata-v1','unknown',
  json_object('period',m.period,'statementState',m.statement_state),
  'unknown',
  CASE WHEN m.statement_state IS NOT NULL OR m.period IS NOT NULL THEN 'ok' ELSE 'absent' END,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM observation_artifact_metadata m
WHERE NOT EXISTS(SELECT 1 FROM metadata_projections p
  WHERE p.fetch_artifact_id=m.fetch_artifact_id AND p.extractor_release='legacy-metadata-v1'
    AND p.input_digest='unknown');

-- The manifest artifact the legacy extraction actually read, where one was
-- recorded. Rows without a manifest reference carry no input: nothing is
-- fabricated for them.
INSERT INTO metadata_projection_inputs(projection_id,input_artifact_id,role,raw_sha256)
SELECT p.id,m.metadata_manifest_artifact_id,'collector_manifest',a.sha256
FROM metadata_projections p
JOIN observation_artifact_metadata m ON m.fetch_artifact_id=p.fetch_artifact_id
JOIN fetch_artifacts a ON a.id=m.metadata_manifest_artifact_id
WHERE p.extractor_release='legacy-metadata-v1' AND p.input_digest='unknown'
  AND m.metadata_manifest_artifact_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM metadata_projection_inputs i
    WHERE i.projection_id=p.id AND i.input_artifact_id=m.metadata_manifest_artifact_id
      AND i.role='collector_manifest');

-- Reader convenience: the projection a legacy reader would pick, one row per
-- artifact. Nothing in the normal read path joins it yet; the Worker selects
-- explicitly by release.
CREATE VIEW legacy_metadata_projections AS
 SELECT p.* FROM metadata_projections p
 WHERE p.extractor_release='legacy-metadata-v1'
   AND p.id=(SELECT max(q.id) FROM metadata_projections q
     WHERE q.fetch_artifact_id=p.fetch_artifact_id AND q.extractor_release='legacy-metadata-v1');
