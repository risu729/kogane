-- Publication compatibility gate (design review D03, PR-05 steps 1-3).
--
-- "This parse succeeded" and "normal readers use this parse" become two
-- facts. published_parse_runs is the adoption pointer per (artifact, parser):
-- operational state that the observation-pipeline writer updates inside the
-- same D1 transaction that marks a parse run ok. publication_events is the
-- append-only history of every pointer change. Both are additive: parse_runs,
-- its supersession pointer and every append-only trigger are unchanged, and
-- a Worker that predates this migration keeps writing and reading as before.
--
-- The backfill below materialises exactly the legacy current set
-- (status='ok' AND superseded_by_parse_run_id IS NULL) so a reader that
-- switches to the projection sees the same rows it saw before. It is one
-- idempotent INSERT ... SELECT ... WHERE NOT EXISTS; re-running it, or running
-- the observation-pipeline /publication/repair route, adds only what is
-- missing (docs/publication-gate.md).

CREATE TABLE published_parse_runs (
  fetch_artifact_id INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  parser_name       TEXT NOT NULL,
  parse_run_id      INTEGER NOT NULL REFERENCES parse_runs(id),
  parser_version    TEXT NOT NULL,
  published_at      TEXT NOT NULL,
  publication_kind  TEXT NOT NULL CHECK(publication_kind IN ('normal','activation','rollback')),
  -- Reserved for the adoption PR (candidate releases); NULL until then.
  release_id        TEXT,
  PRIMARY KEY(fetch_artifact_id,parser_name)
) STRICT;
-- A parse run can only ever be the published run of its own (artifact, parser).
CREATE UNIQUE INDEX published_parse_runs_run ON published_parse_runs(parse_run_id);

-- The pointer may move (only through the writer or the repair route) but a
-- key never loses its publication: history is recorded, never erased.
CREATE TRIGGER published_parse_runs_no_delete BEFORE DELETE ON published_parse_runs
BEGIN SELECT RAISE(ABORT,'published_parse_runs cannot be deleted'); END;
-- Only a successful run of the same artifact and parser can be published.
CREATE TRIGGER published_parse_runs_requires_ok_insert BEFORE INSERT ON published_parse_runs
WHEN NOT EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=NEW.parse_run_id AND p.status='ok'
 AND p.fetch_artifact_id=NEW.fetch_artifact_id AND p.parser_name=NEW.parser_name
 AND p.parser_version=NEW.parser_version)
BEGIN SELECT RAISE(ABORT,'published parse run must be a successful run of the same artifact and parser'); END;
CREATE TRIGGER published_parse_runs_requires_ok_update BEFORE UPDATE ON published_parse_runs
WHEN NEW.fetch_artifact_id<>OLD.fetch_artifact_id OR NEW.parser_name<>OLD.parser_name
 OR NOT EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=NEW.parse_run_id AND p.status='ok'
  AND p.fetch_artifact_id=NEW.fetch_artifact_id AND p.parser_name=NEW.parser_name
  AND p.parser_version=NEW.parser_version)
BEGIN SELECT RAISE(ABORT,'published parse run must be a successful run of the same artifact and parser'); END;

CREATE TABLE publication_events (
  id                    INTEGER PRIMARY KEY,
  fetch_artifact_id     INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  parser_name           TEXT NOT NULL,
  previous_parse_run_id INTEGER REFERENCES parse_runs(id),
  new_parse_run_id      INTEGER NOT NULL REFERENCES parse_runs(id),
  kind                  TEXT NOT NULL CHECK(kind IN ('normal','activation','rollback','backfill','repair')),
  -- 'pipeline' for the writer, 'migration:NNNN' for a backfill, otherwise an operator id.
  actor                 TEXT NOT NULL,
  reason                TEXT NOT NULL,
  occurred_at           TEXT NOT NULL
) STRICT;
CREATE INDEX publication_events_target ON publication_events(fetch_artifact_id,parser_name,id);
CREATE INDEX publication_events_new_run ON publication_events(new_parse_run_id);
CREATE TRIGGER publication_events_no_update BEFORE UPDATE ON publication_events
BEGIN SELECT RAISE(ABORT,'publication_events is append-only'); END;
CREATE TRIGGER publication_events_no_delete BEFORE DELETE ON publication_events
BEGIN SELECT RAISE(ABORT,'publication_events is append-only'); END;
CREATE TRIGGER publication_events_requires_ok BEFORE INSERT ON publication_events
WHEN NOT EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=NEW.new_parse_run_id AND p.status='ok'
 AND p.fetch_artifact_id=NEW.fetch_artifact_id AND p.parser_name=NEW.parser_name)
