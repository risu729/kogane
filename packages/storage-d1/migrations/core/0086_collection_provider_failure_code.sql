-- Preserve a validated failed terminal's closed code beside its registration.
-- Existing rows stay NULL; no provider object is read or evidence backfilled.
ALTER TABLE collection_runs ADD COLUMN provider_failure_code TEXT
  CHECK(provider_failure_code IS NULL OR (
    provider_outcome IS 'failed'
    AND length(provider_failure_code) BETWEEN 1 AND 100
    AND substr(provider_failure_code, 1, 1) GLOB '[a-z0-9]'
    AND provider_failure_code NOT GLOB '*[^a-z0-9_-]*'
    AND instr(provider_failure_code, char(0)) = 0
  ));

CREATE TRIGGER collection_runs_failure_code_immutable
BEFORE UPDATE OF provider_failure_code ON collection_runs
WHEN NEW.provider_failure_code IS NOT OLD.provider_failure_code
BEGIN SELECT RAISE(ABORT, 'a collection provider failure code is immutable'); END;
