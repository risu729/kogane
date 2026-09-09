-- Parser releases, candidate results, comparison and adoption
-- (design review D03, PR-08 / A04; docs/release-adoption.md).
--
-- "The parse succeeded" and "normal reads use this parse" were separated by
-- 0026. This migration separates the third fact: *which release* a normal
-- read uses. A release is a transformation identity - parser code digest,
-- contract versions and metadata extractor release - not a display version
-- string. Candidate results are ordinary `parse_runs` rows that are marked
-- here and are never published; adoption moves the 0026 pointer and appends
-- events; rollback moves it back and appends more events. Nothing here
-- rewrites `parse_runs`, observations or `superseded_by_parse_run_id`.
--
-- Unique-key decision (the review's "final form" is deliberately NOT taken
-- here). `idx_parse_runs_success` (0017) still says: one successful run per
-- (artifact, parser, version). Moving success uniqueness to
-- (input_fingerprint, release) would rewrite the index, the `already` check
-- and every writer at once, which is exactly the migration the review warns
-- against combining with the adoption switch. Instead:
--   * a candidate release always carries a new semantic version, so its runs
--     have a different (artifact, parser, version) key and coexist with the
--     published run under the existing index;
--   * a re-parse of the same version with different metadata is expressed as
--     a new release with a patch bump, whose manifest records the metadata
--     extractor release it used;
--   * state is never encoded in `parser_version`; `parse_run_candidates`
--     carries it.
-- The limit of this design is recorded in docs/release-adoption.md: a
-- candidate that shares its parser version with the published run cannot
-- produce a second successful run for an artifact that already has one.

-- Registered transformation identities. Append-only: a release is a
-- statement about code that ran, so it is never edited or removed.
CREATE TABLE parser_releases (
  release_id                 TEXT PRIMARY KEY,
  parser_name                TEXT NOT NULL,
  semantic_version           TEXT NOT NULL,
  code_digest                TEXT NOT NULL,
  input_contract_version     TEXT NOT NULL,
  output_contract_version    TEXT NOT NULL,
  metadata_extractor_release TEXT NOT NULL,
  dependency_digests_json    TEXT NOT NULL CHECK(json_valid(dependency_digests_json)),
  registered_at              TEXT NOT NULL
) STRICT;
CREATE INDEX parser_releases_parser ON parser_releases(parser_name, semantic_version);
CREATE TRIGGER parser_releases_no_update BEFORE UPDATE ON parser_releases
BEGIN SELECT RAISE(ABORT,'parser_releases is append-only'); END;
CREATE TRIGGER parser_releases_no_delete BEFORE DELETE ON parser_releases
BEGIN SELECT RAISE(ABORT,'parser_releases is append-only'); END;
-- The review's short-term compatibility rule, enforced by the schema: while
-- success uniqueness is keyed by (artifact, parser, version), a deployment
-- that registers the same name and version with a different code digest is
-- refused. Changing a parser or a shared transform it depends on requires a
-- version change.
CREATE TRIGGER parser_releases_stable_code_digest BEFORE INSERT ON parser_releases
WHEN EXISTS(SELECT 1 FROM parser_releases r WHERE r.parser_name=NEW.parser_name
  AND r.semantic_version=NEW.semantic_version AND r.code_digest<>NEW.code_digest)
BEGIN SELECT RAISE(ABORT,'parser release code digest changed without a version change'); END;

-- A successful parse run that is not a publication. `state` is operational:
--   candidate -> written by the candidate lane, invisible to every normal read
--   compared  -> a release comparison has been computed over it
--   ready     -> an operator judged the comparison acceptable
--   adopted   -> the activation moved the publication pointer onto it
--   rejected  -> an operator refused it; the run and its rows stay as evidence
-- Rows are never deleted, and the run they name never changes.
CREATE TABLE parse_run_candidates (
  parse_run_id INTEGER PRIMARY KEY REFERENCES parse_runs(id),
  release_id   TEXT NOT NULL REFERENCES parser_releases(release_id),
  fingerprint  TEXT NOT NULL,
  state        TEXT NOT NULL CHECK(state IN ('candidate','compared','ready','adopted','rejected')),
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX parse_run_candidates_release ON parse_run_candidates(release_id, state, parse_run_id);
CREATE TRIGGER parse_run_candidates_no_delete BEFORE DELETE ON parse_run_candidates
BEGIN SELECT RAISE(ABORT,'parse_run_candidates cannot be deleted'); END;
CREATE TRIGGER parse_run_candidates_preserve_identity BEFORE UPDATE ON parse_run_candidates
WHEN NEW.parse_run_id<>OLD.parse_run_id OR NEW.release_id<>OLD.release_id
 OR NEW.fingerprint<>OLD.fingerprint OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'candidate identity is immutable'); END;

-- One computed comparison of a candidate release against the release the
-- dataset is on. Append-only: a later comparison is a new row, so an
-- interrupted comparison leaves either nothing or one complete summary.
-- `summary_json` holds counts, locator correspondence and difference counts
-- only; it never holds a financial value.
CREATE TABLE release_comparisons (
  id                   INTEGER PRIMARY KEY,
  source_id            TEXT NOT NULL,
  dataset              TEXT NOT NULL,
  parser_name          TEXT NOT NULL,
  base_release_id      TEXT,
  candidate_release_id TEXT NOT NULL REFERENCES parser_releases(release_id),
  summary_json         TEXT NOT NULL CHECK(json_valid(summary_json)),
  computed_at          TEXT NOT NULL
) STRICT;
CREATE INDEX release_comparisons_scope
  ON release_comparisons(source_id, dataset, parser_name, id);