BEGIN SELECT RAISE(ABORT,'publication_events requires a successful parse run of the same artifact and parser'); END;

-- Backfill: the legacy current set. Should two live runs ever share a key
-- (the writer prevents it), the highest id wins deterministically and the
-- consistency view reports the other one.
INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
SELECT p.fetch_artifact_id,p.parser_name,p.id,p.parser_version,p.parsed_at,'normal'
FROM parse_runs p
WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM parse_runs q WHERE q.fetch_artifact_id=p.fetch_artifact_id
    AND q.parser_name=p.parser_name AND q.status='ok' AND q.superseded_by_parse_run_id IS NULL AND q.id>p.id)
  AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.fetch_artifact_id=p.fetch_artifact_id
    AND x.parser_name=p.parser_name);
INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
SELECT x.fetch_artifact_id,x.parser_name,NULL,x.parse_run_id,'backfill','migration:0026','legacy_current_predicate',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM published_parse_runs x
WHERE NOT EXISTS(SELECT 1 FROM publication_events e WHERE e.new_parse_run_id=x.parse_run_id);

-- Reader view: the published run of every (artifact, parser) with its parse
-- run columns. Normal readers join this or published_parse_runs, never the
-- supersession pointer.
CREATE VIEW published_observation_parses AS
 SELECT p.id,p.fetch_artifact_id,p.parser_name,p.parser_version,p.parsed_at,p.status,p.error,
  p.warnings_json,p.superseded_by_parse_run_id,x.published_at,x.publication_kind,x.release_id
 FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id;

-- Consistency check between the projection and the legacy predicate. Empty
-- while every writer maintains the projection; a row means a legacy-only run
-- (an old writer published without the projection) or a projection-only run
-- (the pointer names a run the legacy rule no longer treats as current).
CREATE VIEW publication_gate_mismatches AS
 SELECT p.fetch_artifact_id,p.parser_name,p.id AS parse_run_id,'legacy_only' AS mismatch
 FROM parse_runs p
 WHERE p.status='ok' AND p.superseded_by_parse_run_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM published_parse_runs x WHERE x.parse_run_id=p.id)
 UNION ALL
 SELECT x.fetch_artifact_id,x.parser_name,x.parse_run_id,'projection_only'
 FROM published_parse_runs x JOIN parse_runs p ON p.id=x.parse_run_id
 WHERE p.status<>'ok' OR p.superseded_by_parse_run_id IS NOT NULL;

-- Identity reads adopt the gate: the driver becomes the projection, so a
-- successful run that is not published (a future candidate) never reaches
-- current_identity_observations. Plan shape of 0022 is kept (keyed lookups,
-- candidates and latest materialised once).
DROP VIEW current_identity_observations;
CREATE VIEW current_identity_observations AS
WITH candidates AS MATERIALIZED (
 SELECT r.id,r.parse_run_id,r.policy_version
 FROM published_parse_runs pub
 CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
 CROSS JOIN eligible_identity_runs r ON r.parse_run_id=p.id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
), latest AS MATERIALIZED (
 SELECT parse_run_id,max(policy_version) AS policy_version
 FROM candidates GROUP BY parse_run_id
)
SELECT o.*,r.policy_version,r.parse_run_id
FROM latest l
JOIN candidates r ON r.parse_run_id=l.parse_run_id AND r.policy_version=l.policy_version
JOIN identity_observations o ON o.identity_run_id=r.id;
