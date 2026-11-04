-- Provider displays are non-additive source facts, separate from rule estimates.
ALTER TABLE reward_expiry_snapshots ADD COLUMN provider_section_count INTEGER NOT NULL DEFAULT 0 CHECK(provider_section_count>=0);
CREATE TRIGGER reward_provider_section_count_sealed BEFORE UPDATE ON reward_expiry_snapshots
WHEN OLD.status<>'building' AND NEW.provider_section_count<>OLD.provider_section_count
BEGIN SELECT RAISE(ABORT,'sealed provider display count is immutable'); END;
CREATE TABLE reward_provider_expiry_sections (
 snapshot_id TEXT NOT NULL REFERENCES reward_expiry_snapshots(snapshot_id),
 row_key TEXT NOT NULL CHECK(length(row_key) BETWEEN 1 AND 1024),
 row_seq INTEGER NOT NULL CHECK(row_seq>=0),
 program_id TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object' AND json_extract(payload_json,'$.programId')=program_id),
 row_digest TEXT NOT NULL CHECK(length(row_digest)=64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(snapshot_id,row_key)
) STRICT;
CREATE UNIQUE INDEX reward_provider_expiry_sections_order ON reward_provider_expiry_sections(snapshot_id,row_seq);
CREATE INDEX reward_provider_expiry_sections_program ON reward_provider_expiry_sections(snapshot_id,program_id,row_seq);
CREATE TRIGGER reward_provider_sections_building BEFORE INSERT ON reward_provider_expiry_sections
WHEN NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'provider displays need a building snapshot'); END;
CREATE TRIGGER reward_provider_sections_conflict BEFORE INSERT ON reward_provider_expiry_sections
WHEN EXISTS(SELECT 1 FROM reward_provider_expiry_sections r WHERE r.snapshot_id=NEW.snapshot_id AND r.row_key=NEW.row_key AND r.row_digest IS NOT NEW.row_digest)
BEGIN SELECT RAISE(ABORT,'provider display chunk conflict'); END;
CREATE TRIGGER reward_provider_sections_no_update BEFORE UPDATE ON reward_provider_expiry_sections BEGIN SELECT RAISE(ABORT,'provider display rows are immutable'); END;
CREATE TRIGGER reward_provider_sections_sealed_no_delete BEFORE DELETE ON reward_provider_expiry_sections
WHEN EXISTS(SELECT 1 FROM reward_expiry_snapshots s WHERE s.snapshot_id=OLD.snapshot_id AND s.status<>'retired')
BEGIN SELECT RAISE(ABORT,'provider display rows need retirement before deletion'); END;
CREATE TABLE reward_provider_display_checkpoints (
 snapshot_id TEXT PRIMARY KEY REFERENCES reward_expiry_snapshots(snapshot_id),
 position INTEGER NOT NULL CHECK(position>=0),
 rows_written INTEGER NOT NULL CHECK(rows_written>=0),
 writer_lease TEXT NOT NULL,
 writer_fence INTEGER NOT NULL CHECK(writer_fence>=0),
 updated_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER reward_provider_checkpoint_building BEFORE INSERT ON reward_provider_display_checkpoints
WHEN NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'provider checkpoint needs a building snapshot'); END;
CREATE TRIGGER reward_provider_checkpoint_forward BEFORE UPDATE ON reward_provider_display_checkpoints
WHEN NEW.position<OLD.position OR NEW.rows_written<OLD.rows_written OR NEW.writer_fence<OLD.writer_fence
 OR NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots s WHERE s.snapshot_id=NEW.snapshot_id AND s.status='building')
BEGIN SELECT RAISE(ABORT,'provider checkpoint cannot move backwards or change sealed snapshot'); END;