CREATE TRIGGER release_comparisons_no_update BEFORE UPDATE ON release_comparisons
BEGIN SELECT RAISE(ABORT,'release_comparisons is append-only'); END;
CREATE TRIGGER release_comparisons_no_delete BEFORE DELETE ON release_comparisons
BEGIN SELECT RAISE(ABORT,'release_comparisons is append-only'); END;

-- The adoption pointer per dataset: which release normal job creation uses,
-- and which metadata extractor release its parses read. Mutable operational
-- state, like `published_parse_runs`; the history lives in
-- `release_activation_events`. No row means "the deployed registry decides",
-- which is the behaviour of every Worker that predates this migration.
CREATE TABLE active_releases (
  source_id                  TEXT NOT NULL,
  dataset                    TEXT NOT NULL,
  parser_name                TEXT NOT NULL,
  release_id                 TEXT NOT NULL REFERENCES parser_releases(release_id),
  metadata_extractor_release TEXT NOT NULL DEFAULT 'legacy-metadata-v1',
  activated_at               TEXT NOT NULL,
  PRIMARY KEY(source_id, dataset, parser_name)
) STRICT;
CREATE TRIGGER active_releases_no_delete BEFORE DELETE ON active_releases
BEGIN SELECT RAISE(ABORT,'active_releases cannot be deleted; activate another release instead'); END;

-- Every pointer change, with the operator, the reason and the release the
-- operator believed was active. A rollback is a new event, never an edit.
CREATE TABLE release_activation_events (
  id                  INTEGER PRIMARY KEY,
  source_id           TEXT NOT NULL,
  dataset             TEXT NOT NULL,
  parser_name         TEXT NOT NULL,
  previous_release_id TEXT,
  new_release_id      TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN ('activate','rollback')),
  actor               TEXT NOT NULL,
  reason              TEXT NOT NULL,
  expected_previous   TEXT,
  pointers_moved      INTEGER NOT NULL DEFAULT 0 CHECK(pointers_moved >= 0),
  occurred_at         TEXT NOT NULL
) STRICT;
CREATE INDEX release_activation_events_scope
  ON release_activation_events(source_id, dataset, parser_name, id);
CREATE TRIGGER release_activation_events_no_update BEFORE UPDATE ON release_activation_events
BEGIN SELECT RAISE(ABORT,'release_activation_events is append-only'); END;
CREATE TRIGGER release_activation_events_no_delete BEFORE DELETE ON release_activation_events
BEGIN SELECT RAISE(ABORT,'release_activation_events is append-only'); END;

-- Publication gaps once candidates exist.
--
-- `publication_gate_mismatches` (0026) compares the projection with the
-- legacy predicate and keeps that exact meaning: it is the audit view, and
-- once candidates are written it lists them, which is how a candidate is
-- inspected. It is no longer the repair input, because a candidate is an
-- `ok`, unsuperseded run that must never be published by a repair, and a run
-- replaced by an activation is also `ok` and unsuperseded (adoption never
-- rewrites supersession).
--
-- `publication_gate_gaps` is the operational view: an `ok` unsuperseded run
-- that is not published, is not a candidate result, and was not replaced by an
-- adoption is a genuine gap left by a writer that predates the gate. The two
-- exclusions are stable under the repair route's own writes - repair appends
-- `repair` events and never an `activation`/`rollback` one - so the event
-- statement and the pointer statement of one repair batch select exactly the
-- same runs. The `projection_only` half is the 0026 rule verbatim.
CREATE INDEX publication_events_previous_run ON publication_events(previous_parse_run_id);
CREATE VIEW publication_gate_gaps AS
 SELECT p.fetch_artifact_id,p.parser_name,p.id AS parse_run_id,'legacy_only' AS mismatch
 FROM parse_runs p
 WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id=p.id)
  AND NOT EXISTS(SELECT 1 FROM parse_run_candidates c WHERE c.parse_run_id=p.id)
  AND NOT EXISTS(SELECT 1 FROM publication_events e WHERE e.previous_parse_run_id=p.id
    AND e.kind IN ('activation','rollback'))
 UNION ALL
 SELECT x.fetch_artifact_id,x.parser_name,x.parse_run_id,'projection_only'
 FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id
 WHERE p.status<>'ok' OR p.superseded_by_parse_run_id IS NOT NULL;

-- The candidate results of a release with the scope they belong to. Ids and
-- states only; joined by the comparison and the activation routes.
CREATE VIEW release_candidate_runs AS
 SELECT c.release_id,c.state,c.fingerprint,p.id AS parse_run_id,p.fetch_artifact_id,
  p.parser_name,p.parser_version,a.source_id,a.dataset
 FROM parse_run_candidates c
 JOIN parse_runs p ON p.id=c.parse_run_id
 JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
 WHERE p.status='ok';
