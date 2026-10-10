-- ADR 0055: storage primitives only. No current view, old row, command kind,
-- transport or financial consumer is changed. Members precede their seal in
-- one batch; the deferred FK prevents an unsealed member from committing.
CREATE TABLE instrument_temporal_acceptances (
 core_epoch TEXT NOT NULL,
 commit_seq INTEGER NOT NULL CHECK(commit_seq BETWEEN 1 AND 9007199254740991),
 known_at TEXT NOT NULL CHECK(length(known_at)=24
  AND known_at IS strftime('%Y-%m-%dT%H:%M:%fZ',known_at) AND substr(known_at,12,2)<'24'),
 operation_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(operation_id),
 decision_revision_id TEXT NOT NULL REFERENCES decision_revisions(id),
 member_count INTEGER NOT NULL CHECK(member_count BETWEEN 1 AND 256),
 PRIMARY KEY(core_epoch,commit_seq)
) STRICT;
CREATE TABLE instrument_temporal_versions (
 version_id TEXT PRIMARY KEY CHECK(length(version_id) BETWEEN 1 AND 256),
 core_epoch TEXT NOT NULL,
 commit_seq INTEGER NOT NULL CHECK(commit_seq BETWEEN 1 AND 9007199254740991),
 series_key TEXT NOT NULL CHECK(json_valid(series_key) AND json_type(series_key)='object'),
 supersedes TEXT REFERENCES instrument_temporal_versions(version_id),
 version_json TEXT NOT NULL CHECK(length(version_json)<=524288 AND json_valid(version_json)
  AND json_type(version_json)='object'
  AND json_extract(version_json,'$.versionId') IS version_id
  AND json_extract(version_json,'$.coreEpoch') IS core_epoch
  AND json_extract(version_json,'$.acceptanceSeq') IS commit_seq
  AND json_extract(version_json,'$.series') IS series_key
  AND json_extract(version_json,'$.supersedes') IS supersedes),
 UNIQUE(core_epoch,commit_seq,series_key),
 FOREIGN KEY(core_epoch,commit_seq) REFERENCES instrument_temporal_acceptances(core_epoch,commit_seq)
  DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX instrument_temporal_series ON instrument_temporal_versions(core_epoch,series_key,commit_seq DESC);
CREATE TRIGGER instrument_temporal_versions_guard BEFORE INSERT ON instrument_temporal_versions
BEGIN
 SELECT RAISE(ABORT,'instrument_temporal_member_sealed')
 WHERE EXISTS(SELECT 1 FROM instrument_temporal_acceptances WHERE core_epoch=NEW.core_epoch AND commit_seq=NEW.commit_seq);
 SELECT RAISE(ABORT,'instrument_temporal_chain_conflict')
 WHERE NEW.supersedes IS NOT (SELECT version_id FROM instrument_temporal_versions
  WHERE core_epoch=NEW.core_epoch AND series_key=NEW.series_key ORDER BY commit_seq DESC LIMIT 1)
  OR EXISTS(SELECT 1 FROM instrument_temporal_versions
   WHERE core_epoch=NEW.core_epoch AND series_key=NEW.series_key AND commit_seq>=NEW.commit_seq);
END;
CREATE TRIGGER instrument_temporal_acceptances_guard BEFORE INSERT ON instrument_temporal_acceptances
BEGIN
 SELECT RAISE(ABORT,'instrument_temporal_sequence_conflict')
 WHERE NEW.core_epoch IS NOT (SELECT core_epoch FROM core_source_revision WHERE id=1)
  OR NEW.commit_seq<>coalesce((SELECT max(commit_seq) FROM instrument_temporal_acceptances WHERE core_epoch=NEW.core_epoch),0)+1;
 SELECT RAISE(ABORT,'instrument_temporal_clock_regressed')
 WHERE NEW.known_at<(SELECT known_at FROM instrument_temporal_acceptances WHERE core_epoch=NEW.core_epoch AND commit_seq=NEW.commit_seq-1);
 SELECT RAISE(ABORT,'instrument_temporal_members_incomplete')
 WHERE NEW.member_count<>(SELECT count(*) FROM instrument_temporal_versions WHERE core_epoch=NEW.core_epoch AND commit_seq=NEW.commit_seq);
 SELECT RAISE(ABORT,'instrument_temporal_decision_mismatch')
 WHERE NOT EXISTS(SELECT 1 FROM decision_revisions d
  WHERE d.id=NEW.decision_revision_id AND d.operation_id=NEW.operation_id);
END;
CREATE TRIGGER instrument_temporal_acceptances_no_update BEFORE UPDATE ON instrument_temporal_acceptances
BEGIN SELECT RAISE(ABORT,'instrument temporal journal is append-only'); END;
CREATE TRIGGER instrument_temporal_acceptances_no_delete BEFORE DELETE ON instrument_temporal_acceptances
BEGIN SELECT RAISE(ABORT,'instrument temporal journal is append-only'); END;
CREATE TRIGGER instrument_temporal_acceptances_no_replace BEFORE INSERT ON instrument_temporal_acceptances
WHEN EXISTS(SELECT 1 FROM instrument_temporal_acceptances WHERE (core_epoch=NEW.core_epoch AND commit_seq=NEW.commit_seq) OR operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'instrument temporal replacement is forbidden'); END;
CREATE TRIGGER instrument_temporal_versions_no_update BEFORE UPDATE ON instrument_temporal_versions
BEGIN SELECT RAISE(ABORT,'instrument temporal versions are append-only'); END;
CREATE TRIGGER instrument_temporal_versions_no_delete BEFORE DELETE ON instrument_temporal_versions
BEGIN SELECT RAISE(ABORT,'instrument temporal versions are append-only'); END;
CREATE TRIGGER instrument_temporal_versions_no_replace BEFORE INSERT ON instrument_temporal_versions
WHEN EXISTS(SELECT 1 FROM instrument_temporal_versions WHERE version_id=NEW.version_id OR (core_epoch=NEW.core_epoch AND commit_seq=NEW.commit_seq AND series_key=NEW.series_key))
BEGIN SELECT RAISE(ABORT,'instrument temporal replacement is forbidden'); END;
